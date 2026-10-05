# A headless browser module, and no sign-in UI

Where sign-in lives (a pane, a page, a sidebar, a preferences screen) is the application's decision, so the library ships no UI. Its browser side is a headless module, `passkey-cloudflare/browser`, that owns only the browser half of each ceremony: it takes the WebAuthn options JSON the application fetched from its server and returns the response JSON the application posts back. It makes no requests and knows no routes, cookies or pages; the application's server already owns those.

The module is named by browser operation, not by ceremony. `findPasskey` asks for any passkey this site knows, with immediate mediation where the browser supports it; `usePasskey` asks through the ordinary sheet, as step-up does; `createPasskey` makes a passkey for registration, recovery, rebinding and enrolment alike; and `canFindWithoutSheet` tells the application whether a find can end without a sheet, which decides when it shows register and recover. The finding calls return found or not-found, since browsers give the same error whether there was no passkey or the person dismissed the picker. `createPasskey` returns created, not-created or already-registered, the last when the authenticator already holds a passkey for this record. Any other browser error is thrown as the application's bug. `signalRevokedPasskey` tells the password manager a passkey the server has revoked is gone, through `signalUnknownCredential` where the browser has it; the signal is advice, so it does nothing without the API and never throws. It is for a confirmed revoke only, never a refused login, where it would reveal the cause the uniform refusal hides (ADR 0007).

## Considered Options

- **UI components.** Rejected: every placement would need its own, and the one the demo needs is not the one another application needs.
- **Full ceremonies with application URLs**, where the module also makes the requests. Rejected: it would have to assume the application's error shapes and cookie handling, for the saving of two requests per ceremony.
- **Functions named per ceremony** (`signIn`, `stepUp`, `register`, `recover`, `rebind`, `enrol`). Rejected: six names over two browser calls, and a new ceremony would need a new export.

## Consequences

- The immediate-mediation spellings and the conversion between JSON and buffers live in one place, where each application would otherwise copy them from the demo.
- Headless means no markup, not no words: the library may export plain-language text an application can show as it chooses, such as the member-name rules' description and the nudge toward a capital letter.
- The package keeps exporting TypeScript source, so the demo bundles its browser code, as an adopter would.
- If a future WebAuthn change separates no-passkey from a dismissed picker, a third result can be added without breaking callers.
