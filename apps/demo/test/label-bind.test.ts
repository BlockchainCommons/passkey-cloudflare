import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName, type Browser, type TestApp } from "./harness.ts";

// A label is bound after the record has committed the ceremony's credential
// and session. These tests make that bind fail and check that the ceremony
// still succeeds, and that the credential is labelled when next listed. The
// failure is faked at the binding because a thrown bind is the behaviour under
// test; what a lost bind leaves in storage is tested in credentials.test.ts.

/** The labels namespace, with every bind failing as an unreachable object would. */
function labelsThatRefuseToBind(): Env["CREDENTIAL_LABELS"] {
  const real = env.CREDENTIAL_LABELS;
  const failingStub = (id: DurableObjectId) => {
    const stub = real.get(id);
    return new Proxy(stub, {
      get: (target, property) =>
        property === "bind"
          ? async () => {
              throw new Error("label bind failed");
            }
          : Reflect.get(target, property),
    });
  };
  return new Proxy(real, {
    get: (target, property) => {
      if (property === "get") return failingStub;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function breakLabelBinds(app: TestApp) {
  app.vars.CREDENTIAL_LABELS = labelsThatRefuseToBind();
}

function restoreLabelBinds(app: TestApp) {
  delete app.vars.CREDENTIAL_LABELS;
}

async function listedLabels(browser: Browser): Promise<string[]> {
  const { credentials } = await browser.json(browser.get("/me/credentials"));
  return credentials.map((c: any) => c.label);
}

describe("a ceremony whose label bind fails", () => {
  it("still registers, with a session and recovery codes", async () => {
    const app = testApp();
    const browser = app.browser();
    const name = uniqueName();
    breakLabelBinds(app);

    const { recordId, recoveryCodes } = await browser.register(name);

    expect(recoveryCodes).toHaveLength(8);
    expect(await browser.json(browser.get("/me"))).toMatchObject({ recordId, memberName: name });
    restoreLabelBinds(app);
    const labels = await listedLabels(browser);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
  });

  it("still enrols the passkey, returning no label", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    breakLabelBinds(app);

    const { label } = await browser.enrol();

    expect(label).toBeNull();
    const [, second] = browser.authenticator.credentials;
    restoreLabelBinds(app);
    const labels = await listedLabels(browser);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    browser.session = undefined;
    await browser.login(second!.id);
    expect(browser.session).toBeDefined();
  });

  it("still recovers, with a session", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();
    const options = await newDevice.json(newDevice.post("/auth/recover/options", { memberName: name }));
    const response = await newDevice.authenticator.create(options);
    breakLabelBinds(app);

    const recovered = await newDevice.post("/auth/recover", { memberName: name, code: recoveryCodes[0], response });

    expect(recovered.status).toBe(200);
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId });
    restoreLabelBinds(app);
    expect(await listedLabels(newDevice)).toHaveLength(2);
  });

  it("still rebinds, with a session", async () => {
    const app = testApp();
    const operator = app.browser();
    const { recordId: operatorId } = await operator.register(uniqueName("operator"));
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();
    const name = uniqueName("person");
    const { recordId } = await app.browser().register(name);
    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: name }));
    const fragment = new URL(link).hash.slice(1);
    const newDevice = app.browser();
    const options = await newDevice.json(newDevice.post("/auth/rebind/options", { link: fragment }));
    const response = await newDevice.authenticator.create(options);
    breakLabelBinds(app);

    const rebound = await newDevice.post("/auth/rebind/verify", { link: fragment, response });

    expect(rebound.status).toBe(200);
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId });
    restoreLabelBinds(app);
    expect(await listedLabels(newDevice)).toHaveLength(2);
  });
});
