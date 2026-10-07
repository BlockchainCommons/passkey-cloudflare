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

   The script deploys the measurement Worker again, with the relying party set to the host and a random member name in its `OPERATOR_MEMBER_NAMES` var, which only the non-production entry points read. It registers that name, so the suspended-principal arm has an operator, and waits until the new version has answered 8 times in a row, since the edge can go on serving the previous version for a while after one request reaches the new one. It then sends every refusal arm from `test/refusal-arms.ts`, the same list the invariant test "no distinguishable ceremony failure" uses, once per round, in a fresh random order each round. Round 0 warms the Worker and is not counted. A request to an unknown route is timed each round as a baseline for the network round trip. Any arm that does not get the uniform refusal stops the run.

   Afterwards, query Workers observability, which the measurement Worker has turned on, for its `fetch` events between the script's last `GET /me` and the time it finished, and check that every one carries the `$workers.scriptVersion` that answered that `/me`. Requests before it, while the script waits, may come from either version. The times are taken at the client, and a request the previous version served gets the same uniform refusal, so it would be counted without showing. If any did, run again.

3. Run it a second time. Each run recommends a floor of 1.5 times the slowest arm's p95, rounded up to 50 ms; take the larger of the two. Each arm needs at least 100 samples.

   The rule uses p95, not p99. Above p95 the times are dominated by spikes of up to a second or more that land on cheap arms too, and on different arms in each run, so a p99-based floor moved by hundreds of milliseconds between runs and would make every refused ceremony wait seconds. The cost is a known residue: the slowest arm's own tail is longer than the others', and the few percent of its refusals that run past the floor can still be told apart by time (see the results below).

   Times are measured at the client, so they include the round trip, which makes the floor a little longer than it needs to be rather than shorter.

4. Check the floor: run the script once more with `--floor <floor>`, which deploys the measurement Worker with that `REFUSAL_FLOOR_MS`. Ignore its recommendation, which is meaningless with a floor in place; read the table. The arms' p50s should agree to within a few milliseconds, and no arm's p95 should stand out from the others by more than the baseline's own spread.

5. Set `REFUSAL_FLOOR_MS` in `apps/demo/wrangler.jsonc`, record the runs below, and delete the measurement Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification, or when the demo moves to other infrastructure.

## Last measurement

2026-10-07: two runs of 150 rounds each against the measurement Worker, from one client, in the account the demo has run in since 2026-10-06, on Workers Paid. They were the first in that account, and the first with the credential ID too long and backup eligibility changed arms. Times are in milliseconds, first run / second run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 398 / 399 | 525 / 495 | 594 / 712 | 596 / 970 |
| unknown member name | 367 / 353 | 518 / 427 | 566 / 530 | 608 / 3258 |
| suspended principal | 240 / 215 | 332 / 268 | 391 / 425 | 402 / 442 |
| wrong RP ID | 219 / 196 | 330 / 244 | 439 / 265 | 478 / 632 |
| wrong origin | 218 / 196 | 317 / 253 | 346 / 418 | 524 / 1319 |
| credential ID too long | 222 / 214 | 314 / 278 | 524 / 329 | 525 / 372 |
| bad signature | 219 / 195 | 310 / 260 | 381 / 342 | 465 / 407 |
| regressed sign count | 220 / 194 | 309 / 253 | 387 / 320 | 389 / 365 |
| backup eligibility changed | 230 / 202 | 308 / 261 | 384 / 468 | 593 / 1005 |
| cross origin | 219 / 192 | 301 / 269 | 385 / 419 | 524 / 448 |
| unknown credential | 228 / 218 | 289 / 265 | 386 / 302 | 439 / 393 |
| unknown challenge | 195 / 188 | 283 / 235 | 353 / 319 | 390 / 367 |
| cross-purpose challenge | 218 / 213 | 268 / 308 | 503 / 351 | 719 / 471 |
| malformed response | 183 / 177 | 233 / 224 | 273 / 282 | 349 / 338 |
| baseline: unknown route | 33 / 32 | 38 / 35 | 165 / 42 | 165 / 46 |

The wrong recovery code is the slowest arm, as it was in the previous account. Its p95 was 525 and 495 ms; 1.5 times each is 788 and 743, which round up to 800 and 750. The larger gives the floor: **800 ms**, up from 700.

The slow arms are slower than in the previous measurement (2026-10-03, in the earlier account), with no change to their code: the wrong recovery code's p50 was 295 and 272 ms then, and the unknown member name's 251 and 235. The new arms are not the cause; both sit among the cheaper arms. Whether the difference comes from the new account or from when the runs were taken has not been checked by measuring the 2026-10-03 code again.

A third run of 150 rounds, the same day, with the measurement Worker's floor at 800 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| malformed response | 833 | 1040 | 2395 | 3372 |
| cross origin | 835 | 999 | 2898 | 3987 |
| wrong origin | 836 | 975 | 1049 | 6684 |
| cross-purpose challenge | 834 | 949 | 1119 | 5010 |
| wrong RP ID | 836 | 941 | 1063 | 1453 |
| unknown challenge | 837 | 940 | 1109 | 1271 |
| wrong recovery code | 836 | 936 | 1552 | 2577 |
| unknown credential | 837 | 930 | 1032 | 1044 |
| backup eligibility changed | 836 | 924 | 989 | 992 |
| bad signature | 836 | 923 | 1041 | 1045 |
| suspended principal | 836 | 922 | 999 | 1045 |
| regressed sign count | 835 | 922 | 1047 | 1474 |
| credential ID too long | 837 | 922 | 989 | 1009 |
| unknown member name | 838 | 919 | 1047 | 7210 |
| baseline: unknown route | 33 | 115 | 180 | 229 |

Every arm's p50 is between 833 and 838 ms. The network was noisier than in the first two runs: the baseline's p95 was 115 ms against 38 and 35. The p95s span 121 ms, and the two highest belong to the malformed response and the cross origin, two of the cheapest arms without a floor (p95 233 and 301 ms in the first run); as in the previous checks, the floor was accepted on the reading that a cheap arm cannot be revealed by time it did not spend.

What the floor does not cover:

- The unknown member name's maximum was 3258 ms and the wrong recovery code's 970 ms in the second run, so a few refusals took longer than 800 ms. Their p99s were 530 and 712 ms.
- Three refusals are not among the measured arms, because the invariant test does not have them either, but are no slower than one that is: a throttled recovery (`recovery-throttled`), a member name that differs from the one the recovery options were issued for (`wrong-member-name`), and a removed principal (`removed`). The throttled recovery takes the wrong recovery code's path, and the same identity record call refuses it before checking the code. The wrong member name is refused before the passkey is verified. The removed principal is refused by the same check, on the same row, as the suspended principal.
- A member name claimed by another registration after the options were issued (`member-name-taken`) is no slower than the wrong recovery code, and needs no arm of its own. Registration verifies the new passkey, then makes two member-name registry calls: the claim, which fails, and `claimBefore`, which looks for a stale claim to free. It finds none, since a claim made after the options were issued is younger than a challenge's lifetime and a retired name is not a stale claim, so the record lookup that follows a stale claim does not run. That is six Durable Object calls, counting the two throttles and the challenge before them and the ceremony failure log after, against the wrong recovery code's eight. In exchange it runs a registration verification, which no measured arm runs: with attestation `none` it checks no signature, and a whole successful registration takes 4 ms of CPU at p50 and 8 at p95, and 4 to 14 ms as a fresh version's first call (`docs/workers-free.md`). One Durable Object call costs more than that: the unknown member name makes one call fewer than the wrong recovery code, and their p50s are 31 to 46 ms apart.
- No refusal from the credential binding is covered. A ceremony that adds a passkey (register, enrol, recover, rebind) verifies it, puts its credential id in the credential index, binds its label, then commits to the record. When a later step refuses, it removes the index entry and runs the ceremony's own undo, such as releasing a claimed member name; a label bound for the refused ceremony stays bound and names no passkey. The credential ID too long arm verifies a new passkey and is refused before the index put, but no measured arm reaches the index, so the 800 ms floor was taken without the rest of this path. The comparisons below count Durable Object calls; none of these refusals has been timed:
  - A passkey already registered (`credential-exists`) is refused at the index put. In registration that comes to seven calls, including the member name's release, and a verification: one call fewer than the wrong recovery code, too close for the floor to be said to cover it. In recovery it is the wrong recovery code's path plus a verification and the index put, more than the slowest measured arm, though only a caller holding a valid recovery code reaches it. Anyone can reach the registration case, with a registration response for a credential id already indexed (attestation `none` lets a client build one), which makes it the arm to add: measuring it would bring the verify-and-index path back under the floor.
  - A label that fails to bind (`label-unbound`) adds the label call and the index entry's removal: nine calls in registration, more than the slowest measured arm. It needs no arm of its own, since only a caller who has proved the record reaches it. A new record has no labels, and enrol and rebind bind a label minted for them when their options were issued, so it comes from three places: a bind that throws, whose time the floor cannot bound (as with `internal-error` below); an enrol, rebind or recovery that presents the credential id of a passkey the record revoked, whose index entry is gone but whose label row still names it; and recovery's unchecked label draw landing on a label the record has bound or retired. Each comes after a live session, a live rebind link or a valid recovery code.
  - A record already at a freshly minted record id (`record-exists`) is refused by the record at commit, after the whole binding: ten calls in registration, counting the undo and the ceremony failure log. It needs two random record ids to collide, so no caller can reach it, and it needs no arm. Any other refusal the record returns at commit takes the same path, such as a recovery code that a concurrent recovery used since the check (`wrong-recovery-code`), a rebind link that expired or was used after its options were issued (`bad-rebind-link`), or a principal suspended or removed during the ceremony.
- A ceremony ended by the server's own failure (`internal-error`), such as a Durable Object call that throws, is not measured. It gets the uniform refusal after the floor, but how long it takes depends on how long the failing call takes before it throws, which the floor cannot bound.
