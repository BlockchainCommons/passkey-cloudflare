import { DurableObject } from "cloudflare:workers";
import { FLAG_BACKUP_ELIGIBLE, type VerifiedCredential } from "./webauthn.ts";

// One Durable Object per identity record. It holds the record, its credentials,
// sessions, recovery-code hashes, suspension state and failure rows. It sees
// only ids and hashes: never a label, a member name, a session token or a code.

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface NewSession {
  id: string;
  tokenHash: string;
  userAgent: string;
}

export interface Principal {
  recordId: string;
  kind: "person" | "agent";
  sessionId: string;
}

export type RecordResult<T = {}> = ({ ok: true } & T) | { ok: false; cause: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  created_at INTEGER NOT NULL,
  suspended_at INTEGER
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  algorithm INTEGER NOT NULL,
  sign_count INTEGER NOT NULL,
  registration_flags INTEGER NOT NULL,
  last_flags INTEGER,
  aaguid TEXT NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  prf_public_key BLOB
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL,
  step_up_at INTEGER
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

export class IdentityRecord<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private recordRow(): { id: string; kind: "person" | "agent"; suspended_at: number | null } | undefined {
    return this.sql.exec<{ id: string; kind: "person" | "agent"; suspended_at: number | null }>(
      "SELECT id, kind, suspended_at FROM record",
    ).toArray()[0];
  }

  private insertCredential(credential: VerifiedCredential, now: number): void {
    this.sql.exec(
      `INSERT INTO credentials (id, public_key, algorithm, sign_count, registration_flags, aaguid, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      credential.id,
      credential.publicKey,
      credential.algorithm,
      credential.signCount,
      credential.registrationFlags,
      credential.aaguid,
      JSON.stringify(credential.transports),
      now,
    );
  }

  private insertSession(session: NewSession, now: number): void {
    this.sql.exec(
      "INSERT INTO sessions (id, token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
      session.id,
      session.tokenHash,
      now,
      now + SESSION_LIFETIME_MS,
      session.userAgent,
    );
  }

  /** Create a person's record with its first credential, recovery codes and a session, in one transaction. */
  createPerson(input: {
    recordId: string;
    credential: VerifiedCredential;
    recoveryCodeHashes: string[];
    session: NewSession;
    now: number;
  }): RecordResult {
    if (this.recordRow()) return { ok: false, cause: "record-exists" };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO record (id, kind, created_at) VALUES (?, 'person', ?)",
        input.recordId,
        input.now,
      );
      this.insertCredential(input.credential, input.now);
      for (const hash of input.recoveryCodeHashes) {
        this.sql.exec("INSERT INTO recovery_codes (code_hash, issued_at) VALUES (?, ?)", hash, input.now);
      }
      this.insertSession(input.session, input.now);
    });
    return { ok: true };
  }

  /** What the Worker needs to verify an assertion by one of this record's credentials. */
  credentialForAssertion(
    credentialId: string,
  ): { publicKey: Uint8Array<ArrayBuffer>; signCount: number; enforceCounter: boolean } | null {
    const row = this.sql
      .exec<{ public_key: ArrayBuffer; sign_count: number; registration_flags: number }>(
        "SELECT public_key, sign_count, registration_flags FROM credentials WHERE id = ?",
        credentialId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      publicKey: new Uint8Array(row.public_key),
      signCount: row.sign_count,
      enforceCounter: (row.registration_flags & FLAG_BACKUP_ELIGIBLE) === 0,
    };
  }

  /**
   * Record a verified assertion: re-check the sign counter against the stored
   * one, then update the credential. Returns the cause if the assertion must
   * be refused. Runs inside the caller's transaction.
   */
  private acceptAssertion(credentialId: string, signCount: number, flags: number, now: number): string | null {
    const row = this.sql
      .exec<{ sign_count: number; registration_flags: number }>(
        "SELECT sign_count, registration_flags FROM credentials WHERE id = ?",
        credentialId,
      )
      .toArray()[0];
    if (!row) return "unknown-credential";
    const enforce = (row.registration_flags & FLAG_BACKUP_ELIGIBLE) === 0;
    if (enforce && (signCount > 0 || row.sign_count > 0) && signCount <= row.sign_count) {
      return "counter-regressed";
    }
    this.sql.exec(
      "UPDATE credentials SET sign_count = ?, last_flags = ?, last_used_at = ? WHERE id = ?",
      Math.max(signCount, row.sign_count),
      flags,
      now,
      credentialId,
    );
    return null;
  }

  private refusalFor(): string | null {
    const record = this.recordRow();
    if (!record) return "unknown-record";
    if (record.suspended_at !== null) return "suspended";
    return null;
  }

  /** Complete a login: accept the verified assertion and mint a session, in one transaction. */
  completeLogin(input: {
    credentialId: string;
    signCount: number;
    flags: number;
    session: NewSession;
    now: number;
  }): RecordResult {
    const refused = this.refusalFor();
    if (refused) return { ok: false, cause: refused };
    return this.ctx.storage.transactionSync((): RecordResult => {
      const cause = this.acceptAssertion(input.credentialId, input.signCount, input.flags, input.now);
      if (cause) return { ok: false, cause };
      this.insertSession(input.session, input.now);
      return { ok: true };
    });
  }

  /** End one session. Returns its id, or null if it was not live. */
  revokeSession(tokenHash: string): string | null {
    const row = this.sql
      .exec<{ id: string }>("DELETE FROM sessions WHERE token_hash = ? RETURNING id", tokenHash)
      .toArray()[0];
    return row?.id ?? null;
  }

  /** Validate a session token hash. Called on every authenticated request; nothing is cached. */
  authenticate(tokenHash: string, now: number): Principal | null {
    const record = this.recordRow();
    if (!record || record.suspended_at !== null) return null;
    const session = this.sql
      .exec<{ id: string; expires_at: number }>(
        "SELECT id, expires_at FROM sessions WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!session || session.expires_at <= now) return null;
    return { recordId: record.id, kind: record.kind, sessionId: session.id };
  }
}
