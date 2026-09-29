import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, randomBytes } from "../encoding.ts";
import { CeremonyRefusal } from "../refusal.ts";

// Every login-critical ceremony property is a constant here or in a verifier,
// never a parameter and never a library default.
export const CEREMONY_POLICY = {
  residentKey: "required",
  userVerification: "preferred",
  attestation: "none",
  timeoutMs: 300_000,
} as const;

/** COSE algorithm identifiers. */
export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

/** A credential as the identity layer stores it, after verification in the Worker. */
export interface VerifiedCredential {
  id: string;
  publicKey: Uint8Array;
  algorithm: number;
  signCount: number;
  /** The authenticator data flags byte from the registration ceremony. */
  registrationFlags: number;
  aaguid: string;
  transports: string[];
}

export const FLAG_BACKUP_ELIGIBLE = 0x08;
export const FLAG_BACKED_UP = 0x10;

export interface CreationInput {
  rp: RelyingParty;
  challenge: Uint8Array<ArrayBuffer>;
  userName: string;
  excludeCredentialIds?: string[];
}

export interface RequestInput {
  rp: RelyingParty;
  challenge: Uint8Array<ArrayBuffer>;
  allowCredentialIds?: string[];
}

export interface AssertionExpectation {
  rp: RelyingParty;
  challenge: string;
  credential: { id: string; publicKey: Uint8Array<ArrayBuffer>; signCount: number; enforceCounter: boolean };
}

/**
 * WebAuthn options and verification for one algorithm and attestation policy.
 * A refused response throws a CeremonyRefusal naming the cause.
 */
export interface Verifier {
  /** The COSE algorithms offered at registration, in order of preference. */
  readonly algorithms: readonly number[];
  creationOptions(input: CreationInput): Promise<PublicKeyCredentialCreationOptionsJSON>;
  requestOptions(input: RequestInput): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyRegistration(
    response: RegistrationResponseJSON,
    expected: { rp: RelyingParty; challenge: string },
  ): Promise<VerifiedCredential>;
  verifyAssertion(
    response: AuthenticationResponseJSON,
    expected: AssertionExpectation,
  ): Promise<{ signCount: number; flags: number }>;
}

export function newChallenge(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}

/** Read the challenge a client claims to answer, without trusting anything else in it. */
export function claimedChallenge(response: unknown): string {
  try {
    const clientDataJSON = (response as { response: { clientDataJSON: string } }).response.clientDataJSON;
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(clientDataJSON)));
    if (typeof clientData.challenge !== "string" || clientData.challenge.length === 0) throw new Error();
    return clientData.challenge;
  } catch {
    throw new CeremonyRefusal("malformed-response");
  }
}
