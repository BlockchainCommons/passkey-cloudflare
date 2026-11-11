// What operator-pane.ts needs from the page; see page-contract.ts.

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

export const contract: PageContract = {
  ids: [
    "operator-result",
    "operator-member-rows",
    "operator-members",
    "operator-member",
    "operator-summary",
    "operator-entries",
  ],
  selectors: [
    "#operator-actions button",
    ...OPERATOR_ACTIONS.map((action) => `#operator-actions button[value="${action}"]`),
  ],
};
