import { env, runInDurableObject } from "cloudflare:test";
import type { CredentialLabels } from "passkey-cloudflare";
import { formatRecoveryCodes } from "passkey-cloudflare/browser";
import { decodeTypedBytewords, encodeBytewords } from "passkey-cloudflare/gordian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counting, overriding } from "./failing-namespaces.ts";
import { testApp, uniqueName, type Browser } from "./harness.ts";
import { PINNED_LABEL, PINNED_LABEL_BYTES, pinLabelDraws, savedLabel } from "./label-draws.ts";

const HOUR = 60 * 60 * 1000;
// Well-formed recovery codes that are never issued.
const WRONG_CODE = "ur:seed/oyadgdinaauyatsojkdmflfdfrfxtpbkvyfrzmcwntvdta";
const OTHER_WRONG_CODE = "tuna next jazz obey acid good iron aqua ugly aunt solo junk drum fuel fund fair flux trip back very fair zoom skew exam eyes epic";

const labelsOf = (recordId: string) => env.CREDENTIAL_LABELS.get(env.CREDENTIAL_LABELS.idFromName(recordId));

async function labelRows(recordId: string): Promise<number> {
  return runInDurableObject(labelsOf(recordId), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM labels").one().n,
  );
}

const recordOf = (recordId: string) => env.IDENTITY_RECORDS.get(env.IDENTITY_RECORDS.idFromName(recordId));

/** Every failure cause recorded on one record, read from its own object. */
function failureCausesOn(recordId: string) {
  return runInDurableObject(recordOf(recordId), (_instance, state) =>
    state.storage.sql
      .exec<{ cause: string }>("SELECT cause FROM failures")
      .toArray()
      .map((r) => r.cause),
  );
}

/** The record a credential id is indexed to, or null. */
function indexedRecord(credentialId: string) {
  return env.CREDENTIAL_INDEX.get(env.CREDENTIAL_INDEX.idFromName("global")).get(credentialId);
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

  it("accepts a code in the word form the page shows for reading aloud", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes, recoveryCodeWords } = await app.browser().register(name);
    expect(recoveryCodeWords).toHaveLength(recoveryCodes.length);
    for (const words of recoveryCodeWords) expect(words).toMatch(/^[a-z]{4}( [a-z]{4}){22}$/);

    const recovered = await recover(app.browser(), name, recoveryCodeWords[2]!);

    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).recordId).toBe(recordId);
    // Both forms name one code, so the UR is spent with it.
    expect((await recover(app.browser(), name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("accepts a whole line pasted from the copied codes", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes, issuedAt } = await app.browser().register(name);
    const text = formatRecoveryCodes({ site: "passkeydemo.shallweplay.com", memberName: name, issuedAt, codes: recoveryCodes });
    const line = text.split("\n").find((l) => l.includes(recoveryCodes[4]!))!;

    const recovered = await recover(app.browser(), name, ` ${line}\n`);

    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).recordId).toBe(recordId);
    expect((await recover(app.browser(), name, recoveryCodes[4]!)).status).toBe(400);
  });

  it("reports how many unused codes are left after each recovery", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    expect(recoveryCodes).toHaveLength(8);

    const first = await recover(app.browser(), name, recoveryCodes[0]!);
    expect((await first.json<{ codesLeft: number }>()).codesLeft).toBe(7);

    const second = await recover(app.browser(), name, recoveryCodes[5]!);
    expect((await second.json<{ codesLeft: number }>()).codesLeft).toBe(6);
  });

  it("accepts a code typed in capitals and without its ur:seed/ prefix", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);

    const recovered = await recover(app.browser(), name, recoveryCodes[0]!.slice("ur:seed/".length).toUpperCase());

    expect(recovered.status).toBe(200);
  });

  it("accepts a code read out as words, and spends it in that form too", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    const body = decodeTypedBytewords(recoveryCodes[2]!.slice("ur:seed/".length))!;
    const words = encodeBytewords(body, "standard");

    expect((await recover(app.browser(), name, words)).status).toBe(200);
    expect((await recover(app.browser(), name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("refuses text that is no code like a wrong code", async () => {
    const app = testApp();
    const name = uniqueName();
    await app.browser().register(name);

    const refused = await recover(app.browser(), name, "eeee-eeee-eeee-eeee-eeee-eeee");

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"ceremony refused"}');
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

    const refused = await recover(attacker, name, WRONG_CODE);

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
      expect((await recover(app.browser(), name, OTHER_WRONG_CODE)).status).toBe(400);
    }

    expect((await recover(app.browser(), name, recoveryCodes[0]!)).status).toBe(400);
    now += HOUR + 1;
    expect((await recover(app.browser(), name, recoveryCodes[0]!)).status).toBe(200);
  });

  it("counts a successful recovery once against the record's attempts", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recoveryCodes } = await app.browser().register(name);
    expect((await recover(app.browser(), name, recoveryCodes[0]!)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await recover(app.browser(), name, OTHER_WRONG_CODE)).status).toBe(400);
    }

    expect((await recover(app.browser(), name, recoveryCodes[1]!)).status).toBe(200);
    expect((await recover(app.browser(), name, recoveryCodes[2]!)).status).toBe(400);
  });

  it("finds a name typed without its accents or capitals", async () => {
    const app = testApp();
    const suffix = uniqueName("");
    const { recordId, recoveryCodes } = await app.browser().register(`José${suffix}`);
    const newDevice = app.browser();

    const recovered = await recover(newDevice, `jose${suffix}`, recoveryCodes[0]!);

    expect(recovered.status).toBe(200);
    expect(await newDevice.json(newDevice.get("/me"))).toMatchObject({ recordId, memberName: `José${suffix}` });
  });

  it("refuses an unknown member name like any other refusal", async () => {
    const app = testApp();

    const refused = await recover(app.browser(), uniqueName(), WRONG_CODE);

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
    expect(/\((.+)\)$/.exec(options.user.name)![1]).toBe(PINNED_LABEL);
    await runInDurableObject(labelsOf(recordId), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO labels (label, minted_at) VALUES (?, ?)",
        PINNED_LABEL_BYTES,
        Date.now(),
      );
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

describe("a refused recovery attempt", () => {
  it("with a wrong code, writes no index entry, label or session", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId } = await app.browser().register(name);
    const labelsBefore = await labelRows(recordId);
    const indexCalls = counting(env.CREDENTIAL_INDEX);
    app.vars.CREDENTIAL_INDEX = indexCalls.namespace;
    const attacker = app.browser();

    const refused = await recover(attacker, name, WRONG_CODE);

    expect(refused.status).toBe(400);
    expect(await failureCausesOn(recordId)).toContain("wrong-recovery-code");
    expect(attacker.session).toBeUndefined();
    expect(await labelRows(recordId)).toBe(labelsBefore);
    expect(indexCalls.calls).not.toContain("put");
    expect(await indexedRecord(attacker.authenticator.credentials[0]!.id)).toBeNull();
  });

  it("once the record is throttled, binds no label even for a right code", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    for (let i = 0; i < 5; i++) {
      expect((await recover(app.browser(), name, WRONG_CODE)).status).toBe(400);
    }
    const labelsBefore = await labelRows(recordId);
    const device = app.browser();

    const refused = await recover(device, name, recoveryCodes[0]!);

    expect(refused.status).toBe(400);
    expect(await failureCausesOn(recordId)).toContain("recovery-throttled");
    expect(await indexedRecord(device.authenticator.credentials[0]!.id)).toBeNull();
    expect(await labelRows(recordId)).toBe(labelsBefore);
  });

  it("racing another recovery with the same code, loses with its passkey neither indexed nor listed", async () => {
    const app = testApp();
    const name = uniqueName();
    const { recordId, recoveryCodes } = await app.browser().register(name);
    const code = recoveryCodes[0]!;
    // Hold the first commit until a second recovery with the same code has
    // finished, so that both pass the code check before either commits.
    let reachedCommit!: () => void;
    const firstAtCommit = new Promise<void>((resolve) => (reachedCommit = resolve));
    let releaseCommit!: () => void;
    const secondDone = new Promise<void>((resolve) => (releaseCommit = resolve));
    let recoverCalls = 0;
    app.vars.IDENTITY_RECORDS = overriding(env.IDENTITY_RECORDS, {
      recover: async (input) => {
        if (recoverCalls++ === 0) {
          reachedCommit();
          await secondDone;
        }
        return recordOf(recordId).recover(input);
      },
    });
    const first = app.browser();
    const second = app.browser();

    const firstAttempt = recover(first, name, code);
    await firstAtCommit;
    const won = await recover(second, name, code);
    releaseCommit();
    const lost = await firstAttempt;

    expect(won.status).toBe(200);
    expect(lost.status).toBe(400);
    expect(await failureCausesOn(recordId)).toContain("wrong-recovery-code");
    expect(first.session).toBeUndefined();
    expect(await indexedRecord(first.authenticator.credentials[0]!.id)).toBeNull();
    const { credentials } = await second.json(second.get("/me/credentials"));
    expect(credentials).toHaveLength(2);
    expect(credentials.map((c: any) => c.label)).not.toContain(savedLabel(first.authenticator.credentials[0]!));
  });
});
