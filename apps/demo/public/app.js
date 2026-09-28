// The demo's entry page and the signed-in page for managing passkeys and sessions.
// Plain browser JavaScript, no build step.

const $ = (id) => document.getElementById(id);

function show(section) {
  for (const id of ["entry", "rebind", "codes", "home"]) $(id).hidden = id !== section;
}

function status(message) {
  $("status").textContent = message;
}

// --- base64url and WebAuthn JSON ------------------------------------------

function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
}

function creationOptions(json) {
  return {
    ...json,
    challenge: fromBase64Url(json.challenge),
    user: { ...json.user, id: fromBase64Url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
  };
}

function requestOptions(json) {
  return {
    ...json,
    challenge: fromBase64Url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: fromBase64Url(c.id) })),
  };
}

function credentialJSON(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const r = credential.response;
  const response = { clientDataJSON: toBase64Url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toBase64Url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  } else {
    response.authenticatorData = toBase64Url(r.authenticatorData);
    response.signature = toBase64Url(r.signature);
    if (r.userHandle) response.userHandle = toBase64Url(r.userHandle);
  }
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

// --- HTTP -------------------------------------------------------------------

async function post(path, body = {}) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

async function stepUp() {
  const options = await (await post("/auth/step-up/options")).json();
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  const verified = await post("/auth/step-up/verify", { response: credentialJSON(credential) });
  if (!verified.ok) throw new Error("step-up refused");
}

/** Make a request; if it needs a fresh step-up, do one with a passkey and try again. */
async function withStepUp(request) {
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

function ceremonyCancelled(error) {
  return error?.name === "NotAllowedError" || error?.name === "AbortError";
}

// --- entry ------------------------------------------------------------------

async function supportsImmediateMediation() {
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities?.();
    return capabilities?.immediateGet === true;
  } catch {
    return false;
  }
}

const CHOICES_GUIDANCE = "If you do not have a passkey here yet, register; if you lost yours, recover.";

/** Reveal register and recover. Never registers anyone by itself. */
function revealChoices(reason) {
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
  if (await supportsImmediateMediation()) $("choices").hidden = true;
  else revealChoices(CHOICES_GUIDANCE);
}

// The two ways a browser may spell an immediate request: the proposal's
// mediation value, and Chrome's `uiMode`, which rejects the other as a TypeError.
const IMMEDIATE_REQUESTS = [{ mediation: "immediate" }, { uiMode: "immediate" }];

/**
 * Ask for any passkey this site knows, with immediate mediation where the
 * browser supports it. An immediate request needs the click's user activation
 * and rejects at once with no sheet when there is no passkey here for the
 * site, and with the same error when the person dismisses the picker, so a
 * rejection cannot tell the two apart. A browser that rejects every spelling
 * as malformed falls back to an ordinary request.
 */
async function getPasskey(options) {
  if (await supportsImmediateMediation()) {
    for (const immediate of IMMEDIATE_REQUESTS) {
      try {
        return await navigator.credentials.get({ publicKey: requestOptions(options), ...immediate });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
  }
  return navigator.credentials.get({ publicKey: requestOptions(options) });
}

async function continueWithPasskey() {
  status("");
  const options = await (await post("/auth/login/options")).json();
  let credential;
  try {
    credential = await getPasskey(options);
  } catch (error) {
    if (!ceremonyCancelled(error)) throw error;
    revealChoices(`No passkey was used. ${CHOICES_GUIDANCE}`);
    return;
  }
  const verified = await post("/auth/login/verify", { response: credentialJSON(credential) });
  if (!verified.ok) {
    status("That passkey was not accepted.");
    revealChoices("You can register, or recover with a recovery code.");
    return;
  }
  await showHome();
}

let availabilityTimer;
function checkAvailability() {
  clearTimeout(availabilityTimer);
  const name = $("register-name").value;
  $("name-availability").textContent = "";
  if (!$("register-name").checkValidity()) return;
  availabilityTimer = setTimeout(async () => {
    // A refused check says nothing either way; registering still reports a taken name.
    const response = await fetch(`/auth/member-name?name=${encodeURIComponent(name)}`);
    if (!response.ok || $("register-name").value !== name) return;
    const { available } = await response.json();
    $("name-availability").textContent = available ? "Available" : "Taken";
  }, 300);
}

async function register(event) {
  event.preventDefault();
  const memberName = new FormData(event.target).get("memberName");
  const optionsResponse = await post("/auth/register/options", { memberName });
  if (optionsResponse.status === 409) return status(`The member name ${memberName} is not available.`);
  const options = await optionsResponse.json();
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (error) {
    if (ceremonyCancelled(error)) return status("Registration cancelled.");
    throw error;
  }
  const verified = await post("/auth/register/verify", { response: credentialJSON(credential) });
  if (!verified.ok) return status("Registration was refused.");
  showCodes((await verified.json()).recoveryCodes);
}

async function recover(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const memberName = form.get("memberName");
  const options = await (await post("/auth/recover/options", { memberName })).json();
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (error) {
    if (ceremonyCancelled(error)) return status("Recovery cancelled.");
    throw error;
  }
  const verified = await post("/auth/recover", { memberName, code: form.get("code"), response: credentialJSON(credential) });
  if (!verified.ok) return status("Recovery was refused.");
  const { codesLeft } = await verified.json();
  await showHome();
  $("rotate-message").textContent = rotateMessage(codesLeft);
  $("rotate-prompt").hidden = false;
}

function rotateMessage(codesLeft) {
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
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(await optionsResponse.json()) });
  } catch (error) {
    if (ceremonyCancelled(error)) return status("Cancelled.");
    throw error;
  }
  const verified = await post("/auth/rebind/verify", { link, response: credentialJSON(credential) });
  if (!verified.ok) return status("This link was refused. It may have been used or have expired.");
  history.replaceState(null, "", "/");
  await showHome();
}

function showCodes(codes) {
  $("code-list").replaceChildren(
    ...codes.map((code) => {
      const li = document.createElement("li");
      li.textContent = code;
      return li;
    }),
  );
  // The codes are shown once, so Continue waits for the person to say they saved them.
  $("codes-saved").checked = false;
  $("codes-done").disabled = true;
  show("codes");
}

// --- home -------------------------------------------------------------------

const when = (ms) => (ms ? new Date(ms).toLocaleString() : "never");

function row(cells, action) {
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

async function showHome() {
  const meResponse = await fetch("/me");
  if (meResponse.status === 401) {
    await showEntry();
    return;
  }
  const me = await meResponse.json();
  const [{ credentials }, { sessions }] = await Promise.all([getJSON("/me/credentials"), getJSON("/me/sessions")]);
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
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(await optionsResponse.json()) });
  } catch (error) {
    if (ceremonyCancelled(error)) return status("Cancelled.");
    throw error;
  }
  const verified = await post("/me/credentials/enrol/verify", { response: credentialJSON(credential) });
  if (!verified.ok) {
    status("Adding the passkey was refused.");
  } else {
    const { label } = await verified.json();
    status(label ? `Added passkey ${label}.` : "Added the passkey.");
  }
  await showHome();
}

async function revokePasskey(label) {
  if (!confirm(`Revoke the passkey ${label}? It will no longer log in.`)) return;
  const response = await withStepUp(() => post("/me/credentials/revoke", { label }));
  if (response.status === 409) status("You cannot revoke your only passkey. Add another first.");
  else if (!response.ok) status("Could not revoke that passkey.");
  else {
    const { passkeyName, provider } = await response.json();
    status(`Revoked ${label}. Delete '${passkeyName}' from ${provider ?? "your password manager"} too; it no longer logs in.`);
  }
  await showHome();
}

async function rotateCodes() {
  if (!confirm("Replace your recovery codes? The old ones will stop working.")) return;
  const response = await withStepUp(() => post("/me/recovery-codes/rotate"));
  if (!response.ok) return status("Could not replace your recovery codes.");
  $("rotate-prompt").hidden = true;
  showCodes((await response.json()).recoveryCodes);
}

async function operatorAction(event) {
  event.preventDefault();
  const action = event.submitter.value;
  const memberName = new FormData(event.target).get("memberName");
  const path = { rebind: "/operator/rebind-links", suspend: "/operator/suspend", resume: "/operator/resume" }[action];
  const response = await withStepUp(() => post(path, { memberName }));
  if (!response.ok) return ($("operator-result").textContent = `Refused (${response.status}).`);
  const result = await response.json();
  $("operator-result").textContent = result.link ? `Send this link to ${memberName}: ${result.link}` : "Done.";
}

// --- wiring -----------------------------------------------------------------

function guard(fn) {
  return (...args) =>
    fn(...args).catch((error) => {
      console.error(error);
      status(ceremonyCancelled(error) ? "Cancelled." : "Something went wrong.");
    });
}

$("continue").addEventListener("click", guard(continueWithPasskey));
$("register-name").addEventListener("input", checkAvailability);
$("register-form").addEventListener("submit", guard(register));
$("recover-form").addEventListener("submit", guard(recover));
$("rebind-button").addEventListener("click", guard(rebind));
$("codes-saved").addEventListener("change", (event) => ($("codes-done").disabled = !event.target.checked));
$("codes-done").addEventListener("click", guard(showHome));
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
$("operator-form").addEventListener("submit", guard(operatorAction));

if (location.pathname === "/rebind" && location.hash.length > 1) show("rebind");
else guard(showHome)();
