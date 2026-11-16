# An approval signs the app's digest exactly, and the library keeps nothing of it

An approval is a ceremony in which a person's passkey signs a challenge that is the application's digest of a payload, byte for byte, with no nonce from the library mixed in. The assertion that comes back is then a signature over that payload which any verifier holding the credential's public key can check without the library: the signed data is the authenticator data followed by the SHA-256 of the client data, and the client data carries the digest as its challenge.

Replay is stopped the way every other ceremony stops it, by a pending challenge. The library holds the digest as a pending challenge bound to the session that asked for it, single-use and expiring like any other, keyed by that session and the digest. An assertion presented again, from another session or over another digest finds nothing to consume and gets the uniform refusal. Since the challenge is the app's and not random, two sessions may ask to approve the same digest (two people approving one commit) without either one's pending approval taking or burning the other's.

An approval grants the session nothing: it opens no step-up window and changes no session. It runs under every ceremony protection (the uniform refusal, the ceremony failure log, the per-source throttle, the refusal floor) and updates the sign count, refusing a counter that goes backwards.

The library keeps nothing about the payload. Once the pending challenge is consumed, no trace of the digest is left in its storage; what was approved, and the signature, are the application's to keep.

Two choices go beyond the bare ceremony:

- **Verify takes the digest too.** The application passes the digest it expects at verify as well as at options, and the pending challenge is looked up by it. An application therefore cannot credit an approval to a payload other than the one the passkey signed.
- **A credential list names the record's own credentials.** At options an application may name which of the record's credentials may sign; a listed credential the record does not hold is refused as not found, and an assertion from an unlisted one is refused as `credential-not-allowed`.

## Considered Options

- **A library nonce mixed into the challenge.** Rejected: every verifier would need the nonce as well as the payload to rebuild the challenge, and stock verifiers such as `ssh-keygen -Y verify`, `git verify-commit`, and later Gordian Envelope, cannot take one.
- **Step-up with a payload.** Rejected: every approval would also open the step-up window, so approving a text would grant the session the actions step-up gates.
- **A library-kept approval log.** Rejected: it would put applications' payload digests in the identity layer, and it would be a store that grows without bound.

## Consequences

- The application chooses the digest, so it decides what an approval means and keeps the record of it. The library cannot say later what a person approved.
- The digest must be at least the 16 bytes WebAuthn asks of a challenge, and at most 1024, room enough for an SSH signature's to-be-signed blob.
- Approvals follow today's user verification policy (`preferred`, not enforced); the result reports the UV, BE and BS flags, so an application that needs verification can refuse an approval without it.
