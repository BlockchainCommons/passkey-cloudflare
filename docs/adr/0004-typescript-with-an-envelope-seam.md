# TypeScript throughout, with Gordian Envelope behind a narrow interface

The library and the demo are TypeScript on Cloudflare Workers and Durable Objects, with WebAuthn verification by `@simplewebauthn/server`. Gordian Envelope is used only through a small interface (sign, elide, verify, encode), first implemented with `bc-envelope-ts`, so a Rust implementation compiled to WebAssembly can replace it later without touching callers.

We chose this because, as of September 2026, the security-critical path (passkey verification) has a maintained TypeScript library with public Workers deployments, while no Rust WebAuthn relying-party library builds for `wasm32-unknown-unknown` (`webauthn-rs` requires OpenSSL, even on its development branch). Envelope artifacts (logs, exports) are where a young implementation's risk is bounded.

## Considered Options

- **Rust core.** Invariants carried by the type system is the strongest argument for Rust. Rejected for now: it needs in-house WebAuthn verification, and `bc-envelope` builds for WebAssembly only with getrandom backend overrides, the `pqcrypto` feature off, and a non-Apple clang to compile `secp256k1-sys`, which cannot be feature-gated away (bc-shamir-rust#4, bc-dcbor-rust#6).
- **Hybrid from day one.** TypeScript application with the Rust Envelope build as the only implementation. Rejected: it takes on that fragile build chain before we know the module runs correctly in a Worker.

## Consequences

- `bc-envelope-ts` is beta and has had no security review; nothing on the login path depends on it.
- ADR 0005 narrows this: the Envelope interface is first implemented with hand-written encoders, checked against fixed test vectors, and no Blockchain Commons package is a dependency. The Rust build and `bc-envelope-ts` serve as references for generating those vectors, outside this repository.
- Invariants that the Rust design would carry in types are carried here by branded types where possible and by tests otherwise.
