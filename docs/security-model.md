# Security model: what a passkey proves here, and what it could prove

The library answers one question: which principal is presenting. This page says what that answer rests on, link by link: which bindings are proven by cryptography, which rest on the browser or on the server's storage, and which rest on nothing. The README's [Security Assumptions](../README.md#security-assumptions) section names the parties each binding trusts. [Opportunities](#opportunities) then lists ways the same passkeys could prove more without the server, and says which are built, which are planned and which are directions. The WebAuthn standard's own [security considerations](https://www.w3.org/TR/webauthn-3/#sctn-security-considerations) are not repeated here.

## The bindings

| Binding | Rests on | Notes |
|---|---|---|
| Credential to relying party ID | Cryptography | The authenticator signs the SHA-256 of the RP ID in every response, and the library checks it against the deployment's `RP_ID`. A passkey cannot be used for another RP ID, and cannot be moved to one. The library also stores the RP ID the first passkey was bound to and refuses every ceremony if `RP_ID` changes (README, [Deploying](../README.md#deploying)). |
| Credential to origin | The browser | The origin is in the client data, which the passkey signs, but the browser writes it. The library checks it against the deployment's `ORIGIN`, and refuses a ceremony the browser ran in a frame (`crossOrigin` true, or any `topOrigin`). |
| Credential to identity record | The server's storage | Each registration ceremony presents a fresh random user handle that is never stored ([ADR 0009](adr/0009-a-fresh-user-handle-for-every-passkey.md)). A login finds the record through the credential index, by credential ID, and ignores the handle in the assertion. Nothing the passkey signs names its record. |
| Session to identity record | A bearer token | Whoever holds the token is the principal until it expires. Browsers carry it in a `__Host-session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`), and the record stores only its hash. A session lasts 7 days by default; an application can set its lifetime up to 30 days, and nothing extends it. |
| Step-up to session | The server's storage | A step-up is a fresh passkey check within a live session. The record notes its time, and for 10 minutes afterwards the session may add or revoke a passkey, replace recovery codes, end other sessions and take operator actions. |
| Approval to credential | Cryptography | An approval proves that a credential signed the application's digest: the challenge is the digest byte for byte, so the assertion is a signature over it that anyone holding the credential's public key can check without the server ([ADR 0012](adr/0012-an-approval-signs-the-apps-digest.md)). That the credential belongs to the session's identity record rests on the server's storage, as in the row above, and what the person was shown when they approved rests on the server's page (see below). |
| Identity record to person | Nothing | Registration proves only control of a passkey. At rebind, the operator is expected to check the person out of band; the library cannot see whether they did. |
| Credential to authenticator model | Nothing | Registration asks for no attestation, so the AAGUID the library records is unauthenticated. It is used only to name the passkey's provider to the person. |
| Credential to one device | Nothing | The backup-eligible and backed-up flags say whether a passkey can sync and whether it has, and they too are the authenticator's unauthenticated word. The library stores the flags from registration and the latest use. It acts on the backup-eligible flag in two ways: it enforces the signature counter only for a passkey that cannot sync, and refuses an assertion whose backup-eligible flag differs from the one stored at registration. No ceremony requires a device-bound passkey. |

## What follows

* **The user handle links nothing, by design.** No credential carries its record's identifier, so a third party cannot tell that two passkeys belong to one person. That is a privacy property. It also means that the only evidence of which passkeys make up a record is the server's word. It is also why the library cannot use the WebAuthn Signal API calls addressed by user handle (`signalAllAcceptedCredentials` and `signalCurrentUserDetails`). The browser module calls one signal, `signalUnknownCredential`, for a passkey just revoked, so its password manager can drop the entry.
* **User verification is requested, not required.** Every ceremony asks for user verification as `preferred`, and none refuses a response without it. The user-verified flag is recorded on each session and step-up, and returned with each approval, so an application that needs it can refuse an approval made without it. Several password-manager extensions set the flag without verifying the person, so even where it is set it proves a gesture at most, never a person. Whether step-up and passkey creation should require user verification is an open question: the proposal is to require it at every passkey creation and every step-up while login stays `preferred`, and it is held until it has been tested with security keys with and without a PIN in Safari, Chrome and Firefox, and with more password-manager extensions.
* **A synced passkey is as safe as its sync account.** Whoever takes over the account a passkey syncs through holds the passkey.
* **The server chooses what is signed.** An authenticator shows no content: a passkey signs whatever challenge the page asks for. In an approval, the application chooses the digest and the page that shows the person the payload comes from the same server, so a compromised server can show one payload and ask for a signature over another. Open Integrity Forge, one application built on the library, puts a Git commit's signed data in the challenge in this way.
* **A credential's public key goes only to its own record.** The record's own sessions can read each of its credentials' public keys, and an approval returns the signing credential's key. No operator view shows them.
* **The operator log is the deployment's own account.** Every operator request needs a step-up. Each member lookup and action is written to the operator log before it is carried out; listing member names and reading the log write no entry ([ADR 0011](adr/0011-library-owns-the-operator-pipeline.md)). The log is written by the same deployment, so it shows what the deployment says it did, not what can be proven to anyone outside it.

## Opportunities

Most of the bindings above rest on the server's word. Each item below would move a claim from the server's storage into a statement a passkey signs, which anyone holding the right public keys can check without the server. Each says whether it is built, planned, or a direction the library may take. Open Integrity Forge, one application built on the library, signs Git commits with passkeys in this way.

### A passkey assertion as a portable signature

Built, as the approval ceremony and the `passkey-cloudflare/ssh` export. A WebAuthn assertion signs the authenticator data followed by the SHA-256 of the client data, and the client data carries the challenge. In an approval the challenge is the application's digest, byte for byte, so the assertion is a signature over the application's payload ([ADR 0012](adr/0012-an-approval-signs-the-apps-digest.md)). The approval result returns everything a verifier needs: the credential's public key, the authenticator data, the client data as the browser sent it, and the signature. The `passkey-cloudflare/ssh` export turns an ES256 credential into an OpenSSH `sk-ecdsa-sha2-nistp256@openssh.com` public key, builds the SSHSIG data an application passes as the approval's digest, and encodes the approval as a `webauthn-sk-ecdsa-sha2-nistp256@openssh.com` signature, which stock `ssh-keygen -Y verify` and `git verify-commit` check. Only ES256 credentials can sign in this form.

A later direction is for a person's own passkey to sign the artifacts the README lists as planned: grant records, canvas exports and activity-log entries. A passkey signature is not a plain signature, because it also covers the authenticator data and the client data, so a verifier must understand WebAuthn. Gordian Envelope's verifiers do not yet check `webauthn-sk` signatures, and this direction waits on that.

### An enrolment chain

Planned, after 0.1.0. Adding a passkey takes a step-up, but the step-up comes before the new passkey exists, so it cannot sign the new credential. The plan is an approval made after enrolment, in which a passkey the identity record already holds signs the new credential's public key. Each record would gain a chain of signed statements, each saying "this passkey introduced that one", from which anyone could check which passkeys belong together without trusting storage. The user handle stays fresh for every passkey: the chain shows the link only where the person chooses to publish it.

Two ways in sign nothing today. Recovery adds a passkey with a recovery code, and rebind adds one with the operator's rebind link; in neither does a passkey the record held sign the new one. The chain's entries for recovery and rebind are still to be designed; an operator's signed approval of a rebind (see the next item) would be one input to the rebind entry.

### Signed operator actions, and a quorum

Signed operator actions are planned, after 0.1.0. Rebind, suspend, resume, remove and allowing a retired member name again would each need the operator's approval over the digest of its operator-log entry, and the entry would store the assertion. The operator could not then deny an action, and the log could be checked outside the deployment. Lookups stay logged but unsigned: signatures are for actions, not for reading.

A quorum is planned after that, as an opt-in deployment setting, off by default. With it, rebind and removal need approvals from a set number of operators, and an action that does not gather them in time expires.

### Keys derived with the PRF extension

Planned, after 0.1.0. The WebAuthn PRF extension gives a secret for each credential and salt, released only after the person's gesture. The plan derives a signing key from it of a kind Gordian Envelope already verifies, such as Ed25519 or Schnorr, so a passkey could sign Envelopes without waiting for `webauthn-sk` support. The credential schema already holds a column for its public half. End-to-end encryption of canvas content, wrapping shares for recovery, and keys for an XID document are directions beyond it.

Two limits apply to every use:

* **The secret reaches the page's JavaScript.** It is no safer than the server that serves the page.
* **Each passkey gives a different secret.** A record with several passkeys needs one data key wrapped once for each passkey, and enrolment and recovery must wrap it again.

Not every passkey provider supports the extension.

### A self-certifying identifier

A direction. An identity record could be named by keys rather than by a server-assigned identifier, for example by an XID whose inception key is derived from a passkey with the PRF extension. Its identity could then be shown to be the same across deployments and RP IDs, even though the passkeys themselves cannot move. It depends on PRF-derived keys, and it would change the decision that identity is per app ([ADR 0001](adr/0001-identity-is-per-app.md)).

### Assurance tiers

Partly possible today. An approval result carries the backup-eligible and backed-up flags with the user-verified flag, so an application can already require, for a role of its own, an approval from a passkey that cannot sync. The flags are the authenticator's unauthenticated word (see the bindings above). Requirements at enrolment, such as device-bound passkeys only, and attestation to limit which authenticator models may register, are planned as deployment build options.

### Showing what is signed

A direction. The server chooses what is signed (see What follows), and three things could narrow that gap:

* **A signer the server does not control,** such as a browser extension or a command-line tool, which rebuilds the content and computes the digest itself.
* **A public log of challenges,** so that a substituted challenge can be found afterwards.
* **Secure Payment Confirmation,** a standard in which the browser itself draws what is approved. It is limited to payments.

What makes an independent checker possible is already built: an approval's challenge is the application's digest exactly, with nothing from the library mixed in, so a tool that rebuilds the payload can check the signature against it alone.

### Trusted time

A direction. Every signature here carries only the time its signer claims. Anchoring the heads of a log in a public timestamp service, such as OpenTimestamps, would bound when its entries were made. It needs a hash-chained log first, and the operator log is not chained today. The redactable ceremony failure log the README plans would be one such chain.

### Smaller items

* **Related Origin Requests,** which would let one RP ID serve several domains, are not yet supported.
* **The signature counter adds little.** Synced passkeys commonly report a counter of zero, so the library enforces it only for a passkey that cannot sync.
