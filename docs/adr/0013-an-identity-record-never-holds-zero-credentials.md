# An identity record never holds zero credentials

An identity record is created together with its first passkey, and from then on it always holds at least one. Registration creates the record and binds its first credential in one step (`createPerson`). Revoking a passkey is refused when it is the record's last one (`last-credential`). Recovery and rebinding add a new passkey; neither takes one away.

The reason is that the record, not any one passkey, is the identity: every grant and attribution refers to it. When an identity is a single passkey, losing that passkey loses the identity. Registering again then makes a new principal, and everything attached to the old one is orphaned. Systems in that state grow a support process to reattach it, and that process becomes the weakest credential in the system ([passkey identity gist](https://gist.github.com/ChristopherA/dfb0f82a1223a95fa199837142e0f989), BP-1; the rule itself is in its §4.6 Invariants).

Refusing to remove the last credential is one half of an invariant. The other half is a way back in that does not need a passkey: the record's recovery codes, or an operator's rebind. The two are needed together because the case that matters most is a last passkey that has been compromised. Removal only subtracts, so it cannot fix that. Recovery or rebinding binds a replacement first, and only then can the person revoke the compromised passkey, so there is no moment in which the record holds nothing (gist, BP-1).

## Considered Options

- **A record the application creates before its first passkey.** Rejected for now: until a passkey is bound, the record would hold zero credentials, which this decision rules out. Public #6 asks for it, for an application that has already verified a person by other means; it can be revisited after 0.1.0, together with how a record is named.

## Consequences

- A person cannot lock themselves out by revoking passkeys: the last one stays until another is added.
- Removing a member does not delete their passkeys. Removal marks the record removed and keeps its credentials, so the invariant holds for removed records too.
- Replacing a compromised last passkey means adding a new one first (enrolment, recovery or rebinding), then revoking the old one.
