// Identity layer
export {
  IdentityRecord,
  SESSION_LIFETIME_MS,
  type Principal,
  type RecordCause,
  type SessionCause,
  type SessionSummary,
} from "./identity/record.ts";
export { isRecordId, type RecordId } from "./identity/secrets.ts";
export { CredentialIndex } from "./identity/credential-index.ts";
export { CEREMONY_POLICY, type RelyingParty } from "./identity/webauthn.ts";

// Application-tier building blocks
export { ChallengeStore, CHALLENGE_LIFETIME_MS } from "./app-tier/challenges.ts";
export { MemberNameRegistry, isValidMemberName } from "./app-tier/member-names.ts";
export { CredentialLabels, parseLabel } from "./app-tier/labels.ts";
export { RateLimiter, DEFAULT_RATE_LIMITS, type Limit, type RateLimits } from "./app-tier/rate-limit.ts";
export { CeremonyFailures } from "./app-tier/ceremony-failures.ts";
export type { CeremonyFailure } from "./failures.ts";
export { CeremonyRefusal, REFUSAL_BODY, REFUSAL_STATUS, type Ceremony } from "./refusal.ts";
export { SESSION_COOKIE, clearedSessionCookie, sessionCookie, sessionValueFrom } from "./http.ts";

// Ceremonies
export {
  createPasskeys,
  PasskeyError,
  type CeremonyOutcome,
  type CredentialListing,
  type PasskeyBindings,
  type PasskeyConfig,
  type PasskeyErrorCode,
  type Passkeys,
  type RequestContext,
  type RevocationEvent,
  type RevokedPasskey,
} from "./passkeys.ts";
