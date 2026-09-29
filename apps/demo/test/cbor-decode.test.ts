import { describe, expect, it } from "vitest";
// The narrow verifier's CBOR decoder is internal to the library, so it is imported by path.
import { decodeCbor } from "../../../packages/passkey-cloudflare/src/identity/cbor.ts";

// RFC 8949 Appendix A examples, for the items a WebAuthn response carries.

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));

describe("the verifier's CBOR decoder", () => {
  const decodes: [string, unknown][] = [
    ["00", 0],
    ["01", 1],
    ["0a", 10],
    ["17", 23],
    ["1818", 24],
    ["1819", 25],
    ["1864", 100],
    ["1903e8", 1000],
    ["1a000f4240", 1000000],
    ["1b000000e8d4a51000", 1000000000000],
    ["20", -1],
    ["29", -10],
    ["3863", -100],
    ["3903e7", -1000],
    ["f4", false],
    ["f5", true],
    ["f6", null],
    ["40", new Uint8Array()],
    ["4401020304", Uint8Array.of(1, 2, 3, 4)],
    ["60", ""],
    ["6161", "a"],
    ["6449455446", "IETF"],
    ["62225c", '"\\'],
    ["62c3bc", "ü"],
    ["63e6b0b4", "水"],
    ["64f0908591", "𐅑"],
    ["80", []],
    ["83010203", [1, 2, 3]],
    ["8301820203820405", [1, [2, 3], [4, 5]]],
    ["98190102030405060708090a0b0c0d0e0f101112131415161718181819", Array.from({ length: 25 }, (_, i) => i + 1)],
    ["a0", new Map()],
    ["a201020304", new Map([[1, 2], [3, 4]])],
    ["a26161016162820203", new Map<string, unknown>([["a", 1], ["b", [2, 3]]])],
    ["826161a161626163", ["a", new Map([["b", "c"]])]],
  ];
  for (const [input, value] of decodes) {
    it(`decodes ${input}`, () => {
      expect(decodeCbor(hex(input))).toEqual(value);
    });
  }

  const refuses: [input: string, what: string, error: string][] = [
    ["1bffffffffffffffff", "an integer beyond the safe range", "integer out of range"],
    ["3bffffffffffffffff", "a negative integer beyond the safe range", "integer out of range"],
    ["f90000", "a half-precision float", "unsupported simple value or float"],
    ["fb3ff199999999999a", "a double", "unsupported simple value or float"],
    ["f7", "undefined", "unsupported simple value or float"],
    ["c074323031332d30332d32315432303a30343a30305a", "a tag", "tags are not accepted"],
    ["5f42010243030405ff", "an indefinite-length byte string", "indefinite or reserved length"],
    ["9fff", "an indefinite-length array", "indefinite or reserved length"],
    ["bf61610161629f0203ffff", "an indefinite-length map", "indefinite or reserved length"],
    ["4401020304ff", "trailing bytes", "trailing bytes"],
    ["4501020304", "a byte string longer than its input", "truncated"],
    ["8301", "an array shorter than its count", "truncated"],
    ["a201020103", "a duplicate map key", "duplicate map key"],
    ["a1f401", "a map key that is neither an integer nor text", "map key is not an integer or text"],
    ["62c328", "text that is not UTF-8", "text is not UTF-8"],
  ];
  for (const [input, what, error] of refuses) {
    it(`refuses ${what}`, () => {
      expect(() => decodeCbor(hex(input))).toThrow(error);
    });
  }
});
