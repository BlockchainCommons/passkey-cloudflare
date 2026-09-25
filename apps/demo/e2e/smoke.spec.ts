import { expect, test } from "@playwright/test";

test("register, log out and log back in with a passkey", async ({ page }) => {
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
  const memberName = `smoke${Date.now().toString(36)}`;

  const logins: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/auth/login/verify")) logins.push(r.status());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByRole("heading", { name: "New here? Register" })).toBeVisible();

  await page.locator("#register-name").fill(memberName);
  await page.getByRole("button", { name: "Register with a passkey" }).click();
  await expect(page.locator("#code-list li")).toHaveCount(8);
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#member-name")).toHaveText(memberName);

  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.locator("#home")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue with passkey" })).toBeVisible();

  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#member-name")).toHaveText(memberName);
  expect(logins).toEqual([200]);
});
