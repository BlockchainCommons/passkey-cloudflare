import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { ChallengeStore } from "./app-tier/challenges.ts";
import { randomLabel, type CredentialLabels } from "./app-tier/labels.ts";
import { isValidMemberName, type MemberNameRegistry } from "./app-tier/member-names.ts";
import { sha256Hex, toBase64Url } from "./encoding.ts";
import type { CredentialIndex } from "./identity/credential-index.ts";
import type { IdentityRecord, Principal } from "./identity/record.ts";
import { mintRecoveryCodes, mintSession, parseSessionValue } from "./identity/secrets.ts";
import {
  claimedChallenge,
  creationOptions,
  newChallenge,
  requestOptions,
  verifyAssertion,
  verifyRegistration,
  type RelyingParty,
} from "./identity/webauthn.ts";
import { CeremonyRefusal, uniformRefusal, type Ceremony } from "./refusal.ts";

// The ceremonies, composed from the identity layer (records, credential index,
// verification) and the application-tier building blocks (challenges, member
// names, labels, uniform refusal). This is the module an application calls.

export interface PasskeyBindings {
  IDENTITY_RECORDS: DurableObjectNamespace<IdentityRecord>;
  CREDENTIAL_INDEX: DurableObjectNamespace<CredentialIndex>;
  CHALLENGES: DurableObjectNamespace<ChallengeStore>;
  MEMBER_NAMES: DurableObjectNamespace<MemberNameRegistry>;
  CREDENTIAL_LABELS: DurableObjectNamespace<CredentialLabels>;
}

export interface PasskeyConfig {
  rp: RelyingParty;
  /** Minimum time before any ceremony refusal is returned, in milliseconds. */
  refusalFloorMs: number;
  /** Source of the current time. Defaults to `Date.now`. */
  clock?: () => number;
}

/** What a ceremony needs to know about the request that carries it. */
export interface RequestContext {
  startedAt: number;
  now: number;
  sourceIp: string;
  userAgent: string;
}

export type CeremonyOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

export class NotAvailable extends Error {}

export function createPasskeys(bindings: PasskeyBindings, config: PasskeyConfig) {
  const clock = config.clock ?? Date.now;

  const record = (recordId: string) =>
    bindings.IDENTITY_RECORDS.get(bindings.IDENTITY_RECORDS.idFromName(recordId));
  const index = () => bindings.CREDENTIAL_INDEX.get(bindings.CREDENTIAL_INDEX.idFromName("global"));
  const names = () => bindings.MEMBER_NAMES.get(bindings.MEMBER_NAMES.idFromName("global"));
  const labels = (recordId: string) =>
    bindings.CREDENTIAL_LABELS.get(bindings.CREDENTIAL_LABELS.idFromName(recordId));
  // Challenges are spread over sixteen objects by the first hex digit of their hash.
  const challenges = (hash: string) =>
    bindings.CHALLENGES.get(bindings.CHALLENGES.idFromName(`challenges-${hash[0]}`));

  async function issueChallenge(purpose: Ceremony, payload: unknown, now: number) {
    const challenge = newChallenge();
    const hash = await sha256Hex(toBase64Url(challenge));
    await challenges(hash).issue(hash, purpose, payload, now);
    return challenge;
  }

  async function consumeChallenge<P>(purpose: Ceremony, response: unknown, now: number) {
    const challenge = claimedChallenge(response);
    const hash = await sha256Hex(challenge);
    const taken = await challenges(hash).consume(hash, purpose, now);
    if (taken === null) throw new CeremonyRefusal("unknown-challenge");
    return { challenge, payload: JSON.parse(taken) as P };
  }

  /**
   * Verify an assertion by any credential the site knows. Returns the record
   * it belongs to and what the record must accept.
   */
  async function verifyKnownAssertion(response: AuthenticationResponseJSON, challenge: string) {
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const recordId = credentialId ? await index().get(credentialId) : null;
    if (!recordId) throw new CeremonyRefusal("unknown-credential");
    const stored = await record(recordId).credentialForAssertion(credentialId);
    if (!stored) throw new CeremonyRefusal("unknown-credential", recordId);
    try {
      const verified = await verifyAssertion(response, {
        rp: config.rp,
        challenge,
        credential: { id: credentialId, ...stored },
      });
      return { recordId, credentialId, ...verified };
    } catch (error) {
      if (error instanceof CeremonyRefusal) throw new CeremonyRefusal(error.reason, recordId);
      throw error;
    }
  }

  return {
    context(request: Request): RequestContext {
      const now = clock();
      return {
        startedAt: Date.now(),
        now,
        sourceIp: request.headers.get("CF-Connecting-IP") ?? "unknown",
        userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 256),
      };
    },

    /**
     * Run a ceremony. Any refusal becomes the one uniform response, returned
     * no sooner than the timing floor.
     */
    async ceremony<T>(
      ctx: RequestContext,
      _ceremony: Ceremony,
      run: () => Promise<T>,
    ): Promise<CeremonyOutcome<T>> {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        if (!(error instanceof CeremonyRefusal)) throw error;
        return { ok: false, response: await uniformRefusal(ctx.startedAt, config.refusalFloorMs) };
      }
    },

    async isMemberNameAvailable(name: string): Promise<boolean> {
      return isValidMemberName(name) && (await names().isAvailable(name));
    },

    async memberName(recordId: string): Promise<string | null> {
      return names().nameOf(recordId);
    },

    async registrationOptions(ctx: RequestContext, memberName: string) {
      if (!(await this.isMemberNameAvailable(memberName))) throw new NotAvailable("member name not available");
      const label = randomLabel();
      const challenge = await issueChallenge("register", { memberName, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: `${memberName} (${label})` });
    },

    /** Complete registration: a new record, its first credential, recovery codes and a session. */
    async register(ctx: RequestContext, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{ memberName: string; label: string }>(
        "register",
        response,
        ctx.now,
      );
      const credential = await verifyRegistration(response, { rp: config.rp, challenge });
      const recordId = crypto.randomUUID();
      if (!(await names().claim(payload.memberName, recordId, ctx.now))) {
        throw new CeremonyRefusal("member-name-taken");
      }
      if (!(await index().put(credential.id, recordId))) {
        await names().release(payload.memberName, recordId, ctx.now);
        throw new CeremonyRefusal("credential-exists");
      }
      const session = await mintSession(recordId);
      const recovery = await mintRecoveryCodes();
      const created = await record(recordId).createPerson({
        recordId,
        credential,
        recoveryCodeHashes: recovery.hashes,
        session: { id: session.id, tokenHash: session.tokenHash, userAgent: ctx.userAgent },
        now: ctx.now,
      });
      if (!created.ok) {
        await index().delete(credential.id);
        await names().release(payload.memberName, recordId, ctx.now);
        throw new CeremonyRefusal(created.cause);
      }
      await labels(recordId).bind(payload.label, credential.id, ctx.now);
      return { recordId, session: session.value, recoveryCodes: recovery.codes };
    },

    async loginOptions(ctx: RequestContext) {
      const challenge = await issueChallenge("login", {}, ctx.now);
      return requestOptions({ rp: config.rp, challenge });
    },

    /** Complete a login with any of the site's passkeys, minting a session. */
    async login(ctx: RequestContext, response: AuthenticationResponseJSON) {
      const { challenge } = await consumeChallenge("login", response, ctx.now);
      const assertion = await verifyKnownAssertion(response, challenge);
      const session = await mintSession(assertion.recordId);
      const done = await record(assertion.recordId).completeLogin({
        credentialId: assertion.credentialId,
        signCount: assertion.signCount,
        flags: assertion.flags,
        session: { id: session.id, tokenHash: session.tokenHash, userAgent: ctx.userAgent },
        now: ctx.now,
      });
      if (!done.ok) throw new CeremonyRefusal(done.cause, assertion.recordId);
      return { recordId: assertion.recordId, session: session.value };
    },

    /** End the presented session. */
    async logout(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseSessionValue(sessionValue);
      if (!parsed) return;
      await record(parsed.recordId).revokeSession(parsed.tokenHash);
    },

    /** The principal a session value proves, checked against its record on every call. */
    async authenticate(sessionValue: string | null | undefined): Promise<Principal | null> {
      const parsed = await parseSessionValue(sessionValue);
      if (!parsed) return null;
      return record(parsed.recordId).authenticate(parsed.tokenHash, clock());
    },
  };
}

export type Passkeys = ReturnType<typeof createPasskeys>;
