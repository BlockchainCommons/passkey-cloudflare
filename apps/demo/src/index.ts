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

// Bound in wrangler.jsonc and implemented in later slices.
export class RateLimiter extends DurableObject {}
export class CeremonyFailures extends DurableObject {}
export class OperatorLog extends DurableObject {}
