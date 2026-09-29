# Ceremony CPU time and Workers Free

Workers Free allows 10 ms of CPU time per request. Workers Paid, where the demo is deployed, allows far more. This page records how much CPU each ceremony uses, so a Free deployment of the library can be judged against that limit.

CPU time per request is the same on either plan; Free only enforces the limit. So the measurement runs on any account, and the numbers stand for Free.

## Method

You need `wrangler` logged in, and a Node version that runs TypeScript files directly (Node 23.6 or later). Run every command from `apps/demo`.

1. Deploy the measurement Worker, `apps/demo/wrangler.measure.jsonc`, once to learn its workers.dev host. It runs the same code as the demo with its own Durable Objects, and has Workers observability turned on.

2. Deploy it again with the relying party set to that host. Wait until the new version answers, for example until `POST /auth/login/options` with `Origin: https://<host>` returns 200, then run the ceremonies:

   ```sh
   npx wrangler deploy -c wrangler.measure.jsonc --var RP_ID:<host> --var ORIGIN:https://<host>
   node scripts/measure-cpu.ts https://<host>      # 20 rounds after round 0 by default
   ```

   Each round registers a new person, then logs in, steps up, enrols a second passkey, and recovers on a new device with the first recovery code. The script prints the time window it ran in.

3. Repeat step 2 at least twice more, with a few rounds each. Every deploy is a new script version, so each run's round 0 holds each ceremony's first call on a fresh version.

4. Query Workers observability for the Worker's `fetch` events in each window, and read `$workers.cpuTimeMs` by request path and `$workers.scriptVersion`. Durable Object calls are separate events; leave them out, since each has its own CPU limit.

5. Record the results below and delete the Worker with `npx wrangler delete -c wrangler.measure.jsonc`.

Measure again when a ceremony gains work, such as another Durable Object call or more expensive verification.

## Last measurement

2026-09-29: three deploys, of 21, 6 and 6 rounds, against the measurement Worker. Every request succeeded.

After the first call of each path on a version, in milliseconds of CPU time, 30 samples per path (33 for login options, which also answered the readiness probe):

| Request | min | p50 | p95 | max | Over 10 ms |
|---|---|---|---|---|---|
| POST /auth/register/options | 1 | 1 | 2 | 2 | 0 |
| POST /auth/register/verify | 2 | 4 | 6 | **12** | 1 |
| POST /auth/login/options | 0 | 1 | 2 | 2 | 0 |
| POST /auth/login/verify | 2 | 2 | 7 | 8 | 0 |
| POST /auth/step-up/options | 1 | 1 | 2 | 3 | 0 |
| POST /auth/step-up/verify | 2 | 2 | 3 | 6 | 0 |
| POST /me/credentials/enrol/options | 1 | 1 | 2 | 4 | 0 |
| POST /me/credentials/enrol/verify | 2 | 2 | 3 | 7 | 0 |
| POST /auth/recover/options | 1 | 1 | 2 | 2 | 0 |
| POST /auth/recover | 2 | 3 | 4 | 6 | 0 |

The first call of each path on each fresh version, in run order, one column per deploy:

| Request | 1 | 2 | 3 |
|---|---|---|---|
| POST /auth/register/options | 3 | 4 | 7 |
| POST /auth/register/verify | 9 | **11** | **16** |
| POST /auth/login/verify | 7 | 7 | 10 |
| POST /auth/step-up/verify | 3 | 3 | 7 |
| POST /me/credentials/enrol/verify | 3 | 4 | 7 |
| POST /auth/recover | 5 | 5 | 8 |

Every options request was 4 ms or less on its first call except the register options above; the readiness probe had already loaded the Worker on each version.

What this shows:

- Once warm, every ceremony fits under 10 ms with room to spare: the slowest p95 is 7 ms. Recovery, not measured on a deployment before, is among the cheapest verifies (p50 3 ms).
- The first passkey verification a fresh version runs costs 9 to 16 ms, twice over the limit in three deploys. In these runs that was always a register verify, because each round starts with one; the cost belongs to whichever verification comes first, not to registration. Later verifies on the same version cost a few milliseconds.
- One register verify after warm-up took 12 ms. Observability does not say which isolate served a request, so this may be a second isolate paying the same first-verification cost.

So a Free deployment would refuse some ceremonies: most likely the first one after each deploy or idle eviction, and the first on each new isolate. Bringing that first verification under 10 ms, by finding what it does once and doing less of it, is the change a Free release would need.
