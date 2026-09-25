import {
  clearedSessionCookie,
  createPasskeys,
  PasskeyError,
  sessionCookie,
  sessionValueFrom,
  type PasskeyErrorCode,
  type Passkeys,
  type Principal,
  type RequestContext,
  type RevocationEvent,
} from "passkey-cloudflare";

export interface AppOptions {
  /** Source of the current time, for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Called when sessions end. The demo has no live connections yet, so by default it does nothing. */
  onRevoke?: (event: RevocationEvent) => void | Promise<void>;
}

interface Call {
  request: Request;
  env: Env;
  passkeys: Passkeys;
  ctx: RequestContext;
  body: any;
}

type Handler = (call: Call) => Promise<Response>;
type AuthedHandler = (call: Call, principal: Principal) => Promise<Response>;

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
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

function authed(handler: AuthedHandler): Handler {
  return async (call) => {
    const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
    if (!principal) return error(401, "not logged in");
    return handler(call, principal);
  };
}

const POST: Record<string, Handler> = {
  "/auth/register/options": async ({ passkeys, ctx, body }) =>
    json(await passkeys.registrationOptions(ctx, body.memberName)),

  "/auth/register/verify": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.ceremony(ctx, "register", () => passkeys.register(ctx, body.response));
    if (!outcome.ok) return outcome.response;
    const { recordId, session, recoveryCodes } = outcome.value;
    return json({ recordId, recoveryCodes }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/login/options": async ({ passkeys, ctx }) => json(await passkeys.loginOptions(ctx)),

  "/auth/login/verify": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.ceremony(ctx, "login", () => passkeys.login(ctx, body.response));
    if (!outcome.ok) return outcome.response;
    const { recordId, session } = outcome.value;
    return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/logout": async ({ passkeys, request }) => {
    await passkeys.logout(sessionValueFrom(request));
    return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
  },

  "/auth/logout-everywhere": async ({ passkeys, request }) => {
    if (!(await passkeys.logoutEverywhere(sessionValueFrom(request)))) return error(401, "not logged in");
    return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
  },

  "/auth/recover/options": async ({ passkeys, ctx, body }) =>
    json(await passkeys.recoverOptions(ctx, body.memberName)),

  "/auth/recover": async ({ passkeys, ctx, body }) => {
    const outcome = await passkeys.ceremony(ctx, "recover", () =>
      passkeys.recover(ctx, body.memberName, body.code, body.response),
    );
    if (!outcome.ok) return outcome.response;
    const { recordId, session } = outcome.value;
    return json({ recordId }, { headers: { "Set-Cookie": sessionCookie(session) } });
  },

  "/auth/step-up/options": async ({ passkeys, ctx, request }) =>
    json(await passkeys.stepUpOptions(ctx, sessionValueFrom(request))),

  "/auth/step-up/verify": async ({ passkeys, ctx, request, body }) => {
    const outcome = await passkeys.ceremony(ctx, "step-up", () =>
      passkeys.stepUp(ctx, sessionValueFrom(request), body.response),
    );
    return outcome.ok ? json({ ok: true }) : outcome.response;
  },

  "/me/credentials/enrol/options": async ({ passkeys, ctx, request }) =>
    json(await passkeys.enrolOptions(ctx, sessionValueFrom(request))),

  "/me/credentials/enrol/verify": async ({ passkeys, ctx, request, body }) => {
    const outcome = await passkeys.ceremony(ctx, "enrol", () =>
      passkeys.enrol(ctx, sessionValueFrom(request), body.response),
    );
    return outcome.ok ? json(outcome.value) : outcome.response;
  },

  "/me/credentials/revoke": async ({ passkeys, ctx, request, body }) => {
    await passkeys.revokeCredential(ctx, sessionValueFrom(request), body.label);
    return json({ ok: true });
  },

  "/me/recovery-codes/rotate": async ({ passkeys, ctx, request }) =>
    json({ recoveryCodes: await passkeys.rotateRecoveryCodes(ctx, sessionValueFrom(request)) }),
};

const GET: Record<string, Handler> = {
  "/auth/member-name": async ({ passkeys, request }) => {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    return json({ available: await passkeys.isMemberNameAvailable(name) });
  },

  "/me": authed(async ({ passkeys }, principal) =>
    json({ recordId: principal.recordId, memberName: await passkeys.memberName(principal.recordId) }),
  ),

  "/me/credentials": async ({ passkeys, ctx, request }) =>
    json({ credentials: await passkeys.credentials(ctx, sessionValueFrom(request)) }),

  "/me/sessions": async ({ passkeys, request }) => {
    const sessions = await passkeys.sessions(sessionValueFrom(request));
    if (!sessions) return error(401, "not logged in");
    return json({ sessions });
  },
};

export function createApp(options: AppOptions = {}) {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const passkeys = createPasskeys(env, {
        rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
        refusalFloorMs: Number(env.REFUSAL_FLOOR_MS),
        clock: options.clock,
        onRevoke: options.onRevoke,
      });
      const ctx = passkeys.context(request);
      try {
        return await route(request, env, passkeys, ctx);
      } catch (e) {
        if (e instanceof PasskeyError) return error(STATUS[e.code], e.code);
        throw e;
      }
    },
  };
}

async function route(request: Request, env: Env, passkeys: Passkeys, ctx: RequestContext): Promise<Response> {
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
    return handler({ request, env, passkeys, ctx, body });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const handler = GET[url.pathname];
    if (!handler) return error(404, "not found");
    return handler({ request, env, passkeys, ctx, body: {} });
  }
  return error(405, "method not allowed");
}
