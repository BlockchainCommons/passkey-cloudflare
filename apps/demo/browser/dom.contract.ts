// What dom.ts needs from the page: the panes' dialogs, their status lines and
// the app's. Free of DOM and Workers APIs, so tests can read it; see
// page-contract.ts.

import type { PageContract } from "./page-contract.ts";

/** The panes, each a `<dialog>` with a status line `<pane>-status`. */
export const PANES = ["codes", "settings", "sign-in"] as const;

export type PaneId = (typeof PANES)[number];

export const contract: PageContract = {
  ids: ["status", ...PANES, ...PANES.map((pane) => `${pane}-status`)],
  selectors: PANES.map((pane) => `dialog#${pane}`),
};
