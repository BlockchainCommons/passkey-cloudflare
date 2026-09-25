// Secrets set per deployment with `wrangler secret put`, which `wrangler types`
// cannot see in wrangler.jsonc.
interface Env {
  /** Identity record ids holding the operator role, separated by commas. */
  OPERATOR_RECORD_IDS?: string;
}
