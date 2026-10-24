# A fresh user handle for every passkey, never stored

Every registration ceremony (registration, recovery, rebinding and enrolment) presents a fresh random WebAuthn user handle, 32 bytes, and the server stores none of them. A password manager keys its entry on the relying party and the user handle together, and saving a passkey under a handle it already holds replaces that entry. With a fresh handle each time, one manager can hold several of a record's passkeys as separate entries, each with its own label. And since no handle is stable, none links a record's passkeys to each other, and none a caller sees before proof can find or name a record (ADR 0008).

## Considered Options

- **One stable user handle per record.** Rejected: a second passkey saved in the same manager would replace the first entry while the server still holds both credentials, so the person would see one passkey where the record has two. A stable handle would also tie all of a record's passkeys together for anything that sees more than one of them.

## Consequences

- `excludeCredentials` works from credential IDs alone. It is sent only once the record is proven, at enrolment and rebinding (ADR 0008), and the authenticator matches on credential ID, not user handle. Checked by hand in October 2026: iCloud Keychain (Safari 27, and Chrome 155 through the macOS sheet), Google Password Manager (Chrome 155) and a YubiKey 5 with a PIN (Chrome 155) each refused a second passkey for the same record with `InvalidStateError`, which `createPasskey` returns as already-registered (ADR 0006). Both password managers refuse only after Touch ID, so the person is asked to save before being told the device already has one; for the security key, Chrome shows its own "already registered" sheet first. That check covered no third-party password manager.
- `signalAllAcceptedCredentials` and `signalCurrentUserDetails` cannot be used: both are addressed by user handle, and the server keeps none. A revoked passkey is reported to its manager one at a time with `signalUnknownCredential` after the revoke (`signalRevokedPasskey`, ADR 0006), and an entry that signal does not reach is deleted by hand. Member names do not change, so losing `signalCurrentUserDetails` costs nothing.
- A discoverable login finds the record through the credential index, by credential ID, not through `response.userHandle`. The handle in an assertion is ignored.
