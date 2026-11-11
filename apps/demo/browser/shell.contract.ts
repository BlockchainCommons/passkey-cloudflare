// What shell.ts needs from the page; see page-contract.ts.

import type { PageContract } from "./page-contract.ts";

export const contract: PageContract = {
  ids: ["app-signed-out", "open-sign-in", "app-signed-in", "signed-in", "member-name"],
  selectors: [],
};
