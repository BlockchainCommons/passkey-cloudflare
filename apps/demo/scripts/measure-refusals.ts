// Time every refusal arm against a deployed measurement Worker and recommend a
// refusal timing floor. The method, and the last run's results, are in
// docs/refusal-floor.md.
//
//   node scripts/measure-refusals.ts https://<measurement host> [rounds]
//
// Run it from apps/demo, against a deployment of wrangler.measure.jsonc: it
// sets that Worker's OPERATOR_RECORD_IDS secret to a member it registers.

import { execFileSync } from "node:child_process";
import { SoftwareAuthenticator } from "passkey-cloudflare/testing";
import { Browser, type Target } from "../test/browser.ts";
import { refusalArms } from "../test/refusal-arms.ts";
import { recommendFloor, summarize } from "../test/refusal-timing.ts";

const REFUSAL = '{"error":"ceremony refused"}';

const [originArg, roundsArg = "150"] = process.argv.slice(2);
if (!originArg?.startsWith("https://")) {
  console.error("usage: node scripts/measure-refusals.ts https://<measurement host> [rounds]");
  process.exit(2);
}
const origin: string = originArg;
const rounds = Number(roundsArg);

const target: Target = { origin, fetch: (request) => fetch(request), edge: true };
const browser = () => new Browser(target, new SoftwareAuthenticator({ origin }));

async function becomeOperator(): Promise<Browser> {
  const operator = browser();
  const { recordId } = await operator.register(`measureop${Date.now().toString(36)}`);
  execFileSync("npx", ["wrangler", "secret", "put", "OPERATOR_RECORD_IDS", "-c", "wrangler.measure.jsonc"], {
    input: recordId,
    stdio: ["pipe", "ignore", "inherit"],
  });
  for (let attempt = 0; ; attempt++) {
    if ((await operator.json(operator.get("/me"))).operator) break;
    if (attempt === 30) throw new Error("the operator secret did not take effect");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await operator.stepUp();
  return operator;
}

/** Wall time of one POST, in milliseconds, with the response it got. */
async function timed(path: string, body: unknown) {
  const request = new Request(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = performance.now();
  const response = await fetch(request);
  const text = await response.text();
  return { ms: performance.now() - started, status: response.status, text };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const operator = await becomeOperator();
const arms = await refusalArms({
  browser,
  suspend: async (memberName) => void (await operator.json(operator.post("/operator/suspend", { memberName }))),
});

const samples: Record<string, number[]> = { "(baseline: unknown route)": [] };
for (const arm of Object.keys(arms)) samples[arm] = [];

// Round 0 warms the Worker and its Durable Objects and is not counted.
for (let round = 0; round <= rounds; round++) {
  for (const [arm, prepare] of shuffle(Object.entries(arms))) {
    const { path, body } = await prepare();
    const { ms, status, text } = await timed(path, body);
    if (status !== 400 || text !== REFUSAL) throw new Error(`${arm}: expected the refusal, got ${status} ${text}`);
    if (round > 0) samples[arm]!.push(ms);
  }
  const baseline = await timed("/auth/not-a-route", {});
  if (round > 0) samples["(baseline: unknown route)"]!.push(baseline.ms);
  process.stderr.write(`round ${round}/${rounds}\r`);
}

const { "(baseline: unknown route)": baseline, ...armSamples } = samples;
const summaries = summarize(armSamples);
const [base] = summarize({ "(baseline: unknown route)": baseline! });
const row = (s: { arm: string; n: number; p50: number; p99: number; max: number }) =>
  `| ${s.arm} | ${s.n} | ${Math.round(s.p50)} | ${Math.round(s.p99)} | ${Math.round(s.max)} |`;

console.log(`Measured ${new Date().toISOString().slice(0, 10)} against ${origin}, ${rounds} rounds.\n`);
console.log("| Arm | n | p50 ms | p99 ms | max ms |\n|---|---|---|---|---|");
for (const s of [...summaries, base!]) console.log(row(s));
console.log(`\nRecommended REFUSAL_FLOOR_MS: ${recommendFloor(summaries)}`);
