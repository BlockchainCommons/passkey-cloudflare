// What sign-in-pane.ts needs from the page; see page-contract.ts.

import type { PageContract } from "./page-contract.ts";

export const contract: PageContract = {
  ids: [
    "register-name",
    "name-info",
    "sign-in-status",
    "entry",
    "rebind",
    "choices",
    "choices-reason",
    "name-availability",
    "capital-nudge",
  ],
  selectors: [],
};
