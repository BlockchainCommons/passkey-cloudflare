import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeAttestationObject, decodeCredentialPublicKey, cose } from "@simplewebauthn/server/helpers";
import { fromBase64Url, randomBytes } from "../encoding.ts";
import { CeremonyRefusal } from "../refusal.ts";
import { CEREMONY_POLICY, COSE_EDDSA, COSE_ES256, COSE_RS256, type Verifier } from "./webauthn.ts";

// Verification by `@simplewebauthn/server`, for deployments that need RS256.
// It is imported from its own subpath, so a deployment that uses the narrow
// verifier bundles none of the library. Its first verification on a fresh
// isolate costs more CPU than Workers Free allows (docs/workers-free.md).

function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/origin/i.test(message)) return "wrong-origin";
  if (/RP ID/i.test(message)) return "wrong-rp-id";
  if (/challenge/i.test(message)) return "wrong-challenge";
  if (/signature/i.test(message)) return "bad-signature";
  if (/counter/i.test(message)) return "counter-regressed";
  if (/type/i.test(message)) return "wrong-type";
  if (/user.*present/i.test(message)) return "user-not-present";
  return "verification-failed";
}

export const fullVerifier: Verifier = {
  /** Ed25519, ES256 and RS256; RS256 is for older Windows Hello. */
  algorithms: [COSE_EDDSA, COSE_ES256, COSE_RS256],

  async creationOptions(input) {
    return generateRegistrationOptions({
      rpName: input.rp.name,
      rpID: input.rp.id,
      // A fresh user handle for every ceremony, presented and never stored.
      userID: randomBytes(32),
      userName: input.userName,
      userDisplayName: input.userName,
      challenge: input.challenge,
      timeout: CEREMONY_POLICY.timeoutMs,
      attestationType: CEREMONY_POLICY.attestation,
      excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: CEREMONY_POLICY.residentKey,
        requireResidentKey: true,
        userVerification: CEREMONY_POLICY.userVerification,
      },
      supportedAlgorithmIDs: [...fullVerifier.algorithms],
    });
  },

  async requestOptions(input) {
    return generateAuthenticationOptions({
      rpID: input.rp.id,
      challenge: input.challenge,
      timeout: CEREMONY_POLICY.timeoutMs,
      userVerification: CEREMONY_POLICY.userVerification,
      allowCredentials: (input.allowCredentialIds ?? []).map((id) => ({ id })),
    });
  },

  async verifyRegistration(response, expected) {
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.rp.origin,
        expectedRPID: expected.rp.id,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: false,
        supportedAlgorithmIDs: [...fullVerifier.algorithms],
      });
    } catch (error) {
      throw new CeremonyRefusal(causeOf(error));
    }
    if (!verification.verified) throw new CeremonyRefusal("verification-failed");
    const info = verification.registrationInfo;
    const attestation = decodeAttestationObject(fromBase64Url(response.response.attestationObject));
    const authData = attestation.get("authData");
    const algorithm = decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg);
    if (typeof algorithm !== "number") throw new CeremonyRefusal("verification-failed");
    return {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      algorithm,
      signCount: info.credential.counter,
      registrationFlags: authData[32]!,
      aaguid: info.aaguid,
      transports: (response.response.transports ?? []) as string[],
    };
  },

  async verifyAssertion(response, expected) {
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.rp.origin,
        expectedRPID: expected.rp.id,
        expectedType: "webauthn.get",
        requireUserVerification: false,
        credential: {
          id: expected.credential.id,
          publicKey: expected.credential.publicKey,
          // A zero stored counter disables the library's monotonic check, which is
          // what synced (backup-eligible) credentials need.
          counter: expected.credential.enforceCounter ? expected.credential.signCount : 0,
        },
      });
    } catch (error) {
      throw new CeremonyRefusal(causeOf(error));
    }
    // The library reports a signature that does not verify as unverified rather than as an error.
    if (!verification.verified) throw new CeremonyRefusal("bad-signature");
    const authData = fromBase64Url(response.response.authenticatorData);
    return { signCount: verification.authenticationInfo.newCounter, flags: authData[32]! };
  },
};
