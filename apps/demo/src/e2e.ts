import { createApp } from "./app.ts";
import { operatorRolesFromSecretOrMemberNames } from "./operator-member-names.ts";

// The demo as Playwright runs it (playwright.config.ts), never deployed. Its
// operators can be named by member name, through the OPERATOR_MEMBER_NAMES var,
// so the browser tests drive a real operator.

export default createApp({ operatorRoles: operatorRolesFromSecretOrMemberNames });

export {
  ChallengeStore,
  CredentialIndex,
  CeremonyFailures,
  CredentialLabels,
  IdentityRecord,
  MemberNameRegistry,
  RateLimiter,
} from "passkey-cloudflare";

export { OperatorLog } from "./operator-log.ts";
