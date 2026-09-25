import { describe, expect, it } from "vitest";
import { MIN_SAMPLES, recommendFloor, summarize } from "./refusal-timing.ts";

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
    const ms = (value: number) => Array<number>(MIN_SAMPLES).fill(value);
    expect(recommendFloor(summarize({ a: ms(30), b: ms(80) }))).toBe(150);
    expect(recommendFloor(summarize({ a: ms(100) }))).toBe(150);
    expect(recommendFloor(summarize({ a: ms(101) }))).toBe(200);
  });

  it("refuses to recommend from too few samples for a p99", () => {
    expect(() => recommendFloor(summarize({}))).toThrow();
    expect(() => summarize({ empty: [] })).toThrow();
    // A nearest-rank p99 of fewer than 100 samples is only the maximum.
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(100);
    const enough = Array<number>(MIN_SAMPLES).fill(10);
    expect(() => recommendFloor(summarize({ a: enough, b: enough.slice(1) }))).toThrow(`b: ${MIN_SAMPLES - 1} samples`);
  });
});
