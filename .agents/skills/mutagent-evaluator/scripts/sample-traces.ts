/**
 * scripts/sample-traces.ts — EV-052 trace filtering + sampling.
 * ---------------------------------------------------------------------------
 * The 5 sampling strategies from the error-analysis CORE source, as one
 * deterministic mix:
 *   - Random        — uniform spread (a stable seeded STRIDE, not Math.random)
 *   - Outlier       — extremes by response length / latency / tool-call count
 *   - Failure-driven— prioritize ✗-labeled traces
 *   - Uncertainty   — lowest-confidence labels (judge disagreement proxy)
 *   - Stratified    — even coverage across the pass/fail strata (validate-
 *                     evaluator's ~50✓/50✗ balance)
 *
 * Sealed-sibling: this RE-IMPLEMENTS the diagnostics filtering *pattern* — it
 * NEVER imports the diagnostics package. PURE + deterministic: no Math.random,
 * no clock, no network. The "random" strategy is a fixed stride over the
 * stable input order, so the same (traces, opts) always yields the identical
 * sample (reproducible eval datasets — C-PIN-adjacent).
 */
import { OutcomeVerdict, type EvalTrace, type OutcomeVerdictValue } from "./contracts/eval-types.ts";

/** A trace plus its determiner label (from EV-042) — the unit `*discover` mines. */
export interface LabeledTrace {
  trace: EvalTrace;
  label: OutcomeVerdictValue;
  /** the determiner's confidence (drives uncertainty sampling). */
  confidence: number;
}

export const SampleStrategy = {
  Random: "random",
  Outlier: "outlier",
  FailureDriven: "failure-driven",
  Uncertainty: "uncertainty",
  Stratified: "stratified",
} as const;
export type SampleStrategyValue =
  (typeof SampleStrategy)[keyof typeof SampleStrategy];

/** All five, in a stable priority order (the default mix). */
const ALL_STRATEGIES: readonly SampleStrategyValue[] = [
  SampleStrategy.Stratified,
  SampleStrategy.FailureDriven,
  SampleStrategy.Outlier,
  SampleStrategy.Uncertainty,
  SampleStrategy.Random,
];

// ── filterTraces (the re-implemented filtering pattern) ─────────────────────

export interface TraceFilter {
  /** exact trace.name match. */
  name?: string;
  /** minimum tool-call count. */
  minTools?: number;
  /** maximum tool-call count. */
  maxTools?: number;
}

function toolCount(t: EvalTrace): number {
  return t.observations.filter((o) => o.type === "TOOL").length;
}

/** Apply a filter (re-implemented diagnostics pattern; no cross-package import). */
export function filterTraces(traces: EvalTrace[], filter: TraceFilter): EvalTrace[] {
  return traces.filter((t) => {
    if (filter.name !== undefined && t.name !== filter.name) return false;
    const n = toolCount(t);
    if (filter.minTools !== undefined && n < filter.minTools) return false;
    if (filter.maxTools !== undefined && n > filter.maxTools) return false;
    return true;
  });
}

// ── outlierScore ─────────────────────────────────────────────────────────────

/** A monotone "how unusual" score: tools + latency + response length, scaled. */
export function outlierScore(t: EvalTrace): number {
  const tools = toolCount(t);
  const latency = typeof t.latencyMs === "number" ? t.latencyMs : 0;
  const respLen =
    typeof t.output?.response === "string" ? t.output.response.length : 0;
  // weights chosen so each axis can dominate at its extreme; pure arithmetic.
  return tools * 100 + latency + respLen;
}

// ── balancedSample — ~50/50 ✓/✗, never fabricated ───────────────────────────

/**
 * Pick up to `size` labeled traces with an even pass/fail balance. NEVER
 * invents items: if one class is scarcer, all of it is included and the other
 * class is capped to match (so the result is <= size and as balanced as the
 * data allows). Deterministic — preserves input order within each class.
 */
export function balancedSample(labeled: LabeledTrace[], size: number): LabeledTrace[] {
  const passes = labeled.filter((l) => l.label === OutcomeVerdict.Pass);
  const fails = labeled.filter((l) => l.label === OutcomeVerdict.Fail);
  const perSide = Math.floor(size / 2);
  // balance to the scarcer side so neither class is over-represented vs the other.
  const take = Math.min(perSide, passes.length, fails.length);
  const out: LabeledTrace[] = [...passes.slice(0, take), ...fails.slice(0, take)];

  // if balanced take didn't fill the budget AND one side has leftovers, top up
  // from the larger side up to `size` (still never fabricating).
  if (out.length < size) {
    const remaining = size - out.length;
    const leftover = [...passes.slice(take), ...fails.slice(take)];
    out.push(...leftover.slice(0, remaining));
  }
  return out;
}

// ── sampleTraces — the mixed strategy sample ────────────────────────────────

export interface SampleOptions {
  size: number;
  /** which strategies to mix (default: all five). */
  strategies?: SampleStrategyValue[];
}

/** Stable stride indices over [0,n) yielding ~count evenly-spread positions. */
function strideIndices(n: number, count: number): number[] {
  if (n <= 0 || count <= 0) return [];
  if (count >= n) return Array.from({ length: n }, (_v, i) => i);
  const step = n / count;
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(Math.floor(k * step));
  return out;
}

/** A selected trace plus the DETERMINISTIC strategy that nominated it ("data link"). */
export interface AttributedTrace {
  trace: LabeledTrace;
  /** which strategy's queue this trace was first picked from. */
  selectedBy: SampleStrategyValue;
}

/**
 * Build a deduped sample (<= size) mixing the requested strategies. Each
 * strategy contributes candidates in a fixed order; we round-robin across the
 * strategies and add the next not-yet-picked candidate from each until the
 * budget is met. Deterministic for a given (labeled, opts).
 */
export function sampleTraces(labeled: LabeledTrace[], opts: SampleOptions): LabeledTrace[] {
  return sampleTracesAttributed(labeled, opts).map((a) => a.trace);
}

/**
 * Like {@link sampleTraces}, but each result carries `selectedBy` — the strategy
 * whose queue first nominated it. This is the deterministic provenance ("data
 * link") surfaced on derived dataset cases; the human "why high-value" rationale
 * is authored separately by the selecting agent. Deterministic for (labeled, opts).
 */
export function sampleTracesAttributed(labeled: LabeledTrace[], opts: SampleOptions): AttributedTrace[] {
  const strategies = opts.strategies ?? ALL_STRATEGIES;
  const byId = new Map(labeled.map((l) => [l.trace.id, l]));

  // Per-strategy ordered candidate id lists (pure, stable).
  const queues: string[][] = strategies.map((s) => {
    switch (s) {
      case SampleStrategy.FailureDriven:
        return labeled.filter((l) => l.label === OutcomeVerdict.Fail).map((l) => l.trace.id);
      case SampleStrategy.Outlier:
        return [...labeled]
          .sort((a, b) => outlierScore(b.trace) - outlierScore(a.trace))
          .map((l) => l.trace.id);
      case SampleStrategy.Uncertainty:
        return [...labeled]
          .sort((a, b) => a.confidence - b.confidence)
          .map((l) => l.trace.id);
      case SampleStrategy.Stratified: {
        // interleave pass/fail so coverage spans both strata.
        const p = labeled.filter((l) => l.label === OutcomeVerdict.Pass).map((l) => l.trace.id);
        const f = labeled.filter((l) => l.label === OutcomeVerdict.Fail).map((l) => l.trace.id);
        const out: string[] = [];
        for (let i = 0; i < Math.max(p.length, f.length); i++) {
          if (i < f.length) out.push(f[i]);
          if (i < p.length) out.push(p[i]);
        }
        return out;
      }
      case SampleStrategy.Random:
      default:
        return strideIndices(labeled.length, labeled.length).map((i) => labeled[i].trace.id);
    }
  });

  const picked = new Set<string>();
  const result: AttributedTrace[] = [];
  const cursors = new Array<number>(queues.length).fill(0);

  // round-robin across strategies until budget met or all queues exhausted.
  let progressed = true;
  while (result.length < opts.size && progressed) {
    progressed = false;
    for (let qi = 0; qi < queues.length && result.length < opts.size; qi++) {
      const q = queues[qi];
      while (cursors[qi] < q.length) {
        const id = q[cursors[qi]++];
        if (!picked.has(id)) {
          picked.add(id);
          const lt = byId.get(id);
          if (lt !== undefined) result.push({ trace: lt, selectedBy: strategies[qi] });
          progressed = true;
          break;
        }
      }
    }
  }
  return result;
}
