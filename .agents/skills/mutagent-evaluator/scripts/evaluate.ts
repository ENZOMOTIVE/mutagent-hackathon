/**
 * scripts/evaluate.ts — EV-048 `*evaluate` (GATE verdict + variance view).
 * ---------------------------------------------------------------------------
 * Runs the built suite vs a subject → per-criterion binary+confidence → a
 * severity-gated GATE verdict (binary) + the agent-variance view (EV-054).
 *
 *   GATE          — binary, severity-gated: a FAILING criterion whose severity
 *                   is in the gating set (default {CRIT, HIGH}) fails the gate.
 *                   MED/LOW failures are reported but do not gate.
 *   variance view — eval-SCORE variance across reruns (does the verdict flap?)
 *                   + TRAJECTORY variance (does the agent take different tool
 *                   paths across reruns?). A trustworthy eval is consistent
 *                   BEFORE it is accurate (variance control precedes accuracy).
 *
 * PURE rollup — no clock/random/network; same inputs → identical verdict.
 * Reuses the v1 Severity enum (same package, not sealed-sibling).
 */
import {
  OutcomeVerdict,
  RunVerdict,
  type CriterionVerdict,
  type OutcomeVerdictValue,
  type RunVerdictValue,
} from "./contracts/eval-types.ts";
import { Severity, type SeverityValue } from "./contracts/types.ts";
import {
  EMPTY_EXPECTED_FLOW,
  type ExpectedFlow,
  type ExpectedFlowEdge,
} from "./contracts/flow-graph.ts";

/** One criterion's single-run verdict plus its gating severity. */
export interface GradedCriterion {
  criterionId: string;
  severity: string;
  verdict: CriterionVerdict;
}

export interface GateInput {
  criteria: GradedCriterion[];
  /** failing criteria at these severities fail the gate (default CRIT+HIGH). */
  gatingSeverities?: string[];
}

export interface GateRef {
  criterionId: string;
  severity: string;
}

export interface GateResult {
  /** back-compat: true iff `runVerdict === "pass"` (no CRIT/HIGH fail OR indeterminate). */
  passed: boolean;
  /**
   * GA — the ternary RUN verdict `fail ▸ incomplete ▸ pass`:
   *   - fail        — ≥1 CRIT/HIGH criterion FAILED.
   *   - incomplete  — no CRIT/HIGH fail, but ≥1 CRIT/HIGH was INDETERMINATE
   *                   (`uncertain`). The latent-false-green killer — a run that
   *                   could not be certified is NOT a pass.
   *   - pass        — every CRIT/HIGH criterion passed.
   */
  runVerdict: RunVerdictValue;
  /** every failing criterion (any severity). */
  failedCriteria: GateRef[];
  /** the subset that actually GATED (FAILED + severity in the gating set). */
  gatedBy: GateRef[];
  /** GA — CRIT/HIGH criteria that were INDETERMINATE (drive `incomplete`). */
  indeterminateBy: GateRef[];
  total: number;
  passCount: number;
}

const DEFAULT_GATING: readonly SeverityValue[] = [Severity.Crit, Severity.High];

/**
 * Severity-gated TERNARY GATE (GA). A CRIT/HIGH FAIL fails the run; a CRIT/HIGH
 * INDETERMINATE (uncertain) — with no CRIT/HIGH fail — makes the run INCOMPLETE
 * (never a silent pass); else pass. `failedCriteria` keeps the legacy "any
 * non-pass at any severity" set for back-compat reporting. PURE.
 */
export function evaluateGate(input: GateInput): GateResult {
  const gating = new Set<string>(input.gatingSeverities ?? DEFAULT_GATING);
  const failedCriteria: GateRef[] = [];
  const gatedBy: GateRef[] = [];
  const indeterminateBy: GateRef[] = [];
  let passCount = 0;

  for (const c of input.criteria) {
    const result = c.verdict.result;
    if (result === OutcomeVerdict.Pass) {
      passCount += 1;
      continue;
    }
    const ref: GateRef = { criterionId: c.criterionId, severity: c.severity };
    if (result === OutcomeVerdict.Fail) {
      // a hard fail (legacy failedCriteria + the real gate).
      failedCriteria.push(ref);
      if (gating.has(c.severity)) gatedBy.push(ref);
    } else {
      // uncertain / indeterminate — counted in legacy failedCriteria, but it
      // drives INCOMPLETE (not fail) at gating severity.
      failedCriteria.push(ref);
      if (gating.has(c.severity)) indeterminateBy.push(ref);
    }
  }

  const runVerdict: RunVerdictValue =
    gatedBy.length > 0
      ? RunVerdict.Fail
      : indeterminateBy.length > 0
        ? RunVerdict.Incomplete
        : RunVerdict.Pass;

  return {
    passed: runVerdict === RunVerdict.Pass,
    runVerdict,
    failedCriteria,
    gatedBy,
    indeterminateBy,
    total: input.criteria.length,
    passCount,
  };
}

// ── Variance view (EV-054) ──────────────────────────────────────────────────

/** Map a verdict to a numeric score: pass=1, fail=0, uncertain=0.5. */
function scoreOf(v: OutcomeVerdictValue): number {
  if (v === OutcomeVerdict.Pass) return 1;
  if (v === OutcomeVerdict.Fail) return 0;
  return 0.5;
}

export interface ScoreVariance {
  mean: number;
  variance: number;
  /** consistent iff variance is exactly 0 (every rerun agreed). */
  consistent: boolean;
}

/** Population variance of the eval scores across reruns of one criterion. PURE. */
export function evalScoreVariance(results: OutcomeVerdictValue[]): ScoreVariance {
  if (results.length === 0) return { mean: 0, variance: 0, consistent: true };
  const scores = results.map(scoreOf);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, s) => a + (s - mean) * (s - mean), 0) / scores.length;
  return { mean, variance, consistent: variance === 0 };
}

export interface TrajectoryVariance {
  distinct: number;
  total: number;
  /** stable iff every rerun took the identical tool trajectory. */
  stable: boolean;
}

/** Distinct-trajectory count across reruns (a trajectory = ordered tool names). PURE. */
export function trajectoryVariance(trajectories: string[][]): TrajectoryVariance {
  const keys = trajectories.map((t) => t.join("␟")); // unit-separator join
  const distinct = new Set(keys).size;
  return {
    distinct,
    total: trajectories.length,
    stable: distinct <= 1,
  };
}

// ── rollupScorecard — the *evaluate output ──────────────────────────────────

export interface CriterionReruns {
  scores: OutcomeVerdictValue[];
  trajectories: string[][];
}

export interface ScorecardInput {
  criteria: GradedCriterion[];
  gatingSeverities?: string[];
  /** criterionId -> rerun observations (for the variance view). */
  reruns?: Record<string, CriterionReruns>;
}

export interface CriterionVarianceView {
  score: ScoreVariance;
  trajectory: TrajectoryVariance;
}

export interface Scorecard {
  gate: GateResult;
  variance: Record<string, CriterionVarianceView>;
}

/** Combine the severity-gated GATE with the per-criterion variance view. PURE. */
export function rollupScorecard(input: ScorecardInput): Scorecard {
  const gate = evaluateGate({
    criteria: input.criteria,
    ...(input.gatingSeverities !== undefined ? { gatingSeverities: input.gatingSeverities } : {}),
  });
  const variance: Record<string, CriterionVarianceView> = {};
  const reruns = input.reruns ?? {};
  for (const [criterionId, obs] of Object.entries(reruns)) {
    variance[criterionId] = {
      score: evalScoreVariance(obs.scores),
      trajectory: trajectoryVariance(obs.trajectories),
    };
  }
  return { gate, variance };
}

// ── EV-054 deepened: agent-appropriate variance (supersedes blind 15-dim) ─────
//
// For an AGENT, "variance" is not a fixed 15-dimension determinism scorecard — it
// is (a) does the eval VERDICT flap across reruns, (b) does the agent's
// TRAJECTORY flap in shape (tool path / turn count / sub-agent count), and
// (c) does the trajectory CONFORM to the subject's expected information-flow
// (EV-037). A trustworthy agent eval is consistent in all three BEFORE it is
// accurate. All PURE — no clock/random/network.

/** Spread of a list of integers (min/max/distinct) — turn/sub-agent counts. */
export interface IntSpread {
  min: number;
  max: number;
  distinct: number;
}

function intSpread(values: number[]): IntSpread {
  if (values.length === 0) return { min: 0, max: 0, distinct: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    distinct: new Set(values).size,
  };
}

/** Deepened trajectory variance: tool-sequence + turn-count + sub-agent-count. PURE. */
export interface TrajectoryShapeVariance {
  /** distinct ordered tool sequences across reruns. */
  distinctToolSeqs: number;
  /** spread of turn counts (trajectory lengths). */
  turnCounts: IntSpread;
  /** spread of sub-agent dispatch counts (tools ∈ dispatchToolNames). */
  subAgentCounts: IntSpread;
  /** stable iff every rerun took the identical tool trajectory. */
  stable: boolean;
}

/**
 * Trajectory shape variance across reruns. `dispatchToolNames` (subject-supplied,
 * EV-037) lets the sub-agent-count dimension be subject-agnostic — when omitted,
 * sub-agent counts are all 0. PURE.
 */
export function trajectoryShapeVariance(
  trajectories: string[][],
  dispatchToolNames: string[] = [],
): TrajectoryShapeVariance {
  const dispatch = new Set(dispatchToolNames);
  const distinctToolSeqs = new Set(trajectories.map((t) => t.join("␟"))).size;
  const turnCounts = intSpread(trajectories.map((t) => t.length));
  const subAgentCounts = intSpread(
    trajectories.map((t) => t.filter((name) => dispatch.has(name)).length),
  );
  return {
    distinctToolSeqs,
    turnCounts,
    subAgentCounts,
    stable: distinctToolSeqs <= 1,
  };
}

/** Trajectory-vs-expected-flow divergence (EV-054 · EV-037). */
export interface FlowDivergence {
  expected: number;
  covered: number;
  /** expected edges whose `fromTool → toTool` order is NOT respected in the path. */
  uncovered: ExpectedFlowEdge[];
  /** conformant iff every expected edge is covered (fromTool precedes toTool). */
  conformant: boolean;
}

/**
 * Does one observed trajectory (ordered tool names) respect the subject's
 * expected information-flow? An expected edge `fromTool → toTool` is COVERED when
 * `fromTool` occurs in the path and `toTool` occurs AFTER its first occurrence.
 * Uncovered edges = the agent skipped/reordered an expected handoff. PURE +
 * deterministic; SUBJECT-AGNOSTIC (the expected-flow is supplied).
 */
export function trajectoryFlowDivergence(
  trajectory: string[],
  expected: ExpectedFlow = EMPTY_EXPECTED_FLOW,
): FlowDivergence {
  const uncovered: ExpectedFlowEdge[] = [];
  let covered = 0;
  for (const edge of expected.edges) {
    const fromIdx = trajectory.indexOf(edge.fromTool);
    const toIdx = trajectory.indexOf(edge.toTool, fromIdx + 1);
    if (fromIdx !== -1 && toIdx !== -1) covered += 1;
    else uncovered.push(edge);
  }
  return {
    expected: expected.edges.length,
    covered,
    uncovered,
    conformant: uncovered.length === 0,
  };
}

/** The agent-appropriate variance view for one criterion across reruns. */
export interface AgentVarianceView {
  score: ScoreVariance;
  shape: TrajectoryShapeVariance;
  /** per-rerun trajectory conformance to the expected-flow. */
  flow: FlowDivergence[];
}

export interface AgentVarianceInput {
  scores: OutcomeVerdictValue[];
  trajectories: string[][];
  expectedFlow?: ExpectedFlow;
  dispatchToolNames?: string[];
}

/**
 * The deepened EV-054 view: score variance + trajectory-shape variance + per-rerun
 * expected-flow conformance. This is the agent-appropriate replacement for the
 * blind 15-dim determinism scorecard. PURE.
 */
export function agentVarianceView(input: AgentVarianceInput): AgentVarianceView {
  const expectedFlow = input.expectedFlow ?? EMPTY_EXPECTED_FLOW;
  const dispatch = input.dispatchToolNames ?? expectedFlow.dispatchToolNames;
  return {
    score: evalScoreVariance(input.scores),
    shape: trajectoryShapeVariance(input.trajectories, dispatch),
    flow: input.trajectories.map((t) => trajectoryFlowDivergence(t, expectedFlow)),
  };
}
