// Identity layer
export { IdentityRecord, SESSION_LIFETIME_MS, type Principal, type SessionSummary } from "./identity/record.ts";
export { CredentialIndex } from "./identity/credential-index.ts";
export { CEREMONY_POLICY, type RelyingParty } from "./identity/webauthn.ts";

// Application-tier building blocks
export { ChallengeStore, CHALLENGE_LIFETIME_MS } from "./app-tier/challenges.ts";
export { MemberNameRegistry, isValidMemberName } from "./app-tier/member-names.ts";
export { CredentialLabels } from "./app-tier/labels.ts";
export { CeremonyRefusal, REFUSAL_BODY, REFUSAL_STATUS, type Ceremony } from "./refusal.ts";
export { SESSION_COOKIE, clearedSessionCookie, sessionCookie, sessionValueFrom } from "./http.ts";

// Ceremonies
export {
  createPasskeys,
  NotAvailable,
  type CeremonyOutcome,
  type PasskeyBindings,
  type PasskeyConfig,
  type Passkeys,
  type RequestContext,
  type RevocationEvent,
} from "./passkeys.ts";
