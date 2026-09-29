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

2026-09-29: two runs of 150 rounds each against the measurement Worker, from one client, after a passkey's label came to be bound before the identity record commits it. That added a Durable Object call to the wrong recovery code, rebind and registration refusals. Times are in milliseconds, first run / second run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 424 / 432 | 614 / 542 | 847 / 623 | 1276 / 2097 |
| wrong origin | 224 / 196 | 483 / 284 | 852 / 457 | 1018 / 587 |
| unknown member name | 254 / 273 | 447 / 495 | 810 / 828 | 1040 / 1230 |
| regressed sign count | 227 / 198 | 378 / 290 | 653 / 632 | 670 / 746 |
| bad signature | 223 / 198 | 358 / 281 | 1361 / 406 | 1797 / 429 |
| suspended principal | 243 / 230 | 331 / 416 | 523 / 521 | 580 / 522 |
| wrong RP ID | 223 / 200 | 323 / 290 | 615 / 350 | 707 / 371 |
| cross-purpose challenge | 162 / 175 | 230 / 308 | 399 / 354 | 434 / 454 |
| unknown credential | 172 / 185 | 227 / 278 | 339 / 439 | 425 / 453 |
| unknown challenge | 138 / 154 | 206 / 233 | 282 / 331 | 388 / 350 |
| malformed response | 120 / 126 | 200 / 233 | 528 / 321 | 873 / 389 |
| baseline: unknown route | 18 / 21 | 23 / 46 | 103 / 105 | 105 / 106 |

The wrong recovery code is the slowest arm in both runs, because a refusal there comes late: the Worker verifies the new passkey, reserves it in the credential index, binds its label and prepares a session, then decodes the typed code as Bytewords, before the identity record rejects it and the credential and label are released again. Its p50 rose from 318 and 303 ms in the previous measurement to 424 and 432 ms, the cost of the label bind. Its p95 was 614 and 542 ms; 1.5 times each is 921 and 813, which round up to 950 and 850. The larger gives the floor: **950 ms**, up from 650.

The first run's wrong origin p95 (483 ms) is not repeated in the second (284 ms); that arm does none of the added work, so it was network noise.

A third run of 150 rounds, the same day, with the measurement Worker's floor at 950 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| bad signature | 967 | 1051 | 1125 | 1168 |
| suspended principal | 967 | 1046 | 1077 | 1243 |
| wrong recovery code | 968 | 1040 | 1077 | 1964 |
| cross-purpose challenge | 967 | 1038 | 1072 | 1076 |
| unknown credential | 967 | 1033 | 1055 | 1064 |
| wrong origin | 967 | 1032 | 1059 | 1059 |
| wrong RP ID | 967 | 1030 | 1065 | 1075 |
| unknown challenge | 966 | 1028 | 1070 | 1072 |
| regressed sign count | 967 | 1027 | 1065 | 1077 |
| malformed response | 967 | 1025 | 1073 | 1076 |
| unknown member name | 967 | 1024 | 1069 | 1072 |
| baseline: unknown route | 16 | 20 | 106 | 122 |

Every arm's p50 is 966 to 968 ms, and the wrong recovery code, the slowest arm without a floor, sits in the middle by p95. The p95s span 27 ms, against 65 ms in the previous check at 650 ms. The highest belongs to the bad signature, one of the cheaper arms without a floor (p95 358 and 281 ms), so its tail comes from the network rather than its own work. It is 5 ms above the next arm, 1 ms more than the baseline's p50-to-p95 spread of 4 ms; as in the previous check, the floor was accepted on the reading that a cheap arm cannot be revealed by time it did not spend.

Two runs were stopped by errors from the platform rather than by a refusal, and repeated. One registration was refused in setup five seconds after the script's secret change created a new version, while the Durable Objects restarted; the label bind failed and the ceremony was refused as designed. One login options request, 69 rounds into a floor check, got an uncaught `internal error` from the runtime on the challenge store's Durable Object call.

What the floor does not cover:

- The wrong recovery code's p99 was 847 and 623 ms and its maximum 1276 and 2097 ms, so fewer than 1% of those refusals took longer than 950 ms in either run, but some did.
- Three refusals are not among the measured arms, because the invariant test does not have them either: a throttled recovery (`recovery-throttled`), a passkey already registered (`credential-exists`), and a member name that differs from the one the recovery options were issued for (`wrong-member-name`). The throttled recovery takes the wrong recovery code's path as far as the identity record, which refuses it before checking the code, so it is no slower. The existing passkey is refused at the credential index, before the record. The wrong member name is refused before the passkey is verified.
