// The demo's entry page and the signed-in page for managing passkeys and sessions.
// Bundled into public/app.js by esbuild; see build.command in wrangler.jsonc.

import {
  canFindWithoutSheet,
  createPasskey,
  findPasskey,
  formatRecoveryCodes,
  recoveryCodesHeader,
  usePasskey,
  type PublicKeyCredentialCreationOptionsJSON,
} from "passkey-cloudflare/browser";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element #${id}`);
  return element as T;
}

const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);

function show(section: string) {
  for (const id of ["entry", "rebind", "codes", "home"]) $(id).hidden = id !== section;
}

function status(message: string) {
  $("status").textContent = message;
}

// --- HTTP -------------------------------------------------------------------

async function post(path: string, body: unknown = {}) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

/** A step-up the person declined; the action it guarded does not happen. */
class StepUpCancelled extends Error {}

async function stepUp() {
  const options = await (await post("/auth/step-up/options")).json();
  const used = await usePasskey(options);
  if (used.result === "not-found") throw new StepUpCancelled();
  const verified = await post("/auth/step-up/verify", { response: used.response });
  if (!verified.ok) throw new Error("step-up refused");
}

/** Make a request; if it needs a fresh step-up, do one with a passkey and try again. */
async function withStepUp(request: () => Promise<Response>) {
  let response = await request();
  if (response.status === 403) {
    const { error } = await response.clone().json();
    if (error === "step-up-required") {
      await stepUp();
      response = await request();
    }
  }
  return response;
}

const ALREADY_REGISTERED = "This device already has a passkey for you. Use it to log in, or add one on another device.";

/**
 * Make a passkey. Returns its response to post, or shows why there is none:
 * `cancelled` when the person declined, or that the device already has one.
 */
async function newPasskey(options: PublicKeyCredentialCreationOptionsJSON, cancelled: string) {
  const created = await createPasskey(options);
  if (created.result === "created") return created.response;
  status(created.result === "already-registered" ? ALREADY_REGISTERED : cancelled);
  return undefined;
}

// --- entry ------------------------------------------------------------------

const CHOICES_GUIDANCE = "If you do not have a passkey here yet, register; if you lost yours, recover.";

/** Reveal register and recover. Never registers anyone by itself. */
function revealChoices(reason: string) {
  $("choices-reason").textContent = reason;
  $("choices").hidden = false;
}

/**
 * Show the entry page. A browser without immediate mediation cannot say "no
 * passkey here" without a sheet to cancel, so register and recover show at once;
 * with it, they wait for Continue to end without a passkey.
 */
async function showEntry() {
  show("entry");
  if (await canFindWithoutSheet()) $("choices").hidden = true;
  else revealChoices(CHOICES_GUIDANCE);
}

async function continueWithPasskey() {
  status("");
  const options = await (await post("/auth/login/options")).json();
  // Not-found means no passkey here or a dismissed picker, so the message says only that none was used.
  const found = await findPasskey(options);
  if (found.result === "not-found") {
    revealChoices(`No passkey was used. ${CHOICES_GUIDANCE}`);
    return;
  }
  const verified = await post("/auth/login/verify", { response: found.response });
  if (!verified.ok) {
    status("That passkey was not accepted.");
    revealChoices("You can register, or recover with a recovery code.");
    return;
  }
  await showHome();
}

let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
function checkAvailability() {
  clearTimeout(availabilityTimer);
  const name = input("register-name").value;
  $("name-availability").textContent = "";
  if (!input("register-name").checkValidity()) return;
  availabilityTimer = setTimeout(async () => {
    // A refused check says nothing either way; registering still reports a taken name.
    const response = await fetch(`/auth/member-name?name=${encodeURIComponent(name)}`);
    if (!response.ok || input("register-name").value !== name) return;
    const { available } = (await response.json()) as { available: boolean };
    $("name-availability").textContent = available ? "Available" : "Taken";
  }, 300);
}

async function register(event: SubmitEvent) {
  event.preventDefault();
  const memberName = new FormData(event.target as HTMLFormElement).get("memberName");
  const optionsResponse = await post("/auth/register/options", { memberName });
  if (optionsResponse.status === 409) return status(`The member name ${memberName} is not available.`);
  const response = await newPasskey(await optionsResponse.json(), "Registration cancelled.");
  if (!response) return;
  const verified = await post("/auth/register/verify", { response });
  if (!verified.ok) return status("Registration was refused.");
  await showCodes(await verified.json());
}

async function recover(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  const memberName = form.get("memberName");
  const options = await (await post("/auth/recover/options", { memberName })).json();
  const response = await newPasskey(options, "Recovery cancelled.");
  if (!response) return;
  const verified = await post("/auth/recover", { memberName, code: form.get("code"), response });
  if (!verified.ok) return status("Recovery was refused.");
  const { codesLeft } = (await verified.json()) as { codesLeft: number };
  await showHome();
  $("rotate-message").textContent = rotateMessage(codesLeft);
  $("rotate-prompt").hidden = false;
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
  const link = location.hash.slice(1);
  const optionsResponse = await post("/auth/rebind/options", { link });
  if (!optionsResponse.ok) return status("This link is not valid.");
  const response = await newPasskey(await optionsResponse.json(), "Cancelled.");
  if (!response) return;
  const verified = await post("/auth/rebind/verify", { link, response });
  if (!verified.ok) return status("This link was refused. It may have been used or have expired.");
  history.replaceState(null, "", "/");
  await showHome();
}

// Each code as its UR, or as the same UR body in words, for reading aloud or writing down.
interface ShownCodes {
  recoveryCodes: string[];
  recoveryCodeWords: string[];
}

let shownCodes: ShownCodes = { recoveryCodes: [], recoveryCodeWords: [] };
// The codes as text to keep, always in their UR form: the words view is for display only.
let codesText = "";
let showingWords = false;

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
async function showCodes({ recoveryCodes, recoveryCodeWords, issuedAt }: ShownCodes & { issuedAt: number }) {
  const { memberName } = await getJSON<{ memberName: string }>("/me");
  shownCodes = { recoveryCodes, recoveryCodeWords };
  // The demo's RP ID is its host name.
  const about = { site: location.hostname, memberName, issuedAt };
  codesText = formatRecoveryCodes({ ...about, codes: recoveryCodes });
  $("codes-header").textContent = recoveryCodesHeader(about).join("\n");
  listCodes(false);
  // The codes are shown once, so Continue waits for the person to say they saved them.
  input("codes-saved").checked = false;
  button("codes-done").disabled = true;
  show("codes");
}

// --- home -------------------------------------------------------------------

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

interface Passkey {
  label: string;
  provider: string | null;
  backupEligible: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Session {
  userAgent: string;
  current: boolean;
  createdAt: number;
  expiresAt: number;
}

async function showHome() {
  const meResponse = await fetch("/me");
  if (meResponse.status === 401) {
    await showEntry();
    return;
  }
  const me = (await meResponse.json()) as { memberName: string; operator: boolean };
  const [{ credentials }, { sessions }] = await Promise.all([
    getJSON<{ credentials: Passkey[] }>("/me/credentials"),
    getJSON<{ sessions: Session[] }>("/me/sessions"),
  ]);
  $("member-name").textContent = me.memberName;
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
  $("operator").hidden = !me.operator;
  show("home");
}

async function addPasskey() {
  const optionsResponse = await withStepUp(() => post("/me/credentials/enrol/options"));
  if (!optionsResponse.ok) return status("Could not start adding a passkey.");
  const response = await newPasskey(await optionsResponse.json(), "Cancelled.");
  if (!response) return;
  const verified = await post("/me/credentials/enrol/verify", { response });
  if (!verified.ok) {
    status("Adding the passkey was refused.");
  } else {
    const { label } = (await verified.json()) as { label: string };
    status(`Added passkey ${label}.`);
  }
  await showHome();
}

async function revokePasskey(label: string) {
  if (!confirm(`Revoke the passkey ${label}? It will no longer log in.`)) return;
  const response = await withStepUp(() => post("/me/credentials/revoke", { label }));
  if (response.status === 409) status("You cannot revoke your only passkey. Add another first.");
  else if (!response.ok) status("Could not revoke that passkey.");
  else {
    const { passkeyName, provider } = (await response.json()) as { passkeyName: string; provider: string | null };
    status(`Revoked ${label}. Delete '${passkeyName}' from ${provider ?? "your password manager"} too; it no longer logs in.`);
  }
  await showHome();
}

async function rotateCodes() {
  if (!confirm("Replace your recovery codes? The old ones will stop working.")) return;
  const response = await withStepUp(() => post("/me/recovery-codes/rotate"));
  if (!response.ok) return status("Could not replace your recovery codes.");
  $("rotate-prompt").hidden = true;
  await showCodes(await response.json());
}

const OPERATOR_PATHS: Record<string, string> = { rebind: "/operator/rebind-links", suspend: "/operator/suspend", resume: "/operator/resume" };

async function operatorAction(event: SubmitEvent) {
  event.preventDefault();
  const action = (event.submitter as HTMLButtonElement).value;
  const memberName = new FormData(event.target as HTMLFormElement).get("memberName");
  const path = OPERATOR_PATHS[action];
  if (!path) throw new Error(`unknown operator action ${action}`);
  const response = await withStepUp(() => post(path, { memberName }));
  if (!response.ok) return ($("operator-result").textContent = `Refused (${response.status}).`);
  const result = (await response.json()) as { link?: string };
  $("operator-result").textContent = result.link ? `Send this link to ${memberName}: ${result.link}` : "Done.";
}

// --- wiring -----------------------------------------------------------------

function guard<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return (...args: A) =>
    void fn(...args).catch((error) => {
      console.error(error);
      status(error instanceof StepUpCancelled ? "Cancelled." : "Something went wrong.");
    });
}

$("continue").addEventListener("click", guard(continueWithPasskey));
$("register-name").addEventListener("input", checkAvailability);
$("register-form").addEventListener("submit", guard((event: Event) => register(event as SubmitEvent)));
$("recover-form").addEventListener("submit", guard((event: Event) => recover(event as SubmitEvent)));
$("rebind-button").addEventListener("click", guard(rebind));
input("codes-saved").addEventListener("change", () => (button("codes-done").disabled = !input("codes-saved").checked));
$("codes-done").addEventListener("click", guard(showHome));
$("codes-toggle").addEventListener("click", () => listCodes(!showingWords));
$("codes-copy").addEventListener("click", guard(async () => {
  await navigator.clipboard.writeText(codesText);
  status("Copied your recovery codes.");
}));
$("add-passkey").addEventListener("click", guard(addPasskey));
$("rotate-codes").addEventListener("click", guard(rotateCodes));
$("rotate-now").addEventListener("click", guard(rotateCodes));
$("logout").addEventListener("click", guard(async () => {
  await post("/auth/logout");
  await showEntry();
}));
$("logout-everywhere").addEventListener("click", guard(async () => {
  await post("/auth/logout-everywhere");
  await showEntry();
}));
$("operator-form").addEventListener("submit", guard((event: Event) => operatorAction(event as SubmitEvent)));

if (location.pathname === "/rebind" && location.hash.length > 1) show("rebind");
else guard(showHome)();
