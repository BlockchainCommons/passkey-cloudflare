// Check that `passkey-cloudflare/ssh` makes signatures OpenSSH accepts. For
// each case in test/fixtures/ssh-vectors.json, encode the approval with
// `sshPublicKey` and `sshSignature`, write the signature, message and an
// allowed signers file to a temp directory, and run `ssh-keygen -Y verify`
// on them. A control first runs one case over a changed message, which
// ssh-keygen must refuse, so a verifier that accepts anything fails the run.
//
//   node scripts/check-ssh-signatures.ts
//
// `npm test` runs it from apps/demo. Without ssh-keygen it prints why and
// exits 0, so a machine without OpenSSH still runs the other tests.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshPublicKey, sshSignature } from "passkey-cloudflare/ssh";

interface Case {
  id: string;
  rpId: string;
  namespace: string;
  message: string;
  publicKey: { cose: string; algorithm: number };
  approval: { authenticatorData: string; clientDataJSON: string; signature: string };
}

const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "../test/fixtures/ssh-vectors.json"), "utf8")) as {
  cases: Case[];
};

const probe = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" });
if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
  console.log("ssh signature check: skipped, ssh-keygen is not installed");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "ssh-signatures-"));

/** ssh-keygen's verdict on one signature: its exit status and what it printed. */
function verify(c: Case, publicKey: string, signature: string, message: string, name: string) {
  const allowed = join(dir, `${name}.allowed_signers`);
  const sig = join(dir, `${name}.sig`);
  writeFileSync(allowed, `signer namespaces="${c.namespace}" ${publicKey}\n`);
  writeFileSync(sig, signature);
  const run = spawnSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "signer", "-n", c.namespace, "-s", sig], {
    input: message,
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() };
}

let failed = 0;
try {
  for (const [i, c] of vectors.cases.entries()) {
    const publicKey = sshPublicKey(c.publicKey, c.rpId);
    const signature = await sshSignature({ ...c.approval, publicKey: c.publicKey }, c);
    if (i === 0) {
      const control = verify(c, publicKey, signature, `${c.message}changed`, "control");
      if (control.status === 0) {
        console.error(`ssh signature check: control: ssh-keygen accepted ${c.id} over a changed message`);
        failed++;
      }
    }
    const result = verify(c, publicKey, signature, c.message, String(i));
    if (result.status !== 0) {
      console.error(`ssh signature check: ${c.id}: ssh-keygen refused it: ${result.output}`);
      failed++;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) process.exit(1);
console.log(`ssh signature check: ssh-keygen verified ${vectors.cases.length} signatures`);
