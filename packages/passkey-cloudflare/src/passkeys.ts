import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { CeremonyFailures } from "./app-tier/ceremony-failures.ts";
import type { ChallengeStore } from "./app-tier/challenges.ts";
import { providerName } from "./app-tier/aaguid-names.ts";
import { parseLabel, randomLabel, type CredentialLabels } from "./app-tier/labels.ts";
import type { MemberNameRegistry } from "./app-tier/member-names.ts";
import { isValidMemberName, memberNameKey } from "./member-name-rules.ts";
import { DEFAULT_RATE_LIMITS, type Limit, type RateLimiter, type RateLimits } from "./app-tier/rate-limit.ts";
import { sha256Hex, toBase64Url } from "./encoding.ts";
import type { CredentialIndex } from "./identity/credential-index.ts";
import type { IdentityRecord, Principal, SessionCause, SessionSummary } from "./identity/record.ts";
import {
  hashRecoveryCode,
  mintRebindToken,
  mintRecoveryCodes,
  mintSession,
  newRecordId,
  parseRecordToken,
  type RecordId,
} from "./identity/secrets.ts";
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
  RATE_LIMITS: DurableObjectNamespace<RateLimiter>;
  CEREMONY_FAILURES: DurableObjectNamespace<CeremonyFailures>;
}

export interface PasskeyConfig {
  rp: RelyingParty;
  /** Minimum time before any ceremony refusal is returned, in milliseconds. */
  refusalFloorMs: number;
  /** Source of the current time. Defaults to `Date.now`. */
  clock?: () => number;
  /** Overrides for the per-source and global rate limits. */
  rateLimits?: Partial<RateLimits>;
  /**
   * Called within the same request whenever sessions end by logout, logout
   * everywhere, logout everywhere else or suspension, so the application can
   * close live connections.
   */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
}

export interface RevocationEvent {
  reason: "logout" | "logout-everywhere" | "logout-elsewhere" | "suspension";
  recordId: RecordId;
  sessionIds: string[];
}

/** What a ceremony needs to know about the request that carries it. */
export interface RequestContext {
  startedAt: number;
  now: number;
  sourceIp: string;
  userAgent: string;
}

export type CeremonyOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

/** A refusal that is not a ceremony refusal, and may say why. */
export type PasskeyErrorCode =
  | "not-logged-in"
  | "step-up-required"
  | "not-found"
  | "last-credential"
  | "member-name-unavailable";

export class PasskeyError extends Error {
  constructor(readonly code: PasskeyErrorCode) {
    super(code);
  }
}

function isSessionCause(cause: string): cause is SessionCause {
  return cause === "not-logged-in" || cause === "step-up-required";
}

/** The name a passkey is saved under in a password manager. */
function passkeyName(memberName: string, label: string): string {
  return `${memberName} (${label})`;
}
const ANONYMOUS_CEREMONIES = new Set<Ceremony>(["register", "login", "recover", "rebind"]);

export interface CredentialListing {
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** The password manager that holds the passkey, where its AAGUID is known. */
  provider: string | null;
  backupEligible: boolean;
  backedUp: boolean;
}

export interface RevokedPasskey {
  /** The entry the password manager still shows for the revoked passkey. */
  passkeyName: string;
  /** The password manager that holds that entry, where its AAGUID is known. */
  provider: string | null;
}

export function createPasskeys(bindings: PasskeyBindings, config: PasskeyConfig) {
  const clock = config.clock ?? Date.now;
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const revoked = async (event: RevocationEvent) => {
    await config.onRevoke?.(event);
  };

  const record = (recordId: RecordId) =>
    bindings.IDENTITY_RECORDS.get(bindings.IDENTITY_RECORDS.idFromName(recordId));
  const index = () => bindings.CREDENTIAL_INDEX.get(bindings.CREDENTIAL_INDEX.idFromName("global"));
  const names = () => bindings.MEMBER_NAMES.get(bindings.MEMBER_NAMES.idFromName("global"));
  const labels = (recordId: RecordId) =>
    bindings.CREDENTIAL_LABELS.get(bindings.CREDENTIAL_LABELS.idFromName(recordId));
  // Challenges are spread over sixteen objects by the first hex digit of their hash.
  const challenges = (hash: string) =>
    bindings.CHALLENGES.get(bindings.CHALLENGES.idFromName(`challenges-${hash[0]}`));
  const failures = () => bindings.CEREMONY_FAILURES.get(bindings.CEREMONY_FAILURES.idFromName("global"));

  /** Count a hit against a rate-limit bucket; refuse the ceremony if it is full. */
  async function throttle(bucket: string, limit: Limit, now: number) {
    const limiter = bindings.RATE_LIMITS.get(bindings.RATE_LIMITS.idFromName(bucket));
    if (!(await limiter.hit(limit, now))) throw new CeremonyRefusal("rate-limited");
  }

  /** Run `run` within a per-source limit. Past the limit, the uniform refusal. */
  async function withinSourceLimit<T>(
    ctx: RequestContext,
    bucket: string,
    limit: Limit,
    run: () => Promise<T>,
  ): Promise<CeremonyOutcome<T>> {
    const sourceHash = await sha256Hex(`source:${ctx.sourceIp}`);
    try {
      await throttle(`${bucket}:${sourceHash}`, limit, ctx.now);
    } catch (error) {
      if (!(error instanceof CeremonyRefusal)) throw error;
      return { ok: false, response: await uniformRefusal(ctx.startedAt, config.refusalFloorMs) };
    }
    return { ok: true, value: await run() };
  }

  async function isMemberNameAvailable(name: string): Promise<boolean> {
    return isValidMemberName(name) && (await names().isAvailable(name));
  }

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

  /** The presented session, which must be live. */
  async function liveSession(sessionValue: string | null | undefined, now: number) {
    const parsed = await parseRecordToken(sessionValue);
    const principal = parsed ? await record(parsed.recordId).authenticate(parsed.tokenHash, now) : null;
    if (!parsed || !principal) throw new PasskeyError("not-logged-in");
    return { ...parsed, sessionId: principal.sessionId };
  }

  /** The presented session, which must be live and recently stepped up. */
  async function steppedUpSession(sessionValue: string | null | undefined, now: number) {
    const session = await liveSession(sessionValue, now);
    const check = await record(session.recordId).checkStepUp(session.tokenHash, now);
    if (!check.ok) throw new PasskeyError(check.cause);
    return session;
  }

  /** Turn a record's refusal into the right kind of error. */
  function refuse(cause: string, recordId: RecordId): never {
    if (isSessionCause(cause)) throw new PasskeyError(cause);
    throw new CeremonyRefusal(cause, recordId);
  }

  /** Verify a new passkey's registration for a known record, keeping the record on any refusal. */
  async function verifyRegistrationFor(response: RegistrationResponseJSON, challenge: string, recordId: RecordId) {
    try {
      return await verifyRegistration(response, { rp: config.rp, challenge });
    } catch (error) {
      if (error instanceof CeremonyRefusal) throw new CeremonyRefusal(error.reason, recordId);
      throw error;
    }
  }

  /**
   * Bind a ceremony's label to its credential before the record commits it,
   * so that every passkey a record holds is listed under the label its
   * password manager saved it under. Returns false if the label is taken or
   * the bind failed, and the caller refuses the ceremony. A label bound for a
   * ceremony the record then refuses names no passkey and is never reissued.
   */
  async function bindLabel(recordId: RecordId, label: string, credentialId: string, now: number) {
    try {
      return await labels(recordId).bind(label, credentialId, now);
    } catch (error) {
      console.error("passkey label bind failed; refusing the ceremony", error);
      return false;
    }
  }

  /** Mint a session: the value for the client, and the row for the record's object. */
  async function newSession(recordId: RecordId, ctx: RequestContext) {
    const minted = await mintSession(recordId);
    return { value: minted.value, row: { id: minted.id, tokenHash: minted.tokenHash, userAgent: ctx.userAgent } };
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
      ceremony: Ceremony,
      run: () => Promise<T>,
    ): Promise<CeremonyOutcome<T>> {
      const sourceHash = await sha256Hex(`source:${ctx.sourceIp}`);
      try {
        await throttle(`ceremony:${sourceHash}`, limits.ceremonyPerSource, ctx.now);
        if (ANONYMOUS_CEREMONIES.has(ceremony)) await throttle("ceremony:global", limits.ceremonyGlobal, ctx.now);
        if (ceremony === "recover") {
          await throttle(`recover:${sourceHash}`, limits.recoverPerSource, ctx.now);
          await throttle("recover:global", limits.recoverGlobal, ctx.now);
        }
        return { ok: true, value: await run() };
      } catch (error) {
        if (!(error instanceof CeremonyRefusal)) throw error;
        const failure = { ceremony, cause: error.reason, at: ctx.now, sourceHash };
        if (error.recordId) await record(error.recordId).recordFailure(failure);
        else await failures().record(failure);
        return { ok: false, response: await uniformRefusal(ctx.startedAt, config.refusalFloorMs) };
      }
    },

    /**
     * Issue options for an anonymous ceremony, within the per-source limit.
     * Past the limit, the uniform refusal.
     */
    async anonymousOptions<T>(ctx: RequestContext, issue: () => Promise<T>): Promise<CeremonyOutcome<T>> {
      return withinSourceLimit(ctx, "options", limits.optionsPerSource, issue);
    },

    /**
     * Whether a member name is free to register, within the per-source limit.
     * Past the limit, the uniform refusal.
     */
    async checkMemberName(ctx: RequestContext, name: string): Promise<CeremonyOutcome<boolean>> {
      return withinSourceLimit(ctx, "name-check", limits.nameCheckPerSource, () => isMemberNameAvailable(name));
    },

    async memberName(recordId: RecordId): Promise<string | null> {
      return names().nameOf(recordId);
    },

    async registrationOptions(ctx: RequestContext, typedName: string) {
      if (!(await isMemberNameAvailable(typedName))) throw new PasskeyError("member-name-unavailable");
      const memberName = typedName.normalize("NFC");
      const label = randomLabel();
      const challenge = await issueChallenge("register", { memberName, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: passkeyName(memberName, label) });
    },

    /** Complete registration: a new record, its first credential, recovery codes (with when they were issued) and a session. */
    async register(ctx: RequestContext, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{ memberName: string; label: string }>(
        "register",
        response,
        ctx.now,
      );
      const credential = await verifyRegistration(response, { rp: config.rp, challenge });
      const recordId = newRecordId();
      if (!(await names().claim(payload.memberName, recordId, ctx.now))) {
        throw new CeremonyRefusal("member-name-taken");
      }
      if (!(await index().put(credential.id, recordId))) {
        await names().release(payload.memberName, recordId, ctx.now);
        throw new CeremonyRefusal("credential-exists");
      }
      if (!(await bindLabel(recordId, payload.label, credential.id, ctx.now))) {
        await index().delete(credential.id);
        await names().release(payload.memberName, recordId, ctx.now);
        throw new CeremonyRefusal("label-unbound");
      }
      const session = await newSession(recordId, ctx);
      const recovery = await mintRecoveryCodes();
      const created = await record(recordId).createPerson({
        recordId,
        credential,
        recoveryCodeHashes: recovery.hashes,
        session: session.row,
        now: ctx.now,
      });
      if (!created.ok) {
        await index().delete(credential.id);
        await names().release(payload.memberName, recordId, ctx.now);
        throw new CeremonyRefusal(created.cause);
      }
      return { recordId, session: session.value, recoveryCodes: recovery.codes, issuedAt: ctx.now };
    },

    async loginOptions(ctx: RequestContext) {
      const challenge = await issueChallenge("login", {}, ctx.now);
      return requestOptions({ rp: config.rp, challenge });
    },

    /** Complete a login with any of the site's passkeys, minting a session. */
    async login(ctx: RequestContext, response: AuthenticationResponseJSON) {
      const { challenge } = await consumeChallenge("login", response, ctx.now);
      const assertion = await verifyKnownAssertion(response, challenge);
      const session = await newSession(assertion.recordId, ctx);
      const done = await record(assertion.recordId).completeLogin({
        credentialId: assertion.credentialId,
        signCount: assertion.signCount,
        flags: assertion.flags,
        session: session.row,
        now: ctx.now,
      });
      if (!done.ok) throw new CeremonyRefusal(done.cause, assertion.recordId);
      return { recordId: assertion.recordId, session: session.value };
    },

    /** End the presented session. */
    async logout(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return;
      const sessionId = await record(parsed.recordId).revokeSession(parsed.tokenHash);
      if (sessionId) await revoked({ reason: "logout", recordId: parsed.recordId, sessionIds: [sessionId] });
    },

    /** End every session of the presented session's record. Returns false if it was not live. */
    async logoutEverywhere(sessionValue: string | null | undefined): Promise<boolean> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return false;
      const sessionIds = await record(parsed.recordId).revokeAllSessions(parsed.tokenHash, clock());
      if (!sessionIds) return false;
      await revoked({ reason: "logout-everywhere", recordId: parsed.recordId, sessionIds });
      return true;
    },

    /**
     * End every session of the presented session's record but that one. Needs
     * a fresh step-up, so a stolen session cannot shut the owner out.
     */
    async logoutElsewhere(sessionValue: string | null | undefined): Promise<void> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) throw new PasskeyError("not-logged-in");
      const done = await record(parsed.recordId).revokeOtherSessions(parsed.tokenHash, clock());
      if (!done.ok) throw new PasskeyError(done.cause);
      if (done.sessionIds.length > 0) {
        await revoked({ reason: "logout-elsewhere", recordId: parsed.recordId, sessionIds: done.sessionIds });
      }
    },

    async sessions(sessionValue: string | null | undefined): Promise<SessionSummary[] | null> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return null;
      return record(parsed.recordId).listSessions(parsed.tokenHash, clock());
    },

    async stepUpOptions(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await liveSession(sessionValue, ctx.now);
      const ids = await record(session.recordId).credentialIds(session.tokenHash, ctx.now);
      if (!ids) throw new PasskeyError("not-logged-in");
      const challenge = await issueChallenge(
        "step-up",
        { recordId: session.recordId, sessionId: session.sessionId },
        ctx.now,
      );
      return requestOptions({ rp: config.rp, challenge, allowCredentialIds: ids });
    },

    /** Prove control of one of the record's passkeys again, on this session. */
    async stepUp(ctx: RequestContext, sessionValue: string | null | undefined, response: AuthenticationResponseJSON) {
      const session = await liveSession(sessionValue, ctx.now);
      const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; sessionId: string }>(
        "step-up",
        response,
        ctx.now,
      );
      if (payload.recordId !== session.recordId) throw new CeremonyRefusal("wrong-session", session.recordId);
      const assertion = await verifyKnownAssertion(response, challenge);
      if (assertion.recordId !== session.recordId) throw new CeremonyRefusal("wrong-record", session.recordId);
      const done = await record(session.recordId).completeStepUp({
        tokenHash: session.tokenHash,
        sessionId: payload.sessionId,
        credentialId: assertion.credentialId,
        signCount: assertion.signCount,
        flags: assertion.flags,
        now: ctx.now,
      });
      if (!done.ok) refuse(done.cause, session.recordId);
    },

    async enrolOptions(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      const [label, memberName, ids] = await Promise.all([
        labels(session.recordId).mint(ctx.now),
        names().nameOf(session.recordId),
        record(session.recordId).credentialIds(session.tokenHash, ctx.now),
      ]);
      const challenge = await issueChallenge(
        "enrol",
        { recordId: session.recordId, sessionId: session.sessionId, label },
        ctx.now,
      );
      return creationOptions({
        rp: config.rp,
        challenge,
        userName: passkeyName(memberName ?? session.recordId, label),
        excludeCredentialIds: ids ?? [],
      });
    },

    /** Add a passkey to the stepped-up session's record. Returns its label. */
    async enrol(ctx: RequestContext, sessionValue: string | null | undefined, response: RegistrationResponseJSON) {
      const session = await liveSession(sessionValue, ctx.now);
      const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; sessionId: string; label: string }>(
        "enrol",
        response,
        ctx.now,
      );
      if (payload.recordId !== session.recordId) throw new CeremonyRefusal("wrong-session", session.recordId);
      const credential = await verifyRegistrationFor(response, challenge, session.recordId);
      if (!(await index().put(credential.id, session.recordId))) {
        throw new CeremonyRefusal("credential-exists", session.recordId);
      }
      if (!(await bindLabel(session.recordId, payload.label, credential.id, ctx.now))) {
        await index().delete(credential.id);
        throw new CeremonyRefusal("label-unbound", session.recordId);
      }
      const added = await record(session.recordId).addCredential({
        tokenHash: session.tokenHash,
        sessionId: payload.sessionId,
        credential,
        now: ctx.now,
      });
      if (!added.ok) {
        await index().delete(credential.id);
        refuse(added.cause, session.recordId);
      }
      return { label: payload.label };
    },

    /** The record's passkeys. One with no label is given one here. */
    async credentials(ctx: RequestContext, sessionValue: string | null | undefined): Promise<CredentialListing[]> {
      const session = await liveSession(sessionValue, ctx.now);
      const rows = await record(session.recordId).listCredentials(session.tokenHash, ctx.now);
      if (!rows) throw new PasskeyError("not-logged-in");
      const byCredential = await labels(session.recordId).labelEach(
        rows.map((row) => row.id),
        ctx.now,
      );
      return rows.map((row) => ({
        label: byCredential[row.id]!,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        provider: providerName(row.aaguid),
        backupEligible: row.backupEligible,
        backedUp: row.backedUp,
      }));
    },

    /**
     * Revoke the passkey with this label, typed in any form `parseLabel`
     * reads. The last passkey cannot be revoked. Returns the dead entry as
     * the password manager shows it, and that password manager where its
     * AAGUID is known.
     */
    async revokeCredential(
      ctx: RequestContext,
      sessionValue: string | null | undefined,
      typed: string,
    ): Promise<RevokedPasskey> {
      const label = typeof typed === "string" ? parseLabel(typed) : null;
      const session = await steppedUpSession(sessionValue, ctx.now);
      const credentialId = label === null ? null : await labels(session.recordId).resolve(label);
      if (label === null || !credentialId) throw new PasskeyError("not-found");
      const memberName = await names().nameOf(session.recordId);
      const done = await record(session.recordId).revokeCredential({
        tokenHash: session.tokenHash,
        credentialId,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause);
      await index().delete(credentialId);
      await labels(session.recordId).retire(label, ctx.now);
      return {
        passkeyName: passkeyName(memberName ?? session.recordId, label),
        provider: providerName(done.aaguid),
      };
    },

    /** Replace every recovery code. Returns the new codes, shown once, and when they were issued. */
    async rotateRecoveryCodes(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      const recovery = await mintRecoveryCodes();
      const done = await record(session.recordId).rotateRecoveryCodes({
        tokenHash: session.tokenHash,
        codeHashes: recovery.hashes,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause);
      return { recoveryCodes: recovery.codes, issuedAt: ctx.now };
    },

    /**
     * Options for recovering onto a new passkey. An unknown member name still
     * gets options, so that it is refused only at the end, like any other refusal.
     * Nobody has authenticated yet, so the label is drawn unchecked and stores
     * nothing, as at registration.
     */
    async recoverOptions(ctx: RequestContext, memberName: string) {
      if (!isValidMemberName(memberName)) throw new PasskeyError("not-found");
      const recordId = await names().resolve(memberName);
      const label = randomLabel();
      const shownName = recordId ? await names().nameOf(recordId) : memberName.normalize("NFC");
      const challenge = await issueChallenge("recover", { memberName, recordId, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: passkeyName(shownName ?? memberName, label) });
    },

    /**
     * Recover with a member name, a recovery code and a new passkey, in one
     * request. Returns how many unused recovery codes the record has left.
     */
    async recover(ctx: RequestContext, memberName: string, code: string, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{
        memberName: string;
        recordId: RecordId | null;
        label: string;
      }>("recover", response, ctx.now);
      if (typeof memberName !== "string" || memberNameKey(memberName) !== memberNameKey(payload.memberName)) {
        throw new CeremonyRefusal("wrong-member-name");
      }
      const recordId = await names().resolve(memberName);
      if (!recordId || recordId !== payload.recordId) throw new CeremonyRefusal("unknown-member-name");
      if (typeof code !== "string") throw new CeremonyRefusal("wrong-recovery-code", recordId);
      const credential = await verifyRegistrationFor(response, challenge, recordId);
      if (!(await index().put(credential.id, recordId))) throw new CeremonyRefusal("credential-exists", recordId);
      if (!(await bindLabel(recordId, payload.label, credential.id, ctx.now))) {
        await index().delete(credential.id);
        throw new CeremonyRefusal("label-unbound", recordId);
      }
      const session = await newSession(recordId, ctx);
      const done = await record(recordId).recover({
        codeHash: await hashRecoveryCode(code),
        credential,
        session: session.row,
        now: ctx.now,
      });
      if (!done.ok) {
        await index().delete(credential.id);
        throw new CeremonyRefusal(done.cause, recordId);
      }
      return { recordId, session: session.value, codesLeft: done.codesLeft };
    },

    /** The presented session, if it is live and stepped up within the window; otherwise a PasskeyError. */
    async requireStepUp(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      return { recordId: session.recordId, sessionId: session.sessionId };
    },

    async resolveMemberName(memberName: string): Promise<RecordId | null> {
      return isValidMemberName(memberName) ? names().resolve(memberName) : null;
    },

    /**
     * Create a single-use, expiring rebind link value for a record. Who may do
     * this is the application's decision.
     */
    async createRebindLink(ctx: RequestContext, recordId: RecordId): Promise<string> {
      const token = await mintRebindToken(recordId);
      const done = await record(recordId).createRebindToken(token.tokenHash, ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      return token.value;
    },

    async rebindOptions(ctx: RequestContext, link: string) {
      const parsed = await parseRecordToken(typeof link === "string" ? link : "");
      const live = parsed ? await record(parsed.recordId).checkRebindToken(parsed.tokenHash, ctx.now) : false;
      const memberName = parsed && live ? await names().nameOf(parsed.recordId) : null;
      if (!parsed || !memberName) throw new PasskeyError("not-found");
      const label = await labels(parsed.recordId).mint(ctx.now);
      const challenge = await issueChallenge("rebind", { recordId: parsed.recordId, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: passkeyName(memberName, label) });
    },

    /** Redeem a rebind link with a new passkey, minting a session. */
    async rebind(ctx: RequestContext, link: string, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{ recordId: RecordId; label: string }>(
        "rebind",
        response,
        ctx.now,
      );
      const parsed = await parseRecordToken(typeof link === "string" ? link : "");
      if (!parsed || parsed.recordId !== payload.recordId) throw new CeremonyRefusal("bad-rebind-link");
      const recordId = parsed.recordId;
      const credential = await verifyRegistrationFor(response, challenge, recordId);
      if (!(await index().put(credential.id, recordId))) throw new CeremonyRefusal("credential-exists", recordId);
      if (!(await bindLabel(recordId, payload.label, credential.id, ctx.now))) {
        await index().delete(credential.id);
        throw new CeremonyRefusal("label-unbound", recordId);
      }
      const session = await newSession(recordId, ctx);
      const done = await record(recordId).rebind({
        tokenHash: parsed.tokenHash,
        credential,
        session: session.row,
        now: ctx.now,
      });
      if (!done.ok) {
        await index().delete(credential.id);
        throw new CeremonyRefusal(done.cause, recordId);
      }
      return { recordId, session: session.value };
    },

    /** Suspend a principal: its sessions end now and its logins are refused. */
    async suspend(ctx: RequestContext, recordId: RecordId): Promise<void> {
      const done = await record(recordId).suspend(ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      await revoked({ reason: "suspension", recordId, sessionIds: done.sessionIds });
    },

    async resume(recordId: RecordId): Promise<void> {
      const done = await record(recordId).resume();
      if (!done.ok) throw new PasskeyError("not-found");
    },

    /** The principal a session value proves, checked against its record on every call. */
    async authenticate(sessionValue: string | null | undefined): Promise<Principal | null> {
      const parsed = await parseRecordToken(sessionValue);
      if (!parsed) return null;
      return record(parsed.recordId).authenticate(parsed.tokenHash, clock());
    },
  };
}

export type Passkeys = ReturnType<typeof createPasskeys>;
