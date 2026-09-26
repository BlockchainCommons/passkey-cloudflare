# Choosing the refusal timing floor

Every refused ceremony returns the same response, and returns it no sooner than `REFUSAL_FLOOR_MS` after the request arrived. The floor keeps refusals from being told apart by how long they take, so it has to be longer than the slowest way a ceremony can be refused. If one arm takes longer than the floor, its extra time shows, and so does its cause.

The floor is set from measurements of the deployed runtime, not from local tests. Local tests run every Durable Object in one process, so they show none of the network hops a refusal makes on Cloudflare.

## Method

You need `wrangler` logged in to the account that will host the measurement Worker, and a Node version that runs TypeScript files directly (Node 23.6 or later). Run every command from `apps/demo`.

1. Deploy the measurement Worker, `apps/demo/wrangler.measure.jsonc`. It runs the same code as the demo with its own Durable Objects and no floor. Its rate limits keep their windows and their per-request work, but are set too high to refuse, so a run from one address times the ceremonies rather than the throttle. Deploy it once to learn its workers.dev host, then again with the relying party set to that host:

   ```sh
   cd apps/demo
   npx wrangler deploy -c wrangler.measure.jsonc --var RP_ID:<host> --var ORIGIN:https://<host>
   ```

2. Run the measurement:

   ```sh
   node scripts/measure-refusals.ts https://<host>      # 150 rounds by default
   ```

   The script registers an operator and sets it as the Worker's `OPERATOR_RECORD_IDS` secret, so the suspended-principal arm can run. It then sends every refusal arm from `test/refusal-arms.ts`, the same list the invariant test "no distinguishable ceremony failure" uses, once per round, in a fresh random order each round. Round 0 warms the Worker and is not counted. A request to an unknown route is timed each round as a baseline for the network round trip. Any arm that does not get the uniform refusal stops the run.

3. Run it a second time. Each run recommends a floor of 1.5 times the slowest arm's p95, rounded up to 50 ms; take the larger of the two. Each arm needs at least 100 samples.

   The rule uses p95, not p99. Above p95 the times are dominated by spikes of up to a second or more that land on cheap arms too, and on different arms in each run, so a p99-based floor moved by hundreds of milliseconds between runs and would make every refused ceremony wait seconds. The cost is a known residue: the slowest arm's own tail is longer than the others', and the few percent of its refusals that run past the floor can still be told apart by time (see the results below).

   Times are measured at the client, so they include the round trip, which makes the floor a little longer than it needs to be rather than shorter.

4. Set `REFUSAL_FLOOR_MS` in `apps/demo/wrangler.jsonc`, record both runs below, and delete the measurement Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification, or when the demo moves to other infrastructure.

## Last measurement

2026-09-25: two runs of 150 rounds each against the measurement Worker, from one client. Times are in milliseconds, first run / second run, arms in the second run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 314 / 327 | 380 / 392 | 521 / 650 | 1359 / 1517 |
| unknown member name | 197 / 210 | 241 / 261 | 277 / 355 | 326 / 480 |
| wrong RP ID | 142 / 147 | 194 / 188 | 287 / 335 | 407 / 595 |
| regressed sign count | 145 / 145 | 173 / 186 | 245 / 472 | 652 / 1208 |
| suspended principal | 174 / 156 | 215 / 185 | 305 / 210 | 343 / 405 |
| unknown credential | 141 / 147 | 171 / 180 | 201 / 232 | 279 / 247 |
| bad signature | 145 / 151 | 172 / 171 | 190 / 187 | 255 / 233 |
| wrong origin | 145 / 147 | 183 / 171 | 206 / 191 | 357 / 339 |
| cross-purpose challenge | 131 / 141 | 149 / 170 | 192 / 203 | 244 / 470 |
| unknown challenge | 103 / 116 | 123 / 142 | 166 / 164 | 271 / 298 |
| malformed response | 94 / 104 | 121 / 130 | 288 / 170 | 465 / 173 |
| baseline: unknown route | 15 / 18 | 19 / 22 | 21 / 25 | 23 / 27 |

The wrong recovery code is the slowest arm in both runs, because a refusal there comes late: the Worker verifies the new passkey, reserves it in the credential index and prepares a session before the identity record rejects the code, then releases the credential again. Its p95 was 380 and 392 ms; 1.5 times each is 570 and 588, and both round up to the same floor: **600 ms**. The previous floor, 250 ms, was shorter than that arm's median, so its refusals could be told apart by time alone.

What the floor does not cover:

- The wrong recovery code's p99 was 521 and 650 ms, so roughly 1% of those refusals still take longer than 600 ms. Covering them would need a floor near the p99 rule's 2100 to 2850 ms.
- Three refusals are not among the measured arms, because the invariant test does not have them either: a throttled recovery (`recovery-throttled`), a passkey already registered (`credential-exists`), and a member name that differs from the one the recovery options were issued for (`wrong-member-name`). The throttled recovery takes the wrong recovery code's path as far as the identity record, which refuses it before checking the code, so it is no slower. The existing passkey is refused at the credential index, before the record. The wrong member name is refused before the passkey is verified.
