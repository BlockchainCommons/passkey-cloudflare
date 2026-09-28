import type { SoftwareAuthenticator } from "passkey-cloudflare/testing";

// A browser as the tests drive one, against anything that answers requests:
// the demo app in the Workers runtime, or a deployed Worker over the network.
// Nothing here may depend on the Workers test runtime.

/** Where a browser sends its requests. */
export interface Target {
  /** The origin the browser loads the app from; also the base of every request URL. */
  origin: string;
  fetch(request: Request): Promise<Response>;
  /**
   * True for a real Cloudflare edge, which sets CF-Connecting-IP itself and
   * refuses a request that already carries one.
   */
  edge?: boolean;
}

let ipCounter = 0;

/** One browser: a cookie jar, a source address and an authenticator. */
export class Browser {
  session: string | undefined;
  // Unique across the run, because storage (and so every rate-limit bucket) is shared by all tests.
  readonly ip = `2001:db8::${(++ipCounter).toString(16)}`;
  userAgent = "TestBrowser/1.0";

  readonly app: Target;
  readonly authenticator: SoftwareAuthenticator;

  // Plain fields, not parameter properties, so that Node can strip the types
  // when a script imports this file.
  constructor(app: Target, authenticator: SoftwareAuthenticator) {
    this.app = app;
    this.authenticator = authenticator;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h = new Headers({
      ...(this.app.edge ? {} : { "CF-Connecting-IP": this.ip }),
      "User-Agent": this.userAgent,
      ...headers,
    });
    if (method !== "GET") h.set("Origin", headers.Origin ?? this.app.origin);
    if (body !== undefined) h.set("Content-Type", "application/json");
    if (this.session && !h.has("Authorization")) h.set("Cookie", `__Host-session=${this.session}`);
    const response = await this.app.fetch(
      new Request(this.app.origin + path, {
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
    return this.json<{ recordId: string; recoveryCodes: string[]; recoveryCodeWords: string[] }>(
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
