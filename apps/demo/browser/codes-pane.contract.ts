// What codes-pane.ts needs from the page; see page-contract.ts.

import type { CodeForm } from "./flows.ts";
import type { PageContract } from "./page-contract.ts";

/** The forms the codes pane shows the codes in, each a radio button `codes-form-<form>`. */
export const CODE_FORMS = ["code", "bip39", "bytewords"] as const satisfies readonly CodeForm[];

export const contract: PageContract = {
  ids: [
    "codes-header",
    "codes-saved",
    "codes-done",
    "codes-status",
    "code-list",
    ...CODE_FORMS.map((form) => `codes-form-${form}`),
  ],
  selectors: [],
};
