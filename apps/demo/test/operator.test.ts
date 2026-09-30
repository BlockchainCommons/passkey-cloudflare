import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RECOVERY_CODE_COUNT, type RecordId, type RevocationEvent } from "passkey-cloudflare";
import type { OperatorLog } from "../src/operator-log.ts";
import { testApp, uniqueName, type Browser, type HarnessOptions } from "./harness.ts";

const HOUR = 60 * 60 * 1000;

/** An app with one stepped-up operator and one ordinary person. */
async function deployment(options: HarnessOptions = {}) {
  const app = testApp(options);
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  app.vars.OPERATOR_RECORD_IDS = `${crypto.randomUUID()}, ${operatorId}`;
  await operator.stepUp();
  const person = app.browser();
  const personName = uniqueName("person");
  const { recordId: personId } = await person.register(personName);
  return { app, operator, operatorId, person, personName, personId };
}

async function rebind(device: Browser, link: string) {
  const fragment = new URL(link).hash.slice(1);
  const optionsResponse = await device.post("/auth/rebind/options", { link: fragment });
  if (!optionsResponse.ok) return optionsResponse;
  const response = await device.authenticator.create(await optionsResponse.json());
  return device.post("/auth/rebind/verify", { link: fragment, response });
}

describe("operator role", () => {
  it("is shown to the operator and to no one else", async () => {
    const { operator, person } = await deployment();

    expect(await operator.json(operator.get("/me"))).toMatchObject({ operator: true });
    expect(await person.json(person.get("/me"))).toMatchObject({ operator: false });
  });
});

describe("operator rebind", () => {
  it("binds a new passkey to a person who lost everything, through a link", async () => {
    const { app, operator, personName, personId } = await deployment();

    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: personName }));
    const newDevice = app.browser();
    const rebound = await rebind(newDevice, link);

    expect(link).toMatch(/^https:\/\/passkeydemo\.shallweplay\.com\/rebind#/);
    expect(rebound.status).toBe(200);
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId: personId });
    newDevice.session = undefined;
    expect((await newDevice.login()).recordId).toBe(personId);
  });

  it("links work once", async () => {
    const { app, operator, personName } = await deployment();
    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: personName }));
    await rebind(app.browser(), link);

    // Refused before any passkey ceremony starts.
    expect((await rebind(app.browser(), link)).status).toBe(404);
  });

  it("links expire after a day", async () => {
    let now = Date.now();
    const { app, operator, personName } = await deployment({ clock: () => now });
    const { link } = await operator.json(operator.post("/operator/rebind-links", { memberName: personName }));

    now += 24 * HOUR + 1;

    expect((await rebind(app.browser(), link)).status).toBe(404);
  });

  it("options are refused for a link whose token is wrong, revealing nothing", async () => {
    const { app, personName, personId } = await deployment();
    const device = app.browser();

    const response = await device.post("/auth/rebind/options", { link: `${personId}.${"A".repeat(43)}` });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(personName);
  });

  it("only an operator can create links", async () => {
    const { person, personName } = await deployment();
    await person.stepUp();

    expect((await person.post("/operator/rebind-links", { memberName: personName })).status).toBe(403);
  });

  it("an operator must have stepped up", async () => {
    let now = Date.now();
    const { operator, personName } = await deployment({ clock: () => now });
    now += 11 * 60 * 1000;

    expect((await operator.post("/operator/rebind-links", { memberName: personName })).status).toBe(403);
  });
});

describe("suspension", () => {
  it("ends the principal's sessions at once and refuses its logins, until resumed", async () => {
    const events: RevocationEvent[] = [];
    const { operator, person, personName, personId } = await deployment({
      onRevoke: (event) => void events.push(event),
    });

    expect((await operator.post("/operator/suspend", { memberName: personName })).status).toBe(200);

    expect(events).toEqual([{ reason: "suspension", recordId: personId, sessionIds: [expect.any(String)] }]);
    expect((await person.get("/me")).status).toBe(401);
    const options = await person.json(person.post("/auth/login/options"));
    const refused = await person.post("/auth/login/verify", { response: await person.authenticator.get(options) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');

    expect((await operator.post("/operator/resume", { memberName: personName })).status).toBe(200);
    expect((await person.login()).recordId).toBe(personId);
  });
});

describe("suspension of a principal with no live sessions", () => {
  it("still calls the revocation hook", async () => {
    const events: RevocationEvent[] = [];
    const { operator, person, personName, personId } = await deployment({
      onRevoke: (event) => void events.push(event),
    });
    await person.post("/auth/logout");
    events.length = 0;

    await operator.post("/operator/suspend", { memberName: personName });

    expect(events).toEqual([{ reason: "suspension", recordId: personId, sessionIds: [] }]);
  });
});

describe("operator targets", () => {
  it("can be named by record id, which must be a well-formed one", async () => {
    const { operator, person, personId } = await deployment();

    expect((await operator.post("/operator/suspend", { recordId: "not-a-record-id" })).status).toBe(404);
    expect((await operator.post("/operator/suspend", { recordId: personId })).status).toBe(200);
    expect((await person.get("/me")).status).toBe(401);
  });
});

describe("operator log", () => {
  it("records every operator action with who, what, whom and when", async () => {
    let now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });

    await operator.post("/operator/rebind-links", { memberName: personName });
    await operator.post("/operator/suspend", { memberName: personName });
    await operator.post("/operator/resume", { memberName: personName });

    const { entries } = await operator.json(operator.get("/operator/log"));
    // The log is shared by every operator in the deployment.
    expect(entries.filter((e: any) => e.operatorId === operatorId)).toEqual([
      { operatorId, action: "create-rebind-link", targetId: personId, at: now },
      { operatorId, action: "suspend", targetId: personId, at: now },
      { operatorId, action: "resume", targetId: personId, at: now },
    ]);
  });
});

describe("operator lookup", () => {
  it("shows a member's state and counts, and no device detail", async () => {
    const now = Date.now();
    const { operator, personName, personId } = await deployment({ clock: () => now });

    const response = await operator.post("/operator/lookup", { memberName: personName });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recordId: personId,
      summary: {
        createdAt: now,
        suspendedAt: null,
        passkeys: 1,
        sessions: 1,
        recoveryCodesLeft: RECOVERY_CODE_COUNT,
        rebindLinkOutstanding: false,
      },
      entries: [],
    });
  });

  it("answers 404 for a name no member holds, or one that is not a valid member name, and logs nothing", async () => {
    const { operator, operatorId } = await deployment();

    for (const memberName of [uniqueName("nobody"), "not a member name!", 42]) {
      const response = await operator.post("/operator/lookup", { memberName });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "no such member" });
    }
    const { entries } = await operator.json(operator.get("/operator/log"));
    expect(entries.filter((e: any) => e.operatorId === operatorId)).toEqual([]);
  });

  it("is refused, like the other operator routes, to a non-operator and to an operator who has not stepped up, and logs nothing", async () => {
    let now = Date.now();
    const { operator, operatorId, person, personName, personId } = await deployment({ clock: () => now });
    const start = now;
    await person.stepUp();
    // Read through a lookup, whose entries for this member are uncapped. The shared
    // recent list is capped, and other files' entries could push a lookup out of it.
    const lookups = async () =>
      (await operator.json(operator.post("/operator/lookup", { memberName: personName }))).entries.filter(
        (e: any) => e.action === "lookup",
      );

    const byPerson = await person.post("/operator/lookup", { memberName: personName });
    expect(byPerson.status).toBe(403);
    expect(await byPerson.json()).toEqual({ error: "not an operator" });
    expect(await lookups()).toEqual([]);

    now += 11 * 60 * 1000;
    const stale = await operator.post("/operator/lookup", { memberName: personName });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step-up-required" });
    await operator.stepUp();
    // Only the lookup that read the log after the non-operator's attempt.
    expect(await lookups()).toEqual([{ operatorId, action: "lookup", targetId: personId, at: start }]);
  });

  it("logs each lookup once, and shows every earlier entry for that member, however old", async () => {
    let now = Date.now();
    const { operator, operatorId, personName, personId } = await deployment({ clock: () => now });
    const first = now;
    await operator.post("/operator/suspend", { memberName: personName });
    await operator.post("/operator/lookup", { memberName: personName });
    // Enough later entries for other members to push this member's out of the recent list.
    await runInDurableObject(globalOperatorLog(), async (log: OperatorLog) => {
      for (let i = 0; i < 200; i++) {
        log.append({ operatorId: operatorId as RecordId, action: "suspend", targetId: crypto.randomUUID() as RecordId, at: first });
      }
    });
    now += 1000;

    const { entries } = await operator.json(operator.post("/operator/lookup", { memberName: personName }));

    expect(entries).toEqual([
      { operatorId, action: "suspend", targetId: personId, at: first },
      { operatorId, action: "lookup", targetId: personId, at: first },
    ]);
    const recent = (await operator.json(operator.get("/operator/log"))).entries;
    expect(recent.filter((e: any) => e.targetId === personId)).toEqual([
      { operatorId, action: "lookup", targetId: personId, at: now },
    ]);
  });
});

describe("operator actions on a looked-up member", () => {
  it("answer with the member's updated state and log one entry each", async () => {
    const now = Date.now();
    const { operator, operatorId, personId } = await deployment({ clock: () => now });

    const linked = await operator.json(operator.post("/operator/rebind-links", { recordId: personId }));
    expect(linked.link).toMatch(/\/rebind#/);
    expect(linked.member).toMatchObject({ recordId: personId, summary: { rebindLinkOutstanding: true } });

    const suspended = await operator.json(operator.post("/operator/suspend", { recordId: personId }));
    expect(suspended.member).toMatchObject({ recordId: personId, summary: { suspendedAt: now, sessions: 0 } });

    const resumed = await operator.json(operator.post("/operator/resume", { recordId: personId }));
    expect(resumed.member.summary).toMatchObject({ suspendedAt: null });
    expect(resumed.member.entries).toEqual([
      { operatorId, action: "create-rebind-link", targetId: personId, at: now },
      { operatorId, action: "suspend", targetId: personId, at: now },
      { operatorId, action: "resume", targetId: personId, at: now },
    ]);
  });
});

function globalOperatorLog() {
  return env.OPERATOR_LOG.get(env.OPERATOR_LOG.idFromName("global"));
}
