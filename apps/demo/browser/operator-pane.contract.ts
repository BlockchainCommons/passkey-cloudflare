// What operator-pane.ts needs from the page, and the slot it leaves for an
// app's own operator section; see page-contract.ts and docs/demo-panes.md.

import type { OperatorAction } from "./demo-client.ts";
import type { PageContract } from "./page-contract.ts";

/** The operator actions, each a button with that `value` in `#operator-actions`. */
export const OPERATOR_ACTIONS = [
  "rebind",
  "suspend",
  "resume",
  "allow-name",
  "remove",
] as const satisfies readonly OperatorAction[];

// Every OperatorAction has a button: this fails to compile when one is left out.
const everyAction: [Exclude<OperatorAction, (typeof OPERATOR_ACTIONS)[number]>] extends [never] ? true : never = true;
void everyAction;

/**
 * An empty element that ends the operator section. The demo never writes into
 * it, clears it or hides it; an app puts its own operator section there.
 */
export const OPERATOR_APP_SECTION = "operator-app-section";

export const contract: PageContract = {
  ids: [
    "operator-result",
    "operator-member-rows",
    "operator-members",
    "operator-member",
    "operator-summary",
    "operator-entries",
    OPERATOR_APP_SECTION,
  ],
  selectors: [
    "#operator-actions button",
    ...OPERATOR_ACTIONS.map((action) => `#operator-actions button[value="${action}"]`),
    `section#operator #${OPERATOR_APP_SECTION}`,
  ],
};
