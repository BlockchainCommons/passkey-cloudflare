# Hand-written encoders for dCBOR, Bytewords and simple Envelopes

The library encodes dCBOR, Bytewords and simple Gordian Envelopes with its own small code and takes no Blockchain Commons package as a runtime or test dependency. What we need so far is fixed: Bytewords is a fixed 256-word table with a fixed two-letter short form and a CRC32 checksum, and a recovery code becomes dCBOR by adding a few fixed bytes in front of its underlying value, the random bytes rather than their Bytewords spelling. Wrapping that value in an Envelope, optionally with an assertion carrying the credential's label as a second dCBOR value, adds tag bytes, SHA-256 digests and digest ordering, all small enough to write and check.

Correctness is anchored by fixed test vectors, so the tests stay free of these dependencies too. Where the Blockchain Commons specifications and reference test suites publish vectors, the tests use them. For our own structures, such as a recovery code with a label assertion, the expected bytes are generated outside this repository with the reference implementations (the TypeScript libraries or the Rust command-line tools) and committed as fixtures.

## Considered Options

- **Reference libraries at runtime** (`bc-dcbor-ts`, `bc-ur-ts`, `bc-envelope-ts`). Rejected for now: several beta packages with no security review, to encode a handful of fixed byte layouts.
- **Reference libraries as test dependencies only.** Rejected: the distribution would still carry them, and fixed vectors give the same assurance for fixed structures.

## Consequences

- This narrows ADR 0004: its Envelope interface is still the seam, but its first implementation is this hand-written code, not `bc-envelope-ts`.
- Signing, elision and encryption are where a library would earn its place. Revisit this decision when a feature needs them.
