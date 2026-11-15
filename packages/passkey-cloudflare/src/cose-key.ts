// A credential's public key, as the record stores it (a COSE_Key, RFC 9052)
// and as a JWK (RFC 7517) for Web Crypto and other JOSE tools.

import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { fromBase64Url, toBase64Url } from "./base64url.ts";

/** A credential's public key exactly as its authenticator gave it at registration. */
export interface CredentialPublicKey {
  /** The COSE_Key (RFC 9052), base64url without padding. */
  cose: string;
  /** Its COSE algorithm: -7 (ES256) or -8 (EdDSA), the ones `CEREMONY_POLICY.algorithms` offers. */
  algorithm: number;
}

/** The JWK of a credential public key, for one of the algorithms the ceremonies offer. */
export type CredentialJwk =
  | { kty: "EC"; crv: "P-256"; x: string; y: string; alg: "ES256" }
  | { kty: "OKP"; crv: "Ed25519"; x: string; alg: "EdDSA" };

// COSE labels and values (RFC 9052 section 7, RFC 9053 section 7).
const KTY = 1;
const ALG = 3;
const CRV = -1;
const X = -2;
const Y = -3;
const KTY_OKP = 1;
const KTY_EC2 = 2;
const CRV_P256 = 1;
const CRV_ED25519 = 6;
const ALG_ES256 = -7;
const ALG_EDDSA = -8;

/**
 * Convert a COSE public key, as bytes or base64url, to a JWK. Only the
 * algorithms the ceremonies offer convert: an ES256 key on P-256 and an EdDSA
 * key on Ed25519. Anything else, or a key whose coordinates are the wrong
 * length, throws.
 */
export function coseKeyToJwk(cose: Uint8Array | string): CredentialJwk {
  const bytes = typeof cose === "string" ? fromBase64Url(cose) : cose;
  let key: Map<number, unknown>;
  try {
    key = decodeCredentialPublicKey(bytes as Uint8Array<ArrayBuffer>) as Map<number, unknown>;
  } catch {
    throw new Error("not a COSE key");
  }
  if (!(key instanceof Map)) throw new Error("not a COSE key");
  const coordinate = (label: number): string => {
    const value = key.get(label);
    if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error("COSE key coordinate is not 32 bytes");
    return toBase64Url(value);
  };
  const kty = key.get(KTY);
  const alg = key.get(ALG);
  const crv = key.get(CRV);
  if (alg === ALG_ES256 && kty === KTY_EC2 && crv === CRV_P256) {
    return { kty: "EC", crv: "P-256", x: coordinate(X), y: coordinate(Y), alg: "ES256" };
  }
  if (alg === ALG_EDDSA && kty === KTY_OKP && crv === CRV_ED25519) {
    return { kty: "OKP", crv: "Ed25519", x: coordinate(X), alg: "EdDSA" };
  }
  throw new Error("unsupported COSE key: only ES256 on P-256 and EdDSA on Ed25519 convert");
}
