import { expect, test, type Page } from "@playwright/test";

const CAPITAL_NUDGE = "Member names display as typed, and most read best with a capital letter.";
const NO_PASSKEY_USED = "No passkey was used. If you do not have a passkey here yet, register; if you lost yours, recover.";

/** Give the page a virtual authenticator; returns what reaches it over CDP. */
async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

type Authenticator = Awaited<ReturnType<typeof addAuthenticator>>;

/** Put every passkey `from` holds on `to`, replacing `to`'s copies. */
async function copyCredentials(from: Authenticator, to: Authenticator) {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", { authenticatorId: from.authenticatorId });
  const held = await to.cdp.send("WebAuthn.getCredentials", { authenticatorId: to.authenticatorId });
  for (const credential of credentials) {
    if (held.credentials.some((c) => c.credentialId === credential.credentialId)) {
      await to.cdp.send("WebAuthn.removeCredential", {
        authenticatorId: to.authenticatorId,
        credentialId: credential.credentialId,
      });
    }
    await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.authenticatorId, credential });
  }
}

/** Open the sign-in pane from the app bar. */
async function openSignIn(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#sign-in")).toBeVisible();
}

/** The app bar names the member once they are signed in, and the sign-in pane has closed. */
async function expectSignedIn(page: Page, memberName: string) {
  await expect(page.locator("#sign-in")).toBeHidden();
  await expect(page.locator("#member-name")).toHaveText(memberName);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

/** Open the settings pane from the app bar. */
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#settings")).toBeVisible();
}

/** Register a new member from the sign-in pane and leave the recovery codes. */
async function registerMember(page: Page, memberName: string) {
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
}

test("the app opens signed out, with sign-in in a pane it can close", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Sign in to try passkeys.")).toBeVisible();
  await expect(page.locator("#sign-in")).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings" })).toBeHidden();

  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sign-in")).toBeHidden();
  await openSignIn(page);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#sign-in")).toBeHidden();
});

test("register, log out and log back in with a passkey", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Smoke${Date.now().toString(36)}`;

  const logins: number[] = [];
  const registrations: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/login/verify")) logins.push(r.status());
  });
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeHidden();

  // Immediate mode: a browser with no passkey here answers at once, with no sheet to cancel.
  // The same rejection covers a dismissed picker, so the message claims only that none was used.
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeVisible();
  expect(registrations).toEqual([]);

  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  const header = `Recovery codes for localhost\nMember name: ${memberName}\nIssued: `;
  const issued = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
  const headerText = (await page.locator("#codes-header").textContent())!;
  expect(headerText.startsWith(header)).toBe(true);
  expect(headerText.slice(header.length)).toMatch(issued);
  // Copy takes the codes as text to keep, in their UR form even while the words show.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Show as words" }).click();
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#codes-status")).toHaveText("Copied your recovery codes.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const codes = copied.split("\n").filter((line) => /^\d+\. /.test(line));
  expect(copied.startsWith(`${headerText}\n\n`)).toBe(true);
  expect(codes).toHaveLength(8);
  for (const line of codes) expect(line).toMatch(/^\d\. ur:seed\/[a-z]{46}$/);
  expect(copied).toContain("Each code works once. Recover at localhost with your member name and one code.");
  // The codes are shown once, so leaving them takes a deliberate tick first.
  const saved = page.getByRole("checkbox", { name: "I have saved my recovery codes" });
  const done = page.getByRole("button", { name: "Continue", exact: true });
  await expect(done).toBeDisabled();
  await saved.check();
  await expect(done).toBeEnabled();
  await saved.uncheck();
  await expect(done).toBeDisabled();
  // Esc does not leave codes that are shown once.
  await page.keyboard.press("Escape");
  await expect(page.locator("#codes")).toBeVisible();
  await saved.check();
  await done.click();
  await expect(page.locator("#codes")).toBeHidden();
  await expectSignedIn(page, memberName);

  await openSettings(page);
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings" })).toBeHidden();
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeHidden();

  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expectSignedIn(page, memberName);
  expect(logins).toEqual([200]);
});

test("without immediate mode, register and recover show from the start", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false });
  });
  await addAuthenticator(page);

  const registrations: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lost your passkeys? Recover" })).toBeVisible();

  // Continue with no passkey here still ends at the choices, and never registers anyone.
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByText(NO_PASSKEY_USED)).toBeVisible();
  expect(registrations).toEqual([]);
});

test("the register form checks names by the library's rules and explains them", async ({ page }) => {
  await page.addInitScript(() => {
    PublicKeyCredential.getClientCapabilities = async () => ({ immediateGet: false });
  });
  await page.goto("/");
  await openSignIn(page);
  const name = page.locator("#register-name");
  const rules = page.getByText("A member name is 3 to 32 characters long and starts with a letter.", { exact: false });

  await expect(rules).toBeHidden();
  await page.getByRole("button", { name: "About member names" }).click();
  await expect(rules).toBeVisible();

  await name.fill("a.bc");
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);

  // Typed decomposed, the name is composed in place and checked as available.
  const accented = `Zoë${Date.now().toString(36)}`;
  await name.fill(accented.normalize("NFD"));
  await expect(name).toHaveValue(accented.normalize("NFC"));
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  await expect(page.locator("#name-availability")).toHaveText("Available");
});

test("an all-lowercase name is nudged toward a capital once before it registers", async ({ page }) => {
  await addAuthenticator(page);
  const registrations: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  const name = page.locator("#register-name");
  const register = page.getByRole("button", { name: "Register with a passkey" });
  const nudge = page.getByText(CAPITAL_NUDGE);

  await name.fill(`nudge${Date.now().toString(36)}`);
  await register.click();
  await expect(nudge).toBeVisible();
  expect(registrations).toEqual([]);

  // Editing the name takes the nudge back; the next lowercase name is nudged afresh.
  const memberName = `nudged${Date.now().toString(36)}`;
  await name.fill(memberName);
  await expect(nudge).toBeHidden();
  await register.click();
  await expect(nudge).toBeVisible();
  expect(registrations).toEqual([]);

  await register.click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
});

test("recover on a new device with a recovery code, and be prompted to replace the rest", async ({ page, browser }) => {
  await addAuthenticator(page);
  const memberName = `Recover${Date.now().toString(36)}`;
  await page.goto("/");
  await openSignIn(page);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  const firstCode = page.locator("#code-list li").first();
  const ur = (await firstCode.textContent())!;
  expect(ur).toMatch(/^ur:seed\//);
  // The words are the same code, read aloud or written down; recover with them.
  await page.getByRole("button", { name: "Show as words" }).click();
  await expect(firstCode).toHaveText(/^[a-z]{4}( [a-z]{4}){22}$/);
  const code = (await firstCode.textContent())!;
  await page.getByRole("button", { name: "Show as codes" }).click();
  await expect(firstCode).toHaveText(ur);
  await page.getByRole("button", { name: "Show as words" }).click();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSignedIn(page, memberName);
  await openSettings(page);
  await expect(page.locator("#rotate-prompt")).toBeHidden();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toBeHidden();

  // A new device: no session and no passkey, only the member name and a code.
  const device = await (await browser.newContext()).newPage();
  await addAuthenticator(device);
  await device.goto("/");
  await openSignIn(device);
  await device.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(device.getByText(NO_PASSKEY_USED)).toBeVisible();
  const recoverForm = device.locator("#recover-form");
  // Recovery takes any spelling of the name, and never nudges it toward a capital.
  await recoverForm.getByLabel("Member name").fill(memberName.toLowerCase());
  await recoverForm.getByLabel("Recovery code").fill(code);
  await recoverForm.getByRole("button", { name: "Recover with a new passkey" }).click();

  // Recovery ends in settings, with the prompt to replace the codes at the top.
  await expect(device.locator("#sign-in")).toBeHidden();
  await expect(device.locator("#settings")).toBeVisible();
  await expect(device.locator("#member-name")).toHaveText(memberName);
  await expect(device.locator("#rotate-prompt")).toBeVisible();
  await expect(device.locator("#rotate-prompt")).toContainText("you have 7 codes left");
  await expect(device.getByText(CAPITAL_NUDGE)).toHaveCount(0);
  await expect(device.locator("#rotate-prompt")).toContainText("Replace your remaining codes now");

  // Replacing them shows the new set over settings, then returns there without the prompt.
  device.on("dialog", (d) => void d.accept());
  await device.getByRole("button", { name: "Replace them now" }).click();
  await expect(device.locator("#codes")).toBeVisible();
  await expect(device.locator("#code-list li")).toHaveCount(8);
  await device.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await device.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(device.locator("#codes")).toBeHidden();
  await expect(device.locator("#settings")).toBeVisible();
  await expect(device.locator("#rotate-prompt")).toBeHidden();
  await device.context().close();
});

test("adding a passkey on a device that already has one says so, and adds nothing", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Twice${Date.now().toString(36)}`;
  const enrolments: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/me/credentials/enrol/verify")) enrolments.push(r.url());
  });
  await registerMember(page, memberName);
  await openSettings(page);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);

  // The same authenticator holds this record's passkey, which enrolment excludes.
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.locator("#settings-status")).toHaveText(
    "This device already has a passkey for you. Use it to log in, or add one on another device.",
  );
  expect(enrolments).toEqual([]);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
});

test("log out everywhere else steps up, then leaves only this session", async ({ page, browser }) => {
  const laptop = await addAuthenticator(page);
  const memberName = `Elsewhere${Date.now().toString(36)}`;
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/logout-elsewhere")) statuses.push(r.status());
  });
  await registerMember(page, memberName);

  // A second device holding the same passkey logs in, so the record has two sessions.
  const phone = await (await browser.newContext()).newPage();
  const phoneAuthenticator = await addAuthenticator(phone);
  await copyCredentials(laptop, phoneAuthenticator);
  await phone.goto("/");
  await openSignIn(phone);
  await phone.getByRole("button", { name: "Continue with passkey" }).click();
  await expectSignedIn(phone, memberName);
  // The phone's login advanced the passkey's sign counter; the laptop takes that copy, as a synced passkey would.
  await copyCredentials(phoneAuthenticator, laptop);
  await page.reload();
  await openSettings(page);
  await expect(page.locator("#session-rows tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Log out everywhere else" }).click();

  await expect(page.locator("#settings-status")).toHaveText("Logged out everywhere else.");
  expect(statuses).toEqual([403, 200]);
  await expect(page.locator("#session-rows tr")).toHaveCount(1);
  await expect(page.locator("#session-rows tr")).toContainText("(this one)");
  await phone.reload();
  await expect(phone.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Settings" })).toBeHidden();
  await phone.context().close();
});

test("account details hold the record id and sessions, collapsed, with log-out left outside", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `Details${Date.now().toString(36)}`;
  await registerMember(page, memberName);
  await expect(page.locator("#app-signed-in")).toHaveText("You're signed in with a passkey.");
  const { recordId } = await page.evaluate(() => fetch("/me").then((r) => r.json() as Promise<{ recordId: string }>));

  await openSettings(page);
  const details = page.locator("#account-details");
  await expect(details).not.toHaveAttribute("open");
  await expect(page.locator("#record-id")).toBeHidden();
  await expect(page.locator("#session-rows")).toBeHidden();
  for (const name of ["Log out", "Log out everywhere", "Log out everywhere else"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }

  await page.getByText("Account details").click();
  await expect(page.locator("#record-id")).toHaveText(recordId);
  await expect(page.locator("#session-rows tr")).toHaveCount(1);
  await expect(page.locator("#session-rows tr")).toContainText("(this one)");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy record id" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Copied your record id.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recordId);
});

test("a rebind link opens the sign-in pane at its passkey, and says when the link is not valid", async ({ page }) => {
  await page.goto("/rebind#not-a-link");
  await expect(page.locator("#sign-in")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeHidden();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.locator("#sign-in-status")).toHaveText("This link is not valid.");
});

const INFO = {
  passkeys:
    "Held by is the password manager or security key that stores the passkey, when it can be identified. Synced means that manager can copy the passkey to your other devices. Revoking a passkey stops it signing in, though sessions it already started stay open, and you can't revoke your only one.",
  codes:
    "Recovery codes let you add a new passkey if you lose all of yours, and each one works once. Replacing them gives you a fresh set of 8, shown only once, and every old code stops working straight away, including copies kept elsewhere or split into shares.",
  sessions:
    "A session keeps one browser signed in for 7 days. Log out ends this one, and Log out everywhere ends all of them, this one included. Log out everywhere else keeps this one and asks for your passkey first, so someone holding a stolen session can't shut you out.",
  recordId:
    "Your record id names your identity record and never changes, even if every passkey and code does. It isn't secret. To make yourself an operator on your own deployment, add it to the OPERATOR_RECORD_IDS secret.",
  operator:
    "A rebind link lets the member add a new passkey. Send it yourself once you've confirmed who they are; it works once, within 24 hours, and leaves their old passkeys, sessions and codes in place. Suspend signs the member out everywhere and blocks sign-in, recovery and rebind links until you Resume. Remove does the same for good and retires their member name, so nobody can register it again; it can't be undone, and it refuses an operator. Every action here is logged.",
};

/** Click an info button open and shut, checking its text and aria-expanded each time. */
async function expectInfoToggle(page: Page, name: string, text: string) {
  const toggle = page.getByRole("button", { name, exact: true });
  const info = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(info).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(info).toBeVisible();
  await expect(info).toHaveText(text);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(info).toBeHidden();
}

test("info buttons in settings explain each section, and the operator's shows only to operators", async ({ page }) => {
  await addAuthenticator(page);
  await registerMember(page, `Info${Date.now().toString(36)}`);

  await openSettings(page);
  await expectInfoToggle(page, "About passkeys", INFO.passkeys);
  await expectInfoToggle(page, "About recovery codes", INFO.codes);
  await expectInfoToggle(page, "About sessions", INFO.sessions);
  await page.getByText("Account details").click();
  await expectInfoToggle(page, "About the record id", INFO.recordId);
  await expect(page.locator("#account-details")).toHaveAttribute("open");
  await expect(page.locator("#operator-info-toggle")).toHaveCount(1);
  await expect(page.locator("#operator-info-toggle")).toBeHidden();

  // The operator role comes from a Worker secret; here /me claims it, so the page shows the section.
  await page.route("**/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), operator: true } });
  });
  await page.locator("#settings .close").click();
  await openSettings(page);
  await expectInfoToggle(page, "About the operator actions", INFO.operator);
});

test("an operator looks up a member, and the actions act on the member shown", async ({ page }) => {
  await addAuthenticator(page);
  await registerMember(page, `Lookup${Date.now().toString(36)}`);
  // The operator role comes from a Worker secret fixed when wrangler dev starts, so
  // /me claims it here, and the operator routes answer as the vitest suite shows they do.
  await page.route("**/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), operator: true } });
  });
  const recordId = "0b5f3a1e-6c2d-4e8f-9a7b-1c2d3e4f5a6b";
  const operatorId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
  const created = Date.UTC(2026, 0, 2, 3, 4, 5);
  const summary = {
    createdAt: created,
    suspendedAt: null,
    removedAt: null,
    passkeys: 2,
    sessions: 3,
    recoveryCodesLeft: 7,
    rebindLinkOutstanding: false,
  };
  const earlier = { operatorId, action: "resume", targetId: recordId, at: created + 1000 };
  const lookups: unknown[] = [];
  await page.route("**/operator/lookup", async (route) => {
    const body = route.request().postDataJSON();
    lookups.push(body);
    if (body.memberName !== "Alice") return route.fulfill({ status: 404, json: { error: "no such member" } });
    await route.fulfill({ json: { recordId, retired: false, summary, entries: [earlier] } });
  });
  const suspends: unknown[] = [];
  await page.route("**/operator/suspend", async (route) => {
    suspends.push(route.request().postDataJSON());
    const suspendedAt = created + 2000;
    const entry = { operatorId, action: "suspend", targetId: recordId, at: suspendedAt };
    await route.fulfill({
      json: { ok: true, member: { recordId, summary: { ...summary, suspendedAt, sessions: 0 }, entries: [earlier, entry] } },
    });
  });
  await openSettings(page);

  const name = page.getByRole("textbox", { name: "Member name" });
  const actions = ["Create rebind link", "Suspend", "Resume", "Remove"].map((label) =>
    page.locator("#operator").getByRole("button", { name: label, exact: true }),
  );
  for (const action of actions) await expect(action).toBeDisabled();

  await name.fill("Nobody");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.locator("#operator-result")).toHaveText("No such member");
  await expect(page.locator("#operator-member")).toHaveCount(1);
  await expect(page.locator("#operator-member")).toBeHidden();

  await name.fill("Alice");
  await page.getByRole("button", { name: "Look up" }).click();
  const member = page.locator("#operator-member");
  await expect(member).toBeVisible();
  await expect(member).toContainText(recordId);
  await expect(member).toContainText("Active");
  await expect(member).toContainText(new Date(created).toLocaleString());
  await expect(page.locator("#operator-summary")).toContainText("Passkeys2");
  await expect(page.locator("#operator-summary")).toContainText("Sessions3");
  await expect(page.locator("#operator-summary")).toContainText("Recovery codes left7");
  await expect(page.locator("#operator-summary")).toContainText("Rebind linkNone");
  await expect(page.locator("#operator-entries tr")).toHaveCount(1);
  await expect(page.locator("#operator-entries")).toContainText("resume");
  for (const action of actions) await expect(action).toBeEnabled();

  // Acting on the shown member sends its record id, not the typed name, and shows the member as it now stands.
  await actions[1].click();
  await expect(page.locator("#operator-result")).toHaveText("Done.");
  expect(suspends).toEqual([{ recordId }]);
  await expect(member).toContainText(`Suspended since ${new Date(created + 2000).toLocaleString()}`);
  await expect(page.locator("#operator-summary")).toContainText("Sessions0");
  await expect(page.locator("#operator-entries tr")).toHaveCount(2);

  // Editing the name clears the result until the next lookup.
  await name.fill("Alic");
  await expect(member).toBeHidden();
  await expect(page.locator("#operator-result")).toHaveText("");
  for (const action of actions) await expect(action).toBeDisabled();
  expect(lookups).toEqual([{ memberName: "Nobody" }, { memberName: "Alice" }]);
});

test("an operator removes a member after confirming, and the name then looks up as retired, read-only", async ({ page }) => {
  await addAuthenticator(page);
  await registerMember(page, `Remove${Date.now().toString(36)}`);
  // As above, /me claims the operator role and the operator routes answer as the vitest suite shows they do.
  await page.route("**/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), operator: true } });
  });
  const recordId = "0b5f3a1e-6c2d-4e8f-9a7b-1c2d3e4f5a6b";
  const operatorId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
  const created = Date.UTC(2026, 0, 2, 3, 4, 5);
  const removedAt = created + 2000;
  const summary = {
    createdAt: created,
    suspendedAt: null,
    removedAt: null,
    passkeys: 2,
    sessions: 3,
    recoveryCodesLeft: 7,
    rebindLinkOutstanding: false,
  };
  const removal = { operatorId, action: "remove", targetId: recordId, at: removedAt };
  const removedSummary = { ...summary, removedAt, sessions: 0 };
  let removed = false;
  await page.route("**/operator/lookup", async (route) => {
    const { memberName } = route.request().postDataJSON();
    if (memberName === "Root") {
      return route.fulfill({ json: { recordId: operatorId, retired: false, summary, entries: [] } });
    }
    await route.fulfill({
      json: removed
        ? { recordId, retired: true, summary: removedSummary, entries: [removal] }
        : { recordId, retired: false, summary, entries: [] },
    });
  });
  const removes: unknown[] = [];
  await page.route("**/operator/remove", async (route) => {
    const body = route.request().postDataJSON();
    removes.push(body);
    if (body.recordId === operatorId) return route.fulfill({ status: 409, json: { error: "operator record" } });
    removed = true;
    await route.fulfill({ json: { ok: true, member: { recordId, summary: removedSummary, entries: [removal] } } });
  });
  await openSettings(page);

  const name = page.getByRole("textbox", { name: "Member name" });
  const lookUp = page.getByRole("button", { name: "Look up" });
  const actions = ["Create rebind link", "Suspend", "Resume", "Remove"].map((label) =>
    page.locator("#operator").getByRole("button", { name: label, exact: true }),
  );
  const remove = actions[3]!;

  // An operator's record is refused, and the pane says why.
  await name.fill("Root");
  await lookUp.click();
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(page.locator("#operator-result")).toHaveText(
    "Operators can't be removed. Take them off OPERATOR_RECORD_IDS first.",
  );

  // Declining the confirmation sends nothing.
  await name.fill("Alice");
  await lookUp.click();
  await expect(remove).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect(removes).toEqual([{ recordId: operatorId }]);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe("Remove Alice? This can't be undone, and their name will be retired.");
    void dialog.accept();
  });
  await remove.click();
  await expect(page.locator("#operator-result")).toHaveText("Removed. Their name is retired.");
  expect(removes).toEqual([{ recordId: operatorId }, { recordId }]);
  await expect(page.locator("#operator-member")).toContainText(`Removed since ${new Date(removedAt).toLocaleString()}`);
  for (const action of actions) await expect(action).toBeDisabled();

  await name.fill("Alice");
  await lookUp.click();
  await expect(page.locator("#operator-result")).toHaveText("Retired name");
  await expect(page.locator("#operator-member")).toBeVisible();
  await expect(page.locator("#operator-member")).toContainText(recordId);
  await expect(page.locator("#operator-entries")).toContainText("remove");
  for (const action of actions) await expect(action).toBeDisabled();
});
