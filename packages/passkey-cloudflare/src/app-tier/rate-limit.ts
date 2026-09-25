import { DurableObject } from "cloudflare:workers";

// Sliding-window rate limits, one Durable Object per bucket.

export interface Limit {
  limit: number;
  windowMs: number;
}

export interface RateLimits {
  /** Every ceremony completion from one source address. */
  ceremonyPerSource: Limit;
  /** Anonymous ceremony completions (register, login, recover, rebind) from everywhere. */
  ceremonyGlobal: Limit;
  /** Anonymous ceremony options from one source address. */
  optionsPerSource: Limit;
  /** Recovery attempts from one source address. */
  recoverPerSource: Limit;
  /** Recovery attempts from everywhere. */
  recoverGlobal: Limit;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RATE_LIMITS: RateLimits = {
  ceremonyPerSource: { limit: 30, windowMs: MINUTE },
  ceremonyGlobal: { limit: 6000, windowMs: MINUTE },
  optionsPerSource: { limit: 60, windowMs: MINUTE },
  recoverPerSource: { limit: 10, windowMs: HOUR },
  recoverGlobal: { limit: 1000, windowMs: HOUR },
};

export class RateLimiter<Env = unknown> extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (at INTEGER NOT NULL)");
  }

  /** Count one hit. Returns false, without counting it, if the bucket is already full. */
  hit(limit: Limit, now: number): boolean {
    this.sql.exec("DELETE FROM hits WHERE at <= ?", now - limit.windowMs);
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits").one().n;
    if (count >= limit.limit) return false;
    this.sql.exec("INSERT INTO hits (at) VALUES (?)", now);
    return true;
  }
}
