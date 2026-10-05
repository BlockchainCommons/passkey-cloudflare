// The demo's flows: what each thing a person can do asks of the server,
// through the ceremony client, and the outcome a pane shows. Flows touch no
// DOM; the panes render their outcomes, and app.ts connects the two.

import {
  createPasskey,
  findPasskey,
  formatRecoveryCodes,
  recoveryCodesHeader,
  usePasskey,
} from "passkey-cloudflare/browser";
import type { IssuedCodes, Me, MemberView, PasskeyListing, SessionListing } from "../src/responses.ts";
import {
  CeremonyClient,
  type AlreadyRegistered,
  type Cancelled,
  type OperatorAction,
  type Refused,
} from "./ceremonies.ts";

/**
 * A message for the status line of the pane in front. `declined` when the
 * person made or used no passkey, so nothing changed and nothing needs redrawing.
 */
export type Told = { result: "told"; message: string; declined: boolean };

const told = (message: string, declined = false): Told => ({ result: "told", message, declined });

const CANCELLED = told("Cancelled.", true);

export const ALREADY_REGISTERED =
  "This device already has a passkey for you. Use it to log in, or add one on another device.";

/**
 * What a person is told when an action did not go ahead: declined (a sheet
 * dismissed, a step-up declined, or no passkey to use), already registered on
 * this device, or refused. Every flow ends a non-`ok` outcome here.
 */
function notDone(outcome: Cancelled | AlreadyRegistered | Refused, refused: string, cancelled = "Cancelled."): Told {
  if (outcome.result === "already-registered") return told(ALREADY_REGISTERED, true);
  return outcome.result === "cancelled" ? told(cancelled, true) : told(refused);
}

/** A fresh set of recovery codes as the codes pane shows them: each as its UR and in words, a header, and the text to keep. */
export interface CodesView {
  recoveryCodes: string[];
  recoveryCodeWords: string[];
  header: string[];
  /** The codes as text to keep, always in their UR form: the words are for display only. */
  text: string;
}

/** The signed-in record's settings. */
export interface Settings {
  me: Me;
  credentials: PasskeyListing[];
  sessions: SessionListing[];
}

/** A member an operator looked up: the name looked up and what the server answered. */
export type FoundMember = MemberView & { memberName: string };

const refusedNote = (refused: Refused) => ({ result: "noted", note: `Refused (${refused.response.status}).` }) as const;

/** What an operator lookup or action shows: the member and a note, a note alone, or a message. */
export type OperatorOutcome =
  { result: "member"; member: FoundMember; note: string } | { result: "noted"; note: string } | Told;

export class Flows {
  readonly ceremonies: CeremonyClient;
  /** The site recovery codes are for: the demo's RP ID, its host name. */
  readonly site: string;

  constructor(ceremonies: CeremonyClient, site: string) {
    this.ceremonies = ceremonies;
    this.site = site;
  }

  /** Who is signed in, or null. */
  me(): Promise<Me | null> {
    return this.ceremonies.me();
  }

  // --- signing in -----------------------------------------------------------

  /**
   * Log in with a passkey found on this device. `no-passkey` covers both no
   * passkey here and a dismissed picker, which browsers do not tell apart.
   */
  async continueWithPasskey(): Promise<{ result: "signed-in" | "no-passkey" | "not-accepted" }> {
    const loggedIn = await this.ceremonies.login();
    if (loggedIn.result === "ok") return { result: "signed-in" };
    return { result: loggedIn.result === "cancelled" ? "no-passkey" : "not-accepted" };
  }

  /** Whether a member name is free to register; null when the check was refused, which says nothing either way. */
  memberNameAvailable(name: string): Promise<boolean | null> {
    return this.ceremonies.memberNameAvailable(name);
  }

  async register(memberName: string): Promise<({ result: "registered" } & IssuedCodes) | Told> {
    const registered = await this.ceremonies.register(memberName);
    if (registered.result === "name-unavailable") return told(`The member name ${memberName} is not available.`);
    if (registered.result !== "ok") return notDone(registered, "Registration was refused.", "Registration cancelled.");
    return { ...registered, result: "registered" };
  }

  /** Recover with a recovery code; `codesLeft` is how many unused codes the record has after this one. */
  async recover(memberName: string, code: string): Promise<{ result: "recovered"; codesLeft: number } | Told> {
    const recovered = await this.ceremonies.recover(memberName, code);
    if (recovered.result !== "ok") return notDone(recovered, "Recovery was refused.", "Recovery cancelled.");
    return { result: "recovered", codesLeft: recovered.codesLeft };
  }

  /** Bind a new passkey with a rebind link's fragment. */
  async rebind(link: string): Promise<{ result: "rebound" } | Told> {
    const rebound = await this.ceremonies.rebind(link);
    if (rebound.result === "invalid-link") return told("This link is not valid.");
    if (rebound.result !== "ok")
      return notDone(rebound, "This link was refused. It may have been used or have expired.");
    return { result: "rebound" };
  }

  // --- settings -------------------------------------------------------------

  /** The settings of `me`, the signed-in record. */
  async settings(me: Me): Promise<Settings> {
    const [credentials, sessions] = await Promise.all([this.ceremonies.credentials(), this.ceremonies.sessions()]);
    return { me, credentials, sessions };
  }

  async addPasskey(): Promise<Told> {
    const enrolled = await this.ceremonies.enrol();
    if (enrolled.result !== "ok") return notDone(enrolled, "Adding the passkey was refused.");
    return told(`Added passkey ${enrolled.label}.`);
  }

  async revoke(label: string): Promise<Told> {
    const revoked = await this.ceremonies.revoke(label);
    if (revoked.result === "only-passkey") return told("You cannot revoke your only passkey. Add another first.");
    if (revoked.result !== "ok") return notDone(revoked, "Could not revoke that passkey.");
    const { passkeyName, provider } = revoked;
    return told(
      `Revoked ${label}. Delete '${passkeyName}' from ${provider ?? "your password manager"} too; it no longer logs in.`,
    );
  }

  /** Replace the record's recovery codes with a fresh set. */
  async rotateCodes(): Promise<({ result: "rotated" } & IssuedCodes) | Told> {
    const rotated = await this.ceremonies.rotateRecoveryCodes();
    if (rotated.result !== "ok") return notDone(rotated, "Could not replace your recovery codes.");
    return { ...rotated, result: "rotated" };
  }

  logout(): Promise<void> {
    return this.ceremonies.logout();
  }

  logoutEverywhere(): Promise<void> {
    return this.ceremonies.logoutEverywhere();
  }

  async logoutElsewhere(): Promise<Told> {
    const done = await this.ceremonies.logoutElsewhere();
    if (done.result !== "ok") return notDone(done, "Could not log out everywhere else.");
    return told("Logged out everywhere else.");
  }

  // --- operator -------------------------------------------------------------

  async lookUpMember(memberName: string): Promise<OperatorOutcome> {
    const member = await this.ceremonies.lookUpMember(memberName);
    if (member.result === "cancelled") return CANCELLED;
    if (member.result === "no-such-member") return { result: "noted", note: "No such member" };
    if (member.result !== "ok") return refusedNote(member);
    const { result: _, ...view } = member;
    return { result: "member", member: { ...view, memberName }, note: view.retired ? "Retired name" : "" };
  }

  /** Act on a member a lookup found. */
  async operatorAction(
    action: OperatorAction,
    member: { memberName: string; recordId: string },
  ): Promise<OperatorOutcome> {
    const { memberName } = member;
    const acted = await this.ceremonies.operatorAction(action, member);
    if (acted.result === "cancelled") return CANCELLED;
    if (acted.result === "operator-record") {
      return { result: "noted", note: "Operators can't be removed. Take them off OPERATOR_RECORD_IDS first." };
    }
    if (acted.result !== "ok") return refusedNote(acted);
    const note = acted.link
      ? `Send this link to ${memberName}: ${acted.link}`
      : action === "remove"
        ? "Removed. Their name is retired."
        : action === "allow-name"
          ? `Anyone can now register ${memberName}.`
          : "Done.";
    return { result: "member", member: { ...acted.member, memberName }, note };
  }

  // --- codes ----------------------------------------------------------------

  /** A fresh set, as the server returns it with when it was issued, as the codes pane shows it to the signed-in member. */
  async codes({ recoveryCodes, recoveryCodeWords, issuedAt }: IssuedCodes): Promise<CodesView> {
    const memberName = (await this.ceremonies.me())?.memberName ?? "";
    const about = { site: this.site, memberName, issuedAt };
    return {
      recoveryCodes,
      recoveryCodeWords,
      header: recoveryCodesHeader(about),
      text: formatRecoveryCodes({ ...about, codes: recoveryCodes }),
    };
  }
}

/** The flows of the page at `page` (its `location`): requests to its own origin, passkeys from the browser. */
export function pageFlows(page: { origin: string; hostname: string }): Flows {
  return new Flows(
    new CeremonyClient(
      { origin: page.origin, fetch: (request) => fetch(request) },
      { create: createPasskey, get: (options, mode) => (mode === "find" ? findPasskey(options) : usePasskey(options)) },
    ),
    // The demo's RP ID is its host name.
    page.hostname,
  );
}
