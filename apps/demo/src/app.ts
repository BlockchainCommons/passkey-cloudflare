import {
  clearedSessionCookie,
  createPasskeys,
  isRecordId,
  PasskeyError,
  sessionCookie,
  sessionValueFrom,
  type CeremonyOutcome,
  type PasskeyErrorCode,
  type Passkeys,
  type Principal,
  type RateLimits,
  type RecordId,
  type RequestContext,
  type RevocationEvent,
} from "passkey-cloudflare";
import { seedWords } from "passkey-cloudflare/gordian";
import { operatorLog, type OperatorLog } from "./operator-log.ts";

export interface AppOptions {
  /** Source of the current time, for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Overrides for the library's rate limits. */
  rateLimits?: Partial<RateLimits>;
  /** Called when sessions end. The demo has no live connections yet, so by default it does nothing. */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
  /**
   * The storage prefix the app and the library address their Durable Objects
   * under, for tests. Absent in production; never read from a var or secret.
   */
  storagePrefix?: string;
}

interface Call {
  request: Request;
  env: Env;
  passkeys: Passkeys;
  ctx: RequestContext;
  body: any;
  /** The operator log, under the app's storage prefix. */
  log: () => DurableObjectStub<OperatorLog>;
}

type Handler = (call: Call) => Promise<Response>;
type AuthedHandler = (call: Call, principal: Principal) => Promise<Response>;

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

/** Fresh recovery codes, when they were issued, and each one's word form, which the page offers for reading aloud. */
function withWords({ recoveryCodes, issuedAt }: { recoveryCodes: string[]; issuedAt: number }) {
  return { recoveryCodes, recoveryCodeWords: recoveryCodes.map(seedWords), issuedAt };
}

function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

const STATUS: Record<PasskeyErrorCode, number> = {
  "not-logged-in": 401,
  "step-up-required": 403,
  "not-found": 404,
  "last-credential": 409,
  "member-name-unavailable": 409,
};

function operatorIds(env: Env): Set<string> {
  return new Set(
    (env.OPERATOR_RECORD_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** A handler for an operator who has stepped up. The operator role is this app's, not the library's. */
function operator(handler: (call: Call, operatorId: RecordId) => Promise<Response>): Handler {
  return async (call) => {
    const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
    if (!principal) return error(401, "not logged in");
    if (!operatorIds(call.env).has(principal.recordId)) return error(403, "not an operator");
    await call.passkeys.requireStepUp(call.ctx, sessionValueFrom(call.request));
    return handler(call, principal.recordId);
  };
}

/** The record an operator action targets, named by record id or by member name. */
async function targetRecordId(call: Call): Promise<RecordId | null> {
  if (call.body.recordId !== undefined) return isRecordId(call.body.recordId) ? call.body.recordId : null;
  return call.passkeys.resolveMemberName(call.body.memberName);
}

/** What an operator sees of a member: the record's state and counts, and the operator log entries that target it. */
async function memberView(call: Call, recordId: RecordId) {
  return {
    recordId,
    summary: await call.passkeys.recordSummary(recordId),
    entries: await call.log().listFor(recordId),
  };
}

/** When an action named its target by record id, as the operator pane does, the member as it now stands; otherwise nothing. */
async function memberIfNamedById(call: Call, recordId: RecordId) {
  return call.body.recordId === undefined ? {} : { member: await memberView(call, recordId) };
}

function optionsResponse(outcome: CeremonyOutcome<unknown>): Response {
  return outcome.ok ? json(outcome.value) : outcome.response;
}

function authed(handler: AuthedHandler): Handler {
  return async (call) => {
    const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
    if (!principal) return error(401, "not logged in");
    return handler(call, principal);
  };
}

const POST: Record<string, Handler> = {
  "/auth/register/options": async ({ passkeys, ctx, body }) =>
    optionsResponse(await passkeys.registrationOptions(ctx, body.memberName)),

  "/auth/register/verify": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.register(ctx, body.response);
    if (!outcome.ok) return outcome.response;
    const { recordId, session, ...codes } = outcome.value;
    return json({ recordId, ...withWords(codes) }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/login/options": async ({ passkeys, ctx }) => optionsResponse(await passkeys.loginOptions(ctx)),

  "/auth/login/verify": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.login(ctx, body.response);
    if (!outcome.ok) return outcome.response;
    const { recordId, session } = outcome.value;
    return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/logout": async ({ passkeys, request }) => {
    await passkeys.logout(sessionValueFrom(request));
    return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
  },

  "/auth/logout-everywhere": async ({ passkeys, request }) => {
    await passkeys.logoutEverywhere(sessionValueFrom(request));
    return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
  },

  "/auth/logout-elsewhere": async ({ passkeys, request }) => {
    await passkeys.logoutElsewhere(sessionValueFrom(request));
    return json({ ok: true });
  },

  "/auth/recover/options": async ({ passkeys, ctx, body }) =>
    optionsResponse(await passkeys.recoverOptions(ctx, body.memberName)),

  "/auth/recover": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.recover(ctx, body.memberName, body.code, body.response);
    if (!outcome.ok) return outcome.response;
    const { recordId, session, codesLeft } = outcome.value;
    return json({ recordId, codesLeft }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/rebind/options": async ({ passkeys, ctx, body }) =>
    optionsResponse(await passkeys.rebindOptions(ctx, body.link)),

  "/auth/rebind/verify": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.rebind(ctx, body.link, body.response);
    if (!outcome.ok) return outcome.response;
    const { recordId, session } = outcome.value;
    return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/operator/lookup": operator(async (call, operatorId) => {
    const targetId = await call.passkeys.resolveMemberName(call.body.memberName);
    if (!targetId) return error(404, "no such member");
    const member = await memberView(call, targetId);
    const retired = await call.passkeys.isRetiredMemberName(call.body.memberName);
    await call.log().append({ operatorId, action: "lookup", targetId, at: call.ctx.now });
    return json({ ...member, retired });
  }),

  "/operator/rebind-links": operator(async (call, operatorId) => {
    const targetId = await targetRecordId(call);
    if (!targetId) return error(404, "not found");
    const link = await call.passkeys.createRebindLink(call.ctx, targetId);
    await call.log().append({ operatorId, action: "create-rebind-link", targetId, at: call.ctx.now });
    return json({ link: `${call.env.ORIGIN}/rebind#${link}`, ...(await memberIfNamedById(call, targetId)) });
  }),

  "/operator/suspend": operator(async (call, operatorId) => {
    const targetId = await targetRecordId(call);
    if (!targetId) return error(404, "not found");
    await call.passkeys.suspend(call.ctx, targetId);
    await call.log().append({ operatorId, action: "suspend", targetId, at: call.ctx.now });
    return json({ ok: true, ...(await memberIfNamedById(call, targetId)) });
  }),

  "/operator/resume": operator(async (call, operatorId) => {
    const targetId = await targetRecordId(call);
    if (!targetId) return error(404, "not found");
    await call.passkeys.resume(targetId);
    await call.log().append({ operatorId, action: "resume", targetId, at: call.ctx.now });
    return json({ ok: true, ...(await memberIfNamedById(call, targetId)) });
  }),

  "/operator/remove": operator(async (call, operatorId) => {
    const targetId = await targetRecordId(call);
    if (!targetId) return error(404, "not found");
    // An operator is taken off OPERATOR_RECORD_IDS before they can be removed.
    if (operatorIds(call.env).has(targetId)) return error(409, "operator record");
    await call.passkeys.remove(call.ctx, targetId);
    await call.log().append({ operatorId, action: "remove", targetId, at: call.ctx.now });
    return json({ ok: true, ...(await memberIfNamedById(call, targetId)) });
  }),

  "/operator/allow-name": operator(async (call, operatorId) => {
    if (!(await call.passkeys.resolveMemberName(call.body.memberName))) return error(404, "not found");
    const targetId = await call.passkeys.allowRetiredMemberName(call.body.memberName);
    if (!targetId) return error(409, "name not retired");
    await call.log().append({ operatorId, action: "allow-name", targetId, at: call.ctx.now });
    return json({ ok: true, member: { ...(await memberView(call, targetId)), retired: false } });
  }),

  "/auth/step-up/options": async ({ passkeys, ctx, request }) =>
    json(await passkeys.stepUpOptions(ctx, sessionValueFrom(request))),

  "/auth/step-up/verify": async ({ passkeys, ctx, request, body }) => {
    const outcome = await passkeys.stepUp(ctx, sessionValueFrom(request), body.response);
    return outcome.ok ? json({ ok: true }) : outcome.response;
  },

  "/me/credentials/enrol/options": async ({ passkeys, ctx, request }) =>
    json(await passkeys.enrolOptions(ctx, sessionValueFrom(request))),

  "/me/credentials/enrol/verify": async ({ passkeys, ctx, request, body }) => {
    const outcome = await passkeys.enrol(ctx, sessionValueFrom(request), body.response);
    return outcome.ok ? json(outcome.value) : outcome.response;
  },

  "/me/credentials/revoke": async ({ passkeys, ctx, request, body }) => {
    const revoked = await passkeys.revokeCredential(ctx, sessionValueFrom(request), body.label);
    return json({ ok: true, ...revoked });
  },

  "/me/recovery-codes/rotate": async ({ passkeys, ctx, request }) =>
    json(withWords(await passkeys.rotateRecoveryCodes(ctx, sessionValueFrom(request)))),
};

const GET: Record<string, Handler> = {
  "/auth/member-name": async ({ passkeys, ctx, request }) => {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const outcome = await passkeys.checkMemberName(ctx, name);
    return outcome.ok ? json({ available: outcome.value }) : outcome.response;
  },

  "/me": authed(async ({ passkeys, env }, principal) =>
    json({
      recordId: principal.recordId,
      memberName: await passkeys.memberName(principal.recordId),
      operator: operatorIds(env).has(principal.recordId),
    }),
  ),

  "/me/credentials": async ({ passkeys, ctx, request }) =>
    json({ credentials: await passkeys.credentials(ctx, sessionValueFrom(request)) }),

  "/operator/log": operator(async ({ log }) => json({ entries: await log().list() })),

  "/me/sessions": async ({ passkeys, request }) =>
    json({ sessions: await passkeys.sessions(sessionValueFrom(request)) }),
};

/** The paths the app answers a POST on, each a state-changing route. */
export const POST_ROUTES: readonly string[] = Object.keys(POST);

/** The paths the app answers a GET or HEAD on, each a read route. */
export const GET_ROUTES: readonly string[] = Object.keys(GET);

export function createApp(options: AppOptions = {}) {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const passkeys = createPasskeys(env, {
        rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
        refusalFloorMs: Number(env.REFUSAL_FLOOR_MS),
        clock: options.clock,
        onRevoke: options.onRevoke,
        rateLimits: options.rateLimits,
        storagePrefix: options.storagePrefix,
      });
      const ctx = passkeys.context(request);
      try {
        return await route(request, env, passkeys, ctx, operatorLog(env.OPERATOR_LOG, options.storagePrefix));
      } catch (e) {
        if (e instanceof PasskeyError) return error(STATUS[e.code], e.code);
        throw e;
      }
    },
  };
}

async function route(
  request: Request,
  env: Env,
  passkeys: Passkeys,
  ctx: RequestContext,
  log: Call["log"],
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST") {
    const handler = POST[url.pathname];
    if (!handler) return error(404, "not found");
    if (request.headers.get("Origin") !== env.ORIGIN) return error(403, "origin not allowed");
    let body: any;
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return error(400, "malformed JSON");
    }
    if (typeof body !== "object" || body === null) return error(400, "malformed JSON");
    return handler({ request, env, passkeys, ctx, body, log });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const handler = GET[url.pathname];
    if (!handler) return error(404, "not found");
    return handler({ request, env, passkeys, ctx, body: {}, log });
  }
  return error(405, "method not allowed");
}
