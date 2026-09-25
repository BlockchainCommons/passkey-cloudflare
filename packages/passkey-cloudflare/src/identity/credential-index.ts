import { DurableObject } from "cloudflare:workers";

// The one global lookup on the login path: credential id to record id. A
// Durable Object rather than KV, because KV is eventually consistent.

export class CredentialIndex<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS credentials (credential_id TEXT PRIMARY KEY, record_id TEXT NOT NULL)",
    );
  }

  /** Bind a credential id to a record. Refuses an id that is already bound. */
  put(credentialId: string, recordId: string): boolean {
    const existing = this.sql
      .exec("SELECT 1 FROM credentials WHERE credential_id = ?", credentialId)
      .toArray();
    if (existing.length > 0) return false;
    this.sql.exec("INSERT INTO credentials (credential_id, record_id) VALUES (?, ?)", credentialId, recordId);
    return true;
  }

  get(credentialId: string): string | null {
    const row = this.sql
      .exec<{ record_id: string }>("SELECT record_id FROM credentials WHERE credential_id = ?", credentialId)
      .toArray()[0];
    return row?.record_id ?? null;
  }

  delete(credentialId: string): void {
    this.sql.exec("DELETE FROM credentials WHERE credential_id = ?", credentialId);
  }
}
