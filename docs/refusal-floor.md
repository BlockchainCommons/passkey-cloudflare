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

2026-09-26: two runs of 150 rounds each against the measurement Worker, from one client, after recovery codes became Bytewords-encoded seeds and recovery options stopped minting a label. Times are in milliseconds, first run / second run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 318 / 303 | 408 / 350 | 479 / 725 | 502 / 773 |
| unknown member name | 247 / 231 | 322 / 307 | 991 / 407 | 1296 / 411 |
| suspended principal | 188 / 158 | 236 / 179 | 276 / 223 | 307 / 443 |
| unknown credential | 165 / 157 | 203 / 202 | 281 / 214 | 1350 / 215 |
| bad signature | 154 / 153 | 200 / 182 | 239 / 568 | 600 / 2153 |
| regressed sign count | 155 / 150 | 184 / 181 | 202 / 319 | 205 / 896 |
| wrong RP ID | 154 / 151 | 180 / 189 | 205 / 300 | 291 / 488 |
| wrong origin | 156 / 150 | 179 / 198 | 221 / 354 | 685 / 458 |
| cross-purpose challenge | 154 / 147 | 178 / 170 | 321 / 182 | 1300 / 307 |
| unknown challenge | 136 / 129 | 171 / 161 | 288 / 221 | 530 / 257 |
| malformed response | 125 / 121 | 146 / 146 | 200 / 500 | 201 / 1103 |
| baseline: unknown route | 18 / 17 | 21 / 19 | 24 / 21 | 27 / 21 |

The wrong recovery code is the slowest arm in both runs, because a refusal there comes late: the Worker verifies the new passkey, reserves it in the credential index and prepares a session, then decodes the typed code as Bytewords, before the identity record rejects it and the credential is released again. Its p95 was 408 and 350 ms; 1.5 times each is 612 and 525, which round up to 650 and 550. The larger gives the floor: **650 ms**, up from 600.

A third run of 150 rounds, the same day, with the measurement Worker's floor at 650 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| regressed sign count | 674 | 786 | 946 | 967 |
| cross-purpose challenge | 674 | 757 | 889 | 962 |
| unknown member name | 674 | 755 | 1265 | 1573 |
| wrong RP ID | 674 | 752 | 938 | 962 |
| wrong recovery code | 675 | 749 | 771 | 942 |
| suspended principal | 674 | 748 | 932 | 1014 |
| bad signature | 675 | 748 | 887 | 966 |
| unknown credential | 673 | 726 | 806 | 838 |
| wrong origin | 674 | 726 | 822 | 840 |
| malformed response | 673 | 724 | 880 | 888 |
| unknown challenge | 673 | 721 | 866 | 902 |
| baseline: unknown route | 23 | 28 | 128 | 168 |

Every arm's p50 is 673 to 675 ms, and the wrong recovery code, the slowest arm without a floor, sits in the middle by p95. The p95s span 65 ms, close to the 60 ms of the previous check at 600 ms. The highest belongs to the regressed sign count, one of the cheapest arms without a floor (p95 184 and 181 ms), so its tail comes from the network rather than its own work. By the letter of step 4 it stands out: it is 29 ms above the next arm, and the baseline's p50-to-p95 spread in this run was only 5 ms, against 79 ms in the previous check. The floor was accepted on the reading that a cheap arm cannot be revealed by time it did not spend.

What the floor does not cover:

- The wrong recovery code's p99 was 479 and 725 ms, so in the second run roughly 1% of those refusals took longer than 650 ms. A floor from the same rule applied to p99 would be 1100 to 1500 ms.
- Three refusals are not among the measured arms, because the invariant test does not have them either: a throttled recovery (`recovery-throttled`), a passkey already registered (`credential-exists`), and a member name that differs from the one the recovery options were issued for (`wrong-member-name`). The throttled recovery takes the wrong recovery code's path as far as the identity record, which refuses it before checking the code, so it is no slower. The existing passkey is refused at the credential index, before the record. The wrong member name is refused before the passkey is verified.
