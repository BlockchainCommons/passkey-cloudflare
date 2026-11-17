import { MAX_APPROVAL_DIGEST_BYTES, MIN_APPROVAL_DIGEST_BYTES, type Approval } from "passkey-cloudflare";
import { fromBase64Url, toBase64Url } from "passkey-cloudflare/browser";
import { SshError, sshApprovalDigest, sshPublicKey, sshSignature, type SshHash } from "passkey-cloudflare/ssh";
import { describe, expect, it } from "vitest";
import coseVectors from "./fixtures/cose-jwk-vectors.json";
import vectors from "./fixtures/ssh-vectors.json";

// The fixture is generated outside this repository; see its "about" and
// "references". Its first case is a real Chrome passkey's signature over a Git
// commit, and every expected signature passed `ssh-keygen -Y verify` there.
// `scripts/check-ssh-signatures.ts` runs this encoder's output through
// `ssh-keygen` again in `npm test`.

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const ed25519 = coseVectors.cases.find((c) => c.algorithm === -8)!;
const ed25519Key = { cose: toBase64Url(fromHex(ed25519.coseHex)), algorithm: -8 };
/** The real Chrome passkey's signature over a Git commit. */
const [chrome] = vectors.cases;

/** The thrown SshError's kind, or a note that nothing or something else was thrown. */
async function kindOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof SshError ? e.kind : `not an SshError: ${e}`;
  }
  return "nothing thrown";
}

/** The real case's approval with its clientDataJSON changed by `edit`. */
function withClientData(edit: (json: string) => string) {
  const json = new TextDecoder().decode(fromBase64Url(chrome!.approval.clientDataJSON));
  return {
    ...chrome!.approval,
    publicKey: chrome!.publicKey,
    clientDataJSON: toBase64Url(new TextEncoder().encode(edit(json))),
  };
}

describe("passkey-cloudflare/ssh vectors", () => {
  it("include a real passkey signature", () => {
    expect(chrome!.id).toBe("chrome-passkey-git-commit");
    expect(chrome!.checks.sshKeygen).toMatch(/^Good "git" signature/);
  });

  it("all passed ssh-keygen when generated", () => {
    for (const c of vectors.cases) expect(c.checks.sshKeygen, c.id).toMatch(/^Good "/);
  });

  for (const c of vectors.cases) {
    describe(c.id, () => {
      it("gives the OpenSSH public key", () => {
        expect(sshPublicKey(c.publicKey, c.rpId)).toBe(c.expected.sshPublicKey);
      });

      it("builds the approval digest the passkey signed", async () => {
        const digest = await sshApprovalDigest(c.namespace, c.message, c.hash as SshHash);
        expect(toHex(digest)).toBe(c.expected.digestHex);
        const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(c.approval.clientDataJSON)));
        expect(clientData.challenge).toBe(toBase64Url(digest));
      });

      it("encodes the armored signature byte for byte", async () => {
        const approval = { ...c.approval, publicKey: c.publicKey };
        expect(await sshSignature(approval, { rpId: c.rpId, namespace: c.namespace })).toBe(c.expected.signature);
      });
    });
  }
});

describe("sshApprovalDigest", () => {
  it("takes the message as text or bytes, with sha512 by default", async () => {
    const asText = await sshApprovalDigest(chrome!.namespace, chrome!.message);
    const asBytes = await sshApprovalDigest(chrome!.namespace, new TextEncoder().encode(chrome!.message), "sha512");
    expect(toHex(asText)).toBe(chrome!.expected.digestHex);
    expect(toHex(asBytes)).toBe(chrome!.expected.digestHex);
  });

  it("fits the approval digest bounds for a short namespace", async () => {
    for (const hash of ["sha256", "sha512"] as const) {
      const digest = await sshApprovalDigest("git", "x", hash);
      expect(digest.length).toBeGreaterThanOrEqual(MIN_APPROVAL_DIGEST_BYTES);
      expect(digest.length).toBeLessThanOrEqual(MAX_APPROVAL_DIGEST_BYTES);
    }
  });

  it("refuses an empty namespace and an unknown hash", async () => {
    expect(await kindOf(() => sshApprovalDigest("", "x"))).toBe("bad-namespace");
    // @ts-expect-error only sha256 and sha512 are SSHSIG hashes
    expect(await kindOf(() => sshApprovalDigest("git", "x", "sha1"))).toBe("bad-hash");
  });
});

describe("a credential that is not ES256", () => {
  it("has no OpenSSH public key", async () => {
    expect(await kindOf(() => sshPublicKey(ed25519Key, "example.com"))).toBe("not-es256");
  });

  it("has no webauthn-sk signature", async () => {
    const approval = { ...chrome!.approval, publicKey: ed25519Key };
    expect(await kindOf(() => sshSignature(approval, { rpId: chrome!.rpId, namespace: "git" }))).toBe("not-es256");
  });

  it("is refused by its COSE algorithm too, whatever the key bytes", async () => {
    expect(await kindOf(() => sshPublicKey({ ...chrome!.publicKey, algorithm: -8 }, chrome!.rpId))).toBe("not-es256");
  });

  it("is refused when the COSE key is not a key", async () => {
    expect(await kindOf(() => sshPublicKey({ cose: "AAAA", algorithm: -7 }, chrome!.rpId))).toBe("not-es256");
  });
});

describe("sshSignature refuses", () => {
  const options = { rpId: chrome!.rpId, namespace: chrome!.namespace };
  const approval = { ...chrome!.approval, publicKey: chrome!.publicKey };

  it("an RP ID the authenticator data was not made for", async () => {
    expect(await kindOf(() => sshSignature(approval, { ...options, rpId: "example.com" }))).toBe("rp-id-mismatch");
  });

  it("a namespace other than the one the passkey signed", async () => {
    expect(await kindOf(() => sshSignature(approval, { ...options, namespace: "file" }))).toBe("not-sshsig-challenge");
  });

  it("a challenge that is not SSHSIG data", async () => {
    const plain = withClientData((json) =>
      json.replace(/"challenge":"[^"]*"/, `"challenge":"${toBase64Url(new Uint8Array(32))}"`),
    );
    expect(await kindOf(() => sshSignature(plain, options))).toBe("not-sshsig-challenge");
  });

  it("client data that is not an assertion's", async () => {
    const created = withClientData((json) => json.replace("webauthn.get", "webauthn.create"));
    expect(await kindOf(() => sshSignature(created, options))).toBe("malformed-approval");
  });

  it("a signature that is not DER", async () => {
    const raw = { ...approval, signature: toBase64Url(new Uint8Array(64).fill(1)) };
    expect(await kindOf(() => sshSignature(raw, options))).toBe("malformed-approval");
  });

  it("authenticator data shorter than its fixed fields", async () => {
    const short = { ...approval, authenticatorData: toBase64Url(new Uint8Array(36)) };
    expect(await kindOf(() => sshSignature(short, options))).toBe("malformed-approval");
  });
});

describe("sshSignature's input", () => {
  // The check is tsc's: `npm run typecheck` compiles the tests.
  it("is an approval result as it is", () => {
    const accepts = (approval: Approval) => sshSignature(approval, { rpId: "example.com", namespace: "git" });
    expect(accepts).toBeTypeOf("function");
  });
});
