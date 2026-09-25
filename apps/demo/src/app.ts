import {
  clearedSessionCookie,
  createPasskeys,
  NotAvailable,
  sessionCookie,
  sessionValueFrom,
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

function authed(handler: AuthedHandler): Handler {
  return async (call) => {
    const principal = await call.passkeys.authenticate(sessionValueFrom(call.request));
    if (!principal) return error(401, "not logged in");
    return handler(call, principal);
  };
}

const POST: Record<string, Handler> = {
  "/auth/register/options": async ({ passkeys, ctx, body }) => {
    try {
      return json(await passkeys.registrationOptions(ctx, body.memberName));
    } catch (e) {
      if (e instanceof NotAvailable) return error(409, "member name not available");
      throw e;
    }
  },

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
};

const GET: Record<string, Handler> = {
  "/auth/member-name": async ({ passkeys, request }) => {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    return json({ available: await passkeys.isMemberNameAvailable(name) });
  },

  "/me": authed(async ({ passkeys }, principal) =>
    json({ recordId: principal.recordId, memberName: await passkeys.memberName(principal.recordId) }),
  ),

  "/me/sessions": async ({ passkeys, request }) => {
    const sessions = await passkeys.sessions(sessionValueFrom(request));
    if (!sessions) return error(401, "not logged in");
    return json({ sessions });
  },
};

export function createApp(options: AppOptions = {}) {
  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const passkeys = createPasskeys(env, {
        rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
        refusalFloorMs: Number(env.REFUSAL_FLOOR_MS),
        clock: options.clock,
        onRevoke: options.onRevoke,
      });
      const ctx = passkeys.context(request);

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
    },
  };
}
