/**
 * scripts/edd/edd-types.ts
 * ---------------------------------------------------------------------------
 * Shared categorical constants + TypeBox contracts for the ADL IMPROVE stage —
 * the Eval-Driven-Development (EDD) loop (F18 closure + F19 variance-first).
 *
 * EDD is the ③ IMPROVE stage of the ADL: after the initial *build, the loop
 * drives spec ↔ impl ↔ eval to full green. Two findings live here:
 *
 *   F19 — VARIANCE-FIRST. The FIRST focus after the build is eliminating per-case
 *         VARIANCE (run each case ~N times; the verdict must stop flapping) BEFORE
 *         measuring accuracy over the full dataset. "Without stabilizing variance
 *         first, accuracy over big samples is wasted." (variance-gate.ts gates this.)
 *
 *   F18 — EDD CLOSURE. The evaluator (judge-only, EV-051 — it NEVER fixes) REQUESTS
 *         an AI-Engineer to amend the Agent / AgentSpec. The request carries the
 *         failing cases + the proposed remedy target (agentspec vs impl); the engineer
 *         amends; the suite re-runs. (change-request.ts is the structured contract.)
 *
 * This module is PURE — it holds only categorical constants + TypeBox shapes. No
 * clock / Math.random / network (coding-rules · C-PIN). The two consumer modules
 * (variance-gate.ts · change-request.ts) import from here.
 *
 * Kept in lockstep with schemas/edd-change-request.schema.yaml (the human shape).
 */
import { type Static, Type } from "@sinclair/typebox";

// ── EDD phase ordering (F19 — variance precedes accuracy) ───────────────────
/**
 * The ordered EDD phases. The controller enforces this order: a build is
 * followed by VARIANCE stabilization, and ACCURACY is only measured once
 * variance is stable. DONE is the terminal full-green state; STOPPED is a
 * bounded non-convergence exit (max-swings / wallclock / no-improvement).
 */
export const EddPhase = {
  /** the initial *build landed; the loop has not stabilized variance yet. */
  Build: "build",
  /** F19 — repeat-N the SAME cases; drive per-case verdict spread below threshold. */
  Variance: "variance",
  /** accuracy over the full dataset — ONLY entered once variance is stable. */
  Accuracy: "accuracy",
  /** terminal — variance-stable AND accuracy-met (full green). */
  Done: "done",
  /** terminal — bounded non-convergence (report the convergence delta). */
  Stopped: "stopped",
} as const;
export type EddPhaseValue = (typeof EddPhase)[keyof typeof EddPhase];

// ── F18 — remedy target (which artifact the engineer amends) ────────────────
/**
 * The remedy target the evaluator PROPOSES on a change-request. The evaluator
 * never fixes (EV-051) — it names WHERE the fix belongs and the engineer amends:
 *   - agentspec : the DEFINITION (system_prompt / jobs / sop / criteria). The
 *                 def→impl cascade means the engineer re-runs *build after editing.
 *   - impl      : the IMPLEMENTATION scaffold only (a build-faithfulness / wiring
 *                 defect that does NOT change the spec).
 */
export const RemedyTarget = {
  AgentSpec: "agentspec",
  Impl: "impl",
} as const;
export type RemedyTargetValue = (typeof RemedyTarget)[keyof typeof RemedyTarget];

// ── F18 — change-request lifecycle status ───────────────────────────────────
/**
 * The lifecycle of one change-request as it crosses the SendMessage seam. The
 * evaluator emits `requested`; the engineer transitions it to `amended`
 * (re-eval pending) or `rejected` (with a reason — e.g. the remedy target is
 * wrong, or the failing cases are not reproducible against the spec).
 */
export const ChangeRequestStatus = {
  Requested: "requested",
  Amended: "amended",
  Rejected: "rejected",
} as const;
export type ChangeRequestStatusValue =
  (typeof ChangeRequestStatus)[keyof typeof ChangeRequestStatus];

// ── F18 — why the EDD loop stopped (the bounded terminator) ─────────────────
/**
 * The observable, bounded reasons the EDD loop terminates. `full-green` is the
 * SUCCESS terminator (variance-stable AND accuracy-met). The other three are the
 * afkloop-legal bounds that prevent an infinite loop — each reports a convergence
 * delta. There is NO open-ended "keep going" terminator.
 */
export const EddStopReason = {
  /** SUCCESS — variance-stable AND accuracy ≥ target. */
  FullGreen: "full-green",
  /** bound — hit the max number of evaluator→engineer→re-eval swings. */
  MaxSwings: "max-swings",
  /** bound — hit the wall-clock budget. */
  MaxWallclock: "max-wallclock",
  /** bound — N consecutive swings with no measurable improvement. */
  NoImprovementStreak: "no-improvement-streak",
} as const;
export type EddStopReasonValue =
  (typeof EddStopReason)[keyof typeof EddStopReason];

// ── F19 — per-case variance observation (one case, repeat-N verdicts) ───────
/**
 * One eval case run repeat-N times. `verdicts` is the per-rerun OutcomeVerdict
 * string ("pass" | "fail" | "uncertain") so this contract stays decoupled from
 * the evaluate.ts numeric mapping (variance-gate.ts adapts it via evalScoreVariance).
 */
export const CaseVarianceObservationSchema = Type.Object(
  {
    caseId: Type.String({ minLength: 1 }),
    /** the criterion this spread is measured for (one case may span criteria). */
    criterionId: Type.String({ minLength: 1 }),
    /** the per-rerun verdicts; length === repeat-N. */
    verdicts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    /** OPTIONAL per-rerun ordered tool trajectories (drives trajectory spread). */
    trajectories: Type.Optional(Type.Array(Type.Array(Type.String()))),
  },
  { $id: "CaseVarianceObservation", additionalProperties: false },
);
export type CaseVarianceObservation = Static<typeof CaseVarianceObservationSchema>;

// ── F18 — a failing case bundled into a change-request ──────────────────────
/**
 * One failing (or chronically-uncertain) case the evaluator hands to the engineer.
 * Carries the criterion, the critique (verbatim from the verdict), and ≥1 structured
 * grounding ref {obs,path,value} — the SAME machine-checkable grounding the judge
 * already emitted (GA-1). A failing case with NO ref is a defect (ungrounded ask).
 */
export const FailingCaseRefSchema = Type.Object(
  {
    caseId: Type.String({ minLength: 1 }),
    criterionId: Type.String({ minLength: 1 }),
    /** verbatim critique from the verdict that flagged this case. */
    critique: Type.String({ minLength: 1 }),
    /** ≥1 structured grounding ref — the evidence the critique already cites. */
    refs: Type.Array(
      Type.Object(
        {
          obs: Type.String(),
          path: Type.String(),
          value: Type.String(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { $id: "FailingCaseRef", additionalProperties: false },
);
export type FailingCaseRef = Static<typeof FailingCaseRefSchema>;

// ── F18 — the evaluator → ai-engineer change-request (the SendMessage payload) ─
/**
 * The structured request the evaluator emits to the AI-Engineer over SendMessage.
 * It is a REQUEST, never a patch — the evaluator stays judge-only (EV-051). The
 * engineer consumes it, amends the named `remedyTarget`, and replies with a
 * ChangeRequestResponse. `swing` is the 1-based loop iteration (drives the bound).
 */
export const EddChangeRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    /** 1-based EDD swing index (the Nth evaluator→engineer→re-eval cycle). */
    swing: Type.Integer({ minimum: 1 }),
    subject: Type.String({ minLength: 1 }),
    /** WHERE the engineer should fix — the evaluator PROPOSES, never patches. */
    remedyTarget: Type.Union([
      Type.Literal(RemedyTarget.AgentSpec),
      Type.Literal(RemedyTarget.Impl),
    ]),
    /** the failing cases driving this request (≥1; each grounded). */
    failingCases: Type.Array(FailingCaseRefSchema, { minItems: 1 }),
    /** the proposed remedy in NL — a hypothesis for the engineer, not a mandate. */
    proposedRemedy: Type.String({ minLength: 1 }),
    status: Type.Literal(ChangeRequestStatus.Requested),
  },
  { $id: "EddChangeRequest", additionalProperties: false },
);
export type EddChangeRequest = Static<typeof EddChangeRequestSchema>;
/** Public alias used by change-request.ts (avoids shadowing the schema const). */
export type EddChangeRequestType = Static<typeof EddChangeRequestSchema>;

// ── F18 — the ai-engineer → evaluator response ──────────────────────────────
/**
 * The engineer's reply after consuming a request. `amended` ⇒ the named target was
 * edited (and, for an agentspec target, *build was re-run — def→impl cascade) and a
 * re-eval is now warranted; `rejected` ⇒ the engineer declined (wrong target, not
 * reproducible) WITH a reason. The loop controller reads `status` to decide the next
 * step. There is NO "fixed it, trust me, skip re-eval" path — re-eval always follows.
 */
export const ChangeRequestResponseSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal(ChangeRequestStatus.Amended),
      Type.Literal(ChangeRequestStatus.Rejected),
    ]),
    /** which artifact was actually amended (echoes the request's remedyTarget). */
    amendedTarget: Type.Optional(
      Type.Union([
        Type.Literal(RemedyTarget.AgentSpec),
        Type.Literal(RemedyTarget.Impl),
      ]),
    ),
    /** for an agentspec amend: was *build re-run to cascade def→impl? */
    rebuilt: Type.Optional(Type.Boolean()),
    /** human summary of the amendment OR the rejection reason (always present). */
    note: Type.String({ minLength: 1 }),
  },
  { $id: "ChangeRequestResponse", additionalProperties: false },
);
export type ChangeRequestResponse = Static<typeof ChangeRequestResponseSchema>;
/** Public alias used by change-request.ts (avoids shadowing the schema const). */
export type ChangeRequestResponseType = Static<typeof ChangeRequestResponseSchema>;
