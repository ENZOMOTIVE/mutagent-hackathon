/**
 * scripts/edd/change-request.ts — F18 EDD CLOSURE (the spec↔impl↔eval triad).
 * ---------------------------------------------------------------------------
 * The Evaluator is JUDGE-ONLY (EV-051): it NEVER fixes the subject. To close the
 * EDD loop it instead REQUESTS the AI-Engineer (the *build ACTOR from the SPEC
 * stage) to amend the Agent / AgentSpec — wired over the `SendMessage` tool both
 * agents carry. This module is the structured contract for that hand-off:
 *
 *   evaluator  --(EddChangeRequest)-->  ai-engineer        (the failing cases + remedy target)
 *   ai-engineer --(ChangeRequestResponse)--> evaluator     (amended | rejected)
 *   evaluator  re-evaluates  →  loop until full green OR a bounded STOP.
 *
 * The contract is the SEAM: the evaluator emits a request (validated here), the
 * engineer consumes it (validated here), and the loop controller (also here)
 * decides — using ONLY observable state — whether to swing again or terminate.
 * The termination gate is afkloop-legal: full-green is the success terminator, and
 * three bounds (max-swings · max-wallclock · no-improvement-streak) guarantee the
 * loop is NEVER infinite.
 *
 * PURE — no clock / Math.random / network. The wall-clock bound is checked against
 * an INJECTED elapsed value (the caller measures time; this module only decides),
 * keeping the controller deterministic + unit-testable (C-PIN).
 */
import { Value } from "@sinclair/typebox/value";
import {
  ChangeRequestStatus,
  EddPhase,
  EddStopReason,
  EddChangeRequestSchema,
  ChangeRequestResponseSchema,
  RemedyTarget,
  type EddChangeRequestType,
  type ChangeRequestResponseType,
  type EddPhaseValue,
  type EddStopReasonValue,
  type RemedyTargetValue,
} from "./edd-types.ts";

// Re-export the Static types under their public names (edd-types declares the schemas).
export type { EddChangeRequestType, ChangeRequestResponseType };

// ── Validators (fail-loud over the SendMessage seam) ────────────────────────

/**
 * Validate an evaluator→engineer change-request. THROWS with the first TypeBox
 * error path on any violation — a malformed request must never cross the seam
 * silently (an ungrounded ask, a missing remedy target, etc. fail loud here).
 */
export function validateChangeRequest(req: unknown): EddChangeRequestType {
  if (!Value.Check(EddChangeRequestSchema, req)) {
    const first = [...Value.Errors(EddChangeRequestSchema, req)][0];
    throw new Error(
      `EddChangeRequest invalid${first ? ` at ${first.path}: ${first.message}` : ""}`,
    );
  }
  // Belt-and-braces: every failing case must be GROUNDED (≥1 ref). The schema
  // enforces minItems:1 on refs, but assert the intent explicitly for the seam.
  for (const fc of req.failingCases) {
    if (fc.refs.length === 0) {
      throw new Error(
        `EddChangeRequest invalid: failing case "${fc.caseId}" has no grounding refs (ungrounded ask — EV-051/GA-1)`,
      );
    }
  }
  return req;
}

/**
 * Validate an engineer→evaluator response. THROWS on a malformed reply. A
 * `rejected` status MUST carry a `note` (the reason) — enforced by the schema's
 * minLength on `note`; an `amended` status SHOULD echo `amendedTarget`.
 */
export function validateChangeResponse(res: unknown): ChangeRequestResponseType {
  if (!Value.Check(ChangeRequestResponseSchema, res)) {
    const first = [...Value.Errors(ChangeRequestResponseSchema, res)][0];
    throw new Error(
      `ChangeRequestResponse invalid${first ? ` at ${first.path}: ${first.message}` : ""}`,
    );
  }
  return res;
}

/**
 * Does this response warrant a re-eval? Only an `amended` response does — a
 * `rejected` one means the engineer declined (the evaluator must re-target or
 * escalate, NOT re-eval an unchanged subject). There is no "trust me, skip
 * re-eval" path: an amend ALWAYS triggers a fresh evaluation swing.
 */
export function reEvalWarranted(res: ChangeRequestResponseType): boolean {
  return res.status === ChangeRequestStatus.Amended;
}

// ── F18 loop control — the bounded EDD terminator ───────────────────────────

export interface EddLoopBudget {
  /** hard cap on evaluator→engineer→re-eval swings. */
  maxSwings: number;
  /** hard wall-clock budget in ms (checked against an injected elapsed). */
  maxWallclockMs: number;
  /** stop after this many consecutive swings with no measurable improvement. */
  noImprovementStreakLimit: number;
}

export const DEFAULT_EDD_LOOP_BUDGET: EddLoopBudget = {
  maxSwings: 6,
  maxWallclockMs: 30 * 60 * 1000, // 30 min
  noImprovementStreakLimit: 2,
};

/**
 * The observable loop state the controller reasons over. ALL fields are measured
 * by the caller (the evaluator parent session) and handed in — the controller is
 * a PURE decision function, so the same state always yields the same decision.
 */
export interface EddLoopState {
  /** the current EDD phase (variance vs accuracy vs build). */
  phase: EddPhaseValue;
  /** 1-based count of swings COMPLETED so far. */
  swing: number;
  /** F19 — is the per-case variance gate currently passing? */
  varianceStable: boolean;
  /** is accuracy ≥ target over the dataset? (meaningful only post-variance). */
  accuracyMet: boolean;
  /** measured elapsed wall-clock for the whole loop, ms (injected — not read here). */
  elapsedMs: number;
  /**
   * consecutive swings with no measurable improvement (the caller computes this
   * from a monotone progress metric — e.g. fewer flapping/failing cases). 0 ⇒
   * the last swing improved something.
   */
  noImprovementStreak: number;
}

export interface EddLoopDecision {
  /** true ⇒ terminate now; false ⇒ swing again. */
  done: boolean;
  /** WHY it stopped — set iff done; null while the loop should continue. */
  reason: EddStopReasonValue | null;
  /** the next phase to run (DONE/STOPPED when terminating). */
  nextPhase: EddPhaseValue;
  /** human one-liner — the convergence delta when bounded, the green when done. */
  detail: string;
}

/**
 * THE termination gate (afkloop-legal — observable + bounded + no infinite loop).
 *
 * Order of checks (success first, then the three bounds):
 *   1. FULL GREEN   — varianceStable AND accuracyMet ⇒ DONE (success).
 *   2. MAX SWINGS   — swing ≥ budget.maxSwings ⇒ STOP (report delta).
 *   3. MAX WALLCLOCK— elapsedMs ≥ budget.maxWallclockMs ⇒ STOP.
 *   4. NO-IMPROVE   — noImprovementStreak ≥ budget.noImprovementStreakLimit ⇒ STOP.
 *   else CONTINUE — keep swinging; the next phase is variance until it's stable,
 *   then accuracy (F19 ordering is preserved by `nextPhaseAfterVariance`, but the
 *   loop controller mirrors it: not-stable ⇒ variance, stable ⇒ accuracy).
 *
 * PURE: no clock read — `elapsedMs` is injected. Same state → same decision.
 */
export function decideEddLoop(
  state: EddLoopState,
  budget: EddLoopBudget = DEFAULT_EDD_LOOP_BUDGET,
): EddLoopDecision {
  // 1. SUCCESS terminator — full green.
  if (state.varianceStable && state.accuracyMet) {
    return {
      done: true,
      reason: EddStopReason.FullGreen,
      nextPhase: EddPhase.Done,
      detail: `full green after ${state.swing} swing(s): variance stable AND accuracy met`,
    };
  }
  // 2-4. Bounded non-convergence terminators (each reports the convergence delta).
  if (state.swing >= budget.maxSwings) {
    return stopped(
      EddStopReason.MaxSwings,
      `hit max swings (${state.swing}/${budget.maxSwings}); varianceStable=${state.varianceStable} accuracyMet=${state.accuracyMet}`,
    );
  }
  if (state.elapsedMs >= budget.maxWallclockMs) {
    return stopped(
      EddStopReason.MaxWallclock,
      `hit wall-clock budget (${state.elapsedMs}ms/${budget.maxWallclockMs}ms); varianceStable=${state.varianceStable} accuracyMet=${state.accuracyMet}`,
    );
  }
  if (state.noImprovementStreak >= budget.noImprovementStreakLimit) {
    return stopped(
      EddStopReason.NoImprovementStreak,
      `no improvement for ${state.noImprovementStreak} consecutive swing(s) (limit ${budget.noImprovementStreakLimit})`,
    );
  }
  // CONTINUE — preserve F19 ordering: stabilize variance before accuracy.
  const nextPhase = state.varianceStable ? EddPhase.Accuracy : EddPhase.Variance;
  return {
    done: false,
    reason: null,
    nextPhase,
    detail: `continue: next phase ${nextPhase} (swing ${state.swing}, variance ${state.varianceStable ? "stable" : "flapping"})`,
  };
}

function stopped(reason: EddStopReasonValue, detail: string): EddLoopDecision {
  return { done: true, reason, nextPhase: EddPhase.Stopped, detail };
}

/**
 * Build a well-formed change-request for the evaluator to SendMessage. Validates
 * before returning so a malformed request can never leave the evaluator. The
 * caller supplies the swing index + the grounded failing cases + the proposed
 * remedy + the target; this stamps `status: requested`.
 */
export function buildChangeRequest(input: {
  requestId: string;
  swing: number;
  subject: string;
  remedyTarget: RemedyTargetValue;
  failingCases: EddChangeRequestType["failingCases"];
  proposedRemedy: string;
}): EddChangeRequestType {
  const req: EddChangeRequestType = {
    requestId: input.requestId,
    swing: input.swing,
    subject: input.subject,
    remedyTarget: input.remedyTarget,
    failingCases: input.failingCases,
    proposedRemedy: input.proposedRemedy,
    status: ChangeRequestStatus.Requested,
  };
  return validateChangeRequest(req);
}

/** Convenience: the two remedy targets, re-exported for callers building requests. */
export { RemedyTarget };
