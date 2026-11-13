// What the demo's browser modules need from the page they run in, and a check
// that a page has it. Each module that finds page elements lists its needs in a
// `<module>.contract.ts` beside it; an app that copies the panes copies those
// files and this one, and runs missingFromPage on its own page in its own
// tests (docs/demo-panes.md). Free of DOM and Workers APIs, so it runs in any
// test runner: it reads the page's HTML as text.

/** The elements a module finds in the page. */
export interface PageContract {
  /** Every id the module looks up, run-time ids included in full. */
  readonly ids: readonly string[];
  /**
   * Other markup the module relies on, as selectors: a tag, `#id`, `.class`,
   * `[attribute]` and `[attribute="value"]`, joined into compounds and separated
   * by spaces for descendants, such as `dialog .close`.
   */
  readonly selectors: readonly string[];
}

/**
 * The entries of `contracts` that `html` lacks: each id as `#id`, each selector
 * as written, in order, each once. Expects markup that closes every element
 * that is not void; a comment's markup is not read. Markup inside `<textarea>`,
 * `<title>` or `<template>` is read as if it were in the page.
 */
export function missingFromPage(html: string, ...contracts: PageContract[]): string[] {
  const elements = parse(html);
  const ids = new Set(elements.map((e) => e.attributes.get("id")).filter((id) => id !== undefined));
  const missing = new Set<string>();
  for (const contract of contracts) {
    for (const id of contract.ids) if (!ids.has(id)) missing.add(`#${id}`);
    for (const selector of contract.selectors) {
      const chain = compile(selector);
      if (!elements.some((e) => matchesChain(e, chain))) missing.add(selector);
    }
  }
  return [...missing];
}

interface Element {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly parent: Element | undefined;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const TOKEN =
  /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parse(html: string): Element[] {
  const elements: Element[] = [];
  const open: Element[] = [];
  // Script and style hold text, not markup.
  const text = html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, "<$1$2></$1>");
  for (const [, closing, tag, attributeText] of text.matchAll(TOKEN)) {
    if (closing) {
      const at = open.findLastIndex((e) => e.tag === closing.toLowerCase());
      if (at !== -1) open.length = at;
    } else if (tag) {
      const attributes = new Map<string, string>();
      for (const [, name, double, single, bare] of (attributeText ?? "").matchAll(ATTRIBUTE)) {
        attributes.set(name!.toLowerCase(), decode(double ?? single ?? bare ?? ""));
      }
      const element = { tag: tag.toLowerCase(), attributes, parent: open.at(-1) };
      elements.push(element);
      if (!VOID.has(element.tag)) open.push(element);
    }
  }
  return elements;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES[name] ?? entity;
    const hex = name[1]!.toLowerCase() === "x";
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

interface Compound {
  tag?: string;
  attributes: { name: string; value?: string; word?: boolean }[];
}

const COMPOUND = /^([a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
const PART = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;

/** A selector as compounds, outermost first; throws on anything outside the grammar PageContract names. */
function compile(selector: string): Compound[] {
  return selector
    .trim()
    .split(/\s+/)
    .map((text) => {
      const match = COMPOUND.exec(text);
      if (!match || text === "") throw new Error(`cannot check selector "${selector}"`);
      const attributes = [...(match[2] ?? "").matchAll(PART)].map(([, id, className, name, value]) =>
        id !== undefined
          ? { name: "id", value: id }
          : className !== undefined
            ? { name: "class", value: className, word: true }
            : { name: name!.toLowerCase(), value },
      );
      return { tag: match[1]?.toLowerCase(), attributes };
    });
}

function matchesCompound(element: Element, compound: Compound): boolean {
  if (compound.tag !== undefined && element.tag !== compound.tag) return false;
  return compound.attributes.every(({ name, value, word }) => {
    const actual = element.attributes.get(name);
    if (actual === undefined) return false;
    if (value === undefined) return true;
    return word ? actual.split(/\s+/).includes(value) : actual === value;
  });
}

/** Whether `element` matches the last compound and has ancestors matching the rest, in order. */
function matchesChain(element: Element, chain: Compound[]): boolean {
  if (!matchesCompound(element, chain.at(-1)!)) return false;
  let rest = chain.length - 2;
  for (let ancestor = element.parent; ancestor && rest >= 0; ancestor = ancestor.parent) {
    if (matchesCompound(ancestor, chain[rest]!)) rest--;
  }
  return rest < 0;
}
