# passkey-cloudflare

Passkey-only identity for collaborative web apps on Cloudflare Workers and Durable Objects.

The library answers one question: which principal is presenting. Each application decides what that principal may do. Passkeys are the only credential. Every person can hold several passkeys from their first registration, recovery never falls back to passwords or email, and every failed ceremony gets the same response.

A demo app, a shared card canvas, is built alongside the library to show it in use.

Status: early development. Passkey login works: registration, login, adding and revoking passkeys, recovery codes, step-up, sessions, and operator rebind and suspension. The canvas, agents and signed artifacts come later. The API is not stable yet.

- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Architectural decisions: [`docs/adr/`](docs/adr/)

## Layout

- `packages/passkey-cloudflare`: the library. It deploys inside an application's own Worker. Its main entry point exports the Durable Object classes and `createPasskeys`. Its `/testing` entry point exports a software authenticator for tests, which must never be used as a real authenticator.
- `apps/demo`: the demo Worker, deployed at https://passkeydemo.shallweplay.com: a placeholder app with sign-in and settings in panes over it.

## What has been tested

Checked by hand on the deployed demo, September 2026:

- Safari on macOS and on iOS. Neither reports immediate mediation, so register and recover show from the start.
- Chrome on macOS, with its access to passkeys in Apple Passwords both on and off. On macOS, Chrome reads passkeys from Apple Passwords for the whole machine, so a new Chrome profile still finds them. With access on, Continue signs in with an existing passkey. With access off, Continue finds no passkey and reveals register and recover without showing a passkey sheet.

The automated tests use a software authenticator (ES256 and Ed25519) inside the Workers runtime, and Playwright's Chromium with a virtual authenticator.

Not tested: Windows (including Windows Hello), Android, Linux and Firefox. Registration offers only ES256 and EdDSA, so an authenticator that supports only RS256, such as some older Windows Hello setups, may be unable to register.

The base64url and CBOR helpers of `@simplewebauthn/server`, the WebAuthn library used for verification, are not checked directly against the RFC 4648 and RFC 8949 test vectors. Every ceremony test runs them, so a broken helper would fail those tests, but without saying which helper broke. The library's own dCBOR and Bytewords encoders are checked against published test vectors.

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

The library needs Workers Paid. On Workers Free, whose limit is 10 ms of CPU time per request, the first passkey verification on each new isolate can exceed that limit and be refused: see [`docs/workers-free.md`](docs/workers-free.md).

Operators are listed by identity record id, separated by commas, in the `OPERATOR_RECORD_IDS` secret: `npx wrangler secret put OPERATOR_RECORD_IDS`. Locally, put it in `apps/demo/.dev.vars`.

## License

[BSD-2-Clause-Patent](LICENSE)
