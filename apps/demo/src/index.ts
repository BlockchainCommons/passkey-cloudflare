import { DurableObject } from "cloudflare:workers";
import { createApp } from "./app.ts";

export default createApp();

export {
  ChallengeStore,
  CredentialIndex,
  CredentialLabels,
  IdentityRecord,
  MemberNameRegistry,
} from "passkey-cloudflare";

export { OperatorLog } from "./operator-log.ts";

// Bound in wrangler.jsonc and implemented in later slices.
export class RateLimiter extends DurableObject {}
export class CeremonyFailures extends DurableObject {}
