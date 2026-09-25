import { randomBytes, sha256Hex, toBase64Url } from "../encoding.ts";

// Session tokens and recovery codes. Each is minted from the platform's secure
// generator and handed to the caller once; only its SHA-256 hash is stored.

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id of an identity record: a random UUID minted at registration and never changed. */
export type RecordId = string & { readonly __brand: "RecordId" };

export function isRecordId(value: unknown): value is RecordId {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function newRecordId(): RecordId {
  return crypto.randomUUID() as RecordId;
}

export interface MintedSession {
  id: string;
  /** `recordId.token`, the value a client presents. */
  value: string;
  tokenHash: string;
}

export async function mintSession(recordId: RecordId): Promise<MintedSession> {
  const token = toBase64Url(randomBytes(32));
  return { id: toBase64Url(randomBytes(12)), value: `${recordId}.${token}`, tokenHash: await sha256Hex(token) };
}

/** A single-use rebind link token, `recordId.token`. */
export async function mintRebindToken(recordId: RecordId): Promise<{ value: string; tokenHash: string }> {
  const token = toBase64Url(randomBytes(32));
  return { value: `${recordId}.${token}`, tokenHash: await sha256Hex(token) };
}

/** Split a presented `recordId.token` value (a session or a rebind link) into its record id and token hash. */
export async function parseRecordToken(
  value: string | null | undefined,
): Promise<{ recordId: RecordId; tokenHash: string } | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  const recordId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (dot < 0 || !isRecordId(recordId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { recordId, tokenHash: await sha256Hex(token) };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const RECOVERY_CODE_COUNT = 8;

/** One 120-bit recovery code, as 24 base32 characters in groups of four. */
function recoveryCode(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, "");
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(`recovery-code:${normalizeRecoveryCode(code)}`);
}

export async function mintRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  return { codes, hashes: await Promise.all(codes.map(hashRecoveryCode)) };
}
