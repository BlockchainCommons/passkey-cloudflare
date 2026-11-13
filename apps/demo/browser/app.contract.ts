// What app.ts needs from the page: the controls it wires to flows, each
// pane's close button, and the info toggles; see page-contract.ts.

import type { PublicKeyCredentialHint } from "passkey-cloudflare/browser";
import type { PaneId } from "./dom.contract.ts";
import type { PageContract } from "./page-contract.ts";

/** The hints Settings can add a passkey with, each a button `add-passkey-<hint>`. */
export const ADD_PASSKEY_HINTS = [
  "client-device",
  "hybrid",
  "security-key",
] as const satisfies readonly PublicKeyCredentialHint[];

/**
 * The topics an info toggle explains: a button `<topic>-info-toggle` of class
 * `info-toggle` that controls the text `<topic>-info`, hidden until pressed.
 */
export const INFO_TOPICS = ["name", "passkeys", "codes", "sessions", "record-id", "operator"] as const;

/**
 * The panes with a close button. The codes pane has none: it closes only once
 * the member says the codes are saved (`codes-done`).
 */
export const CLOSABLE_PANES = ["sign-in", "settings"] as const satisfies readonly PaneId[];

export const contract: PageContract = {
  ids: [
    "status",
    "open-sign-in",
    "open-settings",
    "continue",
    "register-name",
    "register-form",
    "recover-form",
    "rebind-button",
    "codes-saved",
    "codes-done",
    "codes-form",
    "codes-copy",
    "copy-record-id",
    "rotate-codes",
    "rotate-now",
    "logout",
    "logout-everywhere",
    "logout-elsewhere",
    "operator-form",
    ...ADD_PASSKEY_HINTS.map((hint) => `add-passkey-${hint}`),
    ...INFO_TOPICS.flatMap((topic) => [`${topic}-info`, `${topic}-info-toggle`]),
  ],
  selectors: [
    "dialog",
    "dialog .close",
    ...CLOSABLE_PANES.map((pane) => `dialog#${pane} .close`),
    ...INFO_TOPICS.map((topic) => `#${topic}-info-toggle.info-toggle[aria-controls="${topic}-info"]`),
  ],
};
