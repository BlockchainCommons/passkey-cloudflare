import { describe, expect, it } from "vitest";
import { narrowVerifier, type RelyingParty, type Verifier } from "passkey-cloudflare";
import { fromBase64Url, toBase64Url } from "passkey-cloudflare/browser";
import { fullVerifier } from "passkey-cloudflare/full-verifier";
import { SoftwareAuthenticator, type Algorithm, type Tamper } from "passkey-cloudflare/testing";

// The narrow verifier against the full one, on the same responses. Wherever
// the narrow verifier accepts, the full one must accept with the same result;
// the one planned difference is that the narrow verifier ignores the
// attestation statement, which the policy never trusts.

const rp: RelyingParty = { id: "verifier.test", name: "Verifier test", origin: "https://verifier.test" };

type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, reason: (error as { reason?: string }).reason ?? String(error) };
  }
}

function challenge() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A registration made against `verifier`'s options, with the challenge it answers. */
async function registration(verifier: Verifier, authenticator: SoftwareAuthenticator, tamper: Tamper = {}) {
  const options = await verifier.creationOptions({ rp, challenge: challenge(), userName: "Alice (able-acid-also)" });
  return { response: await authenticator.create(options, tamper), challenge: options.challenge };
}

function verifyRegistrationBoth(response: Parameters<Verifier["verifyRegistration"]>[0], expectedChallenge: string) {
  const expected = { rp, challenge: expectedChallenge };
  return Promise.all([
    outcome(() => narrowVerifier.verifyRegistration(response, expected)),
    outcome(() => fullVerifier.verifyRegistration(response, expected)),
  ]);
}

/** A registered credential, as the record stores it, and the authenticator that holds it. */
async function registered(algorithm: Algorithm, backupEligible = false) {
  const authenticator = new SoftwareAuthenticator({ origin: rp.origin, algorithm, backupEligible });
  const { response, challenge: c } = await registration(fullVerifier, authenticator);
  const credential = await fullVerifier.verifyRegistration(response, { rp, challenge: c });
  return { authenticator, credential };
}

async function assertionBoth(
  { authenticator, credential }: Awaited<ReturnType<typeof registered>>,
  tamper: Tamper = {},
  stored: { signCount?: number; enforceCounter?: boolean } = {},
) {
  const options = await narrowVerifier.requestOptions({ rp, challenge: challenge() });
  const response = await authenticator.get(options, tamper);
  return { response, options, results: await assertBoth(response, options.challenge, credential, stored) };
}

function assertBoth(
  response: Parameters<Verifier["verifyAssertion"]>[0],
  expectedChallenge: string,
  credential: { id: string; publicKey: Uint8Array },
  stored: { signCount?: number; enforceCounter?: boolean } = {},
) {
  const expected = {
    rp,
    challenge: expectedChallenge,
    credential: {
      id: credential.id,
      publicKey: Uint8Array.from(credential.publicKey),
      signCount: stored.signCount ?? 0,
      enforceCounter: stored.enforceCounter ?? true,
    },
  };
  return Promise.all([
    outcome(() => narrowVerifier.verifyAssertion(response, expected)),
    outcome(() => fullVerifier.verifyAssertion(response, expected)),
  ]);
}

const TAMPERS: [string, Tamper][] = [
  ["another challenge", { challenge: "bm90LWEtY2hhbGxlbmdlLWZyb20tdGhpcy1zZXJ2ZXI" }],
  ["another origin", { origin: "https://evil.example" }],
  ["another relying party", { rpId: "evil.example" }],
  ["the user not present", { userAbsent: true }],
];

describe("the narrow verifier's options", () => {
  it("match the full verifier's, offering only ES256 and Ed25519", async () => {
    const input = { rp, challenge: challenge(), userName: "Alice (able-acid-also)", excludeCredentialIds: ["AAAA", "AQID"] };
    const narrow = await narrowVerifier.creationOptions(input);
    const full = await fullVerifier.creationOptions(input);
    expect(narrow.pubKeyCredParams).toEqual([
      { alg: -8, type: "public-key" },
      { alg: -7, type: "public-key" },
    ]);
    expect(full.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    // Each ceremony gets a fresh user handle, so only its length is compared.
    expect(fromBase64Url(narrow.user.id)).toHaveLength(32);
    const comparable = (o: typeof narrow) => ({ ...o, user: { ...o.user, id: "" }, pubKeyCredParams: [] });
    expect(comparable(narrow)).toEqual(comparable(full));

    const request = { rp, challenge: challenge(), allowCredentialIds: ["AAAA"] };
    expect(await narrowVerifier.requestOptions(request)).toEqual(await fullVerifier.requestOptions(request));
  });
});

describe("a registration", () => {
  for (const algorithm of ["ES256", "Ed25519"] as const) {
    for (const backupEligible of [false, true]) {
      const kind = `${algorithm}${backupEligible ? ", synced" : ""}`;

      it(`verifies to the same credential in both verifiers (${kind})`, async () => {
        const authenticator = new SoftwareAuthenticator({ origin: rp.origin, algorithm, backupEligible });
        const { response, challenge: c } = await registration(narrowVerifier, authenticator);
        const [narrow, full] = await verifyRegistrationBoth(response, c);
        expect(narrow.ok).toBe(true);
        expect(narrow).toEqual(full);
      });

      for (const [name, tamper] of [...TAMPERS, ["the wrong ceremony type", { type: "webauthn.get" }] as [string, Tamper]]) {
        it(`with ${name} is refused by both, for the same reason (${kind})`, async () => {
          const authenticator = new SoftwareAuthenticator({ origin: rp.origin, algorithm, backupEligible });
          const { response, challenge: c } = await registration(narrowVerifier, authenticator, tamper);
          const [narrow, full] = await verifyRegistrationBoth(response, c);
          expect(narrow.ok).toBe(false);
          expect(narrow).toEqual(full);
        });
      }
    }
  }

  it("with an RS256 key is accepted only by the full verifier", async () => {
    const authenticator = new SoftwareAuthenticator({ origin: rp.origin, algorithm: "RS256" });
    const { response, challenge: c } = await registration(fullVerifier, authenticator);
    const [narrow, full] = await verifyRegistrationBoth(response, c);
    expect(full.ok).toBe(true);
    expect(narrow).toEqual({ ok: false, reason: "unsupported-algorithm" });
  });

  it("with an attestation statement it never asked for is accepted by the narrow verifier, which ignores it", async () => {
    const authenticator = new SoftwareAuthenticator({ origin: rp.origin });
    const { response, challenge: c } = await registration(narrowVerifier, authenticator, { attestationFormat: "packed" });
    const [narrow, full] = await verifyRegistrationBoth(response, c);
    expect(narrow.ok).toBe(true);
    expect(full.ok).toBe(false);
  });
});

describe("an assertion", () => {
  for (const algorithm of ["ES256", "Ed25519", "RS256"] as const) {
    it(`verifies the same in both verifiers (${algorithm})`, async () => {
      if (algorithm === "RS256") {
        // The narrow verifier refuses a stored RS256 key rather than guess at it.
        const { results } = await assertionBoth(await registered(algorithm));
        expect(results[1].ok).toBe(true);
        expect(results[0]).toEqual({ ok: false, reason: "unsupported-algorithm" });
        return;
      }
      const { results } = await assertionBoth(await registered(algorithm));
      expect(results[0].ok).toBe(true);
      expect(results[0]).toEqual(results[1]);
    });
  }

  for (const algorithm of ["ES256", "Ed25519"] as const) {
    for (const [name, tamper] of [
      ...TAMPERS,
      ["a bad signature", { badSignature: true }],
      ["the wrong ceremony type", { type: "webauthn.create" }],
    ] as [string, Tamper][]) {
      it(`with ${name} is refused by both, for the same reason (${algorithm})`, async () => {
        const { results } = await assertionBoth(await registered(algorithm), tamper);
        expect(results[0].ok).toBe(false);
        expect(results[0]).toEqual(results[1]);
      });
    }

    it(`whose counter has not advanced is refused by both when the counter is enforced (${algorithm})`, async () => {
      const held = await registered(algorithm);
      const enforced = await assertionBoth(held, { signCount: 3 }, { signCount: 5, enforceCounter: true });
      expect(enforced.results[0]).toEqual({ ok: false, reason: "counter-regressed" });
      expect(enforced.results[1]).toEqual(enforced.results[0]);
      const synced = await assertionBoth(held, { signCount: 3 }, { signCount: 5, enforceCounter: false });
      expect(synced.results[0].ok).toBe(true);
      expect(synced.results[1]).toEqual(synced.results[0]);
    });
  }
});

// --- byte flips ---------------------------------------------------------------

/** A small seeded generator, so a failing flip can be replayed. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flip(field: string, random: () => number): { field: string; at: number } & { bytes: Uint8Array } {
  const bytes = fromBase64Url(field).slice();
  const at = Math.floor(random() * bytes.length);
  bytes[at]! ^= 1 << Math.floor(random() * 8);
  return { field, at, bytes };
}

const FLIPS = 120;

/**
 * Why the narrow verifier may refuse a registration the full one accepts: it
 * checks the whole public key at registration, and its CBOR decoder refuses
 * what the full one's tolerates, such as a byte string longer than its input.
 */
const STRICTER_PARSING = ["malformed-response", "bad-public-key", "unsupported-algorithm"];

describe("under single-bit flips", () => {
  for (const algorithm of ["ES256", "Ed25519"] as const) {
    // The narrow verifier checks the whole public key at registration, where the
    // full one checks only its algorithm until the first assertion; so it may
    // refuse a registration the full one takes, never the reverse.
    it(`a registration is never accepted by the narrow verifier alone, except in its attestation statement (${algorithm})`, async () => {
      const random = prng(algorithm === "ES256" ? 1 : 2);
      const authenticator = new SoftwareAuthenticator({ origin: rp.origin, algorithm });
      const { response, challenge: c } = await registration(narrowVerifier, authenticator);
      for (let i = 0; i < FLIPS; i++) {
        const key = random() < 0.5 ? "clientDataJSON" : "attestationObject";
        const flipped = flip(response.response[key], random);
        const tampered = { ...response, response: { ...response.response, [key]: toBase64Url(flipped.bytes) } };
        const [narrow, full] = await verifyRegistrationBoth(tampered, c);
        const where = `${key} byte ${flipped.at}, flip ${i}`;
        if (narrow.ok && !full.ok) {
          // Only a flip the narrow verifier may ignore: the format name or statement, never authData.
          const credential = (narrow as { value: { publicKey: Uint8Array; id: string } }).value;
          const original = await narrowVerifier.verifyRegistration(response, { rp, challenge: c });
          expect(key, where).toBe("attestationObject");
          expect(credential, where).toEqual(original);
        } else if (narrow.ok) {
          expect(narrow, where).toEqual(full);
        } else if (full.ok) {
          // Refused by the narrow verifier alone: only for parsing more strictly,
          // never by passing a check the full one fails.
          expect(STRICTER_PARSING, where).toContain(narrow.reason);
        }
      }
    });

    it(`an assertion is accepted by both verifiers or by neither (${algorithm})`, async () => {
      const random = prng(algorithm === "ES256" ? 3 : 4);
      const held = await registered(algorithm);
      const { response, options } = await assertionBoth(held);
      const keys = ["clientDataJSON", "authenticatorData", "signature"] as const;
      for (let i = 0; i < FLIPS; i++) {
        const key = keys[Math.floor(random() * keys.length)]!;
        const flipped = flip(response.response[key], random);
        const tampered = { ...response, response: { ...response.response, [key]: toBase64Url(flipped.bytes) } };
        const [narrow, full] = await assertBoth(tampered, options.challenge, held.credential);
        expect(narrow.ok, `${key} byte ${flipped.at}, flip ${i}`).toBe(full.ok);
      }
    });
  }
});
