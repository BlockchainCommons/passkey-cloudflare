import { env, runInDurableObject } from "cloudflare:test";
import { IdentityRecord, MemberNameRegistry } from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

// A deployed object keeps the tables it was created with: CREATE TABLE IF NOT
// EXISTS does not add a column the schema gained later. These tests take a
// column away, as storage created before it would lack it, then start the
// object again and use it through HTTP.

/** A member-name namespace that resolves "global" to a registry no other test uses. */
function privateMemberNames() {
  const real = env.MEMBER_NAMES;
  const id = real.idFromName(crypto.randomUUID());
  const namespace: Env["MEMBER_NAMES"] = new Proxy(real, {
    get: (target, property) => {
      if (property === "idFromName") return () => id;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { namespace, stub: real.get(id) };
}

describe("storage created before a column was added", () => {
  it("still serves an identity record that lacks removed_at", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName("old"));
    const stub = env.IDENTITY_RECORDS.get(env.IDENTITY_RECORDS.idFromName(recordId));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE record DROP COLUMN removed_at");
      new IdentityRecord(state, env);
    });

    expect(await browser.json(browser.get("/me"))).toMatchObject({ recordId });
  });

  it("still serves a member-name registry whose history lacks retired_at", async () => {
    const app = testApp();
    const names = privateMemberNames();
    app.vars.MEMBER_NAMES = names.namespace;
    const operator = app.browser();
    const operatorName = uniqueName("operator");
    const { recordId: operatorId } = await operator.register(operatorName);
    app.vars.OPERATOR_RECORD_IDS = operatorId;
    await operator.stepUp();

    await runInDurableObject(names.stub, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE name_history DROP COLUMN retired_at");
      new MemberNameRegistry(state, env);
    });

    const lookup = await operator.post("/operator/lookup", { memberName: operatorName });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ recordId: operatorId, retired: false });
  });
});
