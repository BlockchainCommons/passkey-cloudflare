import { env, runInDurableObject } from "cloudflare:test";
import { createPasskeys } from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName, type Browser } from "./harness.ts";

// Each ceremony method applies its own throttles, failure record and refusal
// floor, so an application cannot skip them by how it calls the method. A
// server failure inside a ceremony ends in the uniform refusal, like any other.

const REFUSAL = '{"error":"ceremony refused"}';
const HOUR = 60 * 60 * 1000;

/** A namespace whose objects reject every call to `method`, as an unreachable object would. */
function rejecting<N extends object>(real: N, method: string): N {
  const namespace = real as unknown as DurableObjectNamespace;
  const failingStub = (id: DurableObjectId) =>
    new Proxy(namespace.get(id), {
      get: (target, property) =>
        property === method
          ? async () => {
              throw new Error(`${method} failed`);
            }
          : Reflect.get(target, property),
    });
  return new Proxy(real, {
    get: (target, property) => {
      if (property === "get") return failingStub;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Every failure recorded on one record, read from its own object. */
function failuresOn(recordId: string) {
  return runInDurableObject(env.IDENTITY_RECORDS.get(env.IDENTITY_RECORDS.idFromName(recordId)), (_instance, state) =>
    state.storage.sql.exec<{ ceremony: string; cause: string }>("SELECT ceremony, cause FROM failures").toArray(),
  );
}

async function sourceHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`source:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The failures recorded globally from one source address. */
async function globalFailuresFrom(browser: Browser) {
  const hash = await sourceHash(browser.ip);
  return runInDurableObject(env.CEREMONY_FAILURES.get(env.CEREMONY_FAILURES.idFromName("global")), (_instance, state) =>
    state.storage.sql
      .exec<{ ceremony: string; cause: string }>("SELECT ceremony, cause FROM failures WHERE source_hash = ?", hash)
      .toArray(),
  );
}

async function loginAttempt(browser: Browser) {
  const options = await browser.json(browser.post("/auth/login/options"));
  return browser.post("/auth/login/verify", { response: await browser.authenticator.get(options) });
}

describe("a server failure inside a ceremony", () => {
  it("gets the uniform refusal, recorded on the record as internal-error", async () => {
    const app = testApp();
    const browser = app.browser();
    const { recordId } = await browser.register(uniqueName());
    browser.session = undefined;
    app.vars.IDENTITY_RECORDS = rejecting(env.IDENTITY_RECORDS, "completeLogin");

    const refused = await loginAttempt(browser);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(browser.session).toBeUndefined();
    expect(await failuresOn(recordId)).toContainEqual({ ceremony: "login", cause: "internal-error" });
  });

  it("is refused no sooner than the refusal floor", async () => {
    const FLOOR = 200;
    const app = testApp({ vars: { REFUSAL_FLOOR_MS: String(FLOOR) } });
    const browser = app.browser();
    await browser.register(uniqueName());
    browser.session = undefined;
    const options = await browser.json(browser.post("/auth/login/options"));
    const response = await browser.authenticator.get(options);
    app.vars.IDENTITY_RECORDS = rejecting(env.IDENTITY_RECORDS, "completeLogin");

    const started = Date.now();
    const refused = await browser.post("/auth/login/verify", { response });

    expect(refused.status).toBe(400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FLOOR);
  });

  it("before any record is known, is recorded globally", async () => {
    const app = testApp();
    const browser = app.browser();
    const options = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    const response = await browser.authenticator.create(options);
    app.vars.MEMBER_NAMES = rejecting(env.MEMBER_NAMES, "claim");

    const refused = await browser.post("/auth/register/verify", { response });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await globalFailuresFrom(browser)).toContainEqual({ ceremony: "register", cause: "internal-error" });
  });
});

describe("anonymous options past the per-source limit get the uniform refusal", () => {
  const routes: [string, unknown][] = [
    ["/auth/register/options", { memberName: uniqueName() }],
    ["/auth/login/options", {}],
    ["/auth/recover/options", { memberName: uniqueName() }],
    ["/auth/rebind/options", { link: "not-a-link" }],
  ];
  for (const [path, body] of routes) {
    it(path, async () => {
      const app = testApp({ rateLimits: { optionsPerSource: { limit: 1, windowMs: HOUR } } });
      const browser = app.browser();
      await browser.post("/auth/login/options");

      const refused = await browser.post(path, body);

      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(REFUSAL);
    });
  }
});

describe("without a live session", () => {
  it("logging out everywhere answers 401", async () => {
    expect((await testApp().browser().post("/auth/logout-everywhere")).status).toBe(401);
  });

  it("listing sessions answers 401", async () => {
    expect((await testApp().browser().get("/me/sessions")).status).toBe(401);
  });
});

describe("the passkeys interface", () => {
  it("has no ceremony wrapper to call or forget", () => {
    const passkeys = createPasskeys(env, {
      rp: { id: "example.com", name: "Example", origin: "https://example.com" },
      refusalFloorMs: 0,
    });

    expect(Object.keys(passkeys)).not.toContain("ceremony");
    expect(Object.keys(passkeys)).not.toContain("anonymousOptions");
  });
});
