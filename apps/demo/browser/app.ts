// The demo's app shell: a placeholder where an app built on the library would go, a sign-in pane,
// a settings pane for passkeys and sessions, and a pane for fresh recovery codes.
// Bundled into public/app.js by esbuild; see build.command in wrangler.jsonc.

import {
  CAPITAL_NUDGE_MESSAGE,
  canFindWithoutSheet,
  createPasskey,
  findPasskey,
  formatRecoveryCodes,
  MEMBER_NAME_RULES,
  needsCapitalNudge,
  recoveryCodesHeader,
  usePasskey,
} from "passkey-cloudflare/browser";
import type { IssuedCodes, MemberSummary, MemberView } from "../src/responses.ts";
import { CeremonyClient, type AlreadyRegistered, type Cancelled, type OperatorAction } from "./ceremonies.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element #${id}`);
  return element as T;
}

const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);

const pane = (id: string) => $<HTMLDialogElement>(id);

function openPane(id: string) {
  if (!pane(id).open) pane(id).showModal();
}

function closePane(id: string) {
  if (pane(id).open) pane(id).close();
}

/** Show a message in the topmost open pane, or in the app when none is open. */
function status(message: string) {
  const open = ["codes", "settings", "sign-in"].find((id) => pane(id).open);
  $(open ? `${open}-status` : "status").textContent = message;
}

// --- ceremonies -------------------------------------------------------------

const ceremonies = new CeremonyClient(
  { origin: location.origin, fetch: (request) => fetch(request) },
  { create: createPasskey, get: (options, mode) => (mode === "find" ? findPasskey(options) : usePasskey(options)) },
);

const ALREADY_REGISTERED = "This device already has a passkey for you. Use it to log in, or add one on another device.";

/** Show why a ceremony made no passkey: `cancelled` when the person declined, or that the device already has one. */
function noPasskey(outcome: Cancelled | AlreadyRegistered, cancelled: string) {
  status(outcome.result === "already-registered" ? ALREADY_REGISTERED : cancelled);
}

// --- app --------------------------------------------------------------------

/** Draw the app for whoever is signed in, or for nobody. Returns who that is. */
async function showApp() {
  const me = await ceremonies.me();
  $("app-signed-out").hidden = me !== null;
  $("open-sign-in").hidden = me !== null;
  $("app-signed-in").hidden = me === null;
  $("signed-in").hidden = me === null;
  if (me) $("member-name").textContent = me.memberName ?? "";
  return me;
}

/** Leave the settings pane for the signed-out app. */
async function signedOut() {
  closePane("settings");
  $("rotate-prompt").hidden = true;
  await showApp();
}

// --- sign-in pane -----------------------------------------------------------

const CHOICES_GUIDANCE = "If you do not have a passkey here yet, register; if you lost yours, recover.";

/** Reveal register and recover. Never registers anyone by itself. */
function revealChoices(reason: string) {
  $("choices-reason").textContent = reason;
  $("choices").hidden = false;
}

/**
 * Open the sign-in pane at `step`: Continue and the choices, or a rebind link's passkey.
 * A browser without immediate mediation cannot say "no passkey here" without a
 * sheet to cancel, so register and recover show at once; with it, they wait
 * for Continue to end without a passkey.
 */
async function openSignIn(step: "entry" | "rebind" = "entry") {
  $("sign-in-status").textContent = "";
  $("entry").hidden = step !== "entry";
  $("rebind").hidden = step !== "rebind";
  if (step === "entry") {
    if (await canFindWithoutSheet()) $("choices").hidden = true;
    else revealChoices(CHOICES_GUIDANCE);
  }
  openPane("sign-in");
}

async function continueWithPasskey() {
  status("");
  const loggedIn = await ceremonies.login();
  // Cancelled means no passkey here or a dismissed picker, so the message says only that none was used.
  if (loggedIn.result === "cancelled") {
    revealChoices(`No passkey was used. ${CHOICES_GUIDANCE}`);
    return;
  }
  if (loggedIn.result !== "ok") {
    status("That passkey was not accepted.");
    revealChoices("You can register, or recover with a recovery code.");
    return;
  }
  closePane("sign-in");
  await showApp();
}

let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
function checkAvailability(event: Event) {
  clearTimeout(availabilityTimer);
  // The rules' pattern checks composed text, which the server stores; leave
  // text an input method is still composing alone.
  const name = input("register-name").value.normalize("NFC");
  if (!(event as InputEvent).isComposing && name !== input("register-name").value) input("register-name").value = name;
  $("name-availability").textContent = "";
  $("capital-nudge").hidden = true;
  if (!input("register-name").checkValidity()) return;
  availabilityTimer = setTimeout(async () => {
    // A refused check says nothing either way; registering still reports a taken name.
    const available = await ceremonies.memberNameAvailable(name);
    if (available === null || input("register-name").value !== name) return;
    $("name-availability").textContent = available ? "Available" : "Taken";
  }, 300);
}

async function register(event: SubmitEvent) {
  event.preventDefault();
  const memberName = String(new FormData(event.target as HTMLFormElement).get("memberName"));
  // An all-lowercase name registers on the second press, once the nudge has shown.
  if (needsCapitalNudge(memberName) && $("capital-nudge").hidden) {
    $("capital-nudge").textContent = `${CAPITAL_NUDGE_MESSAGE} Register again to keep ${memberName} as typed.`;
    $("capital-nudge").hidden = false;
    return;
  }
  const registered = await ceremonies.register(memberName);
  if (registered.result === "name-unavailable") return status(`The member name ${memberName} is not available.`);
  if (registered.result === "cancelled" || registered.result === "already-registered") {
    return noPasskey(registered, "Registration cancelled.");
  }
  if (registered.result !== "ok") return status("Registration was refused.");
  closePane("sign-in");
  await showApp();
  await showCodes(registered);
}

async function recover(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  const recovered = await ceremonies.recover(String(form.get("memberName")), String(form.get("code")));
  if (recovered.result === "cancelled" || recovered.result === "already-registered") {
    return noPasskey(recovered, "Recovery cancelled.");
  }
  if (recovered.result !== "ok") return status("Recovery was refused.");
  const { codesLeft } = recovered;
  closePane("sign-in");
  await showApp();
  // Recovery ends in settings, where the prompt to replace the codes waits at the top.
  $("rotate-message").textContent = rotateMessage(codesLeft);
  $("rotate-prompt").hidden = false;
  await showSettings();
}

function rotateMessage(codesLeft: number) {
  const left = codesLeft === 0 ? "none" : codesLeft === 1 ? "1 code" : `${codesLeft} codes`;
  return (
    `This recovery used one of your recovery codes; you have ${left} left. ` +
    "Replace your remaining codes now, in case the set was exposed. " +
    "Replacing them stops every old code working, including any you keep elsewhere or have split into shares."
  );
}

async function rebind() {
  const rebound = await ceremonies.rebind(location.hash.slice(1));
  if (rebound.result === "invalid-link") return status("This link is not valid.");
  if (rebound.result === "cancelled" || rebound.result === "already-registered") {
    return noPasskey(rebound, "Cancelled.");
  }
  if (rebound.result !== "ok") return status("This link was refused. It may have been used or have expired.");
  history.replaceState(null, "", "/");
  closePane("sign-in");
  await showApp();
}

// Each code as its UR, or as the same UR body in words, for reading aloud or writing down.
type ShownCodes = Omit<IssuedCodes, "issuedAt">;

let shownCodes: ShownCodes = { recoveryCodes: [], recoveryCodeWords: [] };
// The codes as text to keep, always in their UR form: the words view is for display only.
let codesText = "";
let showingWords = false;
// The codes pane stays open until the person says they saved the codes.
let codesSaved = false;

function listCodes(asWords: boolean) {
  showingWords = asWords;
  const codes = asWords ? shownCodes.recoveryCodeWords : shownCodes.recoveryCodes;
  $("code-list").replaceChildren(
    ...codes.map((code) => {
      const li = document.createElement("li");
      li.textContent = code;
      return li;
    }),
  );
  $("codes-toggle").textContent = asWords ? "Show as codes" : "Show as words";
}

/** A fresh set, as the server returns it with when it was issued. */
async function showCodes({ recoveryCodes, recoveryCodeWords, issuedAt }: IssuedCodes) {
  const memberName = (await ceremonies.me())?.memberName ?? "";
  shownCodes = { recoveryCodes, recoveryCodeWords };
  // The demo's RP ID is its host name.
  const about = { site: location.hostname, memberName, issuedAt };
  codesText = formatRecoveryCodes({ ...about, codes: recoveryCodes });
  $("codes-header").textContent = recoveryCodesHeader(about).join("\n");
  listCodes(false);
  // The codes are shown once, so Continue waits for the person to say they saved them.
  input("codes-saved").checked = false;
  button("codes-done").disabled = true;
  $("codes-status").textContent = "";
  codesSaved = false;
  openPane("codes");
}

/** Leave the codes for where the person was: settings after a replacement, else the app. */
async function leaveCodes() {
  codesSaved = true;
  closePane("codes");
  if (pane("settings").open) await showSettings();
}

// --- settings pane ----------------------------------------------------------

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "never");

function row(cells: string[], action?: HTMLElement) {
  const tr = document.createElement("tr");
  for (const cell of cells) {
    const td = document.createElement("td");
    td.textContent = cell;
    tr.append(td);
  }
  if (action) {
    const td = document.createElement("td");
    td.append(action);
    tr.append(td);
  }
  return tr;
}

/** Fill the settings pane from the server and open it; a lapsed session leaves for the signed-out app. */
async function showSettings() {
  const me = await showApp();
  if (!me) return signedOut();
  const [credentials, sessions] = await Promise.all([ceremonies.credentials(), ceremonies.sessions()]);
  $("credential-rows").replaceChildren(
    ...credentials.map((c) => {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => revokePasskey(c.label));
      return row([c.label, c.provider ?? "unknown", c.backupEligible ? "yes" : "no", when(c.createdAt), when(c.lastUsedAt)], revoke);
    }),
  );
  $("session-rows").replaceChildren(
    ...sessions.map((s) => row([`${s.userAgent}${s.current ? " (this one)" : ""}`, when(s.createdAt), when(s.expiresAt)])),
  );
  $("record-id").textContent = me.recordId;
  $("operator").hidden = !me.operator;
  openPane("settings");
}

async function addPasskey() {
  const enrolled = await ceremonies.enrol();
  if (enrolled.result === "cancelled" || enrolled.result === "already-registered") {
    return noPasskey(enrolled, "Cancelled.");
  }
  status(enrolled.result === "ok" ? `Added passkey ${enrolled.label}.` : "Adding the passkey was refused.");
  await showSettings();
}

async function revokePasskey(label: string) {
  if (!confirm(`Revoke the passkey ${label}? It will no longer log in.`)) return;
  const revoked = await ceremonies.revoke(label);
  if (revoked.result === "cancelled") return status("Cancelled.");
  if (revoked.result === "only-passkey") status("You cannot revoke your only passkey. Add another first.");
  else if (revoked.result !== "ok") status("Could not revoke that passkey.");
  else {
    const { passkeyName, provider } = revoked;
    status(`Revoked ${label}. Delete '${passkeyName}' from ${provider ?? "your password manager"} too; it no longer logs in.`);
  }
  await showSettings();
}

async function rotateCodes() {
  if (!confirm("Replace your recovery codes? The old ones will stop working.")) return;
  const rotated = await ceremonies.rotateRecoveryCodes();
  if (rotated.result === "cancelled") return status("Cancelled.");
  if (rotated.result !== "ok") return status("Could not replace your recovery codes.");
  $("rotate-prompt").hidden = true;
  await showCodes(rotated);
}

/** The member the last lookup found, which the operator actions act on. */
let shownMember: { memberName: string; recordId: string } | null = null;

const operatorActions = () => document.querySelectorAll<HTMLButtonElement>("#operator-actions button");

function memberStatus(summary: MemberSummary): string {
  if (summary.removedAt !== null) return `Removed since ${when(summary.removedAt)}`;
  if (summary.suspendedAt !== null) return `Suspended since ${when(summary.suspendedAt)}`;
  return "Active";
}

/**
 * Show a member, with the actions enabled unless the member was removed, which
 * is final. Allowing the name again is enabled only for a retired name.
 */
function showMember(member: MemberView) {
  const { summary } = member;
  $("operator-summary").replaceChildren(
    row(["Record id", member.recordId]),
    row(["Status", memberStatus(summary)]),
    row(["Created", when(summary.createdAt)]),
    row(["Passkeys", String(summary.passkeys)]),
    row(["Sessions", String(summary.sessions)]),
    row(["Recovery codes left", String(summary.recoveryCodesLeft)]),
    row(["Rebind link", summary.rebindLinkOutstanding ? "Outstanding" : "None"]),
  );
  $("operator-entries").replaceChildren(...member.entries.map((e) => row([when(e.at), e.action, e.operatorId])));
  $("operator-member").hidden = false;
  for (const action of operatorActions()) {
    action.disabled = action.value === "allow-name" ? !member.retired : summary.removedAt !== null;
  }
}

function clearMember() {
  shownMember = null;
  $("operator-member").hidden = true;
  $("operator-result").textContent = "";
  for (const action of operatorActions()) action.disabled = true;
}

async function lookUpMember(event: SubmitEvent) {
  event.preventDefault();
  const memberName = String(new FormData(event.target as HTMLFormElement).get("memberName"));
  clearMember();
  const member = await ceremonies.lookUpMember(memberName);
  if (member.result === "cancelled") return status("Cancelled.");
  if (member.result === "no-such-member") return ($("operator-result").textContent = "No such member");
  if (member.result !== "ok") return ($("operator-result").textContent = `Refused (${member.response.status}).`);
  shownMember = { memberName, recordId: member.recordId };
  showMember(member);
  if (member.retired) $("operator-result").textContent = "Retired name";
}

async function operatorAction(action: OperatorAction) {
  if (!shownMember) return;
  const { memberName, recordId } = shownMember;
  if (action === "remove" && !confirm(`Remove ${memberName}? This can't be undone, and their name will be retired.`)) return;
  if (action === "allow-name" && !confirm(`Let anyone register ${memberName} again? The removed member stays removed.`)) return;
  const result = await ceremonies.operatorAction(action, { memberName, recordId });
  if (result.result === "cancelled") return status("Cancelled.");
  if (result.result === "operator-record") {
    return ($("operator-result").textContent = "Operators can't be removed. Take them off OPERATOR_RECORD_IDS first.");
  }
  if (result.result !== "ok") return ($("operator-result").textContent = `Refused (${result.response.status}).`);
  showMember(result.member);
  $("operator-result").textContent = result.link
    ? `Send this link to ${memberName}: ${result.link}`
    : action === "remove"
      ? "Removed. Their name is retired."
      : action === "allow-name"
        ? `Anyone can now register ${memberName}.`
        : "Done.";
}

// --- wiring -----------------------------------------------------------------

function guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return (...args: A) =>
    void fn(...args).catch((error) => {
      console.error(error);
      status("Something went wrong.");
    });
}

$("open-sign-in").addEventListener("click", guard(() => openSignIn()));
$("open-settings").addEventListener("click", guard(async () => {
  $("settings-status").textContent = "";
  await showSettings();
}));
for (const close of document.querySelectorAll<HTMLButtonElement>("dialog .close")) {
  close.addEventListener("click", () => close.closest("dialog")!.close());
}
// Esc does not leave codes that are shown once. Chrome may close a dialog on a
// repeated Esc even so, and the pane opens again until the person has saved them.
pane("codes").addEventListener("cancel", (event) => event.preventDefault());
pane("codes").addEventListener("close", () => {
  if (!codesSaved) pane("codes").showModal();
});
$("continue").addEventListener("click", guard(continueWithPasskey));
input("register-name").minLength = MEMBER_NAME_RULES.minLength;
// No maxLength: it counts a decomposed name before the input handler composes
// it, and would cut a pasted name short. The pattern holds the upper bound.
input("register-name").pattern = MEMBER_NAME_RULES.pattern;
$("name-rules").textContent = MEMBER_NAME_RULES.description;
for (const toggle of document.querySelectorAll<HTMLButtonElement>(".info-toggle")) {
  const controls = toggle.getAttribute("aria-controls");
  if (!controls) throw new Error(`#${toggle.id} names no aria-controls`);
  const info = $(controls);
  toggle.addEventListener("click", () => {
    const open = info.hidden;
    info.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });
}
$("register-name").addEventListener("input", checkAvailability);
$("register-form").addEventListener("submit", guard((event: Event) => register(event as SubmitEvent)));
$("recover-form").addEventListener("submit", guard((event: Event) => recover(event as SubmitEvent)));
$("rebind-button").addEventListener("click", guard(rebind));
input("codes-saved").addEventListener("change", () => (button("codes-done").disabled = !input("codes-saved").checked));
$("codes-done").addEventListener("click", guard(leaveCodes));
$("codes-toggle").addEventListener("click", () => listCodes(!showingWords));
$("codes-copy").addEventListener("click", guard(async () => {
  await navigator.clipboard.writeText(codesText);
  status("Copied your recovery codes.");
}));
$("copy-record-id").addEventListener("click", guard(async () => {
  await navigator.clipboard.writeText($("record-id").textContent ?? "");
  status("Copied your record id.");
}));
$("add-passkey").addEventListener("click", guard(addPasskey));
$("rotate-codes").addEventListener("click", guard(rotateCodes));
$("rotate-now").addEventListener("click", guard(rotateCodes));
$("logout").addEventListener("click", guard(async () => {
  await ceremonies.logout();
  await signedOut();
}));
$("logout-everywhere").addEventListener("click", guard(async () => {
  await ceremonies.logoutEverywhere();
  await signedOut();
}));
$("logout-elsewhere").addEventListener("click", guard(async () => {
  const done = await ceremonies.logoutElsewhere();
  if (done.result === "cancelled") return status("Cancelled.");
  status(done.result === "ok" ? "Logged out everywhere else." : "Could not log out everywhere else.");
  await showSettings();
}));
$("operator-form").addEventListener("submit", guard((event: Event) => lookUpMember(event as SubmitEvent)));
$("operator-form").addEventListener("input", clearMember);
for (const action of operatorActions()) {
  action.addEventListener("click", guard(() => operatorAction(action.value as OperatorAction)));
}

// A rebind link opens the sign-in pane at its passkey; anything else shows the app.
if (location.pathname === "/rebind" && location.hash.length > 1) {
  guard(async () => {
    await showApp();
    await openSignIn("rebind");
  })();
} else {
  guard(showApp)();
}
