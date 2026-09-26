import { expect, test, type Page } from "@playwright/test";

const NO_PASSKEY_USED = "No passkey was used. If you do not have a passkey here yet, register; if you lost yours, recover.";

async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
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
