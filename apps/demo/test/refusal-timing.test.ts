import { describe, expect, it } from "vitest";
import { recommendFloor, summarize } from "./refusal-timing.ts";

describe("refusal timing", () => {
  it("summarizes each arm by nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    const [summary] = summarize({ "bad signature": samples.reverse() });

    expect(summary).toEqual({ arm: "bad signature", n: 100, p50: 50, p99: 99, max: 100 });
  });

  it("orders arms slowest first by p99", () => {
    const summaries = summarize({ fast: [10, 11, 12], slow: [40, 41, 90], middle: [20, 21, 22] });

    expect(summaries.map((s) => s.arm)).toEqual(["slow", "middle", "fast"]);
  });

  it("sets the floor at half again the slowest p99, rounded up to 50 ms", () => {
    expect(recommendFloor(summarize({ a: [10, 20, 30], b: [60, 70, 80] }))).toBe(150);
    expect(recommendFloor(summarize({ a: [100] }))).toBe(150);
    expect(recommendFloor(summarize({ a: [101] }))).toBe(200);
  });

  it("refuses to recommend from no samples", () => {
    expect(() => recommendFloor(summarize({}))).toThrow();
    expect(() => summarize({ empty: [] })).toThrow();
  });
});
