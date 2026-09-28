import { vi } from "vitest";

/** The label a pinned draw gives: three zero bytes. */
export const PINNED_LABEL = "able-able-able";
/** `PINNED_LABEL` as the labels table stores it. */
export const PINNED_LABEL_BYTES = new Uint8Array(3);

/** The label in the name a passkey was saved under, as its password manager shows it. */
export function savedLabel(credential: { userName: string }): string {
  return /\(([a-z-]+)\)$/.exec(credential.userName)![1]!;
}

/**
 * Make the next `count` labels drawn, or every one, `PINNED_LABEL`, leaving
 * all other randomness alone. Labels are the only draws shorter than eight
 * bytes. Returns the number of label draws made so far. Undo it with
 * `vi.restoreAllMocks()`.
 */
export function pinLabelDraws(count = Infinity): () => number {
  const real = crypto.getRandomValues.bind(crypto);
  let draws = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
    if (array.length >= 8) return real(array);
    draws++;
    return draws <= count ? array.fill(0) : real(array);
  }) as typeof crypto.getRandomValues);
  return () => draws;
}
