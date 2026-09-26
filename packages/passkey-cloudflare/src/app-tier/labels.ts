import { DurableObject } from "cloudflare:workers";
import { randomBytes } from "../encoding.ts";
import { bytewordsIdentifier, bytewordToken } from "../gordian/bytewords.ts";

// A per-record namespace of credential labels. A label is minted when a
// ceremony starts, bound to a credential when it completes, and retired when
// the credential is revoked. A credential whose bind never happened is given a
// label when it is next listed. Labels are never reused within a record.
//
// A label is three random bytes spelled as Bytewords with no checksum, lower
// case and hyphenated: `wand-meow-nail`. It names a passkey; it is not a
// Bytewords encoding. Credentials labelled before this format keep their
// two-word labels.

const LABEL_BYTES = 3;

/** Draws before minting gives up. At half full, all of them are taken about once in 10^19 mints. */
const MINT_TRIES = 64;

/**
 * A label drawn at random and not checked against any namespace. A label that
 * turns out to be taken when it is bound leaves the credential unlabelled
 * until it is next listed.
 */
export function randomLabel(): string {
  return bytewordsIdentifier(randomBytes(LABEL_BYTES), "-");
}

/**
 * The label a person typed, in its stored form, or null if it is not one:
 * any case, words separated by spaces or hyphens, each word whole or as its
 * first and last letters or its first or last three letters.
 */
export function parseLabel(text: string): string | null {
  const bytes = text.trim().split(/[ -]+/).map(bytewordToken);
  if (bytes.length !== LABEL_BYTES || bytes.some((b) => b === null)) return null;
  return bytewordsIdentifier(Uint8Array.from(bytes as number[]), "-");
}

export class CredentialLabels<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS labels (
      label TEXT PRIMARY KEY,
      credential_id TEXT UNIQUE,
      minted_at INTEGER NOT NULL,
      retired_at INTEGER
    )`);
  }

  /**
   * Mint a label never used in this namespace. Throws after MINT_TRIES draws
   * that are all taken, rather than searching a namespace that may be full.
   */
  mint(now: number): string {
    for (let tries = 0; tries < MINT_TRIES; tries++) {
      const label = randomLabel();
      const taken = this.sql.exec("SELECT 1 FROM labels WHERE label = ?", label).toArray().length > 0;
      if (!taken) {
        this.sql.exec("INSERT INTO labels (label, minted_at) VALUES (?, ?)", label, now);
        return label;
      }
    }
    throw new Error(`no free credential label after ${MINT_TRIES} tries`);
  }

  /**
   * Bind a label to a credential. A label minted elsewhere is recorded here
   * first. A credential that already has a label, as a listing gives one whose
   * bind came late, keeps it.
   */
  bind(label: string, credentialId: string, now: number): void {
    if (this.labelOf(credentialId) !== null) return;
    this.sql.exec(
      `INSERT INTO labels (label, credential_id, minted_at) VALUES (?, ?, ?)
       ON CONFLICT (label) DO UPDATE SET credential_id = excluded.credential_id
       WHERE labels.credential_id IS NULL AND labels.retired_at IS NULL`,
      label,
      credentialId,
      now,
    );
  }

  /** The label a credential has or had. A credential has at most one, retired or not. */
  private labelOf(credentialId: string): string | null {
    const row = this.sql
      .exec<{ label: string }>("SELECT label FROM labels WHERE credential_id = ?", credentialId)
      .toArray()[0];
    return row?.label ?? null;
  }

  /** The credential an active label names. */
  resolve(label: string): string | null {
    const row = this.sql
      .exec<{ credential_id: string | null }>(
        "SELECT credential_id FROM labels WHERE label = ? AND retired_at IS NULL",
        label,
      )
      .toArray()[0];
    return row?.credential_id ?? null;
  }

  retire(label: string, now: number): void {
    this.sql.exec("UPDATE labels SET retired_at = ? WHERE label = ?", now, label);
  }

  /**
   * The label of each credential, minting one for any credential that never
   * had one, as a failed bind leaves it. A credential revoked since its caller
   * listed it keeps its retired label rather than gaining an active one.
   */
  labelEach(credentialIds: readonly string[], now: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const credentialId of credentialIds) {
      let label = this.labelOf(credentialId);
      if (label === null) {
        label = this.mint(now);
        this.bind(label, credentialId, now);
      }
      out[credentialId] = label;
    }
    return out;
  }
}
