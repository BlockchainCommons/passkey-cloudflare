import { DurableObject } from "cloudflare:workers";

// Refused ceremonies that resolved to no record. Refusals that did resolve to a
// record are kept in that record's object instead. Outside, every refusal looks
// the same; here each keeps its cause.

export interface CeremonyFailure {
  ceremony: string;
  cause: string;
  at: number;
  /** SHA-256 of the source address, never the address itself. */
  sourceHash: string;
}

export const FAILURE_SCHEMA = `CREATE TABLE IF NOT EXISTS failures (
  at INTEGER NOT NULL,
  ceremony TEXT NOT NULL,
  cause TEXT NOT NULL,
  source_hash TEXT NOT NULL
)`;

export class CeremonyFailures<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(FAILURE_SCHEMA);
  }

  record(failure: CeremonyFailure): void {
    this.sql.exec(
      "INSERT INTO failures (at, ceremony, cause, source_hash) VALUES (?, ?, ?, ?)",
      failure.at,
      failure.ceremony,
      failure.cause,
      failure.sourceHash,
    );
  }
}
