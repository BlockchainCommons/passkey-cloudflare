# Nothing a caller reaches before the record is proven reveals it

Nothing a caller can reach before proving an identity record may reveal that the record exists, which credentials it holds, or why a ceremony was refused. Registration, login and recovery options are issued before anything is proven, so they list no credentials: login sends an empty `allowCredentials`, and registration and recovery an empty `excludeCredentials`. Options issued after the record is proven may list its credentials: step-up by the live session, enrolment by the stepped-up session, and rebinding by the rebind link, a secret token for that one record. So rebind options exclude the record's passkeys, and a device that already holds one is refused by its authenticator instead of being given a second. How refusals themselves stay alike is ADR 0007's rule.

The rule's other cases:

- A refused login sends no signal to the password manager; only a confirmed revoke does (ADR 0006).
- Every ceremony presents a fresh user handle that is never stored, so no handle a caller sees before proof can find or name a record.

## Considered Options

- **Exclude the record's passkeys at recovery too.** Rejected: recovery options are issued for any member name, before the recovery code is checked, and an unknown name gets options too. Listing credential IDs there would tell anyone who knows a member name that the record exists and what its passkeys' IDs are.
- **Check the recovery code before issuing recovery options, then exclude.** Rejected: it would open a way to test codes outside the passkey ceremony, split one rate-limited, floored step into two, and add a response a probe could tell apart. The gain, no second passkey for someone recovering on a device that still holds a working one, does not justify that.

## Consequences

- Someone who recovers on a device that still holds one of the record's passkeys gets a second passkey there. Either one logs in, and the extra one can be revoked in settings.
- A new ceremony, or a new step in one, must say which side of proof it runs on before its options or responses carry anything about a record.
