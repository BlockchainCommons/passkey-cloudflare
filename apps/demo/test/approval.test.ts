import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

// An approval: a person's passkey signs a challenge that is exactly the app's
// digest of a payload. The demo's digest is the SHA-256 of the text it shows.

/** SHA-256 of "hello", from the NIST-style test vectors everyone quotes. */
const HELLO_SHA256_HEX = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function hexToBase64Url(hex: string): string {
  const bytes = hex.match(/../g)!.map((pair) => parseInt(pair, 16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("approval options", () => {
  // Fails until the approval routes exist; flip to `it` when they do.
  it.fails("make the challenge the digest, byte for byte", async () => {
    const app = testApp();
    const browser = app.browser();
    await browser.register(uniqueName());

    const options = await browser.json(browser.post("/me/approve/options", { text: "hello" }));

    expect(options.challenge).toBe(hexToBase64Url(HELLO_SHA256_HEX));
  });
});
