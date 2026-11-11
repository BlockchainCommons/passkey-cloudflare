import { DurableObject } from "cloudflare:workers";
import type { RecordId } from "../identity/secrets.ts";
import { prefixedInstance } from "../storage-prefix.ts";

// Every operator action, with the operator's record id, the action, what it
// acted on, the member it concerns where there is one, and the time. The
// operator role belongs to the application (ADR 0003); the log is the record
// of what its operators did, which the library keeps for it.

/** Any application's own operator action or target kind as the log stores it: a prefix, a colon, then the name (`forge:delete-project`). */
export type AppPrefixed = `${string}:${string}`;

/** The operator actions the library carries out itself. */
export type BuiltInOperatorAction = "lookup" | "create-rebind-link" | "suspend" | "resume" | "remove" | "allow-name";

/** A logged operator action: one of the library's, or an application's own, prefixed. */
export type OperatorActionName = BuiltInOperatorAction | AppPrefixed;

/** What a logged action acted on: a record (the library's kind), or an application's own kind, prefixed. */
export type OperatorTargetKind = "record" | AppPrefixed;

/** What an operator action acted on. */
export interface OperatorTarget {
  kind: OperatorTargetKind;
  id: string;
}

export interface OperatorLogEntry {
  operatorId: RecordId;
  action: OperatorActionName;
  target: OperatorTarget;
  /** The member the action concerns, whose history it shows in; absent when it concerns none. */
  recordId?: RecordId;
  at: number;
}

export class OperatorLog<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      record_id TEXT,
      at INTEGER NOT NULL
    )`);
  }

  append(entry: OperatorLogEntry): void {
    this.sql.exec(
      "INSERT INTO entries (operator_id, action, target_kind, target_id, record_id, at) VALUES (?, ?, ?, ?, ?, ?)",
      entry.operatorId,
      entry.action,
      entry.target.kind,
      entry.target.id,
      entry.recordId ?? null,
      entry.at,
    );
  }

  /** Every entry that concerns one member, oldest first. */
  listFor(recordId: RecordId): OperatorLogEntry[] {
    return this.sql
      .exec<Row>(`SELECT ${COLUMNS} FROM entries WHERE record_id = ? ORDER BY seq`, recordId)
      .toArray()
      .map(toEntry);
  }

  /** The most recent entries, whatever they concern, oldest first. */
  list(limit = 200): OperatorLogEntry[] {
    return this.sql
      .exec<Row>(`SELECT ${COLUMNS} FROM entries ORDER BY seq DESC LIMIT ?`, limit)
      .toArray()
      .reverse()
      .map(toEntry);
  }
}

const COLUMNS = "operator_id, action, target_kind, target_id, record_id, at";

type Row = {
  operator_id: RecordId;
  action: OperatorActionName;
  target_kind: OperatorTargetKind;
  target_id: string;
  record_id: RecordId | null;
  at: number;
};

function toEntry(row: Row): OperatorLogEntry {
  return {
    operatorId: row.operator_id,
    action: row.action,
    target: { kind: row.target_kind, id: row.target_id },
    ...(row.record_id === null ? {} : { recordId: row.record_id }),
    at: row.at,
  };
}

/** The one operator log, under `storagePrefix`, the same prefix the app gives the library. */
export function operatorLog(binding: DurableObjectNamespace<OperatorLog>, storagePrefix?: string) {
  return () => prefixedInstance(binding, storagePrefix, "global");
}
