// What settings-pane.ts needs from the page; see page-contract.ts.

import type { PageContract } from "./page-contract.ts";

export const contract: PageContract = {
  ids: [
    "credential-rows",
    "device-bound-notice",
    "session-rows",
    "record-id",
    "operator",
    "settings-status",
    "rotate-message",
    "rotate-prompt",
  ],
  selectors: [],
};
