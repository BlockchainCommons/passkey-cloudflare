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

3. Run it a second time. Each run recommends a floor of 1.5 times the slowest arm's p95, rounded up to 50 ms; take the larger of the two. Each arm needs at least 100 samples.

   The rule uses p95, not p99. Above p95 the times are dominated by spikes of up to a second or more that land on cheap arms too, and on different arms in each run, so a p99-based floor moved by hundreds of milliseconds between runs and would make every refused ceremony wait seconds. The cost is a known residue: the slowest arm's own tail is longer than the others', and the few percent of its refusals that run past the floor can still be told apart by time (see the results below).

   Times are measured at the client, so they include the round trip, which makes the floor a little longer than it needs to be rather than shorter.

4. Check the floor: run the script once more with `--floor <floor>`, which deploys the measurement Worker with that `REFUSAL_FLOOR_MS`. Ignore its recommendation, which is meaningless with a floor in place; read the table. The arms' p50s should agree to within a few milliseconds, and no arm's p95 should stand out from the others by more than the baseline's own spread.

5. Set `REFUSAL_FLOOR_MS` in `apps/demo/wrangler.jsonc`, record the runs below, and delete the measurement Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification, or when the demo moves to other infrastructure.

## Last measurement

2026-10-03: two runs of 150 rounds each against the measurement Worker, from one client, after recovery came to check the code before the new passkey. The identity record now applies the throttle, counts the attempt and checks the code in one call before the passkey is verified, so a wrong or throttled code is refused without the verification, the credential index, the label or the session. Times are in milliseconds, first run / second run, arms in the first run's order by p95.

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| wrong recovery code | 295 / 272 | 453 / 318 | 699 / 365 | 1710 / 379 |
| wrong RP ID | 227 / 213 | 329 / 236 | 425 / 354 | 2074 / 921 |
| unknown member name | 251 / 235 | 324 / 294 | 470 / 478 | 653 / 498 |
| regressed sign count | 228 / 215 | 311 / 238 | 377 / 338 | 398 / 598 |
| wrong origin | 225 / 217 | 308 / 276 | 510 / 318 | 937 / 320 |
| bad signature | 226 / 212 | 307 / 239 | 445 / 262 | 448 / 264 |
| cross-purpose challenge | 180 / 171 | 250 / 216 | 414 / 530 | 472 / 876 |
| suspended principal | 217 / 205 | 249 / 252 | 360 / 383 | 393 / 563 |
| unknown credential | 196 / 187 | 241 / 223 | 339 / 296 | 1736 / 413 |
| unknown challenge | 149 / 140 | 219 / 161 | 427 / 202 | 625 / 383 |
| malformed response | 140 / 135 | 191 / 168 | 447 / 267 | 532 / 299 |
| baseline: unknown route | 29 / 23 | 36 / 28 | 99 / 49 | 117 / 71 |

The wrong recovery code is still the slowest arm, but by much less: its p50 fell from 419 and 416 ms in the previous measurement to 295 and 272 now. A refusal there now comes early: the Worker consumes the challenge, resolves the member name and decodes the typed code as Bytewords, then the identity record refuses it before the new passkey is verified. That is the unknown member name's work plus one call to the record, and the two arms' p50s are now 37 to 44 ms apart. Its p95 was 453 and 318 ms; 1.5 times each is 680 and 477, which round up to 700 and 500. The larger gives the floor: **700 ms**, down from 950.

The wrong RP ID's maximum of 2074 ms and the unknown credential's of 1736 ms in the first run are single requests; their p99s are 425 and 339 ms, and neither arm does the slow arm's work.

A third run of 150 rounds, the same day, with the measurement Worker's floor at 700 ms:

| Arm | p50 | p95 | p99 | max |
|---|---|---|---|---|
| cross-purpose challenge | 724 | 742 | 772 | 773 |
| suspended principal | 725 | 737 | 799 | 829 |
| unknown challenge | 724 | 733 | 822 | 955 |
| unknown credential | 724 | 733 | 958 | 1262 |
| regressed sign count | 724 | 731 | 777 | 796 |
| wrong recovery code | 724 | 730 | 749 | 750 |
| wrong RP ID | 724 | 730 | 798 | 808 |
| wrong origin | 724 | 729 | 762 | 970 |
| bad signature | 724 | 729 | 761 | 777 |
| unknown member name | 724 | 729 | 799 | 892 |
| malformed response | 724 | 729 | 764 | 780 |
| baseline: unknown route | 23 | 27 | 47 | 58 |

Every arm's p50 is 724 or 725 ms. The p95s span 13 ms, against 43 ms in the previous check, and nine of the eleven are within 4 ms of each other. The highest belongs to the cross-purpose challenge, one of the cheaper arms without a floor (p95 250 and 216 ms); as in the previous checks, the floor was accepted on the reading that a cheap arm cannot be revealed by time it did not spend.

What the floor does not cover:

- The wrong recovery code's p99 was 699 and 365 ms and its maximum 1710 and 379 ms, so a few of those refusals in the first run took longer than 700 ms.
- Three refusals are not among the measured arms, because the invariant test does not have them either, but are no slower than one that is: a throttled recovery (`recovery-throttled`), a member name that differs from the one the recovery options were issued for (`wrong-member-name`), and a removed principal (`removed`). The throttled recovery takes the wrong recovery code's path, and the same identity record call refuses it before checking the code. The wrong member name is refused before the passkey is verified. The removed principal is refused by the same check, on the same row, as the suspended principal.
- A member name claimed by another registration after the options were issued (`member-name-taken`) is no slower than the wrong recovery code, and needs no arm of its own. Registration verifies the new passkey, then makes two member-name registry calls: the claim, which fails, and `claimBefore`, which looks for a stale claim to free. It finds none, since a claim made after the options were issued is younger than a challenge's lifetime and a retired name is not a stale claim, so the record lookup that follows a stale claim does not run. That is six Durable Object calls, counting the two throttles and the challenge before them and the ceremony failure log after, against the wrong recovery code's eight. In exchange it runs a registration verification, which no measured arm runs: with attestation `none` it checks no signature, and a whole successful registration takes 4 ms of CPU at p50 and 8 at p95, and 4 to 14 ms as a fresh version's first call (`docs/workers-free.md`). One Durable Object call costs more than that: the unknown member name makes one call fewer than the wrong recovery code, and their p50s are 37 to 44 ms apart.
- No refusal from the credential binding is covered. A ceremony that adds a passkey (register, enrol, recover, rebind) verifies it, puts its credential id in the credential index, binds its label, then commits to the record. When a later step refuses, it removes the index entry and runs the ceremony's own undo, such as releasing a claimed member name; a label bound for the refused ceremony stays bound and names no passkey. Since recovery came to check the code first, no measured arm verifies a new passkey or reaches the index, so the 700 ms floor was taken without this path. The comparisons below count Durable Object calls; none of these refusals has been timed:
  - A passkey already registered (`credential-exists`) is refused at the index put. In registration that comes to seven calls, including the member name's release, and a verification: one call fewer than the wrong recovery code, too close for the floor to be said to cover it. In recovery it is the wrong recovery code's path plus a verification and the index put, more than the slowest measured arm, though only a caller holding a valid recovery code reaches it. Anyone can reach the registration case, with a registration response for a credential id already indexed (attestation `none` lets a client build one), which makes it the arm to add: measuring it would bring the verify-and-index path back under the floor.
  - A label that fails to bind (`label-unbound`) adds the label call and the index entry's removal: nine calls in registration, more than the slowest measured arm. It needs no arm of its own, since only a caller who has proved the record reaches it. A new record has no labels, and enrol and rebind bind a label minted for them when their options were issued, so it comes from three places: a bind that throws, whose time the floor cannot bound (as with `internal-error` below); an enrol, rebind or recovery that presents the credential id of a passkey the record revoked, whose index entry is gone but whose label row still names it; and recovery's unchecked label draw landing on a label the record has bound or retired. Each comes after a live session, a live rebind link or a valid recovery code.
  - A record already at a freshly minted record id (`record-exists`) is refused by the record at commit, after the whole binding: ten calls in registration, counting the undo and the ceremony failure log. It needs two random record ids to collide, so no caller can reach it, and it needs no arm. Any other refusal the record returns at commit takes the same path, such as a recovery code that a concurrent recovery used since the check (`wrong-recovery-code`), a rebind link that expired or was used after its options were issued (`bad-rebind-link`), or a principal suspended or removed during the ceremony.
- A ceremony ended by the server's own failure (`internal-error`), such as a Durable Object call that throws, is not measured. It gets the uniform refusal after the floor, but how long it takes depends on how long the failing call takes before it throws, which the floor cannot bound.
