// How the refusal timing floor is chosen from measured refusal arms. See
// docs/refusal-floor.md for the method this implements.

export interface ArmSummary {
  arm: string;
  n: number;
  p50: number;
  p99: number;
  max: number;
}

/** Fewest samples per arm for a p99 that is more than the maximum. */
export const MIN_SAMPLES = 100;
/** The floor is this many times the slowest arm's p99... */
export const FLOOR_MARGIN = 1.5;
/** ...rounded up to a multiple of this, in milliseconds. */
export const FLOOR_STEP_MS = 50;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Per-arm percentiles of wall times in milliseconds, slowest p99 first. */
export function summarize(samples: Record<string, number[]>): ArmSummary[] {
  return Object.entries(samples)
    .map(([arm, times]) => {
      if (times.length === 0) throw new Error(`no samples for ${arm}`);
      const sorted = [...times].sort((a, b) => a - b);
      return { arm, n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1)! };
    })
    .sort((a, b) => b.p99 - a.p99);
}

/** The floor that covers the slowest arm's p99 with margin. */
export function recommendFloor(summaries: ArmSummary[]): number {
  const slowest = summaries[0];
  if (!slowest) throw new Error("no arms measured");
  for (const s of summaries) {
    if (s.n < MIN_SAMPLES) throw new Error(`${s.arm}: ${s.n} samples, fewer than ${MIN_SAMPLES}`);
  }
  return Math.ceil((slowest.p99 * FLOOR_MARGIN) / FLOOR_STEP_MS) * FLOOR_STEP_MS;
}
