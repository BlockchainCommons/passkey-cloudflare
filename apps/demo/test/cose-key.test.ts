import { coseKeyToJwk } from "passkey-cloudflare";
import { describe, expect, it } from "vitest";
import vectors from "./fixtures/cose-jwk-vectors.json";

// The fixture is generated outside this repository from published JWK keys
// (RFC 7515, RFC 8037), with each COSE form encoded by the dCBOR reference
// implementations (ADR 0005); see its "about" and "references".

const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// A minimal CBOR map encoder for the malformed keys below: small integer keys,
// small integer or byte string values.
function coseMap(entries: [number, number | Uint8Array][]): Uint8Array {
  const head = (major: number, n: number) => (n < 24 ? [(major << 5) | n] : [(major << 5) | 24, n]);
  const int = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
  const out: number[] = head(5, entries.length);
  for (const [k, v] of entries) out.push(...int(k), ...(typeof v === "number" ? int(v) : [...head(2, v.length), ...v]));
  return new Uint8Array(out);
}

describe("coseKeyToJwk", () => {
  it("covers every algorithm the ceremonies offer", async () => {
    const { CEREMONY_POLICY } = await import("passkey-cloudflare");
    expect(vectors.cases.map((c) => c.algorithm).sort()).toEqual([...CEREMONY_POLICY.algorithms].sort());
  });

  it("checks no case disagreed with a reference", () => {
    expect(vectors.disagreements).toEqual([]);
  });

  for (const c of vectors.cases) {
    it(`converts ${c.id} from bytes`, () => {
      expect(coseKeyToJwk(bytes(c.coseHex))).toEqual(c.jwk);
    });

    it(`converts ${c.id} from base64url`, () => {
      expect(coseKeyToJwk(b64u(bytes(c.coseHex)))).toEqual(c.jwk);
    });

    it(`gives ${c.id} a JWK Web Crypto imports`, async () => {
      const algorithm = c.jwk.kty === "EC" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
      const key = await crypto.subtle.importKey("jwk", coseKeyToJwk(bytes(c.coseHex)), algorithm, true, ["verify"]);
      const raw = new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
      const published =
        c.jwk.kty === "EC" ? "04" + toHex(fromB64u(c.jwk.x)) + toHex(fromB64u(c.jwk.y!)) : toHex(fromB64u(c.jwk.x));
      expect(toHex(raw)).toBe(published);
    });
  }

  const x = new Uint8Array(32).fill(1);
  const y = new Uint8Array(32).fill(2);
  it.each<[string, Uint8Array]>([
    [
      "an algorithm the ceremonies do not offer (RS256)",
      coseMap([
        [1, 3],
        [3, -257],
        [-1, x],
        [-2, y],
      ]),
    ],
    [
      "ES256 on an OKP key",
      coseMap([
        [1, 1],
        [3, -7],
        [-1, 6],
        [-2, x],
      ]),
    ],
    [
      "EdDSA on an EC2 key",
      coseMap([
        [1, 2],
        [3, -8],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    ],
    [
      "ES256 on another curve (P-384)",
      coseMap([
        [1, 2],
        [3, -7],
        [-1, 2],
        [-2, x],
        [-3, y],
      ]),
    ],
    [
      "EdDSA on another curve (Ed448)",
      coseMap([
        [1, 1],
        [3, -8],
        [-1, 7],
        [-2, x],
      ]),
    ],
    [
      "an EC2 key with no y",
      coseMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
      ]),
    ],
    [
      "an EC2 key with a short x",
      coseMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x.slice(1)],
        [-3, y],
      ]),
    ],
    [
      "an OKP key with a long x",
      coseMap([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, new Uint8Array(33)],
      ]),
    ],
    [
      "a key with no algorithm",
      coseMap([
        [1, 2],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    ],
    ["bytes that are not CBOR", new Uint8Array([0xff])],
  ])("refuses %s", (_, cose) => {
    expect(() => coseKeyToJwk(cose)).toThrow(/COSE key/);
  });

  it("refuses text that is not base64url", () => {
    expect(() => coseKeyToJwk("not base64url!")).toThrow();
  });
});
