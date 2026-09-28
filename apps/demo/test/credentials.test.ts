import { env, runInDurableObject } from "cloudflare:test";
import { seedWords } from "passkey-cloudflare/gordian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp, uniqueName } from "./harness.ts";
import { PINNED_LABEL, PINNED_LABEL_BYTES, pinLabelDraws, savedLabel } from "./label-draws.ts";

const MINUTE = 60 * 1000;
const APPLE_PASSWORDS = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

const labelsOf = (recordId: string) => env.CREDENTIAL_LABELS.get(env.CREDENTIAL_LABELS.idFromName(recordId));

/** Leave a record's credentials with no label bound to any of them. */
async function dropLabelBindings(recordId: string) {
  await runInDurableObject(labelsOf(recordId), (_instance, state) => {
    state.storage.sql.exec("UPDATE labels SET credential_id = NULL");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

    expect(label).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
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
        label: expect.stringMatching(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/),
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

  it("when revoked by a label in any typed form, name the dead entry as the password manager shows it, and the password manager", async () => {
    const name = uniqueName();
    const browser = testApp().browser({ aaguid: aaguidBytes(APPLE_PASSWORDS) });
    await browser.register(name);
    await browser.stepUp();
    await browser.enrol();
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    const label = credentials[0].label;

    const revoked = await browser.json(
      browser.post("/me/credentials/revoke", { label: label.toUpperCase().replace(/-/g, " ") }),
    );

    expect(revoked).toEqual({ ok: true, passkeyName: `${name} (${label})`, provider: "Apple Passwords" });
  });

  it("from an unknown password manager, when revoked, name the dead entry without a provider", async () => {
    const name = uniqueName();
    const browser = testApp().browser();
    await browser.register(name);
    await browser.stepUp();
    await browser.enrol();
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    const label = credentials[0].label;

    const revoked = await browser.json(browser.post("/me/credentials/revoke", { label }));

    expect(revoked).toEqual({ ok: true, passkeyName: `${name} (${label})`, provider: null });
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
    for (const label of repaired) expect(label).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    expect(new Set(repaired).size).toBe(2);
    expect(repaired).not.toContain(enrolledLabel);
    const again = await browser.json(browser.get("/me/credentials"));
    expect(again.credentials.map((c: any) => c.label)).toEqual(repaired);
    await labelsOf(recordId).bind(enrolledLabel!, second!.id, Date.now());
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

  it("are not recovered onto a label another passkey holds, and the recovery code still works", async () => {
    const app = testApp();
    const name = uniqueName();
    pinLabelDraws(2);
    const { recoveryCodes } = await app.browser().register(name);
    const collided = app.browser();
    const options = await collided.json(collided.post("/auth/recover/options", { memberName: name }));
    const response = await collided.authenticator.create(options);
    expect(collided.authenticator.credentials[0]!.userName).toBe(`${name} (${PINNED_LABEL})`);

    const refused = await collided.post("/auth/recover", { memberName: name, code: recoveryCodes[0], response });

    expect(refused.status).toBe(400);
    const retry = app.browser();
    const again = await retry.json(retry.post("/auth/recover/options", { memberName: name }));
    const retried = await retry.authenticator.create(again);
    expect((await retry.post("/auth/recover", { memberName: name, code: recoveryCodes[0], response: retried })).status).toBe(200);
    const { credentials } = await retry.json(retry.get("/me/credentials"));
    expect(credentials.map((c: any) => c.label)).toEqual([PINNED_LABEL, savedLabel(retry.authenticator.credentials[0]!)]);
  });

  it("stores a label as its three bytes, and spells it as words only when shown", async () => {
    const browser = testApp().browser();
    pinLabelDraws(1);
    const { recordId } = await browser.register(uniqueName());

    const rows = await runInDurableObject(labelsOf(recordId), (_instance, state) =>
      state.storage.sql
        .exec<{ kind: string; hex: string }>("SELECT typeof(label) AS kind, hex(label) AS hex FROM labels")
        .toArray(),
    );
    expect(rows).toEqual([{ kind: "blob", hex: "000000" }]);
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    expect(credentials.map((c: any) => c.label)).toEqual([PINNED_LABEL]);
  });

  it("finds no passkey for a label in the earlier two-word format", async () => {
    const browser = testApp().browser();
    await browser.register(uniqueName());
    await browser.stepUp();
    await browser.enrol();

    expect((await browser.post("/me/credentials/revoke", { label: "amber-falcon" })).status).toBe(404);
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    expect(credentials).toHaveLength(2);
  });

  it("never reissue a revoked passkey's label, when adding a passkey or when recovering", async () => {
    const app = testApp();
    const name = uniqueName();
    const browser = app.browser();
    pinLabelDraws(1);
    const { recoveryCodes } = await browser.register(name);
    vi.restoreAllMocks();
    await browser.stepUp();
    await browser.enrol();
    expect((await browser.post("/me/credentials/revoke", { label: PINNED_LABEL })).status).toBe(200);

    // Adding a passkey: the retired label is drawn first, and passed over.
    const enrolDraws = pinLabelDraws(1);
    const { label: enrolled } = await browser.enrol();
    vi.restoreAllMocks();

    expect(enrolDraws()).toBe(2);
    expect(enrolled).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    expect(enrolled).not.toBe(PINNED_LABEL);

    // Recovering: the retired label is drawn unchecked, never bound, and the recovery is refused.
    const refusedDevice = app.browser();
    const recoverDraws = pinLabelDraws(1);
    const options = await refusedDevice.json(refusedDevice.post("/auth/recover/options", { memberName: name }));
    vi.restoreAllMocks();
    expect(recoverDraws()).toBe(1);
    const response = await refusedDevice.authenticator.create(options);
    expect((await refusedDevice.post("/auth/recover", { memberName: name, code: recoveryCodes[0], response })).status).toBe(400);
    const device = app.browser();
    const retry = await device.json(device.post("/auth/recover/options", { memberName: name }));
    const retried = await device.authenticator.create(retry);
    expect((await device.post("/auth/recover", { memberName: name, code: recoveryCodes[0], response: retried })).status).toBe(200);

    const { credentials } = await device.json(device.get("/me/credentials"));
    const labels = credentials.map((c: any) => c.label);
    expect(labels).toHaveLength(3);
    expect(labels).not.toContain(PINNED_LABEL);
    expect(new Set(labels).size).toBe(3);
    await device.stepUp();
    expect((await device.post("/me/credentials/revoke", { label: PINNED_LABEL })).status).toBe(404);
  });

  it("never resolve a revoked passkey's label, even when its row names a passkey still in use", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    await browser.stepUp();
    pinLabelDraws(1);
    await browser.enrol();
    vi.restoreAllMocks();
    // A third passkey, so the pinned one is never the last and a wrong resolve could revoke it.
    await browser.enrol();
    const [first, pinned] = browser.authenticator.credentials;
    const retiredLabel = savedLabel(first!);
    expect((await browser.post("/me/credentials/revoke", { label: retiredLabel })).status).toBe(200);

    // A corrupted or migrated row: the retired label now names the pinned passkey. Its own
    // row lets go of it first, since a credential holds at most one row.
    await runInDurableObject(labelsOf(recordId), (_instance, state) => {
      const sql = state.storage.sql;
      const retired = sql.exec<{ label: ArrayBuffer }>("SELECT label FROM labels WHERE retired_at IS NOT NULL").toArray();
      expect(retired).toHaveLength(1);
      const pinnedId = sql
        .exec<{ credential_id: string }>("SELECT credential_id FROM labels WHERE label = ?", PINNED_LABEL_BYTES)
        .one().credential_id;
      sql.exec("UPDATE labels SET credential_id = NULL WHERE label = ?", PINNED_LABEL_BYTES);
      sql.exec("UPDATE labels SET credential_id = ? WHERE label = ?", pinnedId, retired[0]!.label);
    });

    expect((await browser.post("/me/credentials/revoke", { label: retiredLabel })).status).toBe(404);
    const { credentials } = await browser.json(browser.get("/me/credentials"));
    expect(credentials).toHaveLength(2);
    const options = await browser.json(browser.post("/auth/login/options"));
    const response = await browser.authenticator.get(options, {}, pinned!.id);
    expect((await browser.post("/auth/login/verify", { response })).status).toBe(200);
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
    expect(rotated.recoveryCodeWords).toEqual(rotated.recoveryCodes.map(seedWords));
  });
});
