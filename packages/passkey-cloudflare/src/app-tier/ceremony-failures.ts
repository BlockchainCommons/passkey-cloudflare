import { DurableObject } from "cloudflare:workers";
import { FAILURE_SCHEMA, insertFailure, type CeremonyFailure } from "../failures.ts";

// Refused ceremonies that resolved to no record. Refusals that did resolve to a
// record are kept in that record's object instead.

export class CeremonyFailures<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(FAILURE_SCHEMA);
  }

  record(failure: CeremonyFailure): void {
    insertFailure(this.sql, failure);
  }
}
