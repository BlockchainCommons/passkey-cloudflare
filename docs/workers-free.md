# Ceremony CPU time and Workers Free

Workers Free allows 10 ms of CPU time per request. Workers Paid, where the demo is deployed, allows far more. This page records how much CPU each ceremony uses, so a Free deployment of the library can be judged against that limit.

CPU time per request is the same on either plan; Free only enforces the limit. So the measurement runs on any account, and the numbers stand for Free.

## Method

You need `wrangler` logged in, and a Node version that runs TypeScript files directly (Node 23.6 or later). Run every command from `apps/demo`.

1. Deploy the measurement Worker, `apps/demo/wrangler.measure.jsonc`, once to learn its workers.dev host. It runs the same code as the demo with its own Durable Objects, and has Workers observability turned on.

2. Deploy it again with the relying party set to that host, and with an `RP_NAME` used by no earlier deploy. Wait until the new version has answered 8 times in a row: until `POST /auth/register/options` with `Origin: https://<host>` returns options whose `rp.name` is that name. Every deploy of the same code answers any other request the same way, so only the name tells the new version from the last. One answer is not enough: the edge can go on serving the previous version for a while after one request reaches the new one, and in one deploy (see the results below) it served rounds 0 to 4. Then run the ceremonies:

   ```sh
   npx wrangler deploy -c wrangler.measure.jsonc --var RP_ID:<host> --var ORIGIN:https://<host> --var RP_NAME:<unique name>
   node scripts/measure-cpu.ts https://<host>      # 20 rounds after round 0 by default
   ```

   Each round registers a new person, then logs in, steps up, enrols a second passkey, and recovers on a new device with the first recovery code. The script prints the time window it ran in.

3. Repeat step 2 at least twice more, with a few rounds each. Every deploy is a new script version, so each run's round 0 holds each ceremony's first call on a fresh version.

4. Query Workers observability for the Worker's `fetch` events in each window, and read `$workers.cpuTimeMs` by request path and `$workers.scriptVersion`. Check that every request in the window was served by that deploy's version, and drop any the previous version served. Durable Object calls are separate events; leave them out, since each has its own CPU limit.

5. Record the results below and delete the Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification. The RP ID check every ceremony runs was not measured: once an isolate has seen the stored RP ID match, the check is a lookup in memory, with no Durable Object call (see `docs/refusal-floor.md`).

## Last measurement

2026-10-06: six deploys, of 21 rounds and then 6 rounds each, against the measurement Worker in the Cloudflare account the demo moved to that day. The demo runs there on Workers Paid; the 10 ms limit below is Free's, which the numbers are compared against. Every ceremony succeeded, and every request in each run's window was served by that deploy's version.

The first three deploys ran about twice as slow as the 2026-10-03 measurement, warm and cold. To tell new code from a slow machine, the code measured on 2026-10-03 (`7008613`) was deployed three times to the same Worker between the fourth and fifth deploys, with 6 rounds each. It gave the 2026-10-03 numbers again (register verify p50 4 and p95 6 ms, first calls 10 to 11 ms), and so did the current code's deploys 4 to 6 on either side of it (register verify p50 5 and p95 7 ms). So the slow runs came from where or when they ran, not from the code, and the table includes them: they are what a deployment meets on a bad minute.

After the first call of each path on a version, in milliseconds of CPU time, 43 to 45 samples per path (122 for register options, which also answered the readiness probe; observability dropped a few events):

| Request | min | p50 | p95 | max | Over 10 ms |
|---|---|---|---|---|---|
| POST /auth/register/options | 1 | 2 | 8 | 11 | 1 |
| POST /auth/register/verify | 3 | 6 | 11 | 16 | 5 |
| POST /auth/login/options | 0 | 1 | 3 | 5 | 0 |
| POST /auth/login/verify | 2 | 5 | 9 | 13 | 1 |
| POST /auth/step-up/options | 1 | 2 | 3 | 3 | 0 |
| POST /auth/step-up/verify | 2 | 4 | 8 | 8 | 0 |
| POST /me/credentials/enrol/options | 1 | 3 | 4 | 5 | 0 |
| POST /me/credentials/enrol/verify | 2 | 4 | 7 | 8 | 0 |
| POST /auth/recover/options | 1 | 3 | 4 | 6 | 0 |
| POST /auth/recover | 4 | 6 | 10 | 13 | 2 |

The first call of each path on each fresh version, one column per deploy:

| Request | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| POST /auth/register/options | 4 | 9 | 8 | 7 | 4 | 5 |
| POST /auth/register/verify | **19** | **17** | **20** | 10 | **11** | **11** |
| POST /auth/login/verify | **14** | **13** | **15** | 6 | 6 | 8 |
| POST /auth/step-up/verify | 6 | 6 | 9 | 3 | 4 | 3 |
| POST /me/credentials/enrol/verify | 6 | 6 | **12** | 3 | 4 | 4 |
| POST /auth/recover | **11** | 10 | **13** | 5 | 6 | 6 |

What this shows:

- On a good minute every warm ceremony fits under 10 ms, as on 2026-10-03. On a slow one they do not: in deploys 1 to 3, 8 warm verifications went over, register verify at most 16 ms. One warm register options request in deploy 6 took 11 ms.
- The first passkey verification a fresh version runs costs 10 to 20 ms, over the limit in five of six deploys, and the next one is slow too (login verify 13 to 15 ms in deploys 1 to 3). A fresh version can refuse more than its first ceremony.

So a Free deployment would refuse some ceremonies: the first after each deploy or idle eviction, the first on each new isolate, and on a slow machine some warm ones as well.

## Why the first verification costs more

2026-09-28: the verification path of `@simplewebauthn/server` 14.0.2, profiled in a fresh Node process with the V8 inspector. Warming WebCrypto first, by importing a key and verifying a signature directly, left the library's first verification as slow as before. So the one-time cost is in the library's JavaScript, not in WebCrypto:

- The first registration verify spends its extra time running the CBOR and authenticator data parsers for the first time.
- The first assertion verify spends about 4 of its 6.5 ms in `@peculiar/asn1-schema`, a general ASN.1 parser. The library uses it to convert an ES256 signature from DER into raw form.

The library also carries X.509 and attestation-certificate code for attestation formats the demo never accepts, since it asks for no attestation. In the demo Worker's bundle (`wrangler deploy --dry-run --outdir dist --metafile`), `@simplewebauthn/server` and its dependencies are about 690 KB of 774 KB, and the demo and library code are 85 KB.

## Free is not supported

A deployment on Workers Free will refuse some ceremonies, so the library and demo need Workers Paid. One way to fit under 10 ms is a narrow verifier that accepts only what the demo asks for: no attestation, ES256 and Ed25519, the DER signature unwrapped by hand, on `crypto.subtle`. That would replace a maintained library with hand-written code on the security-critical path.

2026-09-29: that verifier was built as a prototype, on the `narrow-verifier` branch. It makes the same checks as `@simplewebauthn/server`, and a differential test holds it to the library on the same responses, valid, tampered and bit-flipped. It shrank the demo Worker's upload from about 774 KB to 96 KB. Measured with the method above over eight fresh versions, the first register verify took 13, 7, 7, 12, 6, 7, 13 and 7 ms, so three were still over 10 ms. On those three versions every other first call was slower too, which points to the machine and to the first run of the application's own code rather than to verification. Warm, the slowest request of any kind took 9 ms. Since a Free deployment would still refuse some first ceremonies, the prototype stays on its branch, and main keeps `@simplewebauthn/server`.
