# Ceremony CPU time and Workers Free

Workers Free allows 10 ms of CPU time per request. Workers Paid, where the demo is deployed, allows far more. This page records how much CPU each ceremony uses, so a Free deployment of the library can be judged against that limit.

CPU time per request is the same on either plan; Free only enforces the limit. So the measurement runs on any account, and the numbers stand for Free.

## Method

You need `wrangler` logged in, and a Node version that runs TypeScript files directly (Node 23.6 or later). Run every command from `apps/demo`.

1. Deploy the measurement Worker, `apps/demo/wrangler.measure.jsonc`, once to learn its workers.dev host. It runs the same code as the demo with its own Durable Objects, and has Workers observability turned on.

2. Deploy it again with the relying party set to that host, and with an `RP_NAME` used by no earlier deploy. Wait until the new version answers: until `POST /auth/register/options` with `Origin: https://<host>` returns options whose `rp.name` is that name. Every deploy of the same code answers any other request the same way, so only the name tells the new version from the last. Then run the ceremonies:

   ```sh
   npx wrangler deploy -c wrangler.measure.jsonc --var RP_ID:<host> --var ORIGIN:https://<host> --var RP_NAME:<unique name>
   node scripts/measure-cpu.ts https://<host>      # 20 rounds after round 0 by default
   ```

   Each round registers a new person, then logs in, steps up, enrols a second passkey, and recovers on a new device with the first recovery code. The script prints the time window it ran in.

3. Repeat step 2 at least twice more, with a few rounds each. Every deploy is a new script version, so each run's round 0 holds each ceremony's first call on a fresh version.

4. Query Workers observability for the Worker's `fetch` events in each window, and read `$workers.cpuTimeMs` by request path and `$workers.scriptVersion`. Durable Object calls are separate events; leave them out, since each has its own CPU limit.

5. Record the results below and delete the Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification.

## Last measurement

2026-10-03: four deploys, of 21, 6, 6 and 6 rounds, against the measurement Worker, after recovery came to check the code with the identity record before verifying the new passkey. A successful recovery makes one more Durable Object call than before. Every ceremony succeeded.

In the first deploy, rounds 0 to 4 were served by the previous version although the readiness probe had already reached the new one; the new version's first calls fell in round 5, starting at its login. Its first-call column below is from there, and the previous version's requests are left out. For the fourth deploy the probe waited for eight new-version answers in a row.

After the first call of each path on a version, in milliseconds of CPU time, 28 to 30 samples per path (40 for register options, which also answered the readiness probe):

| Request | min | p50 | p95 | max | Over 10 ms |
|---|---|---|---|---|---|
| POST /auth/register/options | 1 | 1 | 5 | 6 | 0 |
| POST /auth/register/verify | 2 | 4 | 8 | 8 | 0 |
| POST /auth/login/options | 0 | 1 | 3 | 3 | 0 |
| POST /auth/login/verify | 2 | 3 | 5 | 6 | 0 |
| POST /auth/step-up/options | 0 | 1 | 1 | 1 | 0 |
| POST /auth/step-up/verify | 2 | 2 | 4 | 5 | 0 |
| POST /me/credentials/enrol/options | 1 | 1 | 2 | 3 | 0 |
| POST /me/credentials/enrol/verify | 1 | 3 | 4 | 4 | 0 |
| POST /auth/recover/options | 1 | 1 | 3 | 3 | 0 |
| POST /auth/recover | 3 | 3 | 6 | 8 | 0 |

The first call of each path on each fresh version, one column per deploy:

| Request | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| POST /auth/register/options | 3 | 3 | 4 | 3 |
| POST /auth/register/verify | 4 | **14** | **12** | 8 |
| POST /auth/login/verify | 7 | **11** | 10 | 7 |
| POST /auth/step-up/verify | 3 | 6 | 5 | 3 |
| POST /me/credentials/enrol/verify | 4 | 5 | 4 | 3 |
| POST /auth/recover | 5 | 8 | 7 | 5 |

Every options request was 4 ms or less on its first call; the readiness probe had already loaded the Worker on each version.

What this shows:

- Once warm, every ceremony fits under 10 ms: the slowest p95 is 8 ms. Recovery, with its extra call to the identity record, has a p50 of 3 ms, as before, and a p95 of 6 ms against 4 ms before; its first call on a fresh version took 5 to 8 ms, the same range as before.
- The first passkey verification a fresh version runs costs 7 to 14 ms, over the limit in two of four deploys. In deploys 2 to 4 that was a register verify, because each round starts with one. In the first deploy the new version's first verification was a login verify (7 ms), and its first register verify, which came later, took 4 ms, so the cost belongs to whichever verification comes first, not to registration.
- On the versions where the first verification was over the limit, the next verification was slow too (login verify 11 and 10 ms), so a fresh version can refuse more than its first ceremony.

So a Free deployment would refuse some ceremonies: most likely the first one after each deploy or idle eviction, and the first on each new isolate.

## Why the first verification costs more

2026-09-28: the verification path of `@simplewebauthn/server` 14.0.2, profiled in a fresh Node process with the V8 inspector. Warming WebCrypto first, by importing a key and verifying a signature directly, left the library's first verification as slow as before. So the one-time cost is in the library's JavaScript, not in WebCrypto:

- The first registration verify spends its extra time running the CBOR and authenticator data parsers for the first time.
- The first assertion verify spends about 4 of its 6.5 ms in `@peculiar/asn1-schema`, a general ASN.1 parser. The library uses it to convert an ES256 signature from DER into raw form.

The library also carries X.509 and attestation-certificate code for attestation formats the demo never accepts, since it asks for no attestation. In the demo Worker's bundle (`wrangler deploy --dry-run --outdir dist --metafile`), `@simplewebauthn/server` and its dependencies are about 690 KB of 774 KB, and the demo and library code are 85 KB.

## Free is not supported

A deployment on Workers Free will refuse some ceremonies, so the library and demo need Workers Paid. One way to fit under 10 ms is a narrow verifier that accepts only what the demo asks for: no attestation, ES256 and Ed25519, the DER signature unwrapped by hand, on `crypto.subtle`. That would replace a maintained library with hand-written code on the security-critical path.

2026-09-29: that verifier was built as a prototype, on the `narrow-verifier` branch. It makes the same checks as `@simplewebauthn/server`, and a differential test holds it to the library on the same responses, valid, tampered and bit-flipped. It shrank the demo Worker's upload from about 774 KB to 96 KB. Measured with the method above over eight fresh versions, the first register verify took 13, 7, 7, 12, 6, 7, 13 and 7 ms, so three were still over 10 ms. On those three versions every other first call was slower too, which points to the machine and to the first run of the application's own code rather than to verification. Warm, the slowest request of any kind took 9 ms. Since a Free deployment would still refuse some first ceremonies, the prototype stays on its branch, and main keeps `@simplewebauthn/server`.
