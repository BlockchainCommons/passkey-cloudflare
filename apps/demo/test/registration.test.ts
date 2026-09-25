import { describe, expect, it } from "vitest";
import { testApp, uniqueName } from "./harness.ts";

describe("registration", () => {
  it("creates a record, a passkey and a session in one step", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const registered = await browser.register(name);

    expect(registered.recordId).toMatch(/^[0-9a-f-]{36}$/);
    expect(browser.session).toBeDefined();
    const me = await browser.json(browser.get("/me"));
    expect(me).toMatchObject({ recordId: registered.recordId, memberName: name });
  });

  it("shows eight distinct recovery codes once", async () => {
    const browser = testApp().browser();

    const { recoveryCodes } = await browser.register(uniqueName());

    expect(recoveryCodes).toHaveLength(8);
    expect(new Set(recoveryCodes).size).toBe(8);
    for (const code of recoveryCodes) expect(code).toMatch(/^([a-z2-7]{4}-){5}[a-z2-7]{4}$/);
    const me = await browser.text(browser.get("/me"));
    for (const code of recoveryCodes) expect(me).not.toContain(code);
  });

  it("says a member name is taken before any ceremony starts", async () => {
    const app = testApp();
    const name = uniqueName();
    const first = app.browser();
    const second = app.browser();

    expect(await second.json(second.get(`/auth/member-name?name=${name}`))).toEqual({ available: true });
    await first.register(name);

    expect(await second.json(second.get(`/auth/member-name?name=${name.toUpperCase()}`))).toEqual({
      available: false,
    });
    const options = await second.post("/auth/register/options", { memberName: name });
    expect(options.status).toBe(409);
  });

  it("names the passkey after the member and a distinct label", async () => {
    const browser = testApp().browser();
    const name = uniqueName();

    const options = await browser.json(browser.post("/auth/register/options", { memberName: name }));

    expect(options.user.name).toMatch(new RegExp(`^${name} \\([a-z]+-[a-z]+\\)$`));
    expect(options.user.displayName).toBe(options.user.name);
  });

  it("accepts an Ed25519 passkey", async () => {
    const browser = testApp().browser({ algorithm: "Ed25519" });

    await browser.register(uniqueName());
    await browser.post("/auth/logout");
    await browser.login();

    expect((await browser.get("/me")).status).toBe(200);
  });
});

describe("login", () => {
  it("logs a returning person in with one passkey press", async () => {
    const browser = testApp().browser();
    const { recordId } = await browser.register(uniqueName());
    const first = browser.session;
    browser.session = undefined;

    const loggedIn = await browser.login();

    expect(loggedIn.recordId).toBe(recordId);
    expect(browser.session).toBeDefined();
    expect(browser.session).not.toBe(first);
    expect(await browser.json(browser.get("/me"))).toMatchObject({ recordId });
  });

  it("refuses a passkey the site has never seen", async () => {
    const app = testApp();
    const stranger = app.browser();
    await app.browser().register(uniqueName()); // a site with at least one person
    await stranger.authenticator.create(
      await stranger.json(stranger.post("/auth/register/options", { memberName: uniqueName() })),
    );

    const options = await stranger.json(stranger.post("/auth/login/options"));
    const response = await stranger.post("/auth/login/verify", {
      response: await stranger.authenticator.get(options),
    });

    expect(response.status).toBe(400);
    expect(stranger.session).toBeUndefined();
  });
});
