# Passkey-Only Identity for Collaborative Web Apps on Cloudflare

### _by [Christopher Allen](https://github.com/ChristopherA), Blockchain Commons_

[![License](https://img.shields.io/badge/License-BSD_2--Clause--Patent-blue.svg)](https://spdx.org/licenses/BSD-2-Clause-Patent.html)
[![Project Status: WIP](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)

`passkey-cloudflare` is an identity library for web apps built on Cloudflare Workers and Durable Objects. It is being built as the identity layer for Blockchain Commons' reference web apps, such as [Collaborative Seed Recovery](https://developer.blockchaincommons.com/csr/) and signing coordinators for [FROST](https://developer.blockchaincommons.com/frost/), and to show best practices for secret-key management with Blockchain Commons technologies in a more mainstream web app.

The library answers one question: which principal is presenting. Each application decides what that principal may do. Passkeys are the only credential. Every person can hold several passkeys from their first registration, recovery never falls back to passwords or email, and every failed ceremony gets the same response. It runs on Workers Paid, not Workers Free.

WebAuthn verification itself is done by [`@simplewebauthn/server`](https://github.com/MasterKale/SimpleWebAuthn), which leaves storage, sessions and recovery to the application. This library is the rest of the identity layer: identity records and passkeys kept in Durable Objects (no D1 or KV), sessions and step-up, recovery codes, operator tools, rate limits and the uniform refusal.

A [live demo](https://passkeydemo.gordianstack.com) is built alongside the library to show it in use. It is a placeholder today. It will become a shared canvas of cards that members edit together, with software agents acting for members under permissions they grant.

## Design Practices

These practices come from Christopher Allen's write-up of a running passkey system ([the gist](https://gist.github.com/ChristopherA/dfb0f82a1223a95fa199837142e0f989)) and from the WebAuthn Level 3 credential record.

* **Identity separate from permission.** The library answers only which principal is presenting. Roles, suspension and member names belong to the application tier. Authorization policy can change without touching credential checks.
* **Plural passkeys from the first registration.** A person can enrol more passkeys at any time, and the last one cannot be removed. Each passkey gets its own label of three Bytewords (such as `able-acid-also`), shown in the password manager beside the member name, so a person can tell their passkeys apart.
* **No fallback to a weaker credential.** Recovery uses a single-use code and a new passkey, in one transaction. No password, email or SMS path exists.
* **Recovery codes are stored only as hashes.** A code is shown once and checked by its hash. Input is liberal: a code is accepted as a UR, as words, or as its bare 16 bytes.
* **Step-up for what can lock the owner out.** Adding or revoking a passkey, rotating recovery codes, and ending other sessions each need a fresh passkey check, not only a live session.
* **A new user handle for every ceremony.** The WebAuthn user handle is random each time, presented to the authenticator, and never stored, so it cannot link one person's passkeys to each other.
* **One refusal for every failure.** A ceremony that fails for any reason gets the same response, sent no sooner than a timing floor measured on a deployed Worker. Only an internal ceremony failure log records the cause.
* **Operators see state and counts, not device detail.** An operator who looks up a member sees when the record was created, whether it is suspended, how many passkeys, live sessions and unused recovery codes it has, whether a rebind link is outstanding, and the operator log entries for that member. The device detail (passkey providers, last use, session browsers) still exists in storage, and every operator action is logged. This limits what an operator sees day to day, but it is no privacy guarantee: an operator runs the deployment and can read its storage directly.

## Gordian Principles

`passkey-cloudflare` is meant to display the [Gordian Principles](https://github.com/BlockchainCommons/Gordian#gordian-principles), which are philosophical and technical underpinnings to Blockchain Commons' Gordian technology:

* **Independence.** No identity provider, password or email address stands between a person and their account. The library deploys inside each application's own Worker, and recovery codes are standard `ur:seed` URs that a person can keep in tools of their choosing.
* **Privacy.** A refusal reveals nothing about the account, nothing links one person's passkeys to each other, and operators see counts and state, not devices (see Design Practices). Planned: elision, so logs and exports can be shared with only what each reader needs.
* **Resilience.** Losing one device does not lose the account: a person holds several passkeys and recovery codes from the start. Planned: sharded and social recovery, so no single lost or stolen code decides the account.
* **Openness.** The library and its demo are open source under the BSD-2-Clause-Patent license, and its Gordian encoders are checked against the published reference implementations.

## Gordian Technologies

### In Use Now

* **[UR](https://developer.blockchaincommons.com/ur/) and [dCBOR](https://developer.blockchaincommons.com/dcbor/).** Each recovery code is 128 random bits typed as a Gordian seed (dCBOR tag 40300) and shown as a `ur:seed` UR. That is the text form [Gordian Seed Tool](https://github.com/BlockchainCommons/GordianSeedTool-iOS) imports, so a person can keep their codes there.
* **[Bytewords](https://developer.blockchaincommons.com/bytewords/)** spell each passkey's label, and offer a words form of each recovery code for reading aloud or writing by hand.
* **Hand-written encoders, checked against the reference implementations.** The library's dCBOR, Bytewords and simple [Gordian Envelope](https://developer.blockchaincommons.com/envelope/) encoders take no Blockchain Commons package as a dependency. Their tests hard-code vectors made with the Blockchain Commons Rust and TypeScript libraries. The Envelope encoder is tested but not yet used by a ceremony.

### Planned

* **Signed, elidable artifacts with Gordian Envelope:** an export of a shared canvas that can have cards elided before it is shared, a grant record that lets a third party verify what an agent may do without asking the server, and an activity log for each canvas.
* **A redactable ceremony failure log.** The failure log becomes an append-only chain of signed Envelopes, with an operator view, an auditor view with causes and records elided, and the member's own view. When a member is removed, their entries are redacted in place and the chain still verifies.
* **Sharded account recovery with [SSKR](https://developer.blockchaincommons.com/sskr/).** A person can split recovery into three shares (any two recover) or five (any three), each a UR or a printable QR code, to keep offline, with a partly trusted service, or with friends and family for social recovery.
* **Under consideration:** an identity record that is also an [XID](https://developer.blockchaincommons.com/xid/) document (several keys with permissions, agents as delegates), and a key derived from each passkey (WebAuthn PRF) so peers can verify a member's signatures without the server. The credential schema leaves room for that key.

## Status - Alpha

Passkey login works: registration, login (from the member-name field's passkey autofill too, on browsers without immediate mediation such as Safari), adding passkeys (steered to this device, another device or a security key) and revoking them, recovery codes and their rotation, step-up, and sessions, including logging out elsewhere or everywhere. Operators can look up a member, issue a rebind link, suspend and resume, remove, and allow a retired member name again, and every operator action is logged. The canvas, agents and signed artifacts come later. The API is not stable yet, and the library is not yet published to npm: use it from this repository.

Because it is in alpha, `passkey-cloudflare` should not be used for production tasks until it has had further testing and auditing. See [Blockchain Commons' Development Phases](https://github.com/BlockchainCommons/Community/blob/master/release-path.md).

### What Has Been Tested

Checked by hand on the deployed demo, September 2026:

- Safari on macOS and on iOS. Neither reports immediate mediation, so register and recover show from the start.
- Chrome on macOS, with its access to passkeys in Apple Passwords both on and off. On macOS, Chrome reads passkeys from Apple Passwords for the whole machine, so a new Chrome profile still finds them. With access on, Continue signs in with an existing passkey. With access off, Continue finds no passkey and reveals register and recover without showing a passkey sheet.

The automated tests use a software authenticator (ES256 and Ed25519) inside the Workers runtime, and Playwright's Chromium with a virtual authenticator. The library's own dCBOR, Bytewords and Envelope encoders, the `ur:seed` text of recovery codes, and passkey labels are checked against test vectors made with Blockchain Commons' reference implementations. The base64url and CBOR helpers of `@simplewebauthn/server`, the WebAuthn library used for verification, are covered only indirectly, by the ceremony tests.

Not tested: Windows (including Windows Hello), Android, Linux and Firefox. Passkey autofill has been checked by hand only in Safari on macOS, on the deployed demo; Playwright checks only that it starts and is aborted, in Chromium with Safari's capabilities stubbed. Registration offers only ES256 and EdDSA, so an authenticator that supports only RS256, such as some older Windows Hello setups, may be unable to register. Registration asks for no attestation, so a deployment cannot limit which authenticator models may register.

### Not Yet Supported

- Passkeys used across several domains (WebAuthn Related Origin Requests).
- RS256 at registration, which some older Windows Hello setups need.
- Workers Free (see [`docs/workers-free.md`](docs/workers-free.md)).
- A prompt to add another passkey when one stops being backed up.
- Password-manager icons beside passkey names.
- Changing a member name after registration.

### Current Work

Toward 0.1.0, we are tightening verification and refusal handling, running a second architecture review, writing architecture and recovery-code documentation, and cleaning up the repository and demo for others to use. An adversarial security review follows 0.1.0.

### Version History

- 0.0.1 - October 6, 2026: Moved to Blockchain Commons.

## Repository Layout

- `packages/passkey-cloudflare`: the library. It deploys inside an application's own Worker. It has four entry points:
  - the main entry point: `createPasskeys`, which runs the ceremonies, the Durable Object classes an application binds (listed in `PASSKEY_DURABLE_OBJECTS`), and the building blocks around them, such as rate limits, member names, passkey labels, session cookies and the uniform refusal.
  - `/browser`: the browser half of each ceremony. It turns the options JSON the application fetched into a WebAuthn call and returns the response JSON to post back, and makes no requests of its own.
  - `/gordian`: hand-written dCBOR, Bytewords and Envelope encoders, and the `ur:seed` form recovery codes take.
  - `/testing`: a software authenticator for tests, which must never be used as a real authenticator.
- `apps/demo`: the demo Worker, deployed at https://passkeydemo.gordianstack.com: a placeholder app with sign-in and settings in panes over it.
- [`CONTEXT.md`](CONTEXT.md): Vocabulary
- [`docs/adr/`](docs/adr/): Architectural decisions
- [`docs/refusal-floor.md`](docs/refusal-floor.md): How the refusal timing floor is measured
- [`docs/workers-free.md`](docs/workers-free.md): CPU time per request, and why Workers Free is not enough

## Installation & Testing Instructions

The test scripts run TypeScript files directly, which needs Node 23.6 or later.

```sh
npm install
npm test                               # the demo's HTTP surface inside the Workers runtime, then a check of the deployed bundle
npm run typecheck
npx playwright install chromium        # once
npm run test:e2e -w demo               # the browser smoke test, against wrangler dev
```

The Workers that Playwright and the refusal-floor measurement run are never deployed as the demo. They also name operators by member name, in the `OPERATOR_MEMBER_NAMES` var, so their tests need no secret, and raise every rate limit too high to refuse, so runs from one address are not throttled. That code is left out of the demo's own entry point, `apps/demo/src/index.ts`, and `npm test` checks that the deployed bundle does not contain it.

To run the demo locally, the relying party must match the page's origin, and `--local-upstream` must name the local host. Without it, the demo's custom-domain route rewrites each request's Origin to the deployed domain, and every ceremony is refused as "origin not allowed":

```sh
cd apps/demo
npx wrangler dev --local-upstream localhost:8787 --var RP_ID:localhost --var ORIGIN:http://localhost:8787
```

## Deploying

The library needs Workers Paid. On Workers Free, whose limit is 10 ms of CPU time per request, the first passkey verification on each new isolate can exceed that limit and be refused: see [`docs/workers-free.md`](docs/workers-free.md).

Every refused ceremony waits until the timing floor, `REFUSAL_FLOOR_MS`, has passed. It is set from measurements of a deployed Worker: see [`docs/refusal-floor.md`](docs/refusal-floor.md) for how to repeat them.

Every passkey is bound to the relying party ID, the `RP_ID` var. When a deployment binds its first passkey, the library stores that RP ID, and keeps it while any passkey is bound. If `RP_ID` is changed after that, every ceremony ends in the uniform refusal: browsers offer none of the existing passkeys, and no new one can be registered. The Worker logs an error naming both RP IDs, and the ceremony failure log records the cause `rp-id-changed` (unlike `wrong-rp-id`, which is one passkey response made for another RP ID). Passkeys cannot be moved to a new RP ID. Either restore the old value, or deploy on fresh storage and register again.

Operators are listed by identity record id, separated by commas, in the `OPERATOR_RECORD_IDS` secret: `npx wrangler secret put OPERATOR_RECORD_IDS`. Locally, put it in `apps/demo/.dev.vars`.

A deployment on fresh storage starts with no operator, since record ids are new. To set one up:

1. Register on the deployed demo, open Settings, and copy the record id from Account details.
2. From `apps/demo`, run `npx wrangler secret put OPERATOR_RECORD_IDS` and paste it.
3. Wait for the new version: the secret takes effect only once the edge serves the version it created. Reload Settings until the operator section shows, or check that `GET /me` answers `"operator": true`.

## Financial Support

This is a project of [Blockchain Commons](https://www.blockchaincommons.com/). We are proudly a "not-for-profit" social benefit corporation committed to open source & open development. Our work is funded entirely by donations and collaborative partnerships with people like you. Every contribution will be spent on building open tools, technologies, and techniques that sustain and advance blockchain and internet security infrastructure and promote an open web.

To financially support further development of this and other projects, please consider becoming a Patron of Blockchain Commons through ongoing monthly patronage as a [GitHub Sponsor](https://github.com/sponsors/BlockchainCommons). You can also support Blockchain Commons with bitcoins at our [BTCPay Server](https://btcpay.blockchaincommons.com/).

## Contributing

We encourage public contributions through issues and pull requests! Please review [CONTRIBUTING.md](./CONTRIBUTING.md) for details on our development process. All contributions to this repository require a GPG signed [Contributor License Agreement](./CLA.md).

### Discussions

The best place to talk about Blockchain Commons and its projects is in our GitHub Discussions areas:

- [**Gordian Developer Community**](https://github.com/BlockchainCommons/Gordian-Developer-Community/discussions): For developers working with Gordian specifications.
- [**Gordian User Community**](https://github.com/BlockchainCommons/Gordian/discussions): For users of the Gordian reference apps.
- [**Blockchain Commons Discussions**](https://github.com/BlockchainCommons/Community/discussions): For developers, interns, and patrons of Blockchain Commons, to talk about general Blockchain Commons issues, the intern program, or topics other than those covered by the other two areas.

### Other Questions & Problems

As an open-source, open-development community, Blockchain Commons does not have the resources to provide direct support of our projects. Please consider the discussions area as a locale where you might get answers to questions. Alternatively, please use this repository's [issues](https://github.com/BlockchainCommons/passkey-cloudflare/issues) feature. Unfortunately, we can not make any promises on response time.

If your company requires support to use our projects, please feel free to contact us directly about options. We may be able to offer you a contract for support from one of our contributors, or we might be able to point you to another entity who can offer the contractual support that you need.

### Credits

The following people directly contributed to this repository. You can add your name here by getting involved. The first step is learning how to contribute from our [CONTRIBUTING.md](./CONTRIBUTING.md) documentation.

| Name              | Role                           | Github                                           | Email                                 | GPG Fingerprint                                    |
| ----------------- | ------------------------------ | ------------------------------------------------ | ------------------------------------- | -------------------------------------------------- |
| Christopher Allen | Principal Architect & Engineer | [@ChristopherA](https://github.com/ChristopherA) | \<ChristopherA@LifeWithAlacrity.com\> | FDFE 14A5 4ECB 30FC 5D22  74EF F8D3 6C91 3574 05ED |

Commits are signed with SSH keys. Christopher Allen's current SSH signing keys are listed at <https://api.github.com/users/ChristopherA/ssh_signing_keys>.

## Responsible Disclosure

We want to keep all of our software safe for everyone. If you have discovered a security vulnerability, we appreciate your help in disclosing it to us in a responsible manner. We are unfortunately not able to offer bug bounties at this time.

We do ask that you offer us good faith and use best efforts not to leak information or harm any user, their data, or our developer community. Please give us a reasonable amount of time to fix the issue before you publish it. Do not defraud our users or us in the process of discovery. We promise not to bring legal action against researchers who point out a problem provided they do their best to follow these guidelines.

### Reporting a Vulnerability

Please report suspected security vulnerabilities in private via email to ChristopherA@BlockchainCommons.com (do not use this email for support). Please do NOT create publicly viewable issues for suspected security vulnerabilities.

The following keys may be used to communicate sensitive information to developers:

| Name              | Fingerprint                                        |
| ----------------- | -------------------------------------------------- |
| Christopher Allen | FDFE 14A5 4ECB 30FC 5D22  74EF F8D3 6C91 3574 05ED |

You can import a key by running the following command with that individual's fingerprint: `gpg --recv-keys "<fingerprint>"` Ensure that you put quotes around fingerprints that contain spaces.

## License

Unless otherwise noted (either in this [/README.md](./README.md) or in the file's header comments) the contents of this repository are Copyright © 2026 by Blockchain Commons, LLC, and are [licensed](./LICENSE) under the [spdx:BSD-2-Clause Plus Patent License](https://spdx.org/licenses/BSD-2-Clause-Patent.html).
