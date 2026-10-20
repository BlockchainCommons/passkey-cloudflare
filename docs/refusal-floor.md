# Choosing the refusal timing floor

Every refused ceremony returns the same response, and returns it no sooner than `REFUSAL_FLOOR_MS` after the request arrived. The floor keeps refusals from being told apart by how long they take, so it has to be longer than the slowest way a ceremony can be refused. If one arm takes longer than the floor, its extra time shows, and so does its cause.

The floor is set from measurements of the deployed runtime, not from local tests. Local tests run every Durable Object in one process, so they show none of the network hops a refusal makes on Cloudflare.

## Method

You need `wrangler` logged in to the account that will host the measurement Worker, and a Node version that runs TypeScript files directly (Node 23.6 or later). Run every command from `apps/demo`.

1. Deploy the measurement Worker, `apps/demo/wrangler.measure.jsonc`, once to learn its workers.dev host. It runs the same code as the demo with its own Durable Objects and no floor. Its rate limits keep their windows and their per-request work, but are set too high to refuse, so a run from one address times the ceremonies rather than the throttle.

   ```sh
   cd apps/demo
   npx wrangler deploy -c wrangler.measure.jsonc
   ```

2. Run the measurement:

   ```sh
   node scripts/measure-refusals.ts https://<host>      # 150 rounds by default
   ```

   The script deploys the measurement Worker again, with the relying party set to the host and a random member name in its `OPERATOR_MEMBER_NAMES` var, which only the non-production entry points read. It registers that name, so the suspended-principal arm has an operator, and waits until the new version has answered 8 times in a row, since the edge can go on serving the previous version for a while after one request reaches the new one. It then sends every refusal arm from `test/refusal-arms.ts`, the same list the invariant test "no distinguishable ceremony failure" uses, once per round, in a fresh random order each round. Round 0 warms the Worker and is not counted. A request to an unknown route is timed each round as a baseline for the network round trip. Any arm that does not get the uniform refusal stops the run. So does a network error between the client and the edge, with no table; run it again.

   Afterwards, query Workers observability, which the measurement Worker has turned on, for its `fetch` events between the script's last `GET /me` and the time it finished, and check that every one carries the `$workers.scriptVersion` that answered that `/me`. Requests before it, while the script waits, may come from either version. The times are taken at the client, and a request the previous version served gets the same uniform refusal, so it would be counted without showing. If any did, run again.

3. Run it a second time. Each run recommends a floor of 1.5 times the slowest arm's p95, rounded up to 50 ms; take the larger of the two. When the two recommendations disagree widely, run a third and take the largest of the three. Each arm needs at least 100 samples.

   The rule uses p95, not p99. Above p95 the times are dominated by spikes of up to a second or more that land on cheap arms too, and on different arms in each run, so a p99-based floor moved by hundreds of milliseconds between runs and would make every refused ceremony wait seconds. The cost is a known residue: the slowest arm's own tail is longer than the others', and the few percent of its refusals that run past the floor can still be told apart by time (see the results below).

   Times are measured at the client, so they include the round trip, which makes the floor a little longer than it needs to be rather than shorter.

4. Check the floor: run the script once more with `--floor <floor>`, which deploys the measurement Worker with that `REFUSAL_FLOOR_MS`. Ignore its recommendation, which is meaningless with a floor in place; read the table. The arms' p50s should agree to within a few milliseconds, and no arm's p95 should stand out from the others by more than the baseline's own spread.

5. Set `REFUSAL_FLOOR_MS` in `apps/demo/wrangler.jsonc`, record the runs below, and delete the measurement Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification, or when the demo moves to other infrastructure.

## Last measurement

2026-10-20: three runs of 150 rounds each against the measurement Worker, from one client, in the account the demo has run in since 2026-10-06, on Workers Paid. They were the first with the credential exists arm, the first arm to reach the credential index. The first two runs recommended 850 and 1050 ms, so a third was run. Times are in milliseconds, first / second / third run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| unknown member name | 353 / 347 / 338 | 563 / 526 / 626 | 1106 / 675 / 1105 | 2099 / 758 / 1449 |
| wrong recovery code | 387 / 380 / 386 | 553 / 679 / 634 | 750 / 1394 / 1021 | 757 / 1557 / 1858 |
| credential exists | 357 / 343 / 350 | 524 / 526 / 652 | 637 / 753 / 1050 | 847 / 960 / 1527 |
| backup eligibility changed | 274 / 239 / 249 | 523 / 509 / 542 | 773 / 678 / 1052 | 922 / 746 / 1522 |
| bad signature | 251 / 225 / 224 | 521 / 394 / 421 | 622 / 574 / 524 | 2273 / 814 / 663 |
| wrong RP ID | 259 / 218 / 228 | 464 / 384 / 419 | 718 / 424 / 872 | 1063 / 678 / 1806 |
| regressed sign count | 246 / 217 / 217 | 454 / 373 / 503 | 560 / 490 / 721 | 568 / 530 / 1395 |
| wrong origin | 242 / 225 / 229 | 441 / 402 / 426 | 683 / 633 / 637 | 744 / 864 / 923 |
| cross origin | 254 / 226 / 231 | 427 / 413 / 431 | 647 / 463 / 545 | 785 / 988 / 611 |
| suspended principal | 282 / 230 / 240 | 412 / 440 / 406 | 459 / 749 / 448 | 522 / 863 / 477 |
| unknown credential | 221 / 219 / 217 | 392 / 369 / 405 | 526 / 525 / 723 | 546 / 562 / 748 |
| cross-purpose challenge | 213 / 212 / 213 | 385 / 398 / 311 | 448 / 599 / 526 | 467 / 812 / 595 |
| credential ID too long | 215 / 206 / 208 | 361 / 347 / 389 | 667 / 497 / 534 | 779 / 563 / 716 |
| unknown challenge | 189 / 181 / 182 | 357 / 377 / 331 | 755 / 542 / 491 | 1049 / 721 / 560 |
| malformed response | 162 / 156 / 158 | 256 / 311 / 307 | 347 / 434 / 449 | 614 / 629 / 597 |
| baseline: unknown route | 22 / 19 / 24 | 102 / 27 / 113 | 140 / 105 / 174 | 216 / 107 / 264 |

The slowest arm changed from run to run: the unknown member name in the first (p95 563), the wrong recovery code in the second (679) and the credential exists arm in the third (652). 1.5 times each is 845, 1019 and 978, which round up to 850, 1050 and 1000. The largest gives the floor: **1050 ms**, up from 800.

The credential exists arm is among the three slowest arms in every run, as its Durable Object calls predicted (seven and a registration verification, against the wrong recovery code's eight), and its p50 (357, 343, 350) is within 12 ms of the unknown member name's in each run. Most of the rise from 800 comes from the arms measured before: the wrong recovery code's p95 was 525 and 495 ms on 2026-10-07 and 553 to 679 now, with no change to its code. Whether that comes from when the runs were taken has not been checked by measuring the 2026-10-07 code again.

A fourth run of 150 rounds, the same day, with the measurement Worker's floor at 1050 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| cross-purpose challenge | 1077 | 1253 | 1312 | 1366 |
| unknown member name | 1079 | 1246 | 1312 | 1350 |
| credential ID too long | 1075 | 1228 | 1284 | 1344 |
| bad signature | 1079 | 1227 | 1275 | 1288 |
| credential exists | 1076 | 1227 | 1318 | 1347 |
| suspended principal | 1076 | 1225 | 1301 | 1333 |
| backup eligibility changed | 1078 | 1225 | 1293 | 2120 |
| unknown credential | 1077 | 1219 | 1448 | 6729 |
| malformed response | 1074 | 1217 | 1294 | 1343 |
| wrong origin | 1077 | 1213 | 1332 | 3477 |
| wrong RP ID | 1076 | 1205 | 1257 | 1302 |
| unknown challenge | 1075 | 1195 | 1280 | 2236 |
| wrong recovery code | 1077 | 1193 | 1298 | 2009 |
| regressed sign count | 1076 | 1185 | 1352 | 1396 |
| cross origin | 1076 | 1163 | 1229 | 1267 |
| baseline: unknown route | 23 | 95 | 117 | 127 |

Every arm's p50 is between 1074 and 1079 ms. The p95s span 90 ms (1163 to 1253), within the baseline's own p95 of 95 ms, and the highest belongs to the cross-purpose challenge, one of the cheaper arms without a floor (p95 311 to 398 ms).

What the floor does not cover:

- Each run had refusals that took longer than 1050 ms. The largest p99s were 1106 ms (unknown member name, first run), 1394 (wrong recovery code, second run) and 1105 (unknown member name, third run), and the largest maximum was 2273 (bad signature, first run). In the third run six arms had a maximum over 1050 ms, cheap ones among them: the spikes the p95 rule sets aside.
- Three refusals are not among the measured arms, because the invariant test does not have them either, but are no slower than one that is: a throttled recovery (`recovery-throttled`), a member name that differs from the one the recovery options were issued for (`wrong-member-name`), and a removed principal (`removed`). The throttled recovery takes the wrong recovery code's path, and the same identity record call refuses it before checking the code. The wrong member name is refused before the passkey is verified. The removed principal is refused by the same check, on the same row, as the suspended principal.
- A member name claimed by another registration after the options were issued (`member-name-taken`) is no slower than the credential exists arm, and needs no arm of its own. Registration verifies the new passkey, then makes two member-name registry calls: the claim, which fails, and `claimBefore`, which looks for a stale claim to free. It finds none, since a claim made after the options were issued is younger than a challenge's lifetime and a retired name is not a stale claim, so the record lookup that follows a stale claim does not run. That is six Durable Object calls, counting the two throttles and the challenge before them and the ceremony failure log after, against the credential exists arm's seven, and both run the same registration verification before their calls diverge.
- The credential binding is covered only up to the credential index. A ceremony that adds a passkey (register, enrol, recover, rebind) verifies it, puts its credential id in the credential index, binds its label, then commits to the record. When a later step refuses, it removes the index entry and runs the ceremony's own undo, such as releasing a claimed member name; a label bound for the refused ceremony stays bound and names no passkey. The credential exists arm is a registration refused at the index put, after the verification and before anything is bound, and is measured above. No arm goes past the index put. The comparisons below count Durable Object calls; none of these refusals has been timed:
  - A passkey already registered (`credential-exists`) in recovery takes the wrong recovery code's path plus a verification and the index put, more than either measured arm, though only a caller holding a valid recovery code reaches it. In enrol and rebind it comes after a live session or a live rebind link.
  - A label that fails to bind (`label-unbound`) adds the label call and the index entry's removal: nine calls in registration, more than the slowest measured arm. It needs no arm of its own, since only a caller who has proved the record reaches it. A new record has no labels, and enrol and rebind bind a label minted for them when their options were issued, so it comes from three places: a bind that throws, whose time the floor cannot bound (as with `internal-error` below); an enrol, rebind or recovery that presents the credential id of a passkey the record revoked, whose index entry is gone but whose label row still names it; and recovery's unchecked label draw landing on a label the record has bound or retired. Each comes after a live session, a live rebind link or a valid recovery code.
  - A record already at a freshly minted record id (`record-exists`) is refused by the record at commit, after the whole binding: ten calls in registration, counting the undo and the ceremony failure log. It needs two random record ids to collide, so no caller can reach it, and it needs no arm. Any other refusal the record returns at commit takes the same path, such as a recovery code that a concurrent recovery used since the check (`wrong-recovery-code`), a rebind link that expired or was used after its options were issued (`bad-rebind-link`), or a principal suspended or removed during the ceremony.
- The RP ID check, which every ceremony runs before anything else, adds no Durable Object call to a measured arm, so it did not call for a new run. It reads the RP ID stored in the credential index, and once that matches the configured one, the isolate keeps the match and its later ceremonies skip the read (`apps/demo/test/rp-id-pin.test.ts` counts the calls). The first ceremony on each isolate makes one call more, as does every ceremony on a deployment with no passkeys yet. A deployment whose RP ID changed refuses every ceremony after that read (`rp-id-changed`), so it has no successful ceremony for a refusal to be told apart from.
- A ceremony ended by the server's own failure (`internal-error`, or `options-internal-error` while its options are issued), such as a Durable Object call that throws, is not measured. It gets the uniform refusal after the floor, but how long it takes depends on how long the failing call takes before it throws, which the floor cannot bound.
