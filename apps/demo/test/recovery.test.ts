import { describe, expect, it } from "vitest";
import { testApp, uniqueName, type Browser } from "./harness.ts";

const HOUR = 60 * 60 * 1000;

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
});
