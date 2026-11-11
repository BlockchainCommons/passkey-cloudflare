# Copying the demo's panes

An app can copy the demo's sign-in, codes and Settings panes, with the operator section inside Settings, and give them its own look by setting custom properties, without matching the demo's selectors. The panes are example code: an app copies them and from then on owns its copy. The library ships no UI ([ADR 0006](adr/0006-headless-browser-module.md)), and the panes have no API for an app to call. What this page describes keeps that copy cheap to make and to keep in step with the demo.

The panes are the browser modules in `apps/demo/browser/`, the markup in `apps/demo/public/index.html` and the stylesheet `apps/demo/public/style.css`.

## Restyling with custom properties

`style.css` defines these custom properties on `:root`, each again under `prefers-color-scheme: dark`. Set them in the app's own stylesheet to restyle the panes. Several default to a mix of `currentColor`, which each element resolves against its own text colour.

| Property | What it styles |
|---|---|
| `--surface` | The page's background |
| `--pane-surface` | Each pane's background |
| `--text` | The page's and the panes' text |
| `--muted-text` | Explanations behind the info buttons, and the operator form's hint |
| `--font` | The page's font |
| `--mono-font` | The recovery codes |
| `--border` | The app bar's rule and table cells |
| `--pane-border` | Each pane's border |
| `--control-border` | Buttons and the codes pane's form choice |
| `--hover` | A button's background under the pointer |
| `--placeholder-border` | The dashed box where an app would go |
| `--notice-border` | The notices in Settings, such as the suggestion to add a passkey |
| `--radius-small` | Notices' corners |
| `--radius` | Buttons' corners, and the outer corners of the codes pane's form choice |
| `--radius-large` | The placeholder's corners |
| `--pane-radius` | Each pane's corners |
| `--shadow` | Each pane's shadow (`none` by default) |
| `--backdrop` | What covers the page behind an open pane |
| `--accent` | Primary buttons and the chosen form of the codes |
| `--accent-hover` | A primary button under the pointer |
| `--on-accent` | Text on the accent |
| `--danger` | Actions that cannot be undone, such as an operator's Remove |
| `--disabled` | Disabled buttons |
| `--focus-ring` | The outline around a focused control (a whole `outline` value) |
| `--working-bar` | The moving part of the bar shown while an action runs |
| `--working-bar-track` | The rest of that bar |
| `--status-text` | The status lines that say each step, the page's and each pane's |
| `--status-font` | Those status lines' font |

## Why an app's own rules win

Every rule in `style.css` sits in one cascade layer, `@layer passkey-demo`. A rule outside any layer beats every layered rule whatever its specificity, so an app's plain `dialog { ... }` overrides the demo's `#settings` rules with no id to match. An app that puts its own rules in a layer has to declare that layer after `passkey-demo` for its rules to win.

The browser's own `[hidden]` rule is the exception, and it works against you. Any author `display` outranks it, layered or not, so a rule that sets `display` on an element shown and hidden with the `hidden` attribute makes the element show while hidden. Scope such a rule with `:not([hidden])`, as the demo's `#signed-in:not([hidden])` does. Without that scope, a 44 px target rule on the app bar's buttons once showed Sign in to a member already signed in.

## Checking the page has what the modules need

The browser modules find elements in the page by id and by a few selectors, so a page that lacks one fails at run time, often only when someone opens that part of a pane. Each module that does this lists what it needs in a `<module>.contract.ts` beside it, such as `browser/operator-pane.contract.ts`: the ids, the ids it builds at run time, in full, and selectors for the markup it relies on beyond ids, such as each pane's `<dialog>` and its `.close` button, and each info button's `aria-controls`. `browser/page-contract.ts` holds `missingFromPage(html, ...contracts)`, which reads a page's HTML as text and returns every entry the page lacks. It uses no DOM or Workers APIs, so it runs in any test runner.

Copy the contract files and `page-contract.ts` with the modules, and check the app's page in its own tests:

```ts
import { missingFromPage } from "./browser/page-contract.ts";
import { contract as app } from "./browser/app.contract.ts";
import { contract as dom } from "./browser/dom.contract.ts";
import { contract as operator } from "./browser/operator-pane.contract.ts";
// ...and the contract of every other module the app copied.

expect(missingFromPage(pageHtml, app, dom, operator)).toEqual([]);
```

After syncing the modules from a newer demo, run the check again: a module that now needs an element the app's page lacks fails it by name.

The demo runs the same check on its own page in `apps/demo/test/browser-contracts.test.ts`. That test also reads each module's source and fails on any lookup its contract does not list, so a contract stays in step with its module.

## Adding an app's own operator section

The operator section of Settings, `section#operator`, ends with an empty `<div id="operator-app-section">`. The demo never writes into it, clears it or hides it. An app puts its own section there, such as a list of its projects, and wires it with its own script. The section shows only to operators, because the demo hides the whole of `section#operator` from anyone else.

An app section's actions run on the server through the library's operator pipeline: operator role, step-up, log entry, then the action ([ADR 0011](adr/0011-library-owns-the-operator-pipeline.md)). The section shows only what those actions return. What an operator may see follows [ADR 0010](adr/0010-what-an-operator-sees.md): names already shown to others can be listed, while an item's state and counts are shown one item at a time and logged against it.
