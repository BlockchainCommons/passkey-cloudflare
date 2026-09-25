// Test-only tooling. Nothing exported here belongs in production code.
export { SoftwareAuthenticator } from "./authenticator.ts";
export type { Algorithm, AuthenticatorOptions, StoredCredential, Tamper } from "./authenticator.ts";
export { encodeCbor } from "./cbor.ts";
