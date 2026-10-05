// Run every successful ceremony against a deployed measurement Worker, so its
// CPU time per request can be read from Workers observability. The method, and
// the last run's results, are in docs/workers-free.md.
//
//   node scripts/measure-cpu.ts https://<measurement host> [rounds]
//
// Run it from apps/demo, against a fresh deployment of wrangler.measure.jsonc:
// round 0 then holds each ceremony's first call on a new script version.

import { SoftwareAuthenticator } from "passkey-cloudflare/testing";
import { Browser, uniqueName, type Target } from "../test/browser.ts";

const [originArg, roundsArg = "20"] = process.argv.slice(2);
if (!originArg?.match(/^https?:\/\//)) {
  console.error("usage: node scripts/measure-cpu.ts <measurement origin> [rounds]");
  process.exit(2);
}
const origin: string = originArg;
const rounds = Number(roundsArg);

const target: Target = { origin, fetch: (request) => fetch(request), edge: true };
const browser = () => new Browser(target, new SoftwareAuthenticator({ origin }));

const started = new Date();
for (let round = 0; round <= rounds; round++) {
  const person = browser();
  const memberName = uniqueName("cpu");
  const { recoveryCodes } = await person.register(memberName);
  person.session = undefined;
  await person.login();
  await person.stepUp();
  await person.enrol();

  const recovered = await browser().recover(memberName, recoveryCodes[0]!);
  if (recovered.result !== "ok") throw new Error(`recovery not accepted: ${recovered.result}`);
  process.stderr.write(`round ${round}/${rounds}\r`);
}

// Observability is queried by this window and the request paths.
console.log(`Ran ${rounds + 1} rounds against ${origin}`);
console.log(`from ${started.toISOString()} to ${new Date().toISOString()}`);
