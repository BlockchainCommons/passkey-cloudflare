import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { ChallengeStore } from "./app-tier/challenges.ts";
import { providerName } from "./app-tier/aaguid-names.ts";
import { randomLabel, type CredentialLabels } from "./app-tier/labels.ts";
import { isValidMemberName, memberNameKey, type MemberNameRegistry } from "./app-tier/member-names.ts";
import { sha256Hex, toBase64Url } from "./encoding.ts";
import type { CredentialIndex } from "./identity/credential-index.ts";
import type { IdentityRecord, Principal, SessionSummary } from "./identity/record.ts";
import {
  hashRecoveryCode,
  mintRebindToken,
  mintRecoveryCodes,
  mintSession,
  parseRecordToken,
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
}

export interface PasskeyConfig {
  rp: RelyingParty;
  /** Minimum time before any ceremony refusal is returned, in milliseconds. */
  refusalFloorMs: number;
  /** Source of the current time. Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Called within the same request whenever sessions end by logout, logout
   * everywhere or suspension, so the application can close live connections.
   */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
}

export interface RevocationEvent {
  reason: "logout" | "logout-everywhere" | "suspension";
  recordId: string;
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

const SESSION_CAUSES = new Set<string>(["not-logged-in", "step-up-required"]);

export interface CredentialListing {
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** The password manager that holds the passkey, where its AAGUID is known. */
  provider: string | null;
  backupEligible: boolean;
  backedUp: boolean;
}

export function createPasskeys(bindings: PasskeyBindings, config: PasskeyConfig) {
  const clock = config.clock ?? Date.now;
  const revoked = async (event: RevocationEvent) => {
    if (event.sessionIds.length > 0) await config.onRevoke?.(event);
  };

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
    if (!check.ok) throw new PasskeyError(check.cause as PasskeyErrorCode);
    return session;
  }

  /** Turn a record's refusal into the right kind of error. */
  function refuse(cause: string, recordId: string): never {
    if (SESSION_CAUSES.has(cause)) throw new PasskeyError(cause as PasskeyErrorCode);
    throw new CeremonyRefusal(cause, recordId);
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
      if (!(await this.isMemberNameAvailable(memberName))) throw new PasskeyError("member-name-unavailable");
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
      const { challenge, payload } = await consumeChallenge<{ recordId: string; sessionId: string }>(
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
        userName: `${memberName} (${label})`,
        excludeCredentialIds: ids ?? [],
      });
    },

    /** Add a passkey to the stepped-up session's record. */
    async enrol(ctx: RequestContext, sessionValue: string | null | undefined, response: RegistrationResponseJSON) {
      const session = await liveSession(sessionValue, ctx.now);
      const { challenge, payload } = await consumeChallenge<{ recordId: string; sessionId: string; label: string }>(
        "enrol",
        response,
        ctx.now,
      );
      if (payload.recordId !== session.recordId) throw new CeremonyRefusal("wrong-session", session.recordId);
      const credential = await verifyRegistration(response, { rp: config.rp, challenge });
      if (!(await index().put(credential.id, session.recordId))) {
        throw new CeremonyRefusal("credential-exists", session.recordId);
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
      await labels(session.recordId).bind(payload.label, credential.id, ctx.now);
      return { label: payload.label };
    },

    async credentials(ctx: RequestContext, sessionValue: string | null | undefined): Promise<CredentialListing[]> {
      const session = await liveSession(sessionValue, ctx.now);
      const [rows, byCredential] = await Promise.all([
        record(session.recordId).listCredentials(session.tokenHash, ctx.now),
        labels(session.recordId).active(),
      ]);
      if (!rows) throw new PasskeyError("not-logged-in");
      return rows.map((row) => ({
        label: byCredential[row.id] ?? null,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        provider: providerName(row.aaguid),
        backupEligible: row.backupEligible,
        backedUp: row.backedUp,
      }));
    },

    /** Revoke the passkey with this label. The last passkey cannot be revoked. */
    async revokeCredential(ctx: RequestContext, sessionValue: string | null | undefined, label: string) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      const credentialId = typeof label === "string" ? await labels(session.recordId).resolve(label) : null;
      if (!credentialId) throw new PasskeyError("not-found");
      const done = await record(session.recordId).revokeCredential({
        tokenHash: session.tokenHash,
        credentialId,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause as PasskeyErrorCode);
      await index().delete(credentialId);
      await labels(session.recordId).retire(label, ctx.now);
    },

    /** Replace every recovery code. Returns the new codes, shown once. */
    async rotateRecoveryCodes(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      const recovery = await mintRecoveryCodes();
      const done = await record(session.recordId).rotateRecoveryCodes({
        tokenHash: session.tokenHash,
        codeHashes: recovery.hashes,
        now: ctx.now,
      });
      if (!done.ok) throw new PasskeyError(done.cause as PasskeyErrorCode);
      return recovery.codes;
    },

    /**
     * Options for recovering onto a new passkey. An unknown member name still
     * gets options, so that it is refused only at the end, like any other refusal.
     */
    async recoverOptions(ctx: RequestContext, memberName: string) {
      if (!isValidMemberName(memberName)) throw new PasskeyError("not-found");
      const recordId = await names().resolve(memberName);
      const [label, shownName] = recordId
        ? await Promise.all([labels(recordId).mint(ctx.now), names().nameOf(recordId)])
        : [randomLabel(), memberName];
      const challenge = await issueChallenge("recover", { memberName, recordId, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: `${shownName} (${label})` });
    },

    /** Recover with a member name, a recovery code and a new passkey, in one request. */
    async recover(ctx: RequestContext, memberName: string, code: string, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{
        memberName: string;
        recordId: string | null;
        label: string;
      }>("recover", response, ctx.now);
      if (typeof memberName !== "string" || memberNameKey(memberName) !== memberNameKey(payload.memberName)) {
        throw new CeremonyRefusal("wrong-member-name");
      }
      const recordId = await names().resolve(memberName);
      if (!recordId || recordId !== payload.recordId) throw new CeremonyRefusal("unknown-member-name");
      if (typeof code !== "string") throw new CeremonyRefusal("wrong-recovery-code", recordId);
      let credential;
      try {
        credential = await verifyRegistration(response, { rp: config.rp, challenge });
      } catch (error) {
        if (error instanceof CeremonyRefusal) throw new CeremonyRefusal(error.reason, recordId);
        throw error;
      }
      if (!(await index().put(credential.id, recordId))) throw new CeremonyRefusal("credential-exists", recordId);
      const session = await mintSession(recordId);
      const done = await record(recordId).recover({
        codeHash: await hashRecoveryCode(code),
        credential,
        session: { id: session.id, tokenHash: session.tokenHash, userAgent: ctx.userAgent },
        now: ctx.now,
      });
      if (!done.ok) {
        await index().delete(credential.id);
        throw new CeremonyRefusal(done.cause, recordId);
      }
      await labels(recordId).bind(payload.label, credential.id, ctx.now);
      return { recordId, session: session.value };
    },

    /** The presented session, if it is live and stepped up within the window; otherwise a PasskeyError. */
    async requireStepUp(ctx: RequestContext, sessionValue: string | null | undefined) {
      const session = await steppedUpSession(sessionValue, ctx.now);
      return { recordId: session.recordId, sessionId: session.sessionId };
    },

    async resolveMemberName(memberName: string): Promise<string | null> {
      return isValidMemberName(memberName) ? names().resolve(memberName) : null;
    },

    /**
     * Create a single-use, expiring rebind link value for a record. Who may do
     * this is the application's decision.
     */
    async createRebindLink(ctx: RequestContext, recordId: string): Promise<string> {
      const token = await mintRebindToken(recordId);
      const done = await record(recordId).createRebindToken(token.tokenHash, ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      return token.value;
    },

    async rebindOptions(ctx: RequestContext, link: string) {
      const parsed = await parseRecordToken(typeof link === "string" ? link : "");
      const memberName = parsed ? await names().nameOf(parsed.recordId) : null;
      if (!parsed || !memberName) throw new PasskeyError("not-found");
      const label = await labels(parsed.recordId).mint(ctx.now);
      const challenge = await issueChallenge("rebind", { recordId: parsed.recordId, label }, ctx.now);
      return creationOptions({ rp: config.rp, challenge, userName: `${memberName} (${label})` });
    },

    /** Redeem a rebind link with a new passkey, minting a session. */
    async rebind(ctx: RequestContext, link: string, response: RegistrationResponseJSON) {
      const { challenge, payload } = await consumeChallenge<{ recordId: string; label: string }>(
        "rebind",
        response,
        ctx.now,
      );
      const parsed = await parseRecordToken(typeof link === "string" ? link : "");
      if (!parsed || parsed.recordId !== payload.recordId) throw new CeremonyRefusal("bad-rebind-link");
      const recordId = parsed.recordId;
      let credential;
      try {
        credential = await verifyRegistration(response, { rp: config.rp, challenge });
      } catch (error) {
        if (error instanceof CeremonyRefusal) throw new CeremonyRefusal(error.reason, recordId);
        throw error;
      }
      if (!(await index().put(credential.id, recordId))) throw new CeremonyRefusal("credential-exists", recordId);
      const session = await mintSession(recordId);
      const done = await record(recordId).rebind({
        tokenHash: parsed.tokenHash,
        credential,
        session: { id: session.id, tokenHash: session.tokenHash, userAgent: ctx.userAgent },
        now: ctx.now,
      });
      if (!done.ok) {
        await index().delete(credential.id);
        throw new CeremonyRefusal(done.cause, recordId);
      }
      await labels(recordId).bind(payload.label, credential.id, ctx.now);
      return { recordId, session: session.value };
    },

    /** Suspend a principal: its sessions end now and its logins are refused. */
    async suspend(ctx: RequestContext, recordId: string): Promise<void> {
      const done = await record(recordId).suspend(ctx.now);
      if (!done.ok) throw new PasskeyError("not-found");
      await revoked({ reason: "suspension", recordId, sessionIds: done.sessionIds });
    },

    async resume(_ctx: RequestContext, recordId: string): Promise<void> {
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
