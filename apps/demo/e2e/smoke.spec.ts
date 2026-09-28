import { expect, test, type Page } from "@playwright/test";

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

test("register, log out and log back in with a passkey", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `smoke${Date.now().toString(36)}`;

  const logins: number[] = [];
  const registrations: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/login/verify")) logins.push(r.status());
  });
  page.on("request", (r) => {
    if (r.url().includes("/auth/register")) registrations.push(r.url());
  });
  await page.goto("/");
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
  await expect(page.locator("#status")).toHaveText("Copied your recovery codes.");
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
  await saved.check();
  await done.click();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#member-name")).toHaveText(memberName);

  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.locator("#home")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeHidden();

  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#member-name")).toHaveText(memberName);
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

test("recover on a new device with a recovery code, and be prompted to replace the rest", async ({ page, browser }) => {
  await addAuthenticator(page);
  const memberName = `recover${Date.now().toString(36)}`;
  await page.goto("/");
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
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#rotate-prompt")).toBeHidden();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.locator("#home")).toBeHidden();

  // A new device: no session and no passkey, only the member name and a code.
  const device = await (await browser.newContext()).newPage();
  await addAuthenticator(device);
  await device.goto("/");
  await device.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(device.getByText(NO_PASSKEY_USED)).toBeVisible();
  const recoverForm = device.locator("#recover-form");
  await recoverForm.getByLabel("Member name").fill(memberName);
  await recoverForm.getByLabel("Recovery code").fill(code);
  await recoverForm.getByRole("button", { name: "Recover with a new passkey" }).click();

  await expect(device.locator("#home")).toBeVisible();
  await expect(device.locator("#member-name")).toHaveText(memberName);
  await expect(device.locator("#rotate-prompt")).toBeVisible();
  await expect(device.locator("#rotate-prompt")).toContainText("you have 7 codes left");
  await expect(device.locator("#rotate-prompt")).toContainText("Replace your remaining codes now");
  await device.context().close();
});

test("adding a passkey on a device that already has one says so, and adds nothing", async ({ page }) => {
  await addAuthenticator(page);
  const memberName = `twice${Date.now().toString(36)}`;
  const enrolments: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/me/credentials/enrol/verify")) enrolments.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);

  // The same authenticator holds this record's passkey, which enrolment excludes.
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.locator("#status")).toHaveText(
    "This device already has a passkey for you. Use it to log in, or add one on another device.",
  );
  expect(enrolments).toEqual([]);
  await expect(page.locator("#credential-rows tr")).toHaveCount(1);
});

test("log out everywhere else steps up, then leaves only this session", async ({ page, browser }) => {
  const laptop = await addAuthenticator(page);
  const memberName = `elsewhere${Date.now().toString(36)}`;
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/logout-elsewhere")) statuses.push(r.status());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await page.getByRole("checkbox", { name: "I have saved my recovery codes" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#home")).toBeVisible();

  // A second device holding the same passkey logs in, so the record has two sessions.
  const phone = await (await browser.newContext()).newPage();
  const phoneAuthenticator = await addAuthenticator(phone);
  await copyCredentials(laptop, phoneAuthenticator);
  await phone.goto("/");
  await phone.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(phone.locator("#home")).toBeVisible();
  // The phone's login advanced the passkey's sign counter; the laptop takes that copy, as a synced passkey would.
  await copyCredentials(phoneAuthenticator, laptop);
  await page.reload();
  await expect(page.locator("#session-rows tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Log out everywhere else" }).click();

  await expect(page.locator("#status")).toHaveText("Logged out everywhere else.");
  expect(statuses).toEqual([403, 200]);
  await expect(page.locator("#session-rows tr")).toHaveCount(1);
  await expect(page.locator("#session-rows tr")).toContainText("(this one)");
  await phone.reload();
  await expect(phone.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  await expect(phone.locator("#home")).toBeHidden();
  await phone.context().close();
});
