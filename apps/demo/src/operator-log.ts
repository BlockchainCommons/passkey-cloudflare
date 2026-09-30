import { DurableObject } from "cloudflare:workers";
import type { RecordId } from "passkey-cloudflare";

// Every operator action, with the operator's record id, the action, the target
// and the time. The operator role belongs to this application, not to the
// identity layer, and so does this log.

export interface OperatorLogEntry {
  operatorId: RecordId;
  action: "lookup" | "create-rebind-link" | "suspend" | "resume";
  targetId: RecordId;
  at: number;
}

export class OperatorLog extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
  }

  append(entry: OperatorLogEntry): void {
    this.sql.exec(
      "INSERT INTO entries (operator_id, action, target_id, at) VALUES (?, ?, ?, ?)",
      entry.operatorId,
      entry.action,
      entry.targetId,
      entry.at,
    );
  }

  /** Every entry that targets one record, oldest first. */
  listFor(targetId: RecordId): OperatorLogEntry[] {
    return this.sql
      .exec<Row>("SELECT operator_id, action, target_id, at FROM entries WHERE target_id = ? ORDER BY seq", targetId)
      .toArray()
      .map(toEntry);
  }

  list(limit = 200): OperatorLogEntry[] {
    return this.sql
      .exec<Row>(
        "SELECT operator_id, action, target_id, at FROM entries ORDER BY seq DESC LIMIT ?",
        limit,
      )
      .toArray()
      .reverse()
      .map(toEntry);
  }
}

type Row = {
  operator_id: RecordId;
  action: OperatorLogEntry["action"];
  target_id: RecordId;
  at: number;
};

function toEntry(row: Row): OperatorLogEntry {
  return { operatorId: row.operator_id, action: row.action, targetId: row.target_id, at: row.at };
}
