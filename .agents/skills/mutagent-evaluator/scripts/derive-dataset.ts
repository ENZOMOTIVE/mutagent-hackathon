/**
 * scripts/derive-dataset.ts — EV-047 `*derive-dataset` (Type A — Code-only).
 * ---------------------------------------------------------------------------
 * Distill a LIVING REGRESSION SET from past ✓/✗ traces: pick the cases worth
 * keeping forever (catastrophes, edges, outliers, low-confidence calls), turn
 * each into a `DatasetCase` whose query IS the real input that produced the
 * outcome, and append them MONOTONICALLY into the growing dataset.
 *
 * Reuses (does NOT re-implement) the EV-052 selectors in `sample-traces.ts`
 * (failure-driven = catastrophe · outlier = edge · uncertainty = low-confidence)
 * and the EV-046 monotonic merge in `build-dataset.ts`. The NEW work here is the
 * distillation: trace → regression case + the append-only living set. Holds NO
 * LLM reasoning and makes NO pass/fail decision (the labels are already on the
 * traces, from `*discover`). PURE — no clock / random / network; same input →
 * same regression set (reproducible).
 */
import { OutcomeVerdict, type OutcomeVerdictValue } from "./contracts/eval-types.ts";
import {
  sampleTracesAttributed,
  SampleStrategy,
  type LabeledTrace,
  type AttributedTrace,
  type SampleStrategyValue,
} from "./sample-traces.ts";
import { buildCase, mergeCases } from "./build-dataset.ts";
import { CaseSource, type DatasetCase } from "./contracts/dataset.ts";

/**
 * The regression-worthy selection strategies, in priority order:
 *   - failure-driven (catastrophes — known ✗ we must never regress on)
 *   - outlier        (edges — unusual length / latency / tool-call count)
 *   - uncertainty    (low-confidence determinations — the brittle boundary)
 * Stratified is appended so a balanced ✓/✗ spread is preserved (a regression set
 * needs known-GOOD anchors too, not only failures).
 */
const REGRESSION_STRATEGIES = [
  SampleStrategy.FailureDriven,
  SampleStrategy.Outlier,
  SampleStrategy.Uncertainty,
  SampleStrategy.Stratified,
] as const;

/** Map a determiner verdict onto the outcome tag carried in a derived tuple. */
function outcomeTag(label: OutcomeVerdictValue): string {
  return label === OutcomeVerdict.Pass ? "pass" : label === OutcomeVerdict.Fail ? "fail" : "uncertain";
}

/**
 * Human-readable DETERMINISTIC provenance label for the selecting strategy — the
 * "data link" half of the why (what objective signal nominated this trace). The
 * JUDGMENT half (why it's high-value as a test) is authored separately. PURE.
 */
export function selectedByLabel(s: SampleStrategyValue): string {
  switch (s) {
    case SampleStrategy.FailureDriven:
      return "failure-driven — a confirmed ✗ catastrophe the suite must never regress on";
    case SampleStrategy.Outlier:
      return "outlier — an edge trajectory (unusual length / latency / tool-call count)";
    case SampleStrategy.Uncertainty:
      return "uncertainty — a low-confidence boundary call (the brittle decision edge)";
    case SampleStrategy.Stratified:
      return "stratified — a known-✓ anchor (keeps the regression set ✓/✗ balanced)";
    default:
      return String(s);
  }
}

/**
 * Authors the human "why high-value as a test" rationale for a selected trace.
 * This is the JUDGMENT — supplied by whoever SELECTS the case (the discover/judge
 * agent reasoning over the trace). Receives the attributed trace; returns the
 * rationale string, or undefined to leave it unauthored (renderer shows the
 * deterministic provenance + a "rationale pending" note).
 */
export type RationaleAuthor = (a: AttributedTrace) => string | undefined;

/**
 * Convert one labeled trace into a regression `DatasetCase`. The query IS the
 * trace's real input prompt (the input that produced the ✓/✗); the tuple records
 * the salient axis (the known outcome) so the case is self-describing; the source
 * is `derived` with `originTraceId` for provenance. `selectedBy` carries the
 * DETERMINISTIC strategy label; `rationale` (when `author` supplies one) carries
 * the LLM JUDGMENT of why this is high-value. Returns null when the trace has no
 * input prompt (a regression case needs a replayable input).
 */
export function traceToRegressionCase(a: AttributedTrace, author?: RationaleAuthor): DatasetCase | null {
  const lt = a.trace;
  const prompt = lt.trace.input?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  return buildCase({ outcome: outcomeTag(lt.label) }, prompt, CaseSource.Derived, lt.trace.id, {
    selectedBy: selectedByLabel(a.selectedBy),
    rationale: author?.(a),
  });
}

export interface DeriveOptions {
  /**
   * GA — exclude INDETERMINATE (`uncertain`) traces from the held-out set
   * (DEFAULT true). A held-out regression case needs a CONFIRMED ✓/✗ anchor; an
   * indeterminate outcome is unresolved (it belongs in the calibration loop, not
   * the gate-eligible regression set). Set false to keep them tagged
   * `needs-resolution` instead of dropping.
   */
  excludeIndeterminate?: boolean;
  /**
   * Authors the per-case "why high-value as a test" rationale (the JUDGMENT). The
   * selecting agent supplies it; when omitted the cases carry only the
   * deterministic `selectedBy` provenance.
   */
  authorRationale?: RationaleAuthor;
}

/**
 * Select the regression-worthy traces (reusing the EV-052 selectors) and distill
 * each into a `DatasetCase`. Traces without a replayable input are dropped, and
 * (GA, default) INDETERMINATE traces are excluded from the held-out set. The
 * result is deduped (content-id + near-duplicate query) so the same brittle case
 * isn't kept twice. DETERMINISTIC for a given (labeled, size).
 */
export function deriveRegressionCases(
  labeled: LabeledTrace[],
  size: number,
  opts: DeriveOptions = {},
): DatasetCase[] {
  const excludeIndeterminate = opts.excludeIndeterminate ?? true;
  const pool = excludeIndeterminate
    ? labeled.filter((lt) => lt.label !== OutcomeVerdict.Uncertain)
    : labeled;
  const selected = sampleTracesAttributed(pool, { size, strategies: [...REGRESSION_STRATEGIES] });
  const cases: DatasetCase[] = [];
  for (const a of selected) {
    const c = traceToRegressionCase(a, opts.authorRationale);
    if (c !== null) cases.push(c);
  }
  // dedup within the freshly-derived batch (id + near-dup) via the shared merge.
  return mergeCases([], cases);
}

/**
 * Grow an existing regression set with newly-derived cases — APPEND-ONLY: every
 * existing case is retained, only genuinely-novel (non-near-duplicate) derived
 * cases are added. The living regression set never shrinks (EV-053). DETERMINISTIC.
 */
export function growRegressionSet(
  existing: DatasetCase[],
  labeled: LabeledTrace[],
  size: number,
  opts: DeriveOptions = {},
): DatasetCase[] {
  const derived = deriveRegressionCases(labeled, size, opts);
  return mergeCases(existing, derived);
}
