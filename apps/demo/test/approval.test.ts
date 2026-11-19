import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { coseKeyToJwk, identityRecords, type RecordId } from "passkey-cloudflare";
import { fromBase64Url, toBase64Url } from "passkey-cloudflare/browser";
import { dumpDurableState, hex } from "./durable-state.ts";
import { failuresOn } from "./failure-log.ts";
import { Browser, prepared, refusal, testApp, uniqueName, type TestApp } from "./harness.ts";

// An approval: a person's passkey signs a challenge that is exactly the app's
// digest of a payload. The demo's digest is the SHA-256 of the text it shows.

const REFUSAL = '{"error":"ceremony refused"}';

/** SHA-256 of "hello", from the NIST-style test vectors everyone quotes. */
const HELLO_SHA256_HEX = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** A text no other test approves, so its digest found in storage can only be this test's. */
function uniqueText(): string {
  return `approve ${uniqueName("text")}`;
}

/** The stored sign counter of each of a record's credentials, by credential ID. */
async function signCounts(app: TestApp, recordId: string): Promise<Record<string, number>> {
  const rows = await runInDurableObject(
    identityRecords(env.IDENTITY_RECORDS, app.storagePrefix)(recordId as RecordId),
    (_instance, state) =>
      state.storage.sql.exec<{ id: string; sign_count: number }>("SELECT id, sign_count FROM credentials").toArray(),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.sign_count]));
}

/** An ECDSA signature in DER, as WebAuthn carries it, in the raw r || s form WebCrypto takes. */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(64);
  let at = 2;
  for (const half of [0, 32]) {
    const length = der[at + 1]!;
    let value = der.subarray(at + 2, at + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    raw.set(value, half + 32 - value.length);
    at += 2 + length;
  }
  return raw;
}

/** The rows every challenge store holds, without the schema lines a newly reached store adds. */
async function challengeRows(): Promise<string> {
  const lines = (await dumpDurableState(["CHALLENGES"])).split("\n");
  return lines.filter((line) => line.startsWith("CHALLENGES challenges ")).sort().join("\n");
}

async function registered(app: TestApp) {
  const browser = app.browser();
  const { recordId } = await browser.register(uniqueName());
  return { browser, recordId };
}

describe("approval options", () => {
  it("make the challenge the digest, byte for byte", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());

    const options = await browser.json(browser.post("/me/approve/options", { text: "hello" }));

    expect(options.challenge).toBe(toBase64Url(new Uint8Array(HELLO_SHA256_HEX.match(/../g)!.map((pair) => parseInt(pair, 16)))));
  });

  it("allow every one of the record's passkeys, or only those listed", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    await browser.enrol();
    const [first, second] = browser.authenticator.credentials.map((c) => c.id);

    const all = await browser.json(browser.post("/me/approve/options", { text: uniqueText() }));
    const listed = await browser.json(
      browser.post("/me/approve/options", { text: uniqueText(), credentialIds: [second] }),
    );

    expect(all.allowCredentials.map((c: { id: string }) => c.id).sort()).toEqual([first, second].sort());
    expect(listed.allowCredentials.map((c: { id: string }) => c.id)).toEqual([second]);
  });

  it("refuse a listed credential that is not the record's", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    const other = app.browser();
    await other.register(uniqueName());
    const otherCredential = other.authenticator.credentials[0]!.id;

    const response = await browser.post("/me/approve/options", { text: uniqueText(), credentialIds: [otherCredential] });

    expect(response.status).toBe(404);
  });

  it("need a live session", async () => {
    const app = testApp();
    const browser = app.browser();

    const response = await browser.post("/me/approve/options", { text: uniqueText() });

    expect(response.status).toBe(401);
  });
});

describe("approval", () => {
  it("return the assertion as sent, a signature over the digest that the stored public key verifies", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    const text = uniqueText();
    const request = prepared(await browser.client.approveRequest(text));
    const sent = (request.body as { response: { id: string; response: Record<string, string> } }).response;

    const approval = await browser.json(browser.post(request.path, request.body));

    expect(approval).toMatchObject({
      credentialId: sent.id,
      authenticatorData: sent.response.authenticatorData,
      clientDataJSON: sent.response.clientDataJSON,
      signature: sent.response.signature,
      userVerified: true,
      backupEligible: false,
      backedUp: false,
    });
    const [listed] = await browser.client.credentials();
    expect(approval.publicKey).toEqual(listed!.publicKey);
    // The challenge the passkey signed is the digest of the text.
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(approval.clientDataJSON)));
    expect(clientData.challenge).toBe(toBase64Url(await sha256(text)));
    // And anyone holding the public key can check the signature, as WebAuthn defines it.
    const key = await crypto.subtle.importKey(
      "jwk",
      coseKeyToJwk(fromBase64Url(approval.publicKey.cose)) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const authData = fromBase64Url(approval.authenticatorData);
    const signed = new Uint8Array([...authData, ...(await sha256(fromBase64Url(approval.clientDataJSON)))]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      derToRaw(fromBase64Url(approval.signature)),
      signed,
    );
    expect(valid).toBe(true);
  });

  it("refuse a replayed assertion, recording why", async () => {
    const app = testApp();
    const { browser, recordId } = await registered(app);
    const request = prepared(await browser.client.approveRequest(uniqueText()));
    await browser.json(browser.post(request.path, request.body));
    const counts = await signCounts(app, recordId);

    const replay = await browser.post(request.path, request.body);

    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe(REFUSAL);
    expect(await signCounts(app, recordId)).toEqual(counts);
    expect(await failuresOn(app.storagePrefix, recordId)).toEqual([{ ceremony: "approve", cause: "unknown-challenge" }]);
  });

  it("refuse an assertion sent on another of the record's sessions, leaving the pending approval to its own", async () => {
    const app = testApp();
    const { browser, recordId } = await registered(app);
    const elsewhere = new Browser(app, browser.authenticator);
    await elsewhere.login();
    const request = prepared(await browser.client.approveRequest(uniqueText()));
    const counts = await signCounts(app, recordId);

    const refused = await elsewhere.post(request.path, request.body);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await signCounts(app, recordId)).toEqual(counts);
    expect(await failuresOn(app.storagePrefix, recordId)).toEqual([{ ceremony: "approve", cause: "unknown-challenge" }]);
    // The session that asked can still complete it.
    expect((await browser.post(request.path, request.body)).status).toBe(200);
  });

  it("refuse an assertion over another text than the one the session asked to approve", async () => {
    const app = testApp();
    const { browser, recordId } = await registered(app);
    const request = prepared(await browser.client.approveRequest(uniqueText()));
    const counts = await signCounts(app, recordId);

    const refused = await browser.post(request.path, { ...(request.body as object), text: uniqueText() });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await signCounts(app, recordId)).toEqual(counts);
    expect(await failuresOn(app.storagePrefix, recordId)).toEqual([{ ceremony: "approve", cause: "unknown-challenge" }]);
  });

  it("refuse a passkey the approval did not list, before it changes anything", async () => {
    const app = testApp();
    const { browser, recordId } = await registered(app);
    await browser.enrol();
    // The approval lists one of the IDs the record's own listing gives.
    const [first, second] = (await browser.client.credentials()).map((c) => c.credentialId);
    const text = uniqueText();
    const options = await browser.json(browser.post("/me/approve/options", { text, credentialIds: [first] }));
    // A client that ignores allowCredentials and signs with the other passkey.
    const response = await browser.authenticator.get({ ...options, allowCredentials: [] }, {}, second);
    const counts = await signCounts(app, recordId);

    const refused = await browser.post("/me/approve/verify", { text, response });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(REFUSAL);
    expect(await signCounts(app, recordId)).toEqual(counts);
    expect(await failuresOn(app.storagePrefix, recordId)).toEqual([
      { ceremony: "approve", cause: "credential-not-allowed" },
    ]);
  });

  it("accept only the passkeys named by IDs from the record's own listing", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    await browser.enrol();
    const listed = (await browser.client.credentials()).map((c) => c.credentialId);
    expect(listed.sort()).toEqual(browser.authenticator.credentials.map((c) => c.id).sort());

    for (const credentialId of listed) {
      expect((await browser.approve(uniqueText(), [credentialId])).credentialId).toBe(credentialId);
    }
  });

  it("advance the sign count, and refuse a count that goes backwards", async () => {
    const app = testApp();
    const { browser, recordId } = await registered(app);
    const credentialId = browser.authenticator.credentials[0]!.id;
    const before = (await signCounts(app, recordId))[credentialId]!;

    await browser.approve(uniqueText());
    const after = (await signCounts(app, recordId))[credentialId]!;
    const regressed = refusal(await browser.clientAnswering({ tamper: { signCount: after } }).approve(uniqueText()));

    expect(after).toBeGreaterThan(before);
    expect(await regressed.text()).toBe(REFUSAL);
    expect((await signCounts(app, recordId))[credentialId]).toBe(after);
    expect(await failuresOn(app.storagePrefix, recordId)).toEqual([{ ceremony: "approve", cause: "counter-regressed" }]);
  });

  it("open no step-up window", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    // Registration starts a session with no step-up.
    await browser.approve(uniqueText());

    const gated = await browser.post("/me/recovery-codes/rotate");

    expect(gated.status).toBe(403);
    expect(await gated.json()).toEqual({ error: "step-up-required" });
  });

  it("keep nothing of the payload", async () => {
    const app = testApp();
    const { browser } = await registered(app);
    const text = uniqueText();
    const digest = await sha256(text);
    const pendingBefore = await challengeRows();

    const request = prepared(await browser.client.approveRequest(text));
    const pending = await challengeRows();
    await browser.json(browser.post(request.path, request.body));
    const after = await dumpDurableState();

    // The pending challenge was held while the approval ran, and is gone once it is consumed.
    expect(pending).not.toBe(pendingBefore);
    expect(await challengeRows()).toBe(pendingBefore);
    for (const form of [text, hex(digest), toBase64Url(digest)]) expect(after).not.toContain(form);
  });
});
