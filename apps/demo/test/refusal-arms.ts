import { uniqueName, type Browser } from "./browser.ts";

// Every way a ceremony can be refused, each prepared as a request that the
// server must refuse. The invariant test uses them to check that refusals look
// alike; scripts/measure-refusals.ts uses them to time a deployed Worker.

/** A refused ceremony, ready to send: prepare it, then POST `body` to `path`. */
export type Arm = () => Promise<{ path: string; body: unknown }>;

export interface ArmSetup {
  /** A new browser against the target. */
  browser(): Browser;
  /** Suspend a member, as an operator would. */
  suspend(memberName: string): Promise<void>;
}

/**
 * Register the people the arms need, then return the arms by name. Each arm
 * can be prepared again and again; the arms that need a fresh challenge or
 * device take one each time.
 */
export async function refusalArms(setup: ArmSetup): Promise<Record<string, Arm>> {
  const name = uniqueName();
  const person = setup.browser();
  await person.register(name);
  await person.login();
  const suspendedName = uniqueName();
  const suspended = setup.browser();
  await suspended.register(suspendedName);
  await setup.suspend(suspendedName);
  const stranger = setup.browser();
  await stranger.authenticator.create(
    await stranger.json(stranger.post("/auth/register/options", { memberName: uniqueName() })),
  );

  const loginAttempt = (browser: Browser, tamper = {}): Arm => async () => {
    const options = await browser.json(browser.post("/auth/login/options"));
    return { path: "/auth/login/verify", body: { response: await browser.authenticator.get(options, tamper) } };
  };
  const recoverAttempt = (memberName: () => string): Arm => async () => {
    const device = setup.browser();
    const member = memberName();
    const options = await device.json(device.post("/auth/recover/options", { memberName: member }));
    return {
      path: "/auth/recover",
      body: { memberName: member, code: "eeee-eeee-eeee-eeee-eeee-eeee", response: await device.authenticator.create(options) },
    };
  };
  const crossPurpose: Arm = async () => {
    const options = await person.json(person.post("/auth/register/options", { memberName: uniqueName() }));
    const login = await person.json(person.post("/auth/login/options"));
    return {
      path: "/auth/login/verify",
      body: { response: await person.authenticator.get({ ...login, challenge: options.challenge }) },
    };
  };

  return {
    "unknown challenge": loginAttempt(person, { challenge: "dW5rbm93bi1jaGFsbGVuZ2UtdW5rbm93bi1jaGFsbGVuZ2U" }),
    "wrong origin": loginAttempt(person, { origin: "https://evil.example" }),
    "wrong RP ID": loginAttempt(person, { rpId: "evil.example" }),
    "bad signature": loginAttempt(person, { badSignature: true }),
    "regressed sign count": loginAttempt(person, { signCount: 1 }),
    "cross-purpose challenge": crossPurpose,
    "unknown credential": loginAttempt(stranger),
    "suspended principal": loginAttempt(suspended),
    "wrong recovery code": recoverAttempt(() => name),
    "unknown member name": recoverAttempt(() => uniqueName()),
    "malformed response": async () => ({ path: "/auth/login/verify", body: { response: { id: 7 } } }),
  };
}
