/**
 * scripts/edd/variance-gate.ts — F19 VARIANCE-FIRST gate.
 * ---------------------------------------------------------------------------
 * The EDD loop's FIRST focus after the build: eliminate per-case VARIANCE before
 * measuring accuracy. Run each case ~N times (default 5), report the spread, and
 * GATE — accuracy over the full dataset is only worth measuring once the verdict
 * has stopped flapping on the SAME cases. "Without stabilizing variance first,
 * accuracy over big samples is wasted."
 *
 * This module is ADDITIVE and INTEGRATION-FRIENDLY. It does NOT re-implement the
 * variance math — it consumes the already-shipped `evalScoreVariance` from
 * evaluate.ts (EV-054). It adds (a) the per-case gate decision, (b) the run-level
 * roll-up, and (c) the phase-ordering check that forbids entering ACCURACY until
 * VARIANCE is stable.
 *
 * PURE — no clock / Math.random / network (coding-rules · C-PIN). Same inputs →
 * same gate, always.
 */
import { evalScoreVariance, trajectoryVariance } from "../evaluate.ts";
import { OutcomeVerdict, type OutcomeVerdictValue } from "../contracts/eval-types.ts";
import {
  EddPhase,
  type CaseVarianceObservation,
  type EddPhaseValue,
} from "./edd-types.ts";

/** F19 default repeats — run each case 5× before measuring accuracy. */
export const DEFAULT_REPEAT_N = 5;

/**
 * Default per-case variance threshold. A case is variance-STABLE iff its eval-score
 * population variance is ≤ this. 0 = byte-identical verdict across reruns (the ideal);
 * the small default tolerance admits a single uncertain among passes without flapping
 * the gate. Override per subject via `VarianceGateConfig.maxVariance`.
 */
export const DEFAULT_MAX_VARIANCE = 0;

export interface VarianceGateConfig {
  /** required repeats per case (the gate is UNDER-SAMPLED below this). */
  repeatN: number;
  /** the per-case eval-score variance ceiling (≤ ⇒ stable). */
  maxVariance: number;
}

export const DEFAULT_VARIANCE_GATE_CONFIG: VarianceGateConfig = {
  repeatN: DEFAULT_REPEAT_N,
  maxVariance: DEFAULT_MAX_VARIANCE,
};

/** Map an OutcomeVerdict string to the canonical enum value (validates the set). */
function asVerdict(s: string): OutcomeVerdictValue {
  if (s === OutcomeVerdict.Pass || s === OutcomeVerdict.Fail || s === OutcomeVerdict.Uncertain) {
    return s;
  }
  // Fail-loud: an out-of-set verdict is a contract violation, not a silent pass.
  throw new Error(`variance-gate: out-of-set verdict "${s}" (expected pass|fail|uncertain)`);
}

export interface CaseVarianceResult {
  caseId: string;
  criterionId: string;
  /** the eval-score population variance across the reruns (0 = no flap). */
  variance: number;
  mean: number;
  /** distinct verdicts seen across reruns (1 = no flap). */
  distinctVerdicts: number;
  /** how many reruns were observed (vs the required repeatN). */
  observed: number;
  /** false ⇒ fewer reruns than repeatN: the gate is under-sampled for this case. */
  sufficientlySampled: boolean;
  /** distinct ordered tool trajectories (when trajectories supplied; else 0). */
  distinctTrajectories: number;
  /** true iff variance ≤ maxVariance AND sufficientlySampled. */
  stable: boolean;
}

/**
 * Evaluate ONE case's repeat-N spread against the threshold. PURE.
 * A case is stable iff it was sampled ≥ repeatN times AND its variance is within
 * the ceiling. Under-sampling NEVER reads as stable (you cannot certify a spread
 * you did not measure).
 */
export function gradeCaseVariance(
  obs: CaseVarianceObservation,
  config: VarianceGateConfig = DEFAULT_VARIANCE_GATE_CONFIG,
): CaseVarianceResult {
  const verdicts = obs.verdicts.map(asVerdict);
  const sv = evalScoreVariance(verdicts);
  const distinctVerdicts = new Set(verdicts).size;
  const observed = verdicts.length;
  const sufficientlySampled = observed >= config.repeatN;
  const distinctTrajectories =
    obs.trajectories !== undefined ? trajectoryVariance(obs.trajectories).distinct : 0;
  const withinThreshold = sv.variance <= config.maxVariance;
  return {
    caseId: obs.caseId,
    criterionId: obs.criterionId,
    variance: sv.variance,
    mean: sv.mean,
    distinctVerdicts,
    observed,
    sufficientlySampled,
    distinctTrajectories,
    stable: withinThreshold && sufficientlySampled,
  };
}

export interface VarianceGateResult {
  /** the per-case grades (sorted by caseId then criterionId for C-PIN stability). */
  cases: CaseVarianceResult[];
  /** count of cases whose variance exceeds the ceiling. */
  flapping: number;
  /** count of cases sampled below repeatN. */
  underSampled: number;
  /** the worst (highest) per-case variance observed. */
  maxVariance: number;
  /**
   * THE GATE: true iff EVERY case is variance-stable (within threshold AND
   * sufficiently sampled). The accuracy phase MUST NOT be entered until this
   * is true (F19). A run with zero cases is NOT passed (nothing was measured).
   */
  passed: boolean;
}

/**
 * Roll up the per-case grades into the run-level variance gate. PURE +
 * deterministic: the case list is sorted so the artifact is byte-identical
 * across reruns (C-PIN). An empty case set fails the gate (you cannot certify
 * stability you never measured).
 */
export function evaluateVarianceGate(
  observations: CaseVarianceObservation[],
  config: VarianceGateConfig = DEFAULT_VARIANCE_GATE_CONFIG,
): VarianceGateResult {
  const cases = observations
    .map((o) => gradeCaseVariance(o, config))
    .sort((a, b) =>
      a.caseId === b.caseId
        ? a.criterionId.localeCompare(b.criterionId)
        : a.caseId.localeCompare(b.caseId),
    );
  const flapping = cases.filter((c) => c.variance > config.maxVariance).length;
  const underSampled = cases.filter((c) => !c.sufficientlySampled).length;
  const maxVariance = cases.reduce((m, c) => Math.max(m, c.variance), 0);
  const passed = cases.length > 0 && cases.every((c) => c.stable);
  return { cases, flapping, underSampled, maxVariance, passed };
}

/**
 * F19 phase-ordering guard. Given the current phase + the variance gate result,
 * decide whether the loop MAY advance to the accuracy phase. This encodes the
 * hard ordering: VARIANCE must pass BEFORE ACCURACY is entered.
 *
 * Returns the NEXT phase. PURE — a decision function, no side effects.
 *   - from `build`/`variance`: advance to `accuracy` ONLY if the gate passed;
 *     otherwise stay in `variance` (keep stabilizing).
 *   - from any other phase: returned unchanged (this guard owns only the
 *     variance→accuracy transition; DONE/STOPPED are owned by the loop controller).
 */
export function nextPhaseAfterVariance(
  current: EddPhaseValue,
  gate: VarianceGateResult,
): EddPhaseValue {
  if (current === EddPhase.Build || current === EddPhase.Variance) {
    return gate.passed ? EddPhase.Accuracy : EddPhase.Variance;
  }
  return current;
}

/**
 * Hard assertion for callers that must NOT proceed to accuracy with a flapping
 * suite. THROWS when accuracy is attempted before variance is stable (F19 — the
 * "accuracy over big samples is wasted" guard). Use at the accuracy-run entry.
 */
export function assertVarianceStableBeforeAccuracy(gate: VarianceGateResult): void {
  if (!gate.passed) {
    const detail =
      gate.cases.length === 0
        ? "no cases measured"
        : `${gate.flapping} flapping, ${gate.underSampled} under-sampled (maxVariance=${gate.maxVariance})`;
    throw new Error(
      `variance-gate (F19): refusing to measure accuracy before variance is stable — ${detail}. ` +
        `Stabilize per-case variance first; accuracy over big samples is wasted otherwise.`,
    );
  }
}
