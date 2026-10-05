// The DOM helpers the panes share: elements by id, the panes' dialogs, the
// status line and table rows. No requests.

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

/** Show a message in the topmost open pane, or in the app when none is open. */
export function status(message: string) {
  const open = ["codes", "settings", "sign-in"].find((id) => pane(id).open);
  $(open ? `${open}-status` : "status").textContent = message;
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
