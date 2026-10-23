// The DOM helpers the panes share: elements by id, the panes' dialogs, the
// status line, the busy mark and table rows. No requests; lendPage and
// whileWorking run one they are handed.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element #${id}`);
  return element as T;
}

export const input = (id: string) => $<HTMLInputElement>(id);
export const button = (id: string) => $<HTMLButtonElement>(id);

export const pane = (id: string) => $<HTMLDialogElement>(id);

export function openPane(id: string) {
  if (!pane(id).open) pane(id).showModal();
}

export function closePane(id: string) {
  if (pane(id).open) pane(id).close();
}

const PANES = ["codes", "settings", "sign-in"] as const;

export type PaneId = (typeof PANES)[number];

/** The topmost open pane, or undefined when none is open. */
export const frontPane = (): PaneId | undefined => PANES.find((id) => pane(id).open);

/** Show a message in the topmost open pane, or in the app when none is open. */
export function status(message: string) {
  const open = frontPane();
  $(open ? `${open}-status` : "status").textContent = message;
}

/** Show a message in pane `id` while it is open: a result that comes back after the pane closed writes nothing. */
export function paneStatus(id: PaneId, message: string) {
  if (pane(id).open) $(`${id}-status`).textContent = message;
}

/**
 * Run `request` with the open panes made non-modal, then modal again. A modal
 * pane makes everything outside it inert, and a password manager that draws
 * its passkey picker in the page (LastPass) would take no clicks. Only for the
 * length of a passkey request, so the panes keep their backdrop, focus and
 * Escape the rest of the time. Focus goes back to where it was, such as the
 * button that started the request.
 */
export async function lendPage<T>(request: () => Promise<T>): Promise<T> {
  const lent = PANES.filter((id) => pane(id).matches(":modal"));
  const focused = document.activeElement;
  for (const id of lent) {
    pane(id).close();
    pane(id).show();
  }
  try {
    return await request();
  } finally {
    for (const id of lent) {
      // Closed while the request ran: leave it closed.
      if (pane(id).open && !pane(id).matches(":modal")) {
        pane(id).close();
        pane(id).showModal();
      }
    }
    if (focused instanceof HTMLElement && lent.some((id) => pane(id).open && pane(id).contains(focused)))
      focused.focus();
  }
}

/** How long an action runs before the busy bar shows, so a quick answer draws none. */
export const BAR_DELAY_MS = 300;

let working = 0;
let barTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Mark the page busy while `run` runs, however it ends: a progress cursor at
 * once, and a thin bar along the top after BAR_DELAY_MS. style.css draws both
 * from body's data-working, over any open pane. Overlapping runs share one mark.
 */
export async function whileWorking<T>(run: () => Promise<T>): Promise<T> {
  if (working++ === 0) {
    document.body.dataset.working = "";
    barTimer = setTimeout(() => (document.body.dataset.working = "bar"), BAR_DELAY_MS);
  }
  try {
    return await run();
  } finally {
    if (--working === 0) {
      clearTimeout(barTimer);
      delete document.body.dataset.working;
    }
  }
}

export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "never");

export function row(cells: string[], action?: HTMLElement) {
  const tr = document.createElement("tr");
  for (const cell of cells) {
    const td = document.createElement("td");
    td.textContent = cell;
    tr.append(td);
  }
  if (action) {
    const td = document.createElement("td");
    td.append(action);
    tr.append(td);
  }
  return tr;
}
