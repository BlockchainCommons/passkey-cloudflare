// Each browser module that finds page elements lists what it needs in a
// `<module>.contract.ts` beside it (browser/page-contract.ts). These tests
// check the lists against the modules' own source, so a lookup cannot go
// unlisted, and against the demo page, so the page holds every entry.

import { describe, expect, it } from "vitest";
import type { PageContract } from "../browser/page-contract.ts";
import { INFO_TOPICS } from "../browser/app.contract.ts";
import { missingFromPage } from "../browser/page-contract.ts";
import page from "../public/index.html?raw";

const sources = import.meta.glob<string>("../browser/*.ts", { eager: true, query: "?raw", import: "default" });
const files = import.meta.glob<ContractFile>("../browser/*.contract.ts", { eager: true });
const contracts = Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.contract]));

const modules = Object.keys(sources).filter((path) => !path.endsWith(".contract.ts"));

/** A call that finds page elements: by id through dom.ts's helpers or the DOM, or by selector. Not a declaration of one. */
const LOOKUP =
  /(?<![\w$.]|function\s+)(\$|input|button)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(|\.(getElementById|querySelectorAll|querySelector|closest)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(/g;

interface Lookup {
  /** "id" for a lookup by id, "selector" for one by selector. */
  kind: "id" | "selector";
  /** The argument as written. */
  argument: string;
}

function lookups(source: string): Lookup[] {
  const { code, bare } = mask(source);
  return [...bare.matchAll(LOOKUP)].map((match) => {
    const kind = match[2] === undefined || match[2] === "getElementById" ? "id" : "selector";
    return { kind, argument: firstArgument(code, bare, match.index + match[0].length) };
  });
}

/**
 * `source` twice, each the same length so positions agree: `code` with its
 * comments blanked, and `bare` with the insides of its strings, templates and
 * regular expressions blanked too, a template's `${}` code kept.
 */
function mask(source: string): { code: string; bare: string } {
  const code = source.split("");
  const bare = source.split("");
  const blank = (from: number, to: number, ...outs: string[][]) => {
    for (const out of outs) for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let last = ""; // The last character outside whitespace and comments, to tell a regular expression from a division.
  const DIVIDES = /[\w$)\]]/;
  const KEYWORD_BEFORE = /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/;
  const regexHere = () => !DIVIDES.test(last) || KEYWORD_BEFORE.test(source.slice(0, i).trimEnd());

  /** From the opening quote at `i`, past its closing quote; a template's `${}` is read as code. */
  function string() {
    const quote = source[i]!;
    i++;
    let from = i;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") i += 2;
      else if (quote === "`" && source.startsWith("${", i)) {
        blank(from, i, bare);
        i += 2;
        codeUntilBrace();
        from = i;
      } else i++;
    }
    blank(from, i, bare);
    i++;
    last = quote;
  }

  /** From `i`, code up to and past the `}` that closes it, or to the end of the source. */
  function codeUntilBrace() {
    let depth = 0;
    while (i < source.length) {
      const c = source[i]!;
      if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i);
        const to = end === -1 ? source.length : end;
        blank(i, to, code, bare);
        i = to;
      } else if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        const to = end === -1 ? source.length : end + 2;
        blank(i, to, code, bare);
        i = to;
      } else if (c === '"' || c === "'" || c === "`") string();
      else if (c === "/" && regexHere()) {
        i++;
        const from = i;
        let inClass = false;
        while (i < source.length && (inClass || source[i] !== "/")) {
          if (source[i] === "\\") i++;
          else if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          i++;
        }
        blank(from, i, bare);
        i++;
        last = "/";
      } else {
        if (c === "{") depth++;
        else if (c === "}" && depth-- === 0) {
          i++;
          last = "}";
          return;
        }
        if (!/\s/.test(c)) last = c;
        i++;
      }
    }
  }

  codeUntilBrace();
  return { code: code.join(""), bare: bare.join("") };
}

/** The first argument of the call whose parentheses open just before `start`, as written, without comments. */
function firstArgument(code: string, bare: string, start: number): string {
  let depth = 0;
  let end = start;
  for (; end < bare.length; end++) {
    const c = bare[end]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && depth-- === 0) break;
    else if (c === "," && depth === 0) break;
  }
  return code.slice(start, end).trim();
}

/** A contract file: its contract, and the constants its run-time ids are built from. */
type ContractFile = Record<string, unknown> & { contract: PageContract };

/** The values a `${}` in a module's lookup may stand for: every string in its contract file's other exports. */
function constants(file: ContractFile): Set<string> {
  return new Set(
    Object.entries(file)
      .filter(([name]) => name !== "contract")
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
      .filter((value) => typeof value === "string"),
  );
}

/**
 * Why `lookup` is not resolved by `file`'s contract, or undefined when it is.
 * A string literal must be one of its entries. A template's `${}` must each
 * hold a name, and the template must make an entry with each standing for one
 * of the contract file's constants, such as a pane in `PANES`; the module's
 * types tie the name to that constant.
 */
function unresolved({ kind, argument }: Lookup, file: ContractFile): string | undefined {
  const entries = kind === "id" ? file.contract.ids : file.contract.selectors;
  const quote = argument[0];
  if ((quote === '"' || quote === "'") && argument.at(-1) === quote) {
    const value = argument.slice(1, -1).replace(/\\(.)/g, "$1");
    return entries.includes(value) ? undefined : `${argument} is not in the contract's ${kind}s`;
  }
  if (quote === "`" && argument.at(-1) === "`") {
    const body = argument.slice(1, -1);
    const parts = body.split(/\$\{\s*[\w$]+\s*\}/);
    if (parts.some((part) => part.includes("${"))) return `${argument} holds a \${} that is not a name`;
    const escaped = parts.map((part) => part.replace(/\\(.)/g, "$1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`^${escaped.join("(.+?)")}$`);
    const values = constants(file);
    const made = entries.some((entry) =>
      pattern
        .exec(entry)
        ?.slice(1)
        .every((value) => values.has(value)),
    );
    return made ? undefined : `${argument} makes none of the contract's ${kind}s from its constants`;
  }
  return `${argument} is neither a string nor a template the test can read`;
}

/** dom.ts's helpers pass the id they are given straight through; that is the one lookup by a variable. */
const passesItsId = (module: string, { argument }: Lookup) => module.endsWith("/dom.ts") && argument === "id";

describe("each browser module's contract", () => {
  it("is beside every module that finds page elements", () => {
    const without = modules.filter(
      (module) => lookups(sources[module]!).length > 0 && !contracts[module.replace(/\.ts$/, ".contract.ts")],
    );
    expect(without).toEqual([]);
  });

  it("lists every element its module finds", () => {
    const problems = modules.flatMap((module) => {
      const file = files[module.replace(/\.ts$/, ".contract.ts")];
      if (!file) return [];
      return lookups(sources[module]!)
        .filter((lookup) => !passesItsId(module, lookup))
        .map((lookup) => unresolved(lookup, file))
        .filter((problem) => problem !== undefined)
        .map((problem) => `${module}: ${problem}`);
    });
    expect(problems).toEqual([]);
  });

  it("finds the lookups in a module, so the check above has something to check", () => {
    // A control: the scan must see app.ts's lookups of each kind, or an empty list above proves nothing.
    const found = lookups(sources["../browser/app.ts"]!).map((l) => `${l.kind} ${l.argument}`);
    expect(found).toContain('id "open-sign-in"');
    expect(found).toContain("id `add-passkey-${hint}`");
    expect(found).toContain('selector "dialog .close"');
    expect(found).toContain('selector "dialog"');
    expect(lookups(sources["../browser/operator-pane.ts"]!)).toContainEqual({
      kind: "selector",
      argument: '"#operator-actions button"',
    });
  });
});

describe("the source scan", () => {
  it("reads each lookup's first argument whole, and nothing in comments, strings or regular expressions", () => {
    const source = [
      '// an input (in a comment) and $("commented")',
      "/* a button ( in a block */",
      'const text = "press the button (above)";',
      "const quote = /['\"`]/g;",
      '$("plain");',
      "$('it\\'s');",
      "$(`${PANES.map((p) => `${p}`)[0]}-status`);",
      "document.querySelector<HTMLElement>(",
      '  "#a, #b",',
      ");",
      '$<Map<string, HTMLElement>>("nested-generic");',
      "x.closest(selector);",
    ].join("\n");
    expect(lookups(source)).toEqual([
      { kind: "id", argument: '"plain"' },
      { kind: "id", argument: "'it\\'s'" },
      { kind: "id", argument: "`${PANES.map((p) => `${p}`)[0]}-status`" },
      { kind: "selector", argument: '"#a, #b"' },
      { kind: "id", argument: '"nested-generic"' },
      { kind: "selector", argument: "selector" },
    ]);
  });
});

describe("a lookup's resolution", () => {
  const file: ContractFile = {
    contract: { ids: ["codes-status", "status"], selectors: ["dialog#codes .close"] },
    PANES: ["codes"],
    SLOT: "status",
  };
  const id = (argument: string): Lookup => ({ kind: "id", argument });

  it("takes a listed string, escaped or not, and a template built from a listed constant", () => {
    expect(unresolved(id('"status"'), file)).toBeUndefined();
    expect(unresolved(id("'stat\\us'"), file)).toBeUndefined();
    expect(unresolved(id("`${pane}-status`"), file)).toBeUndefined();
    expect(unresolved(id("`${slot}`"), file)).toBeUndefined();
    expect(unresolved({ kind: "selector", argument: "`dialog#${pane} .close`" }, file)).toBeUndefined();
  });

  it("refuses a template whose ${} stands for no constant, or holds more than a name", () => {
    expect(unresolved(id("`${x}`"), { contract: file.contract })).toMatch(/makes none/);
    expect(unresolved(id("`${x}-status`"), { contract: file.contract })).toMatch(/makes none/);
    expect(unresolved(id("`${x}us`"), file)).toMatch(/makes none/);
    expect(unresolved(id("`${PANES[0]}-status`"), file)).toMatch(/not a name/);
  });

  it("refuses an unlisted string, a selector given as an id, and a variable", () => {
    expect(unresolved(id('"other"'), file)).toMatch(/not in the contract's ids/);
    expect(unresolved(id('"dialog#codes .close"'), file)).toMatch(/not in the contract's ids/);
    expect(unresolved(id("name"), file)).toMatch(/neither a string nor a template/);
  });
});

describe("the demo page", () => {
  it("holds every entry of every browser module's contract", () => {
    expect(Object.keys(contracts).length).toBeGreaterThan(5);
    expect(missingFromPage(page, ...Object.values(contracts))).toEqual([]);
  });

  it("has an info toggle only for a topic app.ts wires", () => {
    // app.ts wires the toggles of INFO_TOPICS; one the page adds outside them would do nothing when pressed.
    const toggles = [...page.matchAll(/<[^>]*\bclass="(?:[^"]*\s)?info-toggle(?:\s[^"]*)?"[^>]*>/g)].map(
      ([tag]) => /\bid="([^"]*)"/.exec(tag)?.[1] ?? tag,
    );
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.filter((id) => !INFO_TOPICS.some((topic) => id === `${topic}-info-toggle`))).toEqual([]);
  });
});
