# passkey-cloudflare

Passkey-only identity for collaborative web apps on Cloudflare Workers and Durable Objects.

The library answers one question: which principal is presenting. Each application decides what that principal may do. Passkeys are the only credential. Every person can hold several passkeys from their first registration, recovery never falls back to passwords or email, and every failed ceremony gets the same response.

A demo app, a shared card canvas, is built alongside the library to show it in use.

Status: early development. Nothing here is ready to use yet.

- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Architectural decisions: [`docs/adr/`](docs/adr/)

## License

[BSD-2-Clause-Patent](LICENSE)
