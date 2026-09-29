import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, randomBytes, sha256, toBase64Url, toHex, concatBytes } from "../encoding.ts";
import { CeremonyRefusal } from "../refusal.ts";
import { decodeCbor, decodeCborItem, type Cbor } from "./cbor.ts";
import {
  CEREMONY_POLICY,
  COSE_EDDSA,
  COSE_ES256,
  FLAG_BACKED_UP,
  FLAG_BACKUP_ELIGIBLE,
  type RelyingParty,
  type Verifier,
} from "./webauthn.ts";

// A WebAuthn verifier for exactly this library's policy: no attestation, and
// ES256 or Ed25519 keys, verified on crypto.subtle. It follows the WebAuthn
// Level 3 verification procedures and makes the same checks, in the same order,
// as `@simplewebauthn/server`, which the differential test holds it to. It
// differs in two ways: it ignores the attestation statement, which the policy
// never trusts, and it checks the whole public key at registration rather
// than at the first assertion.

const FLAG_USER_PRESENT = 0x01;
const FLAG_ATTESTED = 0x40;
const FLAG_EXTENSIONS = 0x80;

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const KTY_OKP = 1;
const KTY_EC2 = 2;
const CRV_P256 = 1;
const CRV_ED25519 = 6;

/** Refuse the ceremony. Every check below ends here or passes. */
function refuse(cause: string): never {
  throw new CeremonyRefusal(cause);
}

function bytesOf(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string") refuse("malformed-response");
  try {
    return fromBase64Url(text.replace(/=+$/, ""));
  } catch {
    refuse("malformed-response");
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The credential id, as both ceremonies require it: present and the same as rawId. */
function checkCredential(response: { id?: unknown; rawId?: unknown; type?: unknown }) {
  if (!response.id || response.id !== response.rawId) refuse("malformed-response");
  if (response.type !== "public-key") refuse("wrong-type");
}

interface ClientData {
  type?: unknown;
  challenge?: unknown;
  origin?: unknown;
  crossOrigin?: unknown;
  topOrigin?: unknown;
  tokenBinding?: unknown;
}

function clientData(encoded: unknown): ClientData {
  if (typeof encoded !== "string") refuse("malformed-response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytesOf(encoded)));
  } catch (error) {
    if (error instanceof CeremonyRefusal) throw error;
    refuse("malformed-response");
  }
  if (typeof parsed !== "object" || parsed === null) refuse("malformed-response");
  return parsed as ClientData;
}

function checkTokenBinding(tokenBinding: unknown, statuses: readonly string[]) {
  if (!tokenBinding) return;
  if (typeof tokenBinding !== "object") refuse("malformed-response");
  if (!statuses.includes((tokenBinding as { status?: unknown }).status as string)) refuse("malformed-response");
}

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  publicKey?: Uint8Array;
}

// One authenticator writes an EdDSA key as a three-entry map that holds four
// entries; read that exact prefix as the four-entry map it is.
const MISCOUNTED_EDDSA_KEY = Uint8Array.from([
  0xa3, 0x01, 0x63, 0x4f, 0x4b, 0x50, 0x03, 0x27, 0x20, 0x67, 0x45, 0x64, 0x32, 0x35, 0x35, 0x31, 0x39,
]);

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) refuse("malformed-response");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const out: AuthenticatorData = { rpIdHash: bytes.slice(0, 32), flags, signCount: view.getUint32(33) };
  let at = 37;
  try {
    if (flags & FLAG_ATTESTED) {
      if (bytes.length < at + 18) refuse("malformed-response");
      out.aaguid = bytes.slice(at, at + 16);
      const idLength = view.getUint16(at + 16);
      at += 18;
      if (bytes.length < at + idLength) refuse("malformed-response");
      out.credentialId = bytes.slice(at, at + idLength);
      at += idLength;
      let keyBytes = bytes;
      if (equalBytes(bytes.subarray(at, at + MISCOUNTED_EDDSA_KEY.length), MISCOUNTED_EDDSA_KEY)) {
        keyBytes = bytes.slice();
        keyBytes[at] = 0xa4;
      }
      const { end } = decodeCborItem(keyBytes, at);
      out.publicKey = keyBytes.slice(at, end);
      at = end;
    }
    if (flags & FLAG_EXTENSIONS) at = decodeCborItem(bytes, at).end;
  } catch (error) {
    if (error instanceof CeremonyRefusal) throw error;
    refuse("malformed-response");
  }
  if (at !== bytes.length) refuse("malformed-response");
  return out;
}

async function checkRelyingParty(data: AuthenticatorData, rp: RelyingParty) {
  if (!equalBytes(data.rpIdHash, await sha256(rp.id))) refuse("wrong-rp-id");
  if (!(data.flags & FLAG_USER_PRESENT)) refuse("user-not-present");
}

function checkBackupFlags(flags: number) {
  if (flags & FLAG_BACKED_UP && !(flags & FLAG_BACKUP_ELIGIBLE)) refuse("verification-failed");
}

type PublicKey = { algorithm: typeof COSE_ES256 | typeof COSE_EDDSA; key: CryptoKey };

/** The COSE key's algorithm, refusing any this verifier does not take. */
function algorithmOf(cose: Cbor): typeof COSE_ES256 | typeof COSE_EDDSA {
  if (!(cose instanceof Map)) refuse("malformed-response");
  const alg = cose.get(COSE_ALG);
  if (typeof alg !== "number") refuse("malformed-response");
  if (alg !== COSE_ES256 && alg !== COSE_EDDSA) refuse("unsupported-algorithm");
  return alg;
}

/** Import a COSE public key for verification. Every field must be exactly what its algorithm needs. */
async function importPublicKey(encoded: Uint8Array): Promise<PublicKey> {
  let cose: Cbor;
  try {
    cose = decodeCbor(encoded);
  } catch {
    refuse("malformed-response");
  }
  const algorithm = algorithmOf(cose);
  const map = cose as Map<number | string, Cbor>;
  const x = map.get(COSE_X);
  try {
    if (algorithm === COSE_ES256) {
      const y = map.get(COSE_Y);
      if (map.get(COSE_KTY) !== KTY_EC2 || map.get(COSE_CRV) !== CRV_P256) refuse("bad-public-key");
      if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
        refuse("bad-public-key");
      }
      const point = concatBytes(Uint8Array.of(0x04), x, y);
      const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return { algorithm, key };
    }
    if (map.get(COSE_KTY) !== KTY_OKP || map.get(COSE_CRV) !== CRV_ED25519) refuse("bad-public-key");
    if (!(x instanceof Uint8Array) || x.length !== 32) refuse("bad-public-key");
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(x), { name: "Ed25519" }, false, ["verify"]);
    return { algorithm, key };
  } catch (error) {
    if (error instanceof CeremonyRefusal) throw error;
    refuse("bad-public-key");
  }
}

/**
 * An ES256 signature as WebCrypto takes it: DER `SEQUENCE { INTEGER r, INTEGER s }`
 * unwrapped to r || s, each 32 bytes. A component is left-padded when short,
 * and loses one leading zero only where that zero keeps it positive.
 */
function rawEcdsaSignature(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let at = 0;
  const byte = () => {
    if (at >= der.length) refuse("bad-signature");
    return der[at++]!;
  };
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    if (first !== 0x81) refuse("bad-signature");
    const long = byte();
    if (long < 0x80) refuse("bad-signature");
    return long;
  };
  const integer = () => {
    if (byte() !== 0x02) refuse("bad-signature");
    const n = length();
    if (n === 0 || n > der.length - at) refuse("bad-signature");
    const bytes = der.subarray(at, at + n);
    at += n;
    if (bytes.length < 32) return concatBytes(new Uint8Array(32 - bytes.length), bytes);
    if (bytes.length === 32) return bytes;
    if (bytes.length === 33 && bytes[0] === 0 && bytes[1]! & 0x80) return bytes.subarray(1);
    refuse("bad-signature");
  };
  if (byte() !== 0x30) refuse("bad-signature");
  const sequence = length();
  if (sequence !== der.length - at) refuse("bad-signature");
  const r = integer();
  const s = integer();
  if (at !== der.length) refuse("bad-signature");
  return concatBytes(r, s);
}

async function verifySignature(publicKey: PublicKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (publicKey.algorithm === COSE_ES256) {
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey.key,
      rawEcdsaSignature(signature),
      Uint8Array.from(data),
    );
  }
  return crypto.subtle.verify({ name: "Ed25519" }, publicKey.key, Uint8Array.from(signature), Uint8Array.from(data));
}

function aaguidString(aaguid: Uint8Array): string {
  const hex = toHex(aaguid);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const narrowVerifier: Verifier = {
  algorithms: [COSE_EDDSA, COSE_ES256],

  async creationOptions(input): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return {
      challenge: toBase64Url(input.challenge),
      rp: { name: input.rp.name, id: input.rp.id },
      // A fresh user handle for every ceremony, presented and never stored.
      user: { id: toBase64Url(randomBytes(32)), name: input.userName, displayName: input.userName },
      pubKeyCredParams: narrowVerifier.algorithms.map((alg) => ({ alg, type: "public-key" as const })),
      timeout: CEREMONY_POLICY.timeoutMs,
      attestation: CEREMONY_POLICY.attestation,
      excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({ id, type: "public-key" as const })),
      authenticatorSelection: {
        residentKey: CEREMONY_POLICY.residentKey,
        requireResidentKey: true,
        userVerification: CEREMONY_POLICY.userVerification,
      },
      extensions: { credProps: true },
      hints: [],
    };
  },

  async requestOptions(input): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return {
      rpId: input.rp.id,
      challenge: toBase64Url(input.challenge),
      allowCredentials: (input.allowCredentialIds ?? []).map((id) => ({ id, type: "public-key" as const })),
      timeout: CEREMONY_POLICY.timeoutMs,
      userVerification: CEREMONY_POLICY.userVerification,
      extensions: undefined,
    };
  },

  async verifyRegistration(response: RegistrationResponseJSON, expected) {
    checkCredential(response);
    const client = clientData(response.response?.clientDataJSON);
    if (client.type !== "webauthn.create") refuse("wrong-type");
    if (client.challenge !== expected.challenge) refuse("wrong-challenge");
    if (client.origin !== expected.rp.origin) refuse("wrong-origin");
    checkTokenBinding(client.tokenBinding, ["present", "supported", "not-supported"]);

    let attestation: Cbor;
    try {
      attestation = decodeCbor(bytesOf(response.response.attestationObject));
    } catch (error) {
      if (error instanceof CeremonyRefusal) throw error;
      refuse("malformed-response");
    }
    // The format and statement are read only for their shape: the policy asks
    // for no attestation and trusts none that arrives.
    if (!(attestation instanceof Map)) refuse("malformed-response");
    const authDataBytes = attestation.get("authData");
    if (typeof attestation.get("fmt") !== "string" || !(attestation.get("attStmt") instanceof Map)) {
      refuse("malformed-response");
    }
    if (!(authDataBytes instanceof Uint8Array)) refuse("malformed-response");

    const data = parseAuthenticatorData(authDataBytes);
    await checkRelyingParty(data, expected.rp);
    if (!data.credentialId || !data.publicKey || !data.aaguid) refuse("malformed-response");
    const publicKey = await importPublicKey(data.publicKey);
    checkBackupFlags(data.flags);
    return {
      id: toBase64Url(data.credentialId),
      publicKey: data.publicKey,
      algorithm: publicKey.algorithm,
      signCount: data.signCount,
      registrationFlags: data.flags,
      aaguid: aaguidString(data.aaguid),
      transports: (response.response.transports ?? []) as string[],
    };
  },

  async verifyAssertion(response: AuthenticationResponseJSON, expected) {
    checkCredential(response);
    const client = clientData(response.response?.clientDataJSON);
    if (client.type !== "webauthn.get") refuse("wrong-type");
    if (client.challenge !== expected.challenge) refuse("wrong-challenge");
    // A cross-origin assertion must come from an expected top origin, and this
    // library expects none; a same-origin one carries no top origin at all.
    if (client.topOrigin) refuse("wrong-origin");
    if (client.origin !== expected.rp.origin) refuse("wrong-origin");
    const authDataBytes = bytesOf(response.response.authenticatorData);
    const signature = bytesOf(response.response.signature);
    if (response.response.userHandle && typeof response.response.userHandle !== "string") refuse("malformed-response");
    checkTokenBinding(client.tokenBinding, ["present", "supported", "notSupported"]);

    const data = parseAuthenticatorData(authDataBytes);
    await checkRelyingParty(data, expected.rp);
    // A zero stored counter disables the monotonic check, which is what synced
    // (backup-eligible) credentials need.
    const stored = expected.credential.enforceCounter ? expected.credential.signCount : 0;
    if ((data.signCount > 0 || stored > 0) && data.signCount <= stored) refuse("counter-regressed");
    const publicKey = await importPublicKey(expected.credential.publicKey);
    checkBackupFlags(data.flags);
    const signed = concatBytes(authDataBytes, await sha256(bytesOf(response.response.clientDataJSON)));
    if (!(await verifySignature(publicKey, signature, signed))) refuse("bad-signature");
    return { signCount: data.signCount, flags: data.flags };
  },
};
