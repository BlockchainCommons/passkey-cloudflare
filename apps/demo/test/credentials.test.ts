import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

const MINUTE = 60 * 1000;
const APPLE_PASSWORDS = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

const labelsOf = (recordId: string) => env.CREDENTIAL_LABELS.get(env.CREDENTIAL_LABELS.idFromName(recordId));

/** Leave a record's credentials as a failed label bind would: no label bound to any of them. */
async function dropLabelBindings(recordId: string) {
  await runInDurableObject(labelsOf(recordId), (_instance, state) => {
    state.storage.sql.exec("UPDATE labels SET credential_id = NULL");
  });
}

function aaguidBytes(uuid: string): Uint8Array {
  return new Uint8Array(uuid.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
}

describe("step-up", () => {
  it("is required before adding a passkey", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());

    const refused = await browser.post("/me/credentials/enrol/options");
    expect(refused.status).toBe(403);

    await browser.stepUp();
    expect((await browser.post("/me/credentials/enrol/options")).status).toBe(200);
  });

  it("lasts ten minutes", async () => {
    let now = Date.now();
    const browser = testApp({ clock: () => now }).browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    const steppedUp = now;

    now = steppedUp + 10 * MINUTE;
    expect((await browser.post("/me/credentials/enrol/options")).status).toBe(200);
    now = steppedUp + 10 * MINUTE + 1;
    expect((await browser.post("/me/credentials/enrol/options")).status).toBe(403);
  });

  it("belongs to the session that performed it", async () => {
    const app = testApp();
    const phone = app.browser();
    await phone.register(uniqueName());
    const laptop = app.browser();
    laptop.authenticator.credentials.push(...phone.authenticator.credentials);
    await laptop.login();

    await laptop.stepUp();

    expect((await phone.post("/me/credentials/enrol/options")).status).toBe(403);
  });
});

describe("passkeys", () => {
  it("can be added, and then any of them logs in", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    const [first] = browser.authenticator.credentials;
    await browser.stepUp();

    const { label } = await browser.enrol();

    expect(label).toMatch(/^[a-z]+-[a-z]+$/);
    const [, second] = browser.authenticator.credentials;
    expect((await browser.login(first!.id)).recordId).toBe(recordId);
    expect((await browser.login(second!.id)).recordId).toBe(recordId);
  });

  it("are listed with label, dates, password manager and sync status, but no key material", async () => {
    let now = Date.now();
    const app = testApp({ clock: () => now });
    const browser = app.browser({ aaguid: aaguidBytes(APPLE_PASSWORDS), backupEligible: true });
    await browser.register(uniqueName());
    const registeredAt = now;
    now += MINUTE;
    await browser.login();

    const { credentials } = await browser.json(browser.get("/me/credentials"));

    expect(credentials).toEqual([
      {
        label: expect.stringMatching(/^[a-z]+-[a-z]+$/),
        createdAt: registeredAt,
        lastUsedAt: registeredAt + MINUTE,
        provider: "Apple Passwords",
        backupEligible: true,
        backedUp: true,
      },
    ]);
  });

  it("from an unknown password manager are listed without a provider name", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());

    const { credentials } = await browser.json(browser.get("/me/credentials"));

    expect(credentials[0]).toMatchObject({ provider: null, backupEligible: false, lastUsedAt: null });
  });

  it("can be revoked by label, after which that passkey no longer logs in", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());
    const [first] = browser.authenticator.credentials;
    await browser.stepUp();
    await browser.enrol();
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    const firstLabel = credentials[0].label;

    const revoked = await browser.post("/me/credentials/revoke", { label: firstLabel });

    expect(revoked.status).toBe(200);
    const after = await browser.json(browser.get("/me/credentials"));
    expect(after.credentials.map((c: any) => c.label)).not.toContain(firstLabel);
    const options = await browser.json(browser.post("/auth/login/options"));
    const response = await browser.authenticator.get(options, {}, first!.id);
    expect((await browser.post("/auth/login/verify", { response })).status).toBe(400);
  });

  it("left without a label are given one when listed, and that label revokes them", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    await browser.stepUp();
    const { label: enrolledLabel } = await browser.enrol();
    const [, second] = browser.authenticator.credentials;
    await dropLabelBindings(recordId);

    const { credentials } = await browser.json(browser.get("/me/credentials"));
    const repaired = credentials.map((c: any) => c.label);

    expect(repaired).toHaveLength(2);
    for (const label of repaired) expect(label).toMatch(/^[a-z]+-[a-z]+$/);
    expect(new Set(repaired).size).toBe(2);
    expect(repaired).not.toContain(enrolledLabel);
    const again = await browser.json(browser.get("/me/credentials"));
    expect(again.credentials.map((c: any) => c.label)).toEqual(repaired);
    await labelsOf(recordId).bind(enrolledLabel, second!.id, Date.now());
    const afterLateBind = await browser.json(browser.get("/me/credentials"));
    expect(afterLateBind.credentials.map((c: any) => c.label)).toEqual(repaired);

    const revoked = await browser.post("/me/credentials/revoke", { label: repaired[1] });

    expect(revoked.status).toBe(200);
    const after = await browser.json(browser.get("/me/credentials"));
    expect(after.credentials.map((c: any) => c.label)).toEqual([repaired[0]]);
    const options = await browser.json(browser.post("/auth/login/options"));
    const response = await browser.authenticator.get(options, {}, second!.id);
    expect((await browser.post("/auth/login/verify", { response })).status).toBe(400);
  });

  it("need a step-up to revoke", async () => {
    let now = Date.now();
    const browser = testApp({ clock: () => now }).browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    await browser.enrol();
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    now += 11 * MINUTE;

    const refused = await browser.post("/me/credentials/revoke", { label: credentials[0].label });

    expect(refused.status).toBe(403);
  });
});

describe("recovery codes", () => {
  it("can be rotated after a step-up, giving eight new codes", async () => {
    const browser = testApp().browser();
    const { recoveryCodes } = await browser.register(uniqueName());
    expect((await browser.post("/me/recovery-codes/rotate")).status).toBe(403);
    await browser.stepUp();

    const rotated = await browser.json(browser.post("/me/recovery-codes/rotate"));

    expect(rotated.recoveryCodes).toHaveLength(8);
    for (const code of rotated.recoveryCodes) expect(recoveryCodes).not.toContain(code);
  });
});
