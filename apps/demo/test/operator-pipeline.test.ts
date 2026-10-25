import { env } from "cloudflare:test";
import {
  createOperators,
  createPasskeys,
  operatorLog,
  type LoggedOperatorAction,
  type OperatorLogEntry,
  type RecordId,
} from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { ORIGIN, testApp, uniqueName, type Browser } from "./harness.ts";

// The library's operator pipeline as an application uses it for an action of
// its own, apart from the demo's routes: an app-prefixed action and target
// kind, run through `createOperators` on the test app's storage.

/** An app with one stepped-up operator, one operator who has not stepped up, and one ordinary person. */
async function deployment() {
  let now = Date.now();
  const app = testApp({ clock: () => now });
  const operator = app.browser();
  const { recordId: operatorId } = await operator.register(uniqueName("operator"));
  const unsteppedOperator = app.browser();
  const { recordId: unsteppedId } = await unsteppedOperator.register(uniqueName("operator"));
  const person = app.browser();
  const personName = uniqueName("person");
  const personId = (await person.register(personName)).recordId as RecordId;
  // A registration counts as a fresh step-up; let every one go stale, then step up the operator alone.
  now += 11 * 60 * 1000;
  await operator.stepUp();
  const passkeys = createPasskeys(env, {
    rp: { id: env.RP_ID, name: env.RP_NAME, origin: env.ORIGIN },
    refusalFloorMs: 0,
    storagePrefix: app.storagePrefix,
    clock: () => now,
  });
  const log = operatorLog(env.OPERATOR_LOG, app.storagePrefix);
  const operators = createOperators({
    passkeys,
    roles: { isOperator: async (recordId) => recordId === operatorId || recordId === unsteppedId },
    log,
  });
  /** The request context for one browser's request, as the app would build it. */
  const ctx = (browser: Browser) =>
    passkeys.context(
      new Request(ORIGIN, { headers: { "CF-Connecting-IP": browser.ip, "User-Agent": browser.userAgent } }),
    );
  return { operator, operatorId, unsteppedOperator, person, personName, personId, operators, log, ctx };
}

describe("an app's own operator action", () => {
  it("writes one entry with its action, target and member before its work runs", async () => {
    const { operator, operatorId, personId, operators, log, ctx } = await deployment();
    let seenByWork: OperatorLogEntry[] | null = null;

    const outcome = await operators.run(operator.session, ctx(operator), {
      action: "forge:delete-project",
      target: async () => ({ target: { kind: "forge:project", id: "project-1" }, recordId: personId }),
      act: async () => {
        seenByWork = await log().list();
        return "deleted";
      },
    });

    const entry = {
      operatorId,
      action: "forge:delete-project",
      target: { kind: "forge:project", id: "project-1" },
      recordId: personId,
      at: expect.any(Number),
    };
    expect(outcome).toEqual({ ok: true, value: "deleted" });
    expect(seenByWork).toEqual([entry]);
    expect(await log().list()).toEqual([entry]);
  });

  it("writes no entry and runs no work when any step refuses", async () => {
    const { operator, unsteppedOperator, person, personId, operators, log, ctx } = await deployment();
    let worked = 0;
    type Action = LoggedOperatorAction<string, "forge:project-locked">;
    const action = (overrides: Partial<Action> = {}): Action => ({
      action: "forge:delete-project",
      target: async () => ({ target: { kind: "forge:project", id: "project-1" }, recordId: personId }),
      act: async () => {
        worked++;
        return "deleted";
      },
      ...overrides,
    });

    const refusals = [
      await operators.run(undefined, ctx(operator), action()),
      await operators.run(person.session, ctx(person), action()),
      await operators.run(unsteppedOperator.session, ctx(unsteppedOperator), action()),
      await operators.run(operator.session, ctx(operator), action({ target: async () => null })),
      await operators.run(operator.session, ctx(operator), action({ check: async () => "forge:project-locked" })),
    ].map((outcome) => (outcome.ok ? "ok" : outcome.refusal));

    expect(refusals).toEqual(["not-logged-in", "not-operator", "not-stepped-up", "not-found", "forge:project-locked"]);
    expect(worked).toBe(0);
    expect(await log().list()).toEqual([]);
  });

  it("shows in its member's history when it names one, and only in the full log when it does not", async () => {
    const { operator, operatorId, personName, personId, operators, log, ctx } = await deployment();
    const deleteProject = (id: string, recordId?: RecordId) =>
      operators.run(operator.session, ctx(operator), {
        action: "forge:delete-project",
        target: async () => ({ target: { kind: "forge:project", id }, ...(recordId ? { recordId } : {}) }),
        act: async () => "deleted",
      });
    await deleteProject("owned", personId);
    await deleteProject("ownerless");

    const looked = await operators.lookup(operator.session, ctx(operator), personName);

    const owned = { operatorId, action: "forge:delete-project", target: { kind: "forge:project", id: "owned" } };
    const ownerless = {
      operatorId,
      action: "forge:delete-project",
      target: { kind: "forge:project", id: "ownerless" },
    };
    const lookup = { operatorId, action: "lookup", target: { kind: "record", id: personId }, recordId: personId };
    expect(looked.ok && looked.value.entries).toEqual([
      { ...owned, recordId: personId, at: expect.any(Number) },
      { ...lookup, at: expect.any(Number) },
    ]);
    expect(await log().list()).toEqual([
      { ...owned, recordId: personId, at: expect.any(Number) },
      { ...ownerless, at: expect.any(Number) },
      { ...lookup, at: expect.any(Number) },
    ]);
  });

  it("takes only prefixed names for an app's own actions and target kinds", () => {
    const unprefixedAction: LoggedOperatorAction<string> = {
      // @ts-expect-error An app's action carries its prefix and a colon.
      action: "delete-project",
      target: async () => ({ target: { kind: "forge:project", id: "project-1" } }),
      act: async () => "deleted",
    };
    const unprefixedKind: LoggedOperatorAction<string> = {
      action: "forge:delete-project",
      // @ts-expect-error An app's target kind carries its prefix and a colon.
      target: async () => ({ target: { kind: "project", id: "project-1" } }),
      act: async () => "deleted",
    };
    expect([unprefixedAction, unprefixedKind]).toHaveLength(2);
  });
});

describe("a declared unlogged operator read", () => {
  it("runs after the role and step-up checks and writes no entry", async () => {
    const { operator, unsteppedOperator, person, operators, log, ctx } = await deployment();
    let read = 0;
    const tier0 = { unlogged: "tier-0" as const, read: async () => ++read };
    const ownLog = { unlogged: "operator-log" as const, read: async () => ++read };

    const refused = [
      await operators.run(unsteppedOperator.session, ctx(unsteppedOperator), tier0),
      await operators.run(unsteppedOperator.session, ctx(unsteppedOperator), ownLog),
      await operators.memberNames(unsteppedOperator.session, ctx(unsteppedOperator)),
      await operators.logEntries(unsteppedOperator.session, ctx(unsteppedOperator)),
      await operators.run(person.session, ctx(person), tier0),
      await operators.run(undefined, ctx(operator), ownLog),
    ].map((outcome) => (outcome.ok ? "ok" : outcome.refusal));
    expect(refused).toEqual([
      "not-stepped-up",
      "not-stepped-up",
      "not-stepped-up",
      "not-stepped-up",
      "not-operator",
      "not-logged-in",
    ]);
    expect(read).toBe(0);

    expect(await operators.run(operator.session, ctx(operator), tier0)).toEqual({ ok: true, value: 1 });
    expect(await operators.run(operator.session, ctx(operator), ownLog)).toEqual({ ok: true, value: 2 });
    expect((await operators.memberNames(operator.session, ctx(operator))).ok).toBe(true);
    expect(await operators.logEntries(operator.session, ctx(operator))).toEqual({ ok: true, value: [] });
    expect(await log().list()).toEqual([]);
  });
});
