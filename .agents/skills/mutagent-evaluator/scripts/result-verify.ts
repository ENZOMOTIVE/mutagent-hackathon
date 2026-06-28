/**
 * scripts/result-verify.ts — GA-5 the result-verifier (reviewer ≠ judge · downgrade-only).
 * ---------------------------------------------------------------------------
 * The ⑤ VERIFY guard: an INDEPENDENT pass over a decided verdict that asks the
 * one question sourcing can't secure — does the CLAIM actually ENTAIL the
 * VERDICT, or is there an inferential leap (a hidden, ungrounded premise)?
 *
 * Two hard invariants (the contract):
 *   1. DOWNGRADE-ONLY — the verifier may only move a verdict DOWN the lattice
 *      `pass|fail → uncertain(blockedBy)`. It NEVER flips pass↔fail and NEVER
 *      promotes uncertain→pass/fail. `uncertain` is the floor (returned as-is).
 *   2. NEVER FIXES — it is a reviewer, not a judge and not a remediator (EV-051);
 *      it emits a (possibly-downgraded) verdict, nothing else.
 *
 * The deterministic skeleton here re-resolves the verdict's cited refs (GA-1) and
 * applies the independent reviewer's `entails` judgement (the LLM leaf). On a
 * dead ref OR an inferential leap → downgrade to `uncertain` + a typed
 * `blockedBy`. PURE — no clock/random/network.
 */
import {
  AssumptionKind,
  OutcomeVerdict,
  resolveRef,
  type AssumptionKindValue,
  type CriterionVerdict,
  type EvalTrace,
  type VerdictBlock,
} from "./contracts/eval-types.ts";

/** The independent reviewer's judgement (produced by the LLM verify leaf). */
export interface VerifierSignal {
  /** does the CLAIM entail the VERDICT? false ⇒ inferential leap ⇒ downgrade. */
  entails: boolean;
  /** when !entails: the residual (ungrounded) premise — becomes blockedBy.text. */
  leap?: string;
  /** the kind of the residual assumption (default `normative`). */
  leapKind?: AssumptionKindValue;
  /** the reviewer identity (≠ the judge that produced the verdict). */
  reviewerId?: string;
}

export interface VerifyResult {
  verdict: CriterionVerdict;
  downgraded: boolean;
  reason: string;
}

function downgrade(
  verdict: CriterionVerdict,
  blockedBy: VerdictBlock,
  reason: string,
): VerifyResult {
  return {
    verdict: {
      ...verdict,
      result: OutcomeVerdict.Uncertain,
      // confidence is meaningless on an abstain — zero it.
      confidence: 0,
      critique: `${verdict.critique}\n\n[VERIFY downgrade] ${reason}`,
      blockedBy,
    },
    downgraded: true,
    reason,
  };
}

/**
 * Verify ONE decided verdict against its situation + the independent reviewer
 * signal. DOWNGRADE-ONLY. PURE.
 *
 * @param verdict   the judge's decided verdict (pass | fail | uncertain).
 * @param situation the trace(s) the verdict was rendered over (for re-resolution).
 * @param signal    the independent reviewer's entailment judgement.
 */
export function verifyVerdict(
  verdict: CriterionVerdict,
  situation: EvalTrace[],
  signal: VerifierSignal,
): VerifyResult {
  // `uncertain` is the lattice floor — nothing to downgrade.
  if (verdict.result === OutcomeVerdict.Uncertain) {
    return { verdict, downgraded: false, reason: "already uncertain (lattice floor) — unchanged." };
  }

  // (a) re-resolve cited refs — a dead ref means the evidence no longer supports
  //     the claim ⇒ downgrade to uncertain(factual-intent).
  const refs = verdict.refs ?? [];
  if (refs.length > 0 && situation.length > 0) {
    const anyResolves = refs.some((r) => resolveRef(r, situation).resolved);
    if (!anyResolves) {
      return downgrade(
        verdict,
        {
          kind: AssumptionKind.FactualIntent,
          text: "cited evidence no longer re-resolves against the situation (dead ref).",
        },
        "VERIFY: none of the verdict's cited refs re-resolve — evidence does not support the claim.",
      );
    }
  }

  // (b) entailment — the master switch. claim true ≠ verdict true.
  if (!signal.entails) {
    return downgrade(
      verdict,
      {
        kind: signal.leapKind ?? AssumptionKind.Normative,
        text: signal.leap ?? "claim does not entail the verdict (residual ungrounded premise).",
      },
      `VERIFY (${signal.reviewerId ?? "reviewer"}): inferential leap — the claim does not ` +
        "entail the verdict; downgrading to indeterminate (not flipping).",
    );
  }

  // entails ∧ refs resolve → grounded; verdict stands (verifier never promotes).
  return { verdict, downgraded: false, reason: "VERIFY: claim entails verdict ∧ refs resolve — grounded." };
}

/** Batch verify — keyed by criterionId; verdicts with no signal default to
 *  `entails: true` (no reviewer objection ⇒ stands). DOWNGRADE-ONLY. PURE. */
export function verifyVerdicts(
  verdicts: CriterionVerdict[],
  situation: EvalTrace[],
  signals: Record<string, VerifierSignal>,
): VerifyResult[] {
  return verdicts.map((v) =>
    verifyVerdict(v, situation, signals[v.criterionId] ?? { entails: true }),
  );
}
