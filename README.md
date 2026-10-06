# Passkey-Only Identity for Collaborative Web Apps on Cloudflare

### _by [Christopher Allen](https://github.com/ChristopherA), Blockchain Commons_

[![License](https://img.shields.io/badge/License-BSD_2--Clause--Patent-blue.svg)](https://spdx.org/licenses/BSD-2-Clause-Patent.html)
[![Project Status: WIP](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)

**`passkey-cloudflare` is a Passkey-only identity for collaborative
web apps on Cloudflare Workers and Durable Objects.**

The library answers one question: which principal is presenting. Each
application decides what that principal may do. Passkeys are the only
credential. Every person can hold several passkeys from their first
registration, recovery never falls back to passwords or email, and
every failed ceremony gets the same response.

A demo app is built alongside the library to show it in use. It is
a placeholder today and will become a shared card canvas.

## Additional Information

- `packages/passkey-cloudflare`: the library. It deploys inside an application's own Worker. It has four entry points:
  - the main entry point: `createPasskeys`, which runs the ceremonies, the Durable Object classes an application binds (listed in `PASSKEY_DURABLE_OBJECTS`), and the building blocks around them, such as rate limits, member names, passkey labels, session cookies and the uniform refusal.
  - `/browser`: the browser half of each ceremony. It turns the options JSON the application fetched into a WebAuthn call and returns the response JSON to post back, and makes no requests of its own.
  - `/gordian`: hand-written dCBOR, Bytewords and Envelope encoders, and the `ur:seed` form recovery codes take.
  - `/testing`: a software authenticator for tests, which must never be used as a real authenticator.
- `apps/demo`: the demo Worker, deployed at https://passkeydemo.gordianstack.com: a placeholder app with sign-in and settings in panes over it.
- [`CONTEXT.md`](CONTEXT.md): Vocabulary
- [`docs/adr/`](docs/adr/): Architectural decisions

## Installation & Testing Instructions

The test scripts run TypeScript files directly, which needs Node 23.6 or later.

```sh
npm install
npm test                               # the demo's HTTP surface inside the Workers runtime, then a check of the deployed bundle
npm run typecheck
npx playwright install chromium        # once
npm run test:e2e -w demo               # the browser smoke test, against wrangler dev
```

To run the demo locally, the relying party must match the page's origin, and `--local-upstream` must name the local host. Without it, the demo's custom-domain route rewrites each request's Origin to the deployed domain, and every ceremony is refused as "origin not allowed":

```sh
cd apps/demo
npx wrangler dev --local-upstream localhost:8787 --var RP_ID:localhost --var ORIGIN:http://localhost:8787
```

Every refused ceremony waits until the timing floor, `REFUSAL_FLOOR_MS`, has passed. It is set from measurements of a deployed Worker: see [`docs/refusal-floor.md`](docs/refusal-floor.md) for how to repeat them.

The library needs Workers Paid. On Workers Free, whose limit is 10 ms of CPU time per request, the first passkey verification on each new isolate can exceed that limit and be refused: see [`docs/workers-free.md`](docs/workers-free.md).

Operators are listed by identity record id, separated by commas, in the `OPERATOR_RECORD_IDS` secret: `npx wrangler secret put OPERATOR_RECORD_IDS`. Locally, put it in `apps/demo/.dev.vars`.

A deployment on fresh storage starts with no operator, since record ids are new. To set one up:

1. Register on the deployed demo, open Settings, and copy the record id from Account details.
2. From `apps/demo`, run `npx wrangler secret put OPERATOR_RECORD_IDS` and paste it.
3. Wait for the new version: the secret takes effect only once the edge serves the version it created. Reload Settings until the operator section shows, or check that `GET /me` answers `"operator": true`.

The Workers that Playwright and the refusal-floor measurement run are never deployed as the demo, and also name operators by member name, in the `OPERATOR_MEMBER_NAMES` var, so their tests need no secret. That code is left out of the demo's own entry point, `apps/demo/src/index.ts`, and `npm test` checks that the deployed bundle does not contain it.

An operator can look up a member by member name and see the record's state and counts: when it was created, whether it is suspended, how many passkeys, live sessions and unused recovery codes it has, whether a rebind link is outstanding, and the operator log entries for that member. Each lookup is logged. It shows counts and state only, to keep small what an operator sees day to day; the device detail (passkey providers, last use, session browsers) still exists in storage. This is no privacy guarantee against an operator, who runs the deployment and can read its storage directly. A member's privacy from an operator rests on trusting the operator, not on the software.

## Gordian Principles

`passkey-cloudflare` is being built as the identity layer for Blockchain Commons' reference web apps, such as [Collaborative Seed Recovery](https://developer.blockchaincommons.com/csr/) and signing coordinators for [FROST](https://developer.blockchaincommons.com/frost/). It also shows best practices for secret-key management with Blockchain Commons technologies such as UR and SSKR in a more mainstream web app. It is meant to display the [Gordian Principles](https://github.com/BlockchainCommons/Gordian#gordian-principles), which are philosophical and technical underpinnings to Blockchain Commons' Gordian technology:

* **Independence.** Passkeys are the only credential. No identity provider, password or email address stands between a person and their account, and the library deploys inside each application's own Worker.
* **Privacy.** Every failed ceremony gets the same response, recovery never falls back to email, and an operator's day-to-day view of a member is limited to counts and state.
* **Resilience.** Every person can hold several passkeys from their first registration, and recovery codes restore access without a password. Each recovery code is a seed written as a `ur:seed` UR, so it can be read aloud as Bytewords.
* **Openness.** The library and its demo are open source under the BSD-2-Clause-Patent license.

## Status - Alpha

Passkey login works: registration, login, adding and revoking
passkeys, recovery codes and their rotation, step-up, and sessions,
including logging out elsewhere or everywhere. Operators can look up a member, issue a rebind link,
suspend and resume, remove, and allow a retired member name again,
and every operator action is logged. The canvas, agents and signed
artifacts come later. The API is not stable yet.

Because it is in alpha, `passkey-cloudflare` should not be used for production tasks until it has had further testing and auditing. See [Blockchain Commons' Development Phases](https://github.com/BlockchainCommons/Community/blob/master/release-path.md).

### What Has Been Tested

Checked by hand on the deployed demo, September 2026, before it moved to its current domain:

- Safari on macOS and on iOS. Neither reports immediate mediation, so register and recover show from the start.
- Chrome on macOS, with its access to passkeys in Apple Passwords both on and off. On macOS, Chrome reads passkeys from Apple Passwords for the whole machine, so a new Chrome profile still finds them. With access on, Continue signs in with an existing passkey. With access off, Continue finds no passkey and reveals register and recover without showing a passkey sheet.

The automated tests use a software authenticator (ES256 and Ed25519)
inside the Workers runtime, and Playwright's Chromium with a virtual
authenticator.

Not tested: Windows (including Windows Hello), Android, Linux and Firefox. Registration offers only ES256 and EdDSA, so an authenticator that supports only RS256, such as some older Windows Hello setups, may be unable to register.

The base64url and CBOR helpers of `@simplewebauthn/server`, the
WebAuthn library used for verification, are not checked directly
against the RFC 4648 and RFC 8949 test vectors. Every ceremony test
runs them, so a broken helper would fail those tests, but without
saying which helper broke. The library's own dCBOR, Bytewords and
Envelope encoders, the `ur:seed` text of recovery codes, and passkey
labels are checked against test vectors made with Blockchain Commons'
reference implementations.

### Known Issues

- Password managers that draw their passkey picker inside the page, such as LastPass, are blocked by the demo's sign-in pane, and overlapping logins can show a refusal while signed in ([#1](https://github.com/BlockchainCommons/passkey-cloudflare/issues/1)).

### Version History

0.0.1 (10/6/26) - Local repo ported to Blockchain Commons

## Origin, Authors, Copyright & Licenses

Unless otherwise noted (either in this [/README.md](./README.md) or in
the file's header comments) the contents of this repository are
Copyright © 2026 by Blockchain Commons, LLC, and are
[licensed](./LICENSE) under the [spdx:BSD-2-Clause Plus Patent
License](https://spdx.org/licenses/BSD-2-Clause-Patent.html).

## Financial Support

This is a project of [Blockchain Commons](https://www.blockchaincommons.com/). We are proudly a "not-for-profit" social benefit corporation committed to open source & open development. Our work is funded entirely by donations and collaborative partnerships with people like you. Every contribution will be spent on building open tools, technologies, and techniques that sustain and advance blockchain and internet security infrastructure and promote an open web.

To financially support further development of this and other projects, please consider becoming a Patron of Blockchain Commons through ongoing monthly patronage as a [GitHub Sponsor](https://github.com/sponsors/BlockchainCommons). You can also support Blockchain Commons with bitcoins at our [BTCPay Server](https://btcpay.blockchaincommons.com/).

## Contributing

We encourage public contributions through issues and pull requests! Please review [How to Contribute](https://github.com/BlockchainCommons/Community/blob/master/CONTRIBUTING.md) for details on our development process.

### Discussions

The best place to talk about Blockchain Commons and its projects is in our GitHub Discussions areas.

[**Gordian User Community**](https://github.com/BlockchainCommons/Gordian/discussions). For users of the Gordian reference apps.

[**Blockchain Commons Discussions**](https://github.com/BlockchainCommons/Community/discussions). For developers, interns, and patrons of Blockchain Commons, please use the discussions area of the [Community repo](https://github.com/BlockchainCommons/Community) to talk about general Blockchain Commons issues, the intern program, or topics other than those covered by the [Gordian Developer Community](https://github.com/BlockchainCommons/Gordian-Developer-Community/discussions) or the 
[Gordian User Community](https://github.com/BlockchainCommons/Gordian/discussions).

### Other Questions & Problems

As an open-source, open-development community, Blockchain Commons does not have the resources to provide direct support of our projects. Please consider the discussions area as a locale where you might get answers to questions. Alternatively, please use this repository's [issues](https://github.com/BlockchainCommons/passkey-cloudflare/issues) feature. Unfortunately, we can not make any promises on response time.

If your company requires support to use our projects, please feel free to contact us directly about options. We may be able to offer you a contract for support from one of our contributors, or we might be able to point you to another entity who can offer the contractual support that you need.

### Credits

The following people directly contributed to this repository. You can add your name here by getting involved. The first step is learning how to contribute from our [How to Contribute](https://github.com/BlockchainCommons/Community/blob/master/CONTRIBUTING.md) documentation.


| Name              | Role                | Github                                            | Email                                                       | GPG Fingerprint                                    |
| ----------------- | ------------------- | ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Christopher Allen | Principal Architect & Engineer | [@ChristopherA](https://github.com/ChristopherA) | \<ChristopherA@LifeWithAlacrity.com\>                       | FDFE 14A5 4ECB 30FC 5D22  74EF F8D3 6C91 3574 05ED |

Commits are signed with SSH keys. Christopher Allen's current SSH signing keys are listed at <https://api.github.com/users/ChristopherA/ssh_signing_keys>.

## Responsible Disclosure

We want to keep all of our software safe for everyone. If you have discovered a security vulnerability, we appreciate your help in disclosing it to us in a responsible manner. We are unfortunately not able to offer bug bounties at this time.

We do ask that you offer us good faith and use best efforts not to leak information or harm any user, their data, or our developer community. Please give us a reasonable amount of time to fix the issue before you publish it. Do not defraud our users or us in the process of discovery. We promise not to bring legal action against researchers who point out a problem provided they do their best to follow the these guidelines.

### Reporting a Vulnerability

Please report suspected security vulnerabilities in private via email to ChristopherA@BlockchainCommons.com (do not use this email for support). Please do NOT create publicly viewable issues for suspected security vulnerabilities.

The following keys may be used to communicate sensitive information to developers:

| Name              | Fingerprint                                        |
| ----------------- | -------------------------------------------------- |
| Christopher Allen | FDFE 14A5 4ECB 30FC 5D22  74EF F8D3 6C91 3574 05ED |

You can import a key by running the following command with that individual’s fingerprint: `gpg --recv-keys "<fingerprint>"` Ensure that you put quotes around fingerprints that contain spaces.
