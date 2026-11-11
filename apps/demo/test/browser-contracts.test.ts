// Each browser module that finds page elements lists what it needs in a
// `<module>.contract.ts` beside it (browser/page-contract.ts). These tests
// check the lists against the modules' own source, so a lookup cannot go
// unlisted, and against the demo page, so the page holds every entry.

import { describe, expect, it } from "vitest";
import type { PageContract } from "../browser/page-contract.ts";
import { missingFromPage } from "../browser/page-contract.ts";
import page from "../public/index.html?raw";

const sources = import.meta.glob<string>("../browser/*.ts", { eager: true, query: "?raw", import: "default" });
const contracts = import.meta.glob<PageContract>("../browser/*.contract.ts", { eager: true, import: "contract" });

const modules = Object.keys(sources).filter((path) => !path.endsWith(".contract.ts"));

/** A call that finds page elements: by id through dom.ts's helpers or the DOM, or by selector. Not a declaration of one. */
const LOOKUP =
  /(?<![\w$.]|function\s+)(\$|input|button)\s*(?:<[^<>()]*>)?\s*\(|\.(getElementById|querySelectorAll|querySelector|closest)\s*(?:<[^<>()]*>)?\s*\(/g;

interface Lookup {
  /** "id" for a lookup by id, "selector" for one by selector. */
  kind: "id" | "selector";
  /** The argument as written. */
  argument: string;
}

function lookups(source: string): Lookup[] {
  return [...source.matchAll(LOOKUP)].map((match) => {
    const kind = match[2] === undefined || match[2] === "getElementById" ? "id" : "selector";
    const start = match.index + match[0].length;
    return { kind, argument: firstArgument(source, start) };
  });
}

/** The first argument of the call whose parentheses open just before `start`, as written. */
function firstArgument(source: string, start: number): string {
  const quote = source[start];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = source.indexOf(quote, start + 1);
    return source.slice(start, end + 1);
  }
  return /^[^,)]*/.exec(source.slice(start))![0].trim();
}

/**
 * Why `lookup` is not resolved by `contract`, or undefined when it is: a
 * string literal must be one of its entries, and a template's fixed parts,
 * with anything in each `${}`, must make one.
 */
function unresolved({ kind, argument }: Lookup, contract: PageContract): string | undefined {
  const entries = kind === "id" ? contract.ids : contract.selectors;
  const quote = argument[0];
  if (quote === '"' || quote === "'") {
    return entries.includes(argument.slice(1, -1)) ? undefined : `${argument} is not in the contract's ${kind}s`;
  }
  if (quote === "`") {
    const parts = argument.slice(1, -1).split(/\$\{[^}]*\}/);
    const pattern = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`);
    return entries.some((entry) => pattern.test(entry))
      ? undefined
      : `${argument} makes none of the contract's ${kind}s`;
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
      const contract = contracts[module.replace(/\.ts$/, ".contract.ts")];
      if (!contract) return [];
      return lookups(sources[module]!)
        .filter((lookup) => !passesItsId(module, lookup))
        .map((lookup) => unresolved(lookup, contract))
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

describe("the demo page", () => {
  it("holds every entry of every browser module's contract", () => {
    expect(Object.keys(contracts).length).toBeGreaterThan(5);
    expect(missingFromPage(page, ...Object.values(contracts))).toEqual([]);
  });
});
