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

4. Check the floor: deploy the measurement Worker again with `--var REFUSAL_FLOOR_MS:<floor>` added, and run the script once more. Ignore its recommendation, which is meaningless with a floor in place; read the table. The arms' p50s should agree to within a few milliseconds, and no arm's p95 should stand out from the others by more than the baseline's own spread.

5. Set `REFUSAL_FLOOR_MS` in `apps/demo/wrangler.jsonc`, record the runs below, and delete the measurement Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification, or when the demo moves to other infrastructure.

## Last measurement

2026-10-01: two runs of 150 rounds each against the measurement Worker, from one client, after a removed member came to be refused. Removal adds no Durable Object call: the identity record refuses a removed principal from the same row read that refuses a suspended one. Times are in milliseconds, first run / second run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 419 / 416 | 620 / 532 | 1317 / 630 | 1576 / 1545 |
| unknown member name | 271 / 267 | 421 / 431 | 525 / 582 | 565 / 1000 |
| bad signature | 226 / 231 | 359 / 420 | 447 / 439 | 564 / 440 |
| wrong RP ID | 224 / 233 | 343 / 430 | 446 / 560 | 494 / 8493 |
| regressed sign count | 225 / 232 | 330 / 321 | 746 / 427 | 747 / 557 |
| wrong origin | 227 / 234 | 317 / 334 | 431 / 497 | 592 / 523 |
| suspended principal | 202 / 253 | 290 / 394 | 457 / 468 | 1220 / 2090 |
| cross-purpose challenge | 168 / 168 | 290 / 352 | 470 / 780 | 499 / 1667 |
| unknown credential | 182 / 179 | 272 / 266 | 405 / 460 | 832 / 913 |
| unknown challenge | 132 / 124 | 206 / 209 | 433 / 294 | 687 / 310 |
| malformed response | 120 / 117 | 180 / 257 | 246 / 514 | 523 / 823 |
| baseline: unknown route | 17 / 19 | 25 / 33 | 100 / 167 | 290 / 168 |

The wrong recovery code is the slowest arm in both runs, as in the previous measurement (p50 424 and 432 ms then, 419 and 416 now), because a refusal there comes late: the Worker verifies the new passkey, reserves it in the credential index, binds its label and prepares a session, then decodes the typed code as Bytewords, before the identity record rejects it and the credential and label are released again. Its p95 was 620 and 532 ms; 1.5 times each is 930 and 798, which round up to 950 and 800. The larger gives the floor: **950 ms**, unchanged.

The wrong RP ID's maximum of 8493 ms in the second run is one request; its p99 is 560 ms, and that arm does none of the slow arm's work.

A third run of 150 rounds, the same day, with the measurement Worker's floor at 950 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| malformed response | 971 | 1051 | 1097 | 1243 |
| wrong recovery code | 969 | 1048 | 1123 | 1148 |
| cross-purpose challenge | 968 | 1048 | 1210 | 2857 |
| unknown member name | 968 | 1045 | 1049 | 1062 |
| wrong origin | 968 | 1043 | 1256 | 1318 |
| unknown credential | 968 | 1034 | 1126 | 1140 |
| suspended principal | 969 | 1026 | 1205 | 1278 |
| unknown challenge | 968 | 1026 | 1073 | 1188 |
| bad signature | 968 | 1023 | 1066 | 1128 |
| regressed sign count | 969 | 1022 | 1208 | 1223 |
| wrong RP ID | 968 | 1008 | 1045 | 1143 |
| baseline: unknown route | 17 | 25 | 38 | 89 |

Every arm's p50 is 968 to 971 ms. The p95s span 43 ms, against 27 ms in the previous check, with the top five within 8 ms of each other. The highest belongs to the malformed response, the cheapest arm without a floor (p95 180 and 257 ms), 3 ms above the wrong recovery code; as in the previous checks, the floor was accepted on the reading that a cheap arm cannot be revealed by time it did not spend.

One run was stopped at round 120 by an error from the platform rather than by a refusal, and repeated: a login options request got an uncaught "Network connection lost." on a Durable Object call.

What the floor does not cover:

- The wrong recovery code's p99 was 1317 and 630 ms and its maximum 1576 and 1545 ms, so a few of those refusals took longer than 950 ms, as in the previous measurement.
- Four refusals are not among the measured arms, because the invariant test does not have them either: a throttled recovery (`recovery-throttled`), a passkey already registered (`credential-exists`), a member name that differs from the one the recovery options were issued for (`wrong-member-name`), and a removed principal (`removed`). The throttled recovery takes the wrong recovery code's path as far as the identity record, which refuses it before checking the code, so it is no slower. The existing passkey is refused at the credential index, before the record. The wrong member name is refused before the passkey is verified. The removed principal is refused by the same check, on the same row, as the suspended principal.
