import { DurableObject } from "cloudflare:workers";
import type { RecordId } from "../identity/secrets.ts";

// Unique member names, each resolving to a record id, with history kept.
// Uniqueness is case-insensitive; the name is shown as the person typed it.

const MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;

export function isValidMemberName(name: unknown): name is string {
  return typeof name === "string" && MEMBER_NAME.test(name);
}

export function memberNameKey(name: string): string {
  return name.toLowerCase();
}

export class MemberNameRegistry<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS names (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        record_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS name_history (
        record_id TEXT NOT NULL,
        name TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        released_at INTEGER
      );
    `);
  }

  isAvailable(name: string): boolean {
    return (
      this.sql.exec("SELECT 1 FROM names WHERE key = ?", memberNameKey(name)).toArray().length === 0
    );
  }

  /** Claim a name for a record. Refuses a name that is taken. */
  claim(name: string, recordId: RecordId, now: number): boolean {
    if (!this.isAvailable(name)) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO names (key, name, record_id) VALUES (?, ?, ?)", memberNameKey(name), name, recordId);
      this.sql.exec(
        "INSERT INTO name_history (record_id, name, claimed_at) VALUES (?, ?, ?)",
        recordId,
        name,
        now,
      );
    });
    return true;
  }

  /** Undo a claim whose registration did not complete. */
  release(name: string, recordId: RecordId, now: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM names WHERE key = ? AND record_id = ?", memberNameKey(name), recordId);
      this.sql.exec(
        "UPDATE name_history SET released_at = ? WHERE record_id = ? AND name = ? AND released_at IS NULL",
        now,
        recordId,
        name,
      );
    });
  }

  resolve(name: string): RecordId | null {
    const row = this.sql
      .exec<{ record_id: RecordId }>("SELECT record_id FROM names WHERE key = ?", memberNameKey(name))
      .toArray()[0];
    return row?.record_id ?? null;
  }

  nameOf(recordId: RecordId): string | null {
    const row = this.sql
      .exec<{ name: string }>("SELECT name FROM names WHERE record_id = ?", recordId)
      .toArray()[0];
    return row?.name ?? null;
  }
}
