# passkey-cloudflare

Passkey-only identity for collaborative web apps on Cloudflare Workers and Durable Objects.

The library answers one question: which principal is presenting. Each application decides what that principal may do. Passkeys are the only credential. Every person can hold several passkeys from their first registration, recovery never falls back to passwords or email, and every failed ceremony gets the same response.

A demo app, a shared card canvas, is built alongside the library to show it in use.

Status: early development. Passkey login works: registration, login, adding and revoking passkeys, recovery codes, step-up, sessions, and operator rebind and suspension. The canvas, agents and signed artifacts come later. The API is not stable yet.

- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Architectural decisions: [`docs/adr/`](docs/adr/)

## Layout

- `packages/passkey-cloudflare`: the library. It deploys inside an application's own Worker. Its main entry point exports the Durable Object classes and `createPasskeys`. Its `/testing` entry point exports a software authenticator for tests, which must never be used as a real authenticator.
- `apps/demo`: the demo Worker and its entry page.

## Development

```sh
npm install
npm test                               # the demo's HTTP surface, inside the Workers runtime
npm run typecheck
npx playwright install chromium        # once
npm run test:e2e -w demo               # the browser smoke test, against wrangler dev
```

To run the demo locally, the relying party must match the page's origin:

```sh
cd apps/demo
npx wrangler dev --var RP_ID:localhost --var ORIGIN:http://localhost:8787
```

Every refused ceremony waits until the timing floor, `REFUSAL_FLOOR_MS`, has passed. It is set from measurements of a deployed Worker: see [`docs/refusal-floor.md`](docs/refusal-floor.md) for how to repeat them.

Operators are listed by identity record id, separated by commas, in the `OPERATOR_RECORD_IDS` secret: `npx wrangler secret put OPERATOR_RECORD_IDS`. Locally, put it in `apps/demo/.dev.vars`.

## License

[BSD-2-Clause-Patent](LICENSE)
