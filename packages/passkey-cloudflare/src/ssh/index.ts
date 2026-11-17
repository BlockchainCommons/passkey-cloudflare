// OpenSSH forms of a passkey and of an approval: the
// sk-ecdsa-sha2-nistp256@openssh.com public key of an ES256 credential, the
// SSHSIG to-be-signed data an app passes as the approval digest, and the
// armored webauthn-sk-ecdsa-sha2-nistp256@openssh.com signature an approval
// becomes. `ssh-keygen -Y verify` and `git verify-commit` check the result.
// The passkey makes the signature; this code only lays out bytes, so it is
// hand-written with no new dependency, like the Gordian encoders (ADR 0005).
// Specifications: PROTOCOL.sshsig and PROTOCOL.u2f in the OpenSSH source.

import { fromBase64Url } from "../base64url.ts";
import { coseKeyToJwk, type CredentialPublicKey } from "../cose-key.ts";
import { concatBytes as concat } from "../encoding.ts";

const KEY_TYPE = "sk-ecdsa-sha2-nistp256@openssh.com";
const SIGNATURE_TYPE = "webauthn-sk-ecdsa-sha2-nistp256@openssh.com";
const MAGIC = new TextEncoder().encode("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const ES256 = -7;

/** The hash algorithms SSHSIG names for the message. */
export type SshHash = "sha256" | "sha512";
const HASH_LENGTH: Record<SshHash, number> = { sha256: 32, sha512: 64 };
const SUBTLE_HASH: Record<SshHash, string> = { sha256: "SHA-256", sha512: "SHA-512" };

/**
 * Why an OpenSSH form could not be made:
 * - `not-es256`: the credential is not an ES256 key on P-256, the only kind
 *   OpenSSH takes from a passkey.
 * - `bad-namespace`, `bad-hash`: SSHSIG needs a namespace and sha256 or sha512.
 * - `not-sshsig-challenge`: the approval's challenge is not the SSHSIG data
 *   for the namespace given.
 * - `rp-id-mismatch`: the authenticator data was made for another RP ID.
 * - `malformed-approval`: the approval's fields do not decode.
 */
export type SshErrorKind =
  "not-es256" | "bad-namespace" | "bad-hash" | "not-sshsig-challenge" | "rp-id-mismatch" | "malformed-approval";

export class SshError extends Error {
  readonly kind: SshErrorKind;

  constructor(kind: SshErrorKind, message: string) {
    super(`ssh: ${message}`);
    this.kind = kind;
  }
}

/** The parts of an approval result the signature is made from. An `Approval` passes as it is. */
export interface SshApproval {
  publicKey: CredentialPublicKey;
  /** base64url, as the browser sent it. */
  authenticatorData: string;
  /** base64url, byte for byte as the browser sent it: the signature covers it. */
  clientDataJSON: string;
  /** The DER ECDSA signature, base64url. */
  signature: string;
}

const encoder = new TextEncoder();

function uint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** An SSH wire string: a 32-bit big-endian length, then the bytes. */
function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return concat(uint32(bytes.length), bytes);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function digest(hash: SshHash, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(SUBTLE_HASH[hash], data as Uint8Array<ArrayBuffer>));
}

/** The uncompressed P-256 point of an ES256 credential. */
function es256Point(publicKey: CredentialPublicKey): Uint8Array {
  if (publicKey.algorithm !== ES256)
    throw new SshError("not-es256", `COSE algorithm ${publicKey.algorithm} is not ES256`);
  let jwk;
  try {
    jwk = coseKeyToJwk(publicKey.cose);
  } catch {
    jwk = undefined;
  }
  if (jwk?.kty !== "EC") throw new SshError("not-es256", "the credential's COSE key is not an ES256 key on P-256");
  return concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
}

/**
 * The OpenSSH key blob: the point and the application, which is the RP ID,
 * because OpenSSH checks the authenticator data's RP ID hash against it.
 */
function keyBlob(publicKey: CredentialPublicKey, rpId: string): Uint8Array {
  return concat(sshString(KEY_TYPE), sshString("nistp256"), sshString(es256Point(publicKey)), sshString(rpId));
}

/**
 * An ES256 credential as an OpenSSH security key,
 * `sk-ecdsa-sha2-nistp256@openssh.com AAAA...`, as an allowed signers or
 * authorized keys file lists it. `rpId` is the relying party the passkey
 * belongs to. Throws `SshError` (`not-es256`) for any other credential.
 */
export function sshPublicKey(publicKey: CredentialPublicKey, rpId: string): string {
  return `${KEY_TYPE} ${toBase64(keyBlob(publicKey, rpId))}`;
}

function checkNamespace(namespace: string): void {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new SshError("bad-namespace", "an SSH signature needs a namespace");
  }
}

/**
 * The approval digest that makes a passkey's approval an SSH signature over
 * `message`: the SSHSIG to-be-signed data for `namespace` (such as `git` or
 * `file`), holding the message's `hash`. Pass it to `approvalOptions` and
 * `approve`; for a short namespace it is about 100 bytes, inside the
 * approval digest bounds.
 */
export async function sshApprovalDigest(
  namespace: string,
  message: Uint8Array | string,
  hash: SshHash = "sha512",
): Promise<Uint8Array<ArrayBuffer>> {
  checkNamespace(namespace);
  if (!Object.hasOwn(HASH_LENGTH, hash)) throw new SshError("bad-hash", `${String(hash)} is not an SSHSIG hash`);
  const bytes = typeof message === "string" ? encoder.encode(message) : message;
  return concat(MAGIC, sshString(namespace), sshString(""), sshString(hash), sshString(await digest(hash, bytes)));
}

// A reader over SSH wire data that throws on data that ends too soon.
class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new RangeError("SSH data ends too soon");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  string(): Uint8Array {
    const [a, b, c, d] = this.take(4);
    return this.take(((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0);
  }

  done(): boolean {
    return this.at === this.bytes.length;
  }
}

/** The hash an SSHSIG challenge names, if the challenge is the SSHSIG data for `namespace`. */
function challengeHash(challenge: Uint8Array, namespace: string): SshHash {
  const notSshsig = () =>
    new SshError("not-sshsig-challenge", `the challenge is not SSHSIG data for namespace ${namespace}`);
  try {
    const reader = new Reader(challenge);
    if (!equalBytes(reader.take(MAGIC.length), MAGIC)) throw notSshsig();
    if (!equalBytes(reader.string(), encoder.encode(namespace))) throw notSshsig();
    if (reader.string().length !== 0) throw notSshsig();
    const hash = new TextDecoder().decode(reader.string());
    const hashed = reader.string();
    if (!Object.hasOwn(HASH_LENGTH, hash) || hashed.length !== HASH_LENGTH[hash as SshHash] || !reader.done()) {
      throw notSshsig();
    }
    return hash as SshHash;
  } catch (e) {
    throw e instanceof SshError ? e : notSshsig();
  }
}

/** The two integers of a DER ECDSA signature (SEQUENCE of two INTEGERs, short lengths only). */
function derIntegers(der: Uint8Array): [Uint8Array, Uint8Array] {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new RangeError("not a DER signature");
  let at = 2;
  const integer = () => {
    if (der[at] !== 0x02 || der[at + 1] === undefined || der[at + 1]! >= 0x80)
      throw new RangeError("not a DER integer");
    const length = der[at + 1]!;
    const value = der.subarray(at + 2, at + 2 + length);
    if (length === 0 || value.length !== length) throw new RangeError("not a DER integer");
    at += 2 + length;
    return value;
  };
  const r = integer();
  const s = integer();
  if (at !== der.length) throw new RangeError("not a DER signature");
  return [r, s];
}

/** An SSH mpint of an unsigned integer: no leading zero bytes, but one zero byte before a set high bit. */
function mpint(value: Uint8Array): Uint8Array {
  let i = 0;
  while (i < value.length - 1 && value[i] === 0) i++;
  const trimmed = value.subarray(i);
  return sshString(trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed);
}

function armor(blob: Uint8Array): string {
  const body = toBase64(blob)
    .match(/.{1,70}/g)!
    .join("\n");
  return `${ARMOR_BEGIN}\n${body}\n${ARMOR_END}\n`;
}

interface DecodedApproval {
  authenticatorData: Uint8Array;
  clientData: Uint8Array;
  challenge: Uint8Array;
  origin: string;
  r: Uint8Array;
  s: Uint8Array;
}

function decodeApproval(approval: SshApproval): DecodedApproval {
  try {
    const authenticatorData = fromBase64Url(approval.authenticatorData);
    if (authenticatorData.length < 37) throw new RangeError("authenticator data is too short");
    const clientData = fromBase64Url(approval.clientDataJSON);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clientData)) as Record<
      string,
      unknown
    >;
    if (parsed.type !== "webauthn.get") throw new TypeError("not an assertion's client data");
    if (typeof parsed.challenge !== "string" || typeof parsed.origin !== "string") {
      throw new TypeError("client data lacks its challenge or origin");
    }
    const [r, s] = derIntegers(fromBase64Url(approval.signature));
    return { authenticatorData, clientData, challenge: fromBase64Url(parsed.challenge), origin: parsed.origin, r, s };
  } catch {
    throw new SshError("malformed-approval", "the approval's fields do not decode");
  }
}

/**
 * The armored SSH signature an approval makes, in OpenSSH's webauthn-sk
 * format, for the approval digest `sshApprovalDigest` built. `rpId` is the
 * relying party the passkey belongs to and `namespace` the one the digest
 * was built for; the hash is read from the challenge. Throws `SshError` when
 * the credential is not ES256, the challenge is not that namespace's SSHSIG
 * data, the authenticator data names another RP ID, or a field does not
 * decode. It checks the encoding, not the signature: a verifier does that.
 */
export async function sshSignature(
  approval: SshApproval,
  { rpId, namespace }: { rpId: string; namespace: string },
): Promise<string> {
  checkNamespace(namespace);
  const blob = keyBlob(approval.publicKey, rpId);
  const decoded = decodeApproval(approval);
  const hash = challengeHash(decoded.challenge, namespace);
  const rpIdHash = await digest("sha256", encoder.encode(rpId));
  if (!equalBytes(decoded.authenticatorData.subarray(0, 32), rpIdHash)) {
    throw new SshError("rp-id-mismatch", `the authenticator data was not made for RP ID ${rpId}`);
  }
  const signature = concat(
    sshString(SIGNATURE_TYPE),
    sshString(concat(mpint(decoded.r), mpint(decoded.s))),
    decoded.authenticatorData.subarray(32, 37),
    sshString(decoded.origin),
    sshString(decoded.clientData),
    sshString(decoded.authenticatorData.subarray(37)),
  );
  return armor(
    concat(
      MAGIC,
      uint32(1),
      sshString(blob),
      sshString(namespace),
      sshString(""),
      sshString(hash),
      sshString(signature),
    ),
  );
}
