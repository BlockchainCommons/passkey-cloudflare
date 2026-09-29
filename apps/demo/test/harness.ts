import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { SoftwareAuthenticator, type AuthenticatorOptions } from "passkey-cloudflare/testing";
import { createApp, type AppOptions } from "../src/app.ts";
import { Browser } from "./browser.ts";

export { Browser, uniqueName } from "./browser.ts";

export const ORIGIN = "https://passkeydemo.shallweplay.com";

export interface HarnessOptions extends AppOptions {
  vars?: Partial<Env>;
}

/** The demo app as a test drives it: its fetch handler, with configuration injected. */
export function testApp(options: HarnessOptions = {}) {
  const { vars, ...appOptions } = options;
  const app = createApp(appOptions);
  return {
    origin: ORIGIN,
    /** Configuration variables, read on every request, so a test can change them. */
    vars: { ...vars } as Partial<Env>,
    async fetch(request: Request): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await app.fetch(request, { ...env, ...this.vars } as Env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },
    browser(authenticatorOptions: Partial<AuthenticatorOptions> = {}) {
      return new Browser(this, new SoftwareAuthenticator({ origin: ORIGIN, ...authenticatorOptions }));
    },
  };
}

export type TestApp = ReturnType<typeof testApp>;
