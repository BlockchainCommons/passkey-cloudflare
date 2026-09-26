import { env, runInDurableObject } from "cloudflare:test";
import type { CredentialLabels } from "passkey-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp, uniqueName, type Browser } from "./harness.ts";

const HOUR = 60 * 60 * 1000;

const labelsOf = (recordId: string) => env.CREDENTIAL_LABELS.get(env.CREDENTIAL_LABELS.idFromName(recordId));

async function labelRows(recordId: string): Promise<number> {
  return runInDurableObject(labelsOf(recordId), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM labels").one().n,
  );
}

/**
 * Make every label drawn from here on the same label, leaving all other
 * randomness alone. Labels are the only draws shorter than eight bytes.
 * Returns the number of label draws made so far.
 */
function pinLabelDraws(): () => number {
  const real = crypto.getRandomValues.bind(crypto);
  let draws = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
    if (array.length >= 8) return real(array);
    draws++;
    return array.fill(0);
  }) as typeof crypto.getRandomValues);
  return () => draws;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A person on a new device with nothing but their member name and a code. */
async function recover(device: Browser, memberName: string, code: string) {
  const options = await device.json(device.post("/auth/recover/options", { memberName }));
  const response = await device.authenticator.create(options);
  return device.post("/auth/recover", { memberName, code, response });
}

describe("recovery", () => {
  it("binds a new passkey to the existing record and logs the person in", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const newDevice = app.browser();

    const recovered = await recover(newDevice, name, recoveryCodes[3]!);

    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).recordId).toBe(recordId);
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId, memberName: name });
    newDevice.session = undefined;
    expect((await newDevice.login()).recordId).toBe(recordId);
  });

  it("accepts a code typed in capitals and without dashes", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);

    const recovered = await recover(app.browser(), name, recoveryCodes[0]!.replace(/-/g, "").toUpperCase());

    expect(recovered.status).toBe(200);
  });

  it("accepts each code only once", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    await recover(app.browser(), name, recoveryCodes[0]!);

    const again = await recover(app.browser(), name, recoveryCodes[0]!);

    expect(again.status).toBe(400);
  });

  it("refuses a wrong code and binds nothing", async () => {
    const app = testApp();
    const name = uniqueName();
    await app.browser().register(name);
    const attacker = app.browser();

    const refused = await recover(attacker, name, "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa");

    expect(refused.status).toBe(400);
    expect(attacker.session).toBeUndefined();
    const options = await attacker.json(attacker.post("/auth/login/options"));
    const login = await attacker.post("/auth/login/verify", { response: await attacker.authenticator.get(options) });
    expect(login.status).toBe(400);
  });

  it("stops accepting codes replaced by a rotation", async () => {
    const app = testApp();
    const name = uniqueName();
    const person = app.browser();
    const { recoveryCodes } = await person.register(name);
    await person.stepUp();
    await person.post("/me/recovery-codes/rotate");

    const refused = await recover(app.browser(), name, recoveryCodes[0]!);

    expect(refused.status).toBe(400);
  });

  it("allows five attempts per hour for a record", async () => {
    let now = Date.now();
    const app = testApp({ clock: () => now });
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    for (let i = 0; i < 5; i++) {
      expect((await recover(app.browser(), name, "bbbb-bbbb-bbbb-bbbb-bbbb-bbbb")).status).toBe(400);
    }

    expect((await recover(app.browser(), name, recoveryCodes[0]!)).status).toBe(400);
    now += HOUR + 1;
    expect((await recover(app.browser(), name, recoveryCodes[0]!)).status).toBe(200);
  });

  it("refuses an unknown member name like any other refusal", async () => {
    const app = testApp();

    const refused = await recover(app.browser(), uniqueName(), "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa");

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');
  });

  it("stores no label for options on a known member name", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId } = await app.browser().register(name);
    const before = await labelRows(recordId);

    for (let i = 0; i < 5; i++) {
      const device = app.browser();
      expect((await device.post("/auth/recover/options", { memberName: name })).status).toBe(200);
    }

    expect(await labelRows(recordId)).toBe(before);
  });

  it("completes on a record whose label namespace is full, where minting gives up", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const labelDraws = pinLabelDraws();
    const device = app.browser();
    const options = await device.json(device.post("/auth/recover/options", { memberName: name }));
    const pinned = /\((.+)\)$/.exec(options.user.name)![1]!;
    await runInDurableObject(labelsOf(recordId), (_instance, state) => {
      state.storage.sql.exec("INSERT OR IGNORE INTO labels (label, minted_at) VALUES (?, ?)", pinned, Date.now());
    });

    const drawsBefore = labelDraws();
    await runInDurableObject(labelsOf(recordId), (instance) => {
      expect(() => (instance as CredentialLabels).mint(Date.now())).toThrow(/label/);
    });
    const tries = labelDraws() - drawsBefore;
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(1000);

    const response = await device.authenticator.create(options);
    const recovered = await device.post("/auth/recover", { memberName: name, code: recoveryCodes[0]!, response });
    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).recordId).toBe(recordId);
  });
});
