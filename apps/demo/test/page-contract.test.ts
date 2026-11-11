import { describe, expect, it } from "vitest";
import { missingFromPage } from "../browser/page-contract.ts";

const page = `<!doctype html>
<html>
  <head><script type="module" src="/app.js"></script></head>
  <body>
    <!-- <p id="commented"></p> -->
    <dialog id="settings">
      <button class="close primary" type="button">&times;</button>
      <input id="name" />
      <br>
      <button id="topic-info-toggle" class="info-toggle" aria-controls="topic-info">i</button>
      <p id="topic-info" hidden></p>
      <div id="actions"><button value="remove">Remove</button></div>
    </dialog>
    <p id='single'>after a void element</p>
  </body>
</html>`;

describe("missingFromPage", () => {
  it("finds ids, wherever they sit and however they are quoted", () => {
    expect(missingFromPage(page, { ids: ["settings", "name", "topic-info", "single"], selectors: [] })).toEqual([]);
  });

  it("names each id the page lacks, and does not read ids in comments", () => {
    expect(missingFromPage(page, { ids: ["settings", "absent", "commented"], selectors: [] })).toEqual([
      "#absent",
      "#commented",
    ]);
  });

  it("matches tags, ids, classes and attributes, alone or with a value, through descendants", () => {
    const selectors = [
      "dialog",
      "dialog#settings",
      "dialog .close",
      "#settings .close.primary",
      '#topic-info-toggle.info-toggle[aria-controls="topic-info"]',
      "#actions button",
      '#actions button[value="remove"]',
      "#settings p[hidden]",
      "body p#single",
    ];
    expect(missingFromPage(page, { ids: [], selectors })).toEqual([]);
  });

  it("names each selector the page lacks", () => {
    const selectors = [
      "section",
      "p.close",
      '#topic-info-toggle[aria-controls="other-info"]',
      "#actions button[name]",
      "#single button",
      "dialog#single",
    ];
    expect(missingFromPage(page, { ids: [], selectors })).toEqual(selectors);
  });

  it("checks every contract it is given, and names a missing entry once", () => {
    expect(
      missingFromPage(page, { ids: ["absent"], selectors: ["section"] }, { ids: ["absent", "name"], selectors: [] }),
    ).toEqual(["#absent", "section"]);
  });

  it("refuses a selector it cannot read, rather than call it missing", () => {
    expect(() => missingFromPage(page, { ids: [], selectors: ["dialog > .close"] })).toThrow(/dialog > \.close/);
    expect(() => missingFromPage(page, { ids: [], selectors: ["li:first-child"] })).toThrow(/li:first-child/);
  });
});
