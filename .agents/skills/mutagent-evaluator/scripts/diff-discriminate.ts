/**
 * scripts/diff-discriminate.ts — GA-11 observed-eligibility via the broken∧¬healthy diff.
 * ---------------------------------------------------------------------------
 * A criterion earns the `observed` grounding tier ONLY if it DISCRIMINATES: it
 * must fire on a BROKEN trace AND NOT fire on a HEALTHY companion trace. A check
 * that fires on both is not detecting THIS failure — it is noise (or garbage-in)
 * and must NOT be presented as an observed defect.
 *
 *   fires-on-broken ∧ ¬fires-on-healthy   → OBSERVED-eligible (discriminates)
 *   fires-on-broken ∧  fires-on-healthy   → DEMOTE → inferred (does not discriminate)
 *                                            · if FIXABLE infra → route→diagnostics
 *   ¬fires-on-broken                       → DEMOTE → inferred (no observed failure)
 *
 * GRANDFATHER (regression-safety rule #2): when there is NO healthy companion
 * trace, this NEVER hard-fails — it gracefully falls back to single-trace +
 * honest prevalence, keeps the `observed` tier, and TAGS the decision
 * `single-trace-fallback`. The diff is skipped, not enforced.
 *
 * PURE — a decision function over boolean fire-signals; no clock/random/network.
 * The actual "does it fire?" judgement is produced upstream (the judge/determiner
 * leaf, LLM); this module only DECIDES eligibility from those signals (code).
 */
import {
  CriterionFlag,
  Grounding,
  type GroundingValue,
  type MinedCriterion,
} from "./contracts/eval-types.ts";

/** The upstream fire-signals for one criterion (produced by the judge leaf). */
export interface CriterionFireSignals {
  criterionId: string;
  /** did the criterion fire (detect its failure) on the BROKEN trace? */
  firesOnBroken: boolean;
  /** did it fire on the HEALTHY companion? (ignored when `hasHealthy` is false) */
  firesOnHealthy: boolean;
  /** is a healthy companion trace available at all? false ⇒ graceful fallback. */
  hasHealthy: boolean;
}

export const DiffDecision = {
  /** discriminates → keep `observed`. */
  Observed: "observed-eligible",
  /** no healthy companion → keep `observed`, tagged single-trace. */
  SingleTraceFallback: "single-trace-fallback",
  /** fires on both / not on broken → demote to `inferred`. */
  DemoteInferred: "demote-inferred",
  /** fires on healthy too AND fixable infra → route to diagnostics (garbage-in). */
  RouteDiagnostics: "route-diagnostics",
} as const;
export type DiffDecisionValue = (typeof DiffDecision)[keyof typeof DiffDecision];

export interface DiffResult {
  criterionId: string;
  decision: DiffDecisionValue;
  /** the grounding the criterion should carry after the diff. */
  grounding: GroundingValue;
  /** true when the diff was skipped for lack of a healthy companion (tagged). */
  tagged: boolean;
  reason: string;
}

/**
 * Decide observed-eligibility for ONE criterion from its fire-signals. PURE.
 * `isFixable` lets a non-discriminating INFRA criterion route to diagnostics
 * (garbage-in) rather than merely demote.
 */
export function discriminate(
  signals: CriterionFireSignals,
  isFixable = false,
): DiffResult {
  const { criterionId, firesOnBroken, firesOnHealthy, hasHealthy } = signals;

  if (!hasHealthy) {
    return {
      criterionId,
      decision: DiffDecision.SingleTraceFallback,
      grounding: Grounding.Observed,
      tagged: true,
      reason:
        "no healthy companion trace — graceful single-trace fallback (diff skipped, " +
        "honest prevalence retained); observed tier kept, tagged single-trace.",
    };
  }
  if (!firesOnBroken) {
    return {
      criterionId,
      decision: DiffDecision.DemoteInferred,
      grounding: Grounding.Inferred,
      tagged: false,
      reason: "did not fire on the broken trace — no observed failure; demoted to inferred.",
    };
  }
  if (firesOnHealthy) {
    return isFixable
      ? {
          criterionId,
          decision: DiffDecision.RouteDiagnostics,
          grounding: Grounding.Inferred,
          tagged: false,
          reason:
            "fires on BOTH broken and healthy (does not discriminate) AND is fixable infra — " +
            "garbage-in; route to diagnostics rather than judge.",
        }
      : {
          criterionId,
          decision: DiffDecision.DemoteInferred,
          grounding: Grounding.Inferred,
          tagged: false,
          reason:
            "fires on BOTH broken and healthy — does not discriminate this failure; demoted to inferred.",
        };
  }
  return {
    criterionId,
    decision: DiffDecision.Observed,
    grounding: Grounding.Observed,
    tagged: false,
    reason: "fires on broken ∧ NOT on healthy — discriminates; observed-eligible.",
  };
}

/**
 * Apply diff-discrimination to a batch of mined criteria, demoting grounding +
 * tagging single-trace fallbacks. A criterion with NO matching fire-signal is
 * left untouched (the diff was not run for it). Returns a NEW array; inputs are
 * never mutated. PURE — same (criteria, signals) ⇒ identical output.
 *
 * When a criterion is demoted from `observed` → `inferred`, its evidence is
 * updated honestly (grounding + seen_in_traces) and the decision is recorded in
 * `discovery.reasoning` so the demotion is never silent (NO data loss — refs +
 * assumptions are preserved verbatim).
 */
export function applyDiffDiscrimination(
  criteria: MinedCriterion[],
  signals: CriterionFireSignals[],
): MinedCriterion[] {
  const byId = new Map(signals.map((s) => [s.criterionId, s]));
  return criteria.map((c) => {
    const sig = byId.get(c.id);
    if (sig === undefined) return c; // diff not run for this criterion
    if (c.discovery.evidence.grounding !== Grounding.Observed) return c; // only gate observed
    const isFixable = c.flag === CriterionFlag.Fixable;
    const res = discriminate(sig, isFixable);
    if (res.grounding === Grounding.Observed && !res.tagged) return c; // unchanged
    return {
      ...c,
      discovery: {
        ...c.discovery,
        evidence: {
          ...c.discovery.evidence,
          grounding: res.grounding,
          seen_in_traces:
            res.grounding === Grounding.Observed ? c.discovery.evidence.seen_in_traces : false,
        },
        reasoning: `${c.discovery.reasoning} | diff-discriminate: ${res.reason}`,
      },
    };
  });
}
