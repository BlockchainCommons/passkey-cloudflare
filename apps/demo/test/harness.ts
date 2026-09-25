import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { SoftwareAuthenticator, type AuthenticatorOptions } from "passkey-cloudflare/testing";
import { createApp, type AppOptions } from "../src/app.ts";

export const ORIGIN = "https://canvas.shallweplay.com";

let ipCounter = 0;

export interface HarnessOptions extends AppOptions {
  vars?: Partial<Env>;
}

/** The demo app as a test drives it: its fetch handler, with configuration injected. */
export function testApp(options: HarnessOptions = {}) {
  const { vars, ...appOptions } = options;
  const app = createApp(appOptions);
  const testEnv = { ...env, ...vars } as Env;
  return {
    async fetch(request: Request): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await app.fetch(request, testEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },
    browser(authenticatorOptions: Partial<AuthenticatorOptions> = {}) {
      return new Browser(this, new SoftwareAuthenticator({ origin: ORIGIN, ...authenticatorOptions }));
    },
  };
}

export type TestApp = ReturnType<typeof testApp>;

/** One browser: a cookie jar, a source address and an authenticator. */
export class Browser {
  session: string | undefined;
  readonly ip = `192.0.2.${++ipCounter % 250}`;
  userAgent = "TestBrowser/1.0";

  constructor(
    readonly app: TestApp,
    readonly authenticator: SoftwareAuthenticator,
  ) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h = new Headers({
      "CF-Connecting-IP": this.ip,
      "User-Agent": this.userAgent,
      ...headers,
    });
    if (method !== "GET") h.set("Origin", headers.Origin ?? ORIGIN);
    if (body !== undefined) h.set("Content-Type", "application/json");
    if (this.session && !h.has("Authorization")) h.set("Cookie", `__Host-session=${this.session}`);
    const response = await this.app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie?.startsWith("__Host-session=")) {
      const value = setCookie.slice("__Host-session=".length).split(";")[0]!;
      this.session = value === "" ? undefined : value;
    }
    return response;
  }

  async post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request("POST", path, body, headers);
  }

  async get(path: string, headers?: Record<string, string>) {
    return this.request("GET", path, undefined, headers);
  }

  async json<T = any>(response: Promise<Response> | Response): Promise<T> {
    const r = await response;
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }

  async text(response: Promise<Response> | Response): Promise<string> {
    const r = await response;
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.text();
  }

  /** Register a new person and return what the server answered. */
  async register(memberName: string) {
    const options = await this.json(this.post("/auth/register/options", { memberName }));
    const response = await this.authenticator.create(options);
    return this.json<{ recordId: string; recoveryCodes: string[] }>(
      this.post("/auth/register/verify", { response }),
    );
  }

  async login(credentialId?: string) {
    const options = await this.json(this.post("/auth/login/options"));
    const response = await this.authenticator.get(options, {}, credentialId);
    return this.json<{ recordId: string }>(this.post("/auth/login/verify", { response }));
  }

  async stepUp() {
    const options = await this.json(this.post("/auth/step-up/options"));
    const response = await this.authenticator.get(options);
    return this.json(this.post("/auth/step-up/verify", { response }));
  }

  async enrol() {
    const options = await this.json(this.post("/me/credentials/enrol/options"));
    const response = await this.authenticator.create(options);
    return this.json<{ label: string }>(this.post("/me/credentials/enrol/verify", { response }));
  }
}

let nameCounter = 0;
export function uniqueName(prefix = "member"): string {
  return `${prefix}${Date.now().toString(36)}${++nameCounter}`;
}
