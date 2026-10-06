import { describe, expect, it } from "vitest";
import { CeremonyClient, type Authenticator } from "../browser/ceremonies.ts";
import { ALREADY_REGISTERED, Flows } from "../browser/flows.ts";
import { softwareAuthenticator, type Browser } from "./browser.ts";
import { testApp, uniqueName } from "./harness.ts";

const SITE = "passkeydemo.gordianstack.com";

/** The demo's flows on `browser`, its authenticator replaced in part by `answering`. */
function flowsOn(browser: Browser, answering: Partial<Authenticator> = {}) {
  const software = softwareAuthenticator(browser.authenticator);
  const client = new CeremonyClient(
    { origin: browser.app.origin, fetch: (request) => browser.send(request) },
    { ...software, ...answering },
  );
  return new Flows(client, SITE);
}

const declining: Partial<Authenticator> = {
  create: async () => ({ result: "not-created" }),
  get: async () => ({ result: "not-found" }),
};

/** A signed-in person whose session has not stepped up, and an operator who can look them up. */
async function signedIn() {
  const app = testApp();
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = operatorId;
  const person = app.browser();
  const personName = uniqueName("person");
  const { recordId: personId } = await person.register(personName);
  return { app, operator, person, personName, personId };
}

describe("the demo's flows", () => {
  it("tell a declined step-up as Cancelled, from every session-gated action", async () => {
    const { person, operator, personName, personId } = await signedIn();
    const flows = flowsOn(person, declining);
    const operatorFlows = flowsOn(operator, declining);
    const label = (await person.ceremonies.credentials())[0]!.label;

    const told = [
      await flows.addPasskey(),
      await flows.revoke(label),
      await flows.rotateCodes(),
      await flows.logoutElsewhere(),
      await operatorFlows.lookUpMember(personName),
      await operatorFlows.operatorAction("suspend", { memberName: personName, recordId: personId }),
    ];

    expect(told).toEqual(Array(6).fill({ result: "told", message: "Cancelled.", declined: true }));
  });

  it("tell a ceremony that made no passkey why, in its own words", async () => {
    const app = testApp();
    const name = uniqueName();

    expect(await flowsOn(app.browser(), declining).register(name)).toEqual({
      result: "told",
      message: "Registration cancelled.",
      declined: true,
    });
    expect(
      await flowsOn(app.browser(), { create: async () => ({ result: "already-registered" }) }).register(name),
    ).toEqual({ result: "told", message: ALREADY_REGISTERED, declined: true });
  });

  it("tell Continue that used no passkey from one that was not accepted", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());

    expect(await flowsOn(app.browser(), declining).continueWithPasskey()).toEqual({ result: "no-passkey" });
    expect(
      await flowsOn(browser, {
        get: softwareAuthenticator(browser.authenticator, { tamper: { badSignature: true } }).get,
      }).continueWithPasskey(),
    ).toEqual({
      result: "not-accepted",
    });
  });

  it("return a registration's codes as the codes pane shows and copies them", async () => {
    const app = testApp();
    const name = uniqueName();

    const flows = flowsOn(app.browser());
    const registered = await flows.register(name);

    if (registered.result !== "registered") throw new Error(registered.result);
    const codes = await flows.codes(registered);
    expect(codes.header).toEqual([
      `Recovery codes for ${SITE}`,
      `Member name: ${name}`,
      expect.stringMatching(/^Issued: /),
    ]);
    expect(codes.recoveryCodeWords).toHaveLength(codes.recoveryCodes.length);
    expect(codes.text).toContain(`1. ${codes.recoveryCodes[0]}`);
    expect(codes.text).not.toContain(codes.recoveryCodeWords[0]);
  });

  it("show the member a lookup found, with what the lookup noted", async () => {
    const { operator, personName, personId } = await signedIn();
    await operator.stepUp();

    const found = await flowsOn(operator).lookUpMember(personName);

    expect(found).toMatchObject({ result: "member", member: { memberName: personName, recordId: personId }, note: "" });
    expect(await flowsOn(operator).lookUpMember(uniqueName())).toEqual({ result: "noted", note: "No such member" });
  });
});
