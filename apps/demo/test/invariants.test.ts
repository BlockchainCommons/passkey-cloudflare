import { seedSecretFromTyped } from "passkey-cloudflare/gordian";
import { describe, expect, it } from "vitest";
import { dumpDurableState } from "./durable-state.ts";
import { ORIGIN, testApp, uniqueName, type Browser, type TestApp } from "./harness.ts";
import { refusalArms } from "./refusal-arms.ts";

// One named test per milestone 1 invariant. Each states a promise the system
// makes, and fails if the promise breaks.

const REFUSAL = '{"error":"ceremony refused"}';

/** A recovery code's 16-byte secret, in hex, as a dump of durable state would render it. */
function codeSecretHex(code: string): string {
  return Array.from(seedSecretFromTyped(code)!, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function recoverWith(device: Browser, memberName: string, code: string) {
  const options = await device.json(device.post("/auth/recover/options", { memberName }));
  return device.post("/auth/recover", { memberName, code, response: await device.authenticator.create(options) });
}

async function operatorFor(app: TestApp) {
  const operator = app.browser();
  const { recordId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = recordId;
  await operator.stepUp();
  return operator;
}

describe("invariants", () => {
  it("no password credential type exists", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    for (const param of options.pubKeyCredParams) expect(param.type).toBe("public-key");
    await browser.register(name);
    browser.session = undefined;

    const withPassword = await browser.post("/auth/login/verify", { memberName: name, password: "hunter2" });
    expect(withPassword.status).toBe(400);
    expect(browser.session).toBeUndefined();
    expect(await dumpDurableState()).not.toMatch(/password/i);
  });

  it("no plaintext secret in durable state", async () => {
    const app = testApp();
    const operator = await operatorFor(app);
    const person = app.browser();
    const name = uniqueName();
    const secrets: string[] = [operator.session!.split(".")[1]!];

    const { recoveryCodes } = await person.register(name);
    secrets.push(person.session!.split(".")[1]!, ...recoveryCodes, ...recoveryCodes.map(codeSecretHex));
    await person.login();
    secrets.push(person.session!.split(".")[1]!);
    await person.stepUp();
    const rotated = await person.json(person.post("/me/recovery-codes/rotate"));
    secrets.push(...rotated.recoveryCodes, ...rotated.recoveryCodes.map(codeSecretHex));
    const newDevice = app.browser();
    await recoverWith(newDevice, name, rotated.recoveryCodes[0]);
    secrets.push(newDevice.session!.split(".")[1]!);
    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: name }));
    secrets.push(link.split("#")[1].split(".")[1]);
    const challenge = (await person.json(person.post("/auth/login/options"))).challenge;
    secrets.push(challenge);

    const state = await dumpDurableState();
    expect(secrets.length).toBeGreaterThan(20);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThanOrEqual(24);
      expect(state).not.toContain(secret);
    }
  });

  it("no secret from a weak generator", async () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random must never be used");
    };
    try {
      const app = testApp();
      const operator = await operatorFor(app);
      const browser = app.browser();
      const name = uniqueName();
      const { recoveryCodes } = await browser.register(name);
      await browser.login();
      await browser.stepUp();
      await browser.enrol();
      await browser.json(browser.post("/me/recovery-codes/rotate"));
      await operator.json(operator.post("/operator/rebind-links", { memberName: name }));
      expect((await recoverWith(app.browser(), name, recoveryCodes[0]!)).status).toBe(400);
    } finally {
      Math.random = original;
    }
  });

  it("no session without a proof in the same operation", async () => {
    const app = testApp();
    const operator = await operatorFor(app);
    const name = uniqueName();
    const person = app.browser();

    // A proof used once cannot be used again to mint another session.
    const registerOptions = await person.json(person.post("/auth/register/options", { memberName: name }));
    const registration = await person.authenticator.create(registerOptions);
    const { recoveryCodes } = await person.json(person.post("/auth/register/verify", { response: registration }));
    const loginOptions = await person.json(person.post("/auth/login/options"));
    const assertion = await person.authenticator.get(loginOptions);
    await person.post("/auth/login/verify", { response: assertion });
    const recoverDevice = app.browser();
    const recoverOptions = await recoverDevice.json(recoverDevice.post("/auth/recover/options", { memberName: name }));
    const recovery = { memberName: name, code: recoveryCodes[0], response: await recoverDevice.authenticator.create(recoverOptions) };
    await recoverDevice.post("/auth/recover", recovery);
    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: name }));
    const fragment = link.split("#")[1];
    const rebindDevice = app.browser();
    const rebindOptions = await rebindDevice.json(rebindDevice.post("/auth/rebind/options", { link: fragment }));
    const rebind = { link: fragment, response: await rebindDevice.authenticator.create(rebindOptions) };
    await rebindDevice.post("/auth/rebind/verify", rebind);
    const sessionsBefore = (await person.json(person.get("/me/sessions"))).sessions.length;

    const replays = [
      ["/auth/register/verify", { response: registration }],
      ["/auth/login/verify", { response: assertion }],
      ["/auth/recover", recovery],
      ["/auth/rebind/verify", rebind],
      ["/auth/login/verify", {}],
      ["/auth/register/verify", {}],
    ] as const;
    for (const [path, body] of replays) {
      const replay = await app.browser().post(path, body);
      expect(replay.status).toBe(400);
      expect(replay.headers.get("Set-Cookie")).toBeNull();
    }
    expect((await person.json(person.get("/me/sessions"))).sessions.length).toBe(sessionsBefore);
  });

  it("no cached authorization", async () => {
    const app = testApp();
    const operator = await operatorFor(app);
    const phone = app.browser();
    const name = uniqueName();
    await phone.register(name);
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    for (let i = 0; i < 3; i++) expect((await phone.get("/me")).status).toBe(200);

    await laptop.login();
    await laptop.post("/auth/logout-everywhere");
    expect((await phone.get("/me")).status).toBe(401);

    await phone.login();
    expect((await phone.get("/me")).status).toBe(200);
    await operator.post("/operator/suspend", { memberName: name });
    expect((await phone.get("/me")).status).toBe(401);
  });

  it("no record with zero credentials", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const [only] = (await browser.json(browser.get("/me/credentials"))).credentials;

    const refused = await browser.post("/me/credentials/revoke", { label: only.label });

    expect(refused.status).toBe(409);
    await browser.enrol();
    const both = (await browser.json(browser.get("/me/credentials"))).credentials;
    expect((await browser.post("/me/credentials/revoke", { label: both[0].label })).status).toBe(200);
    expect((await browser.post("/me/credentials/revoke", { label: both[1].label })).status).toBe(409);
    expect((await browser.json(browser.get("/me/credentials"))).credentials).toHaveLength(1);
    browser.session = undefined;
    await browser.login();
  });

  it("no label reaches the identity layer", async () => {
    const browser = testApp().browser();
    const name = uniqueName("labelcheck");
    await browser.register(name);
    await browser.stepUp();
    await browser.enrol();
    const labels = (await browser.json(browser.get("/me/credentials"))).credentials.map((c: any) => c.label);
    expect(labels).toHaveLength(2);

    const identityState = await dumpDurableState(["IDENTITY_RECORDS", "CREDENTIAL_INDEX"]);

    expect(identityState).not.toContain(name);
    for (const label of labels) expect(identityState).not.toContain(label);
    expect(await dumpDurableState(["CREDENTIAL_LABELS"])).toContain(labels[0]);
  });

  it("no distinguishable ceremony failure", async () => {
    const FLOOR = 200;
    const BOUND = 50;
    const app = testApp({ vars: { REFUSAL_FLOOR_MS: String(FLOOR) } });
    const operator = await operatorFor(app);
    const arms = await refusalArms({
      browser: () => app.browser(),
      suspend: async (memberName) => void (await operator.json(operator.post("/operator/suspend", { memberName }))),
    });

    const seen: { arm: string; status: number; body: string; headers: string; ms: number }[] = [];
    for (const [arm, prepare] of Object.entries(arms)) {
      const { path, body } = await prepare();
      const request = new Request(ORIGIN + path, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "2001:db8:ffff::1" },
        body: JSON.stringify(body),
      });
      const started = Date.now();
      const response = await app.fetch(request);
      const ms = Date.now() - started;
      const headers = [...response.headers].filter(([k]) => k !== "date").map(([k, v]) => `${k}: ${v}`).join("\n");
      seen.push({ arm, status: response.status, body: await response.text(), headers, ms });
    }

    for (const s of seen) {
      expect(s, s.arm).toMatchObject({ status: 400, body: REFUSAL, headers: seen[0]!.headers });
      expect(s.ms, s.arm).toBeGreaterThanOrEqual(FLOOR);
    }
    const times = seen.map((s) => s.ms);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(BOUND);
    // Inside, each refusal keeps its own cause.
    const causes = new Set(
      [...(await dumpDurableState(["IDENTITY_RECORDS", "CEREMONY_FAILURES"])).matchAll(/ failures .* cause=(\S+)/g)].map(
        (m) => m[1],
      ),
    );
    for (const cause of ["unknown-challenge", "wrong-origin", "wrong-rp-id", "bad-signature", "counter-regressed", "unknown-credential", "suspended", "wrong-recovery-code", "unknown-member-name", "malformed-response"]) {
      expect(causes).toContain(cause);
    }
  });

  it("no cross-purpose challenge", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());
    const loginChallenge = (await browser.json(browser.post("/auth/login/options"))).challenge;
    const registerOptions = await browser.json(browser.post("/auth/register/options", { memberName: uniqueName() }));
    await browser.stepUp();
    const stepUpOptions = await browser.json(browser.post("/auth/step-up/options"));

    // A login challenge presented to registration.
    const asRegistration = await browser.post("/auth/register/verify", {
      response: await browser.authenticator.create({ ...registerOptions, challenge: loginChallenge }),
    });
    // A registration challenge presented to login.
    const loginOptions = await browser.json(browser.post("/auth/login/options"));
    const asLogin = await browser.post("/auth/login/verify", {
      response: await browser.authenticator.get({ ...loginOptions, challenge: registerOptions.challenge }),
    });
    // A step-up challenge presented to login.
    const stepUpAsLogin = await browser.post("/auth/login/verify", {
      response: await browser.authenticator.get({ ...loginOptions, challenge: stepUpOptions.challenge }),
    });

    for (const response of [asRegistration, asLogin, stepUpAsLogin]) {
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(REFUSAL);
    }
  });

  it("no login-critical property left to defaults", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const registration = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    const again = await browser.json(browser.post("/auth/register/options", { memberName: name }));
    const login = await browser.json(browser.post("/auth/login/options"));

    expect(registration.rp.id).toBe("canvas.shallweplay.com");
    expect(registration.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred",
    });
    expect(registration.pubKeyCredParams).toEqual([
      { alg: -8, type: "public-key" },
      { alg: -7, type: "public-key" },
    ]);
    expect(registration.attestation).toBe("none");
    expect(registration.timeout).toBe(300_000);
    expect(registration.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(again.user.id).not.toBe(registration.user.id);
    expect(login.rpId).toBe("canvas.shallweplay.com");
    expect(login.allowCredentials).toEqual([]);
    expect(login.userVerification).toBe("preferred");
    expect(login.timeout).toBe(300_000);
  });
});
