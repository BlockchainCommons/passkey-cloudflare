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
});
