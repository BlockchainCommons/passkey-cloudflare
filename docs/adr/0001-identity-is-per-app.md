# Identity is per app; the library deploys inside each app's Worker

The passkey library ships as a package that an application deploys inside its own Cloudflare Worker, so each app owns its identity records and its relying-party ID. We chose this over a separately deployed identity service reached by service binding because service bindings only work within one Cloudflare account (every adopter of an open-source library deploys their own copy regardless), and because the first demo is a single app.

## Considered Options

- **Shared identity service.** One deployed substrate Worker that several apps bind to, so one person has one record, one set of passkeys and portable grants across apps on the same registrable domain. Deferred, not rejected: the boundary between identity (which principal is presenting) and application policy (names, roles, bans) is kept as a strict internal interface so that a shared service can later be built on it.

## Consequences

- A person who uses two apps built on the library has two unrelated records, even when both apps are run by the same operator.
- Moving a family of apps to shared identity later is a migration: records must be merged, and apps must share a relying-party ID for their passkeys to carry over.
