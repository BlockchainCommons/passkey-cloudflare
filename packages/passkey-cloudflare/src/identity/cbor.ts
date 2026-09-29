// A strict CBOR decoder (RFC 8949) for what a WebAuthn response carries: the
// attestation object, the credential public key and extension outputs. It
// takes definite lengths only, integers within the safe range, text or
// integer map keys with no duplicates, and the simple values false, true and
// null; anything else is refused, as are tags and floats.

export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<number | string, Cbor>;

export class CborError extends Error {}

const MAX_DEPTH = 16;

/** Decode the one item at `offset`, returning it and the offset just past it. */
export function decodeCborItem(bytes: Uint8Array, offset = 0): { value: Cbor; end: number } {
  let at = offset;

  const take = (n: number): Uint8Array => {
    if (n > bytes.length - at) throw new CborError("truncated");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };

  const argument = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return take(1)[0]!;
    if (info === 25) {
      const b = take(2);
      return (b[0]! << 8) | b[1]!;
    }
    if (info === 26) {
      const b = take(4);
      return ((b[0]! << 24) >>> 0) + ((b[1]! << 16) | (b[2]! << 8) | b[3]!);
    }
    if (info === 27) {
      const b = take(8);
      const high = ((b[0]! << 24) >>> 0) + ((b[1]! << 16) | (b[2]! << 8) | b[3]!);
      const low = ((b[4]! << 24) >>> 0) + ((b[5]! << 16) | (b[6]! << 8) | b[7]!);
      const value = high * 2 ** 32 + low;
      if (!Number.isSafeInteger(value)) throw new CborError("integer out of range");
      return value;
    }
    throw new CborError("indefinite or reserved length");
  };

  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new CborError("nested too deeply");
    const initial = take(1)[0]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 2:
        return take(argument(info)).slice();
      case 3:
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(argument(info)));
        } catch (error) {
          if (error instanceof CborError) throw error;
          throw new CborError("text is not UTF-8");
        }
      case 4: {
        const length = argument(info);
        // Every item takes at least one byte, so a longer count is truncated.
        if (length > bytes.length - at) throw new CborError("truncated");
        const out: Cbor[] = [];
        for (let i = 0; i < length; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const length = argument(info);
        if (length * 2 > bytes.length - at) throw new CborError("truncated");
        const out = new Map<number | string, Cbor>();
        for (let i = 0; i < length; i++) {
          const key = item(depth + 1);
          if (typeof key !== "number" && typeof key !== "string") throw new CborError("map key is not an integer or text");
          if (out.has(key)) throw new CborError("duplicate map key");
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError("unsupported simple value or float");
      default:
        throw new CborError("tags are not accepted");
    }
  };

  const value = item(0);
  return { value, end: at };
}

/** Decode `bytes` as exactly one item. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  const { value, end } = decodeCborItem(bytes);
  if (end !== bytes.length) throw new CborError("trailing bytes");
  return value;
}
