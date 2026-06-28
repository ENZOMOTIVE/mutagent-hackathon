/**
 * scripts/assemble-scorecard.ts
 * ---------------------------------------------------------------------------
 * The two-track rollup (decision #5). GATE and TREND are assembled SEPARATELY
 * and NEVER merged.
 *
 *   Track-1 GATE  — binary, severity-gated. Component PASS iff 0 CRIT/HIGH rows
 *                   FAIL. Run PASS iff every component passes. (skip != fail.)
 *   Track-2 TREND — the manual's 15-dim variance score, carried verbatim from
 *                   the variance comparator (or an empty/zeroed frame on a
 *                   single-run audit).
 *
 * Pure + deterministic: rows are grouped in stable order; no clock/random. The
 * generatedAt is injected by the caller so byte-identity masking is satisfiable.
 */
import {
  type CoverageOptions,
  type DeterministicRowResult,
  computeCoverage,
} from "./run-deterministic.ts";
import {
  type GateComponent,
  type RunVerdictValue,
  type Scorecard,
  type ScorecardCriterion,
  type TrendDimension,
  RowResult,
  RunVerdict,
  Severity,
} from "./contracts/types.ts";

const GATING_SEVERITIES: ReadonlySet<string> = new Set([
  Severity.Crit,
  Severity.High,
]);

export interface AssembleInput {
  subject: string;
  runId: string;
  generatedAt: string;
  rows: DeterministicRowResult[];
  /** Track-2 trend dimensions (from variance-compare). Empty on single-run. */
  trendDimensions?: TrendDimension[];
  trendRunPair?: { a: string; b: string };
  /**
   * Coverage-honesty options (EV-OUT-002). Controls the skip-rate WARNING
   * threshold only — never alters gate pass/fail. Defaults preserve behavior.
   */
  coverageOptions?: CoverageOptions;
}

/** Group rows by componentId, preserving first-seen order. */
function groupByComponent(
  rows: DeterministicRowResult[],
): { componentId: string; criteria: ScorecardCriterion[] }[] {
  const order: string[] = [];
  const map = new Map<string, ScorecardCriterion[]>();
  for (const r of rows) {
    if (!map.has(r.componentId)) {
      map.set(r.componentId, []);
      order.push(r.componentId);
    }
    map.get(r.componentId)!.push(r.criterion);
  }
  return order.map((componentId) => ({
    componentId,
    criteria: map.get(componentId)!,
  }));
}

/** Track-1: a component passes iff no CRIT/HIGH criterion FAILED (skip != fail). */
function componentPass(criteria: ScorecardCriterion[]): boolean {
  return !criteria.some(
    (c) => c.result === RowResult.Fail && GATING_SEVERITIES.has(c.severity),
  );
}

/**
 * GA — the component TERNARY verdict `fail ▸ incomplete ▸ pass`:
 *   fail        iff a CRIT/HIGH criterion FAILED.
 *   incomplete  iff (no CRIT/HIGH fail) AND a CRIT/HIGH criterion was INDETERMINATE.
 *   pass        otherwise.
 * The v1 audit path never emits `incomplete` rows ⇒ this returns pass/fail only
 * there (byte-compatible with `componentPass`).
 */
function componentVerdict(criteria: ScorecardCriterion[]): RunVerdictValue {
  const gatingFail = criteria.some(
    (c) => c.result === RowResult.Fail && GATING_SEVERITIES.has(c.severity),
  );
  if (gatingFail) return RunVerdict.Fail;
  const gatingIndeterminate = criteria.some(
    (c) => c.result === RowResult.Incomplete && GATING_SEVERITIES.has(c.severity),
  );
  return gatingIndeterminate ? RunVerdict.Incomplete : RunVerdict.Pass;
}

export function assembleScorecard(input: AssembleInput): Scorecard {
  const grouped = groupByComponent(input.rows);

  const gateComponents: GateComponent[] = grouped.map((g) => ({
    componentId: g.componentId,
    pass: componentPass(g.criteria),
    verdict: componentVerdict(g.criteria),
    criteria: g.criteria,
  }));

  // Totals across ALL criteria (both tracks).
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let critFail = 0;
  let highFail = 0;
  let incomplete = 0;
  for (const g of gateComponents) {
    for (const c of g.criteria) {
      if (c.result === RowResult.Pass) pass += 1;
      else if (c.result === RowResult.Fail) {
        fail += 1;
        if (c.severity === Severity.Crit) critFail += 1;
        else if (c.severity === Severity.High) highFail += 1;
      } else if (c.result === RowResult.Incomplete) incomplete += 1;
      else skip += 1;
    }
  }

  // GA — the ternary run verdict: fail ▸ incomplete ▸ pass.
  const runVerdict: RunVerdictValue = gateComponents.some(
    (g) => g.verdict === RunVerdict.Fail,
  )
    ? RunVerdict.Fail
    : gateComponents.some((g) => g.verdict === RunVerdict.Incomplete)
      ? RunVerdict.Incomplete
      : RunVerdict.Pass;
  // back-compat: runPass is now exactly `runVerdict === "pass"`. For the v1 audit
  // path (which never emits `incomplete` rows) this is byte-identical to the old
  // `every(component.pass)`; GA's only behavior delta is incomplete ⇒ runPass=false.
  const runPass = runVerdict === RunVerdict.Pass;

  // Coverage honesty (EV-OUT-002): graded-vs-total + skip-rate warning, derived
  // from the SAME totals the gate uses. Warning-only — `runPass` above is the
  // sole pass/fail authority; coverage NEVER mutates it.
  const coverage = computeCoverage(
    { pass, fail, skip },
    input.coverageOptions,
  );

  // Track-2 TREND: assembled SEPARATELY. varianceScore = count of dimensions
  // that diverged beyond target.
  const dimensions = input.trendDimensions ?? [];
  const varianceScore = dimensions.filter(
    (d) => d.divergence === "diverged",
  ).length;

  const scorecard: Scorecard = {
    subject: input.subject,
    runId: input.runId,
    generatedAt: input.generatedAt,
    coverage,
    gate: {
      runPass,
      runVerdict,
      components: gateComponents,
      totals: { pass, fail, skip, critFail, highFail, incomplete },
    },
    trend: {
      ...(input.trendRunPair ? { runPair: input.trendRunPair } : {}),
      dimensions,
      varianceScore,
    },
  };
  return scorecard;
}
