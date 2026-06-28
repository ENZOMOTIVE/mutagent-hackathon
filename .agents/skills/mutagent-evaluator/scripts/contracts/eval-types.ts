/**
 * scripts/contracts/eval-types.ts
 * ---------------------------------------------------------------------------
 * Canonical contracts for the W1 eval-DEVELOPMENT engine (EV-041/042/043/048 +
 * 049/050/051/052). This is a SEPARATE surface from the v1 static-auditor
 * contracts in `contracts/types.ts` (EV-REQ-001..027) — the auditor is a
 * different product (the `*audit` surface); the W1 engine is the new
 * eval-development capability. Keeping them in distinct files means the v1
 * audit contracts stay frozen while the eval engine grows.
 *
 * Design invariants (mirror the orchestrator's pure-core style):
 *   - Pure data shapes + categorical constants (no magic strings).
 *   - No clock / random / network anywhere a core consumes these.
 *   - The live LLM judge is reached only via a `JudgeInvoke` DI seam; these
 *     types never bind a provider SDK.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CodeEvalSpec } from "../code-eval.ts";

// ── Trace shapes (in-package; NOT importing a platform SDK type) ─────────────
//
// A minimal, platform-agnostic view of one Langfuse-style trace record: enough
// for the determiner / profiler / sampler to deep-read. We deliberately keep
// `input`/`output`/observation `output` loosely typed (`unknown`) — real
// exports carry arbitrary nested payloads; the cores narrow only the fields
// they actually read.

/** One observation (span) inside a trace. `type === "TOOL"` marks a tool call. */
export interface TraceObservation {
  type: string;
  name?: string;
  output?: unknown;
  input?: unknown;
}

/** A single trace record (one agent session). */
export interface EvalTrace {
  id: string;
  name?: string;
  input?: { prompt?: string } & Record<string, unknown>;
  output?: { response?: string; steps?: number } & Record<string, unknown>;
  observations: TraceObservation[];
  /** Langfuse scores — empty on the sample export (unlabeled → determiner owns it). */
  scores?: unknown[];
  /** Langfuse tags — empty on the sample export. */
  tags?: string[];
  latencyMs?: number;
  costUsd?: number;
  /**
   * §9.4.2 node 1 (EXAMINE fidelity gate) — an EXPLICIT truncation marker the
   * INGESTION layer sets when the source platform recorded the session as
   * cut-off / unterminated (e.g. a Langfuse/OTel root span that never closed, an
   * errored run with no terminal event). When `true`, the deterministic
   * pre-judge fidelity gate (`assessTraceFidelity`) flags the trajectory
   * INCOMPLETE and it is NEVER dispatched the full criteria walk — a synthesized
   * INCOMPLETE verdict is emitted instead (never a fabricated pass/fail from a
   * partial trace). OPTIONAL/additive: absent ⇒ the trace is judged normally.
   */
  incomplete?: boolean;
  /** the human-readable reason the trace was marked incomplete (rides into the gate). */
  incompleteReason?: string;
}

// ── Subject vocabulary (EV-002 zero-subject-logic / EV-049 behavior-in-profile)
//
// The engine holds the CONCEPTS (an event has a kind · some tools are recovery
// reactions · there is a primary send action · a guard may carry a counter) but
// NEVER the subject-specific NAMES. Those all live HERE, injected via the subject
// profile (`profile-subject.ts` populates them). The determiner reads the vocab
// off the injected profile — it has zero module-level subject constants.
//
// `UNCLASSIFIED_EVENT` is the ENGINE's generic sentinel for "matched no tag rule"
// — it is NOT subject vocabulary (it names no subject concept), so it stays in
// the engine.
export const UNCLASSIFIED_EVENT = "other";

/**
 * One tag→event-kind classification rule. `tag` is the opening-tag stem to look
 * for in a trace prompt (matched as `<{tag}`, case-insensitive — a prefix match,
 * so the stem `opportunity` also catches `<opportunity_update`). `kind` is the
 * label assigned on a match. Rules are evaluated in order; first match wins.
 */
export interface EventTagRule {
  kind: string;
  tag: string;
}

/**
 * The SUBJECT-SPECIFIC vocabulary the success/failure determiner needs. Produced
 * by `profileSubject` (EV-049) and carried on the `SubjectProfile`; the engine
 * reads it from the injected profile, never from a module constant.
 */
export interface SubjectVocab {
  /** tool names whose presence after a failed send counts as a recovery reaction. */
  recoveryTools: string[];
  /** ordered tag→kind rules; first match wins, else `UNCLASSIFIED_EVENT`. */
  eventTags: EventTagRule[];
  /** the primary outbound action tool name (e.g. the subject's "send" tool). */
  sendTool: string;
  /**
   * attribute name carrying a guard's consecutive-action count (parsed as
   * `{attr}="N"`); `null` when the subject has no such guard.
   */
  guardCounterAttr: string | null;
}

// ── Outcome verdict (EV-042) ────────────────────────────────────────────────
export const OutcomeVerdict = {
  Pass: "pass",
  Fail: "fail",
  /** The determiner could not decide with confidence (drives uncertainty
   *  sampling downstream, EV-052). NEVER silently coerced to pass/fail.
   *  GA: also the canonical ADJUDICATE abstain state — an `uncertain` verdict
   *  carrying a `blockedBy` payload IS the grounded-adjudication INDETERMINATE
   *  (GA-4 reuses this enum rather than adding a 4th value, so the ~17 existing
   *  verdict consumers compile unchanged). */
  Uncertain: "uncertain",
} as const;
export type OutcomeVerdictValue =
  (typeof OutcomeVerdict)[keyof typeof OutcomeVerdict];

// ── Run-level verdict lattice (GA · the ternary gate) ────────────────────────
/**
 * GA: the RUN-level verdict is a tri-state lattice `fail ▸ incomplete ▸ pass`
 * (assemble-scorecard / evaluate.ts gate). A run is `incomplete` (NOT a false
 * green) when a CRIT/HIGH criterion adjudicated `uncertain`/indeterminate but no
 * CRIT/HIGH criterion outright failed — the latent false-green killer. This is a
 * RUN-level rollup state, distinct from the per-criterion `OutcomeVerdict`.
 */
export const RunVerdict = {
  Pass: "pass",
  /** ≥1 CRIT/HIGH criterion failed. */
  Fail: "fail",
  /** no CRIT/HIGH fail, but ≥1 CRIT/HIGH indeterminate — gate cannot certify. */
  Incomplete: "incomplete",
} as const;
export type RunVerdictValue = (typeof RunVerdict)[keyof typeof RunVerdict];

// ── GA assumption kinds (GA-3 typed assumptions) ─────────────────────────────
/**
 * GA-3: the TYPE of an assumption decides where its lifecycle routes when it
 * blocks a verdict (the `blockedBy.kind`): `factual-intent` → re-ground from the
 * trace (calibrate) · `normative` → operator ratification · `scope` → re-scope /
 * skip the criterion for this situation.
 */
export const AssumptionKind = {
  /** a presumed FACT about intent/world the trace did not establish. */
  FactualIntent: "factual-intent",
  /** a value/standard call (what SHOULD count as good) — operator-owned. */
  Normative: "normative",
  /** whether the criterion even applies to this route/situation. */
  Scope: "scope",
} as const;
export type AssumptionKindValue =
  (typeof AssumptionKind)[keyof typeof AssumptionKind];

/**
 * Deterministic signals extracted from a trace. These are FED to the judge;
 * they are NOT the verdict. Critically, `toolCount` is a signal only — the
 * determiner must never use "called a tool" as a success proxy (sample's
 * zero-tool guard-holds are correct restraint = SUCCESS).
 */
export interface OutcomeSignals {
  /** the classified event kind (from `vocab.eventTags`), else `UNCLASSIFIED_EVENT`. */
  eventKind: string;
  toolCount: number;
  /**
   * true=≥1 send observed · false=a KNOWN no-send (the send tool IS identified,
   * but the trace called it zero times) · null=UNKNOWN (the subject's send tool
   * is unset/uninferred, EV-049 — we CANNOT know whether it sent, so we honestly
   * report UNKNOWN rather than a false `false`). HINT only — decides nothing.
   */
  sentMessage: boolean | null;
  /** true=at least one send succeeded · false=all sends failed · null=no send/unknown. */
  sendSucceeded: boolean | null;
  /** consecutive_outbound from an outbound_guard event, else null. */
  guardConsecutive: number | null;
  /** a recovery tool (retry/escalation) is present after a failed send. */
  recoveryPresent: boolean;
}

/** A judge's critique-before-verdict structured answer. */
export interface CritiqueVerdict {
  /** The reasoning — MUST precede the verdict (parse rejects a bare verdict). */
  critique: string;
  result: OutcomeVerdictValue | "pass" | "fail";
  /** 0..1 self-reported confidence. */
  confidence: number;
}

/** The determiner's output for one trace. */
export interface OutcomeResult {
  traceId: string;
  reached: OutcomeVerdictValue;
  confidence: number;
  rationale: string;
  signals: OutcomeSignals;
}

// ── Discovered criteria (EV-041) ────────────────────────────────────────────
export const CriterionFlag = {
  /** Build a judge / code-check for this — a genuine behavioral eval. */
  EvalWorthy: "eval-worthy",
  /** Infra / dependency failure — route to diagnostics, do NOT judge the model. */
  Fixable: "fixable",
} as const;
export type CriterionFlagValue =
  (typeof CriterionFlag)[keyof typeof CriterionFlag];

export const JudgeKind = {
  /** Subjective behavioral judgment → LLM judge. */
  Llm: "llm-judge",
  /** Objective check over tool outputs → deterministic code. */
  Code: "code-based",
  /** Code detects, judge confirms. */
  Hybrid: "hybrid",
} as const;
export type JudgeKindValue = (typeof JudgeKind)[keyof typeof JudgeKind];

/** One discovered BINARY ACTIONABLE eval criterion (the output of `*discover`). */
export interface DiscoveredCriterion {
  id: string;
  /** Pass = … (binary statement). */
  statement: string;
  /** what the judge/check must be fed. */
  judgeInputs: string[];
  judgeKind: JudgeKindValue;
  flag: CriterionFlagValue;
  /** the ✓/✗ label evidence count that surfaced this category. */
  supportCount: number;
}

// ── Judge spec + verdict (EV-043 / EV-048) ──────────────────────────────────
/** A built judge spec: one binary+confidence judge for one criterion. */
export interface JudgeSpec {
  criterionId: string;
  statement: string;
  passDefinition: string;
  failDefinition: string;
  /** few-shot exemplars — drawn from the TRAIN split ONLY (never dev/test). */
  fewShot: JudgeExemplar[];
  judgeKind: JudgeKindValue;
}

export interface JudgeExemplar {
  traceId: string;
  label: OutcomeVerdictValue;
  why: string;
}

/**
 * GA-4: the assumption-blocked payload carried by an `uncertain`/indeterminate
 * verdict. `kind` routes the calibration loop (factual→re-ground · normative→
 * operator · scope→re-scope). PRESENT iff the verdict is indeterminate.
 */
export interface VerdictBlock {
  kind: AssumptionKindValue;
  /** the unbound term / ungroundable premise / residual leap that blocked. */
  text: string;
}

/**
 * A judge verdict for one (criterion × subject-trace).
 *
 * GA additive fields (all OPTIONAL — legacy verdicts compile + flow unchanged;
 * NO silent drop downstream, every stage must preserve them):
 *   - `refs`       — the field-level resolvable evidence the claim cites (GA-1).
 *   - `assumptions`— typed assumptions the judge surfaced (GA-3).
 *   - `blockedBy`  — set iff `result === uncertain` AND the abstain is assumption
 *                    -driven; makes the indeterminate routable (GA-4).
 */
export interface CriterionVerdict {
  criterionId: string;
  traceId: string;
  result: OutcomeVerdictValue;
  confidence: number;
  critique: string;
  refs?: DiscoveryRef[];
  assumptions?: DiscoveryAssumption[];
  blockedBy?: VerdictBlock;
  /**
   * §9.4.2 node 7 (T3) — the AUDITABLE record of the INDEPENDENT (2nd-judge)
   * verification pass over a GATING fail. PRESENT iff a gating fail was put
   * through `#mode-verify` (reviewer ≠ the deciding judge). `upheld:false` means
   * the fail was REFUTED → downgraded to `uncertain` (the run rolls up to
   * INCOMPLETE); `upheld:true` means the second judge confirmed the fail STANDS.
   * Persisted so the report + on-disk artifact show that a second judge ran and
   * what it concluded (not just "eligible for"). NO silent drop downstream.
   */
  independentVerify?: IndependentVerifyRecord;
}

/**
 * §9.4.2 node 7 (T3) — the auditable second-judge verification record. Emitted
 * for every GATING (CRIT/HIGH) fail that went through the INDEPENDENT verifier
 * (`#mode-verify`, reviewer ≠ the deciding judge). It is the visible, persisted
 * proof that the refutation pass actually ran — distinct from the self-verify
 * step the deciding judge does inline.
 */
export interface IndependentVerifyRecord {
  /** the criterion this verification pass reviewed (set on the result-level ledger). */
  criterionId?: string;
  /** the contract guarantee: this review came from a DIFFERENT judge identity. */
  byDifferentJudge: true;
  /** true = the second judge CONFIRMED the fail (stands); false = REFUTED (downgraded). */
  upheld: boolean;
  /** the second judge's reasoning (entailment held / inferential leap / dead ref). */
  reason: string;
  /** the independent reviewer's identity (≠ the deciding judge). */
  reviewerId?: string;
  /** when refuted: the kind of the residual ungrounded premise (calibration routing). */
  leapKind?: AssumptionKindValue;
}

/**
 * UI-12-A (GA-1 grounding readiness) — the MACHINE-CHECKABLE grounding-capture
 * health of a batch of folded verdicts.
 *
 * The denominator is the DECIDED verdicts (pass|fail) — the only verdicts a GA-1
 * `refs[]` is REQUIRED for. An `uncertain` abstain legitimately carries NO ref
 * (it carries `blockedBy`/`assumptions` instead) and is `na` for grounding, NOT
 * ungrounded — counting abstains/bare-absences in the denominator is exactly what
 * produced the false 0% the UI-12 audit caught (52/92 critiques cited observed
 * strings, but 0/92 verdicts emitted structured `refs`, so `groundedPct` read 0%).
 *
 * `warning` is SET (loud) iff there ARE decided verdicts yet ZERO carry a ref —
 * the silent-capture regression. ADVISORY by contract: the readiness assert never
 * hard-fails the run; it surfaces the regression so it is caught, not hidden.
 */
export interface GroundingReadiness {
  /** pass|fail verdicts — the grounding-applicable denominator. */
  decidedCount: number;
  /** decided verdicts carrying ≥1 structured `refs[]`. */
  groundedCount: number;
  /** `uncertain` (abstain) verdicts — `na` for grounding (carry `blockedBy`, not refs). */
  abstainedCount: number;
  /** `groundedCount / decidedCount` as a %; 100 (na) when there are no decided verdicts. */
  groundedPctOfDecided: number;
  /** criterionIds of DECIDED verdicts missing a ref (the audit surface). */
  ungroundedDecided: string[];
  /** LOUD flag — set iff `decidedCount > 0 && groundedCount === 0`. */
  warning?: string;
}

// ── Substrate (EV-050) ──────────────────────────────────────────────────────
export const Substrate = {
  /**
   * DEFAULT: Claude Code agent-dispatch. Verdicts are produced by parent-session-
   * dispatched eval-judge / error-analyst leaf subagents reasoning on the HOST
   * runtime (diagnostics-style mass-dispatch) and read back from verdict FILES —
   * the default path calls NO provider SDK. See scripts/agent-dispatch.ts +
   * references/workflows/orchestrator-protocol.md.
   */
  AgentDispatch: "agent-dispatch",
  /**
   * OPTIONAL: the evaluator's own in-house AI-SDK judge (google-genai shape).
   * Kept (not deleted) but DEMOTED from default — for the CI / code-based export
   * path where a provider call is wanted instead of host-runtime dispatch.
   */
  InHouse: "in-house",
  /** Export to the user's eval framework (Vitest/promptfoo/Braintrust/…). */
  UserFramework: "user-framework",
  /** Deterministic code checks (objective criteria — no LLM). */
  CodeBased: "code-based",
} as const;
export type SubstrateValue = (typeof Substrate)[keyof typeof Substrate];

// ── TypeBox guard for a discovered criterion (closed object) ────────────────
export const DiscoveredCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    statement: Type.String({ minLength: 1 }),
    judgeInputs: Type.Array(Type.String({ minLength: 1 })),
    judgeKind: Type.Union([
      Type.Literal(JudgeKind.Llm),
      Type.Literal(JudgeKind.Code),
      Type.Literal(JudgeKind.Hybrid),
    ]),
    flag: Type.Union([
      Type.Literal(CriterionFlag.EvalWorthy),
      Type.Literal(CriterionFlag.Fixable),
    ]),
    supportCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type DiscoveredCriterionStatic = Static<typeof DiscoveredCriterionSchema>;

// ── TypeBox guard for the subject vocabulary (EV-002 / EV-049) ───────────────
// Data-type enforcement is the script's legit job (handover): an AUTHORED vocab
// (or one auto-generated by the profiler) is validated against this closed shape
// before the engine trusts it. Strings only — the engine never executes the
// vocab, it matches against it.
export const EventTagRuleSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    tag: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const SubjectVocabSchema = Type.Object(
  {
    recoveryTools: Type.Array(Type.String({ minLength: 1 })),
    eventTags: Type.Array(EventTagRuleSchema),
    sendTool: Type.String(),
    guardCounterAttr: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SubjectVocabStatic = Static<typeof SubjectVocabSchema>;

/**
 * Validate + narrow an unknown value to `SubjectVocab` (guarded-parse style,
 * mirroring the orchestrator's contract parsers). THROWS with the first schema
 * error when the value does not match — a malformed authored/loaded vocab must
 * never silently reach the determiner.
 */
export function parseSubjectVocab(value: unknown): SubjectVocab {
  if (!Value.Check(SubjectVocabSchema, value)) {
    const first = [...Value.Errors(SubjectVocabSchema, value)][0];
    const where = first?.path ?? "(root)";
    const msg = first?.message ?? "does not match SubjectVocab";
    throw new Error(`parseSubjectVocab: invalid subject vocab at ${where}: ${msg}`);
  }
  return value;
}

// ════════════════════════════════════════════════════════════════════════════
// §5b unified metric type-system + §5c discovery-rationale (P2 / P2b)
// ────────────────────────────────────────────────────────────────────────────
// ADDITIVE EXTENSION — a `MinedCriterion` is a `DiscoveredCriterion` PLUS the
// unified metric metadata (§5b) + an evidence-first discovery-rationale block
// (§5c, DR-2). It is a SUBTYPE so the base `DiscoveredCriterion` (and its six
// existing literal constructors across build-evals / run-pipeline / self-audit
// + tests) stay byte-stable — the discover output carries the full field set
// without forcing every consumer to change (P1-style zero-regression contract).
// ════════════════════════════════════════════════════════════════════════════

/** §5b `type.generality` — does the metric need the subject profile? */
export const Generality = {
  /** subject-AGNOSTIC; reusable on ANY generation pipeline (well-formedness). */
  GeneralStructural: "general-structural",
  /** subject-profile-DERIVED; needs the subject's intent/brand/facts. */
  SpecificSemantic: "specific-semantic",
} as const;
export type GeneralityValue = (typeof Generality)[keyof typeof Generality];

/** §5b `type.dimension` — the existing MECE R1/R2/R3 axis. */
export const MetricDimension = {
  OperationCorrectness: "operation-correctness",
  DataCorrectness: "data-correctness",
  OperationalDeviation: "operational-deviation",
} as const;
export type MetricDimensionValue =
  (typeof MetricDimension)[keyof typeof MetricDimension];

/** §5b `type.level` — the input-vs-output axis. */
export const MetricLevel = {
  Context: "context",
  Output: "output",
  CrossStage: "cross-stage",
} as const;
export type MetricLevelValue = (typeof MetricLevel)[keyof typeof MetricLevel];

/**
 * §5b `type.check_method` — the code-vs-judge ROUTER (SF-2 / DEC-16). The
 * load-bearing field that drives P3 (code-track). The 3-value router shape:
 * `deterministic` (code track) · `llm-judge` (judge track) · `hybrid` (code
 * pre-filter + judge). `substrate` is DERIVED from this. NOTE: PRD §5b lists a
 * finer 6-value taxonomy (deterministic-script | typebox-schema | gate |
 * trace-cross-ref | trajectory-diff | llm-judge); the 3-value router is the part
 * P3 needs — the finer split is a deferred refinement (this is additive only;
 * the code-track itself is NOT implemented here).
 */
// PRD §5b reconciliation: 3-value router load-bearing (SF-2/DEC-16); finer split deferred
export const CheckMethod = {
  Deterministic: "deterministic",
  LlmJudge: "llm-judge",
  Hybrid: "hybrid",
} as const;
export type CheckMethodValue = (typeof CheckMethod)[keyof typeof CheckMethod];

/** §5c `evidence.grounding` — the "seen in traces?" answer; the honesty cut. */
export const Grounding = {
  /** a failure was ACTUALLY seen in traces (cites refs + k/n prevalence). */
  Observed: "observed",
  /** a good-practice guard with no observed failure yet. */
  Inferred: "inferred",
  /** a hypothesis awaiting evidence (the weakest tier). */
  HypothesisPending: "hypothesis-pending",
} as const;
export type GroundingValue = (typeof Grounding)[keyof typeof Grounding];

/** §5c `assumptions[].status`. GA-3 adds `eliminated` (the calibration-loop
 *  terminal state: the assumption was disproven / retired, not merely verified). */
export const AssumptionStatus = {
  Verified: "verified",
  Unverified: "unverified",
  Hypothesis: "hypothesis",
  /** GA-3: the assumption was eliminated by the calibration loop (disproven or
   *  retired). A criterion whose blocking assumption is eliminated is re-adjudicable. */
  Eliminated: "eliminated",
} as const;
export type AssumptionStatusValue =
  (typeof AssumptionStatus)[keyof typeof AssumptionStatus];

/** §5b `severity` — by variance impact; CRIT/HIGH gate. */
export const Severity = {
  Crit: "CRIT",
  High: "HIGH",
  Med: "MED",
  Low: "LOW",
} as const;
export type SeverityValue = (typeof Severity)[keyof typeof Severity];

/** §5c `expected_impact.confidence`. */
export const Confidence = {
  High: "high",
  Med: "med",
  Low: "low",
} as const;
export type ConfidenceValue = (typeof Confidence)[keyof typeof Confidence];

/** The substrate a metric runs on — DERIVED from `check_method`. */
export const MetricSubstrate = {
  Code: "code",
  Judge: "judge",
} as const;
export type MetricSubstrateValue =
  (typeof MetricSubstrate)[keyof typeof MetricSubstrate];

/** §5b — the unified metric metadata carried by every mined criterion. */
export interface MetricMetadata {
  generality: GeneralityValue;
  dimension: MetricDimensionValue;
  level: MetricLevelValue;
  /** the code-vs-judge router (SF-2). */
  check_method: CheckMethodValue;
  /** DERIVED from check_method (kept explicit for the reader). */
  substrate: MetricSubstrateValue;
  /** `[stepId,…]` — the recurrence: where this metric fires (define once, apply many). */
  applies_to: string[];
  severity: SeverityValue;
  /** the MINIMAL slice the check needs. */
  judge_inputs: string[];
  /** EV-051 fix-vs-eval routing. */
  flag: CriterionFlagValue;
}

/**
 * GA-1: a STRUCTURED, resolvable grounding reference. A ref names WHERE a value
 * lives (`obs` = trace/observation id · `path` = field path) and the EXACT
 * `value` cited. `resolveRef` re-resolves it against the trace by exact
 * (whitespace-normalized) value match — an `observed` claim must re-resolve.
 */
export interface DiscoveryRef {
  /** the trace id / observation id the value was read from (e.g. "ef30a271"). */
  obs: string;
  /** the field path within the trace/observation (e.g. "output.response"). */
  path: string;
  /** the EXACT cited value (re-resolved by whitespace-normalized exact match). */
  value: string;
}

/**
 * §5c — one assumption behind a discovered criterion + its evidence status.
 * GA-3: `kind` types the assumption so its lifecycle/blocking routes correctly
 * (OPTIONAL for grandfather — legacy assumptions without `kind` stay valid).
 */
export interface DiscoveryAssumption {
  text: string;
  status: AssumptionStatusValue;
  kind?: AssumptionKindValue;
}

/** §5c — the evidence block; the OBSERVED-vs-INFERRED honesty cut. */
export interface DiscoveryEvidence {
  grounding: GroundingValue;
  seen_in_traces: boolean;
  /** honest `k/n sampled` — NOT corpus-extrapolated. */
  prevalence: string;
  /** GA-1: structured, RE-RESOLVABLE grounding refs. REQUIRED non-empty for
   *  OBSERVED, and ≥1 must re-resolve exact-match when traces are supplied. */
  refs: DiscoveryRef[];
}

/** §5c expected impact = severity × coverage × discovery-confidence. */
export interface DiscoveryExpectedImpact {
  severity: SeverityValue;
  /** `stages/cases` the metric covers. */
  coverage: string;
  confidence: ConfidenceValue;
}

/** §5c (DR-2) — the per-criterion discovery-rationale block (evidence-first). */
export interface DiscoveryRationale {
  /** the behavior / failure mode this criterion guards. */
  targets: string;
  /** the user/business/correctness consequence if it fails. */
  why_problem: string;
  evidence: DiscoveryEvidence;
  /** trace observation → category → criterion (the decision path). */
  reasoning: string;
  assumptions: DiscoveryAssumption[];
  expected_impact: DiscoveryExpectedImpact;
  fix_or_eval: "eval-worthy" | "fixable->diagnostics";
}

/**
 * A mined criterion = a `DiscoveredCriterion` + the §5b metadata + the §5c DR-2
 * rationale. The output of the real `*discover` AGGREGATE path.
 */
export interface MinedCriterion extends DiscoveredCriterion {
  metadata: MetricMetadata;
  discovery: DiscoveryRationale;
  /**
   * The EXECUTABLE code-check reference (the uniform-standard companion of the
   * human-readable `statement`). REQUIRED when `metadata.check_method` is
   * `deterministic` or `hybrid` (enforced by `lint-uniformity.ts`, not TypeBox —
   * the schema keeps it OPTIONAL so a pure `llm-judge` criterion omits it and
   * legacy criteria stay valid). When present it is run by `runCodeEval` in the
   * tier-0 pre-pass (zero judge tokens, byte-identical). Reuses the existing
   * `CodeEvalSpec` registry — no new check vocabulary.
   */
  codeEval?: CodeEvalSpec;
}

// ── TypeBox schemas (closed objects) ────────────────────────────────────────

/**
 * The CANONICAL TypeBox companion of `code-eval.ts` `CodeEvalSpec` — the single
 * source of truth for validating a code-eval spec on ANY criterion (mined OR the
 * judging-matrix row). `contracts/eval-matrix.ts` re-exports this as
 * `MatrixCodeEvalSchema` so the two surfaces accept BYTE-IDENTICAL specs (no
 * drift). Each member is a closed object; the union is exhaustive over the 7
 * primitives the runtime `runCodeEval` handles (a `tests/` sync test asserts the
 * schema set == the runtime switch set). Kept HERE (not in eval-matrix) so the
 * MinedCriterion schema can reference it WITHOUT a runtime import cycle.
 */
export const CodeEvalSpecSchema = Type.Union([
  Type.Object(
    { primitive: Type.Literal("presence"), field: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      primitive: Type.Literal("string-equality"),
      field: Type.String({ minLength: 1 }),
      expected: Type.String(),
      caseInsensitive: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { primitive: Type.Literal("format-validity"), field: Type.String({ minLength: 1 }), pattern: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      primitive: Type.Literal("schema-conformance"),
      field: Type.String({ minLength: 1 }),
      requiredKeys: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { primitive: Type.Literal("ref-integrity"), producer: Type.String({ minLength: 1 }), consumer: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      primitive: Type.Literal("recovery-after-failure"),
      failField: Type.String({ minLength: 1 }),
      failEquals: Type.String(),
      recoveryTools: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      primitive: Type.Literal("tool-output-failure"),
      tool: Type.String({ minLength: 1 }),
      successPath: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const MetricMetadataSchema = Type.Object(
  {
    generality: Type.Union([
      Type.Literal(Generality.GeneralStructural),
      Type.Literal(Generality.SpecificSemantic),
    ]),
    dimension: Type.Union([
      Type.Literal(MetricDimension.OperationCorrectness),
      Type.Literal(MetricDimension.DataCorrectness),
      Type.Literal(MetricDimension.OperationalDeviation),
    ]),
    level: Type.Union([
      Type.Literal(MetricLevel.Context),
      Type.Literal(MetricLevel.Output),
      Type.Literal(MetricLevel.CrossStage),
    ]),
    check_method: Type.Union([
      Type.Literal(CheckMethod.Deterministic),
      Type.Literal(CheckMethod.LlmJudge),
      Type.Literal(CheckMethod.Hybrid),
    ]),
    substrate: Type.Union([
      Type.Literal(MetricSubstrate.Code),
      Type.Literal(MetricSubstrate.Judge),
    ]),
    applies_to: Type.Array(Type.String()),
    severity: Type.Union([
      Type.Literal(Severity.Crit),
      Type.Literal(Severity.High),
      Type.Literal(Severity.Med),
      Type.Literal(Severity.Low),
    ]),
    judge_inputs: Type.Array(Type.String({ minLength: 1 })),
    flag: Type.Union([
      Type.Literal(CriterionFlag.EvalWorthy),
      Type.Literal(CriterionFlag.Fixable),
    ]),
  },
  { additionalProperties: false },
);

/** GA-1 — structured grounding ref (closed object). */
export const DiscoveryRefSchema = Type.Object(
  {
    obs: Type.String({ minLength: 1 }),
    path: Type.String(),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** §5c/GA-3 — one assumption + status (+ optional typed `kind`). */
export const DiscoveryAssumptionSchema = Type.Object(
  {
    text: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal(AssumptionStatus.Verified),
      Type.Literal(AssumptionStatus.Unverified),
      Type.Literal(AssumptionStatus.Hypothesis),
      Type.Literal(AssumptionStatus.Eliminated),
    ]),
    kind: Type.Optional(
      Type.Union([
        Type.Literal(AssumptionKind.FactualIntent),
        Type.Literal(AssumptionKind.Normative),
        Type.Literal(AssumptionKind.Scope),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const DiscoveryRationaleSchema = Type.Object(
  {
    targets: Type.String({ minLength: 1 }),
    why_problem: Type.String({ minLength: 1 }),
    evidence: Type.Object(
      {
        grounding: Type.Union([
          Type.Literal(Grounding.Observed),
          Type.Literal(Grounding.Inferred),
          Type.Literal(Grounding.HypothesisPending),
        ]),
        seen_in_traces: Type.Boolean(),
        prevalence: Type.String({ minLength: 1 }),
        refs: Type.Array(DiscoveryRefSchema),
      },
      { additionalProperties: false },
    ),
    reasoning: Type.String({ minLength: 1 }),
    assumptions: Type.Array(DiscoveryAssumptionSchema),
    expected_impact: Type.Object(
      {
        severity: Type.Union([
          Type.Literal(Severity.Crit),
          Type.Literal(Severity.High),
          Type.Literal(Severity.Med),
          Type.Literal(Severity.Low),
        ]),
        coverage: Type.String(),
        confidence: Type.Union([
          Type.Literal(Confidence.High),
          Type.Literal(Confidence.Med),
          Type.Literal(Confidence.Low),
        ]),
      },
      { additionalProperties: false },
    ),
    fix_or_eval: Type.Union([
      Type.Literal("eval-worthy"),
      Type.Literal("fixable->diagnostics"),
    ]),
  },
  { additionalProperties: false },
);

export const MinedCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    statement: Type.String({ minLength: 1 }),
    judgeInputs: Type.Array(Type.String({ minLength: 1 })),
    judgeKind: Type.Union([
      Type.Literal(JudgeKind.Llm),
      Type.Literal(JudgeKind.Code),
      Type.Literal(JudgeKind.Hybrid),
    ]),
    flag: Type.Union([
      Type.Literal(CriterionFlag.EvalWorthy),
      Type.Literal(CriterionFlag.Fixable),
    ]),
    supportCount: Type.Integer({ minimum: 0 }),
    metadata: MetricMetadataSchema,
    discovery: DiscoveryRationaleSchema,
    /** the executable code-check reference (uniform standard); OPTIONAL at the
     *  schema layer — `lint-uniformity.ts` enforces presence by check_method. */
    codeEval: Type.Optional(CodeEvalSpecSchema),
  },
  { additionalProperties: false },
);
export type MinedCriterionStatic = Static<typeof MinedCriterionSchema>;

/**
 * Validate + narrow an unknown value to `MinedCriterion`. THROWS with the first
 * schema error. Additionally enforces the §5c EVIDENCE-FIRST guard that TypeBox
 * can't express: a criterion grounded `observed` MUST cite ≥1 ref AND a non-zero
 * prevalence numerator — an INFERRED claim may never be rendered as OBSERVED.
 */
export function parseMinedCriterion(value: unknown): MinedCriterion {
  if (!Value.Check(MinedCriterionSchema, value)) {
    const first = [...Value.Errors(MinedCriterionSchema, value)][0];
    const where = first?.path ?? "(root)";
    const msg = first?.message ?? "does not match MinedCriterion";
    throw new Error(`parseMinedCriterion: invalid mined criterion at ${where}: ${msg}`);
  }
  assertGroundingHonest(value as MinedCriterion);
  return value as MinedCriterion;
}

/**
 * §5c/GA-1 HARD evidence-first gate. An `observed` grounding REQUIRES:
 *   (a) ≥1 cited ref, AND
 *   (b) a non-zero prevalence numerator (k>0 in "k/n"), AND
 *   (c) GA-1: when `traces` are supplied, ≥1 ref must RE-RESOLVE exact-match
 *       against the trace batch (an `observed` claim whose refs no longer resolve
 *       is an inferred-as-observed defect and is REJECTED).
 * THROWS otherwise — never present an INFERRED criterion as a found defect. The
 * `traces` arg is OPTIONAL so the structural gate (a,b) still runs for legacy
 * callers (e.g. `parseMinedCriterion`) that have no trace batch at hand.
 */
export function assertGroundingHonest(c: MinedCriterion, traces?: EvalTrace[]): void {
  const ev = c.discovery.evidence;
  if (ev.grounding !== Grounding.Observed) return;
  if (ev.refs.length === 0) {
    throw new Error(
      `assertGroundingHonest: criterion '${c.id}' is grounded 'observed' but cites ` +
        "NO refs — an observed defect must cite real trace refs (evidence-first; " +
        "never render inferred-as-observed).",
    );
  }
  const k = parsePrevalenceNumerator(ev.prevalence);
  if (k <= 0) {
    throw new Error(
      `assertGroundingHonest: criterion '${c.id}' is grounded 'observed' but its ` +
        `prevalence '${ev.prevalence}' has a zero numerator — observed requires k>0.`,
    );
  }
  if (traces !== undefined && traces.length > 0) {
    const anyResolves = ev.refs.some((r) => resolveRef(r, traces).resolved);
    if (!anyResolves) {
      throw new Error(
        `assertGroundingHonest: criterion '${c.id}' is grounded 'observed' but NONE ` +
          "of its refs RE-RESOLVE (exact, whitespace-normalized) against the trace " +
          "batch — an observed claim must cite a value that is actually present (GA-1).",
      );
    }
  }
}

/** Parse the `k` from a `k/n` prevalence string; returns 0 when unparseable. */
export function parsePrevalenceNumerator(prevalence: string): number {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(prevalence);
  if (m === null) return 0;
  const k = Number.parseInt(m[1], 10);
  return Number.isNaN(k) ? 0 : k;
}

// ════════════════════════════════════════════════════════════════════════════
// GA-1/GA-2 — resolve-ref primitive (the BIND + GATHER guard core, PURE)
// ────────────────────────────────────────────────────────────────────────────
// `resolveRef` is the single deterministic primitive both guards ride:
//   · GA-1 GATHER  — an `observed` criterion's evidence refs must re-resolve.
//   · GA-2 BIND    — at judge time every criterion TERM (its referents) must
//                    resolve to a grounded referent in the SITUATION trace, else
//                    the verdict is indeterminate(factual-intent), NOT a fail.
// "Exact value match (whitespace-normalized)" = the normalized ref value occurs
// verbatim (as a substring token) in the normalized serialization of the value
// AT the cited `obs`+`path` — NOT anywhere in the batch. No fuzzy / no semantic
// match — the honest, deterministic, byte-reproducible cut.
//
// GA-D1 (obs+path-aware): the earlier resolver substring-matched the value
// ANYWHERE in the batch and ignored the cited `obs`/`path`, so a ref could
// "resolve" against the WRONG observation (a value minted in obs A also occurring
// in an unrelated obs B was scored resolved:true). That overstates grounding —
// an inferred-as-observed defect. `resolveRef` now LOCATES the cited `obs`, reads
// the value AT `path`, and asserts exact-equality THERE. obs not found / path
// absent / value mismatch ⇒ UNRESOLVED (correctly demoting observed→inferred via
// `assertGroundingHonest`).
// ════════════════════════════════════════════════════════════════════════════

/** Whitespace-normalize + lowercase for exact-match comparison. PURE. */
export function normalizeRefText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The result of resolving one ref against a trace batch. */
export interface RefResolution {
  ref: DiscoveryRef;
  resolved: boolean;
  /** the id of the trace the value was found in (when resolved). */
  matchedIn?: string;
}

/** Serialize an arbitrary value to a flat searchable string. PURE. */
function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Locate the trace the ref's `obs` names. An `obs` id may name the TRACE itself
 * (top-level `id`) or one of its observations (by `name`). Returns the FIRST
 * trace (in batch order) whose id equals `obs` OR that carries an observation
 * named `obs` (exact, whitespace-normalized). `undefined` when `obs` names
 * neither — which makes the ref UNRESOLVED (no whole-batch fall-back). PURE.
 */
function locateByObs(obs: string, traces: EvalTrace[]): EvalTrace | undefined {
  const key = normalizeRefText(obs);
  if (key.length === 0) return undefined;
  return traces.find(
    (t) =>
      normalizeRefText(t.id) === key ||
      t.observations.some((o) => normalizeRefText(o.name ?? "") === key),
  );
}

/**
 * Read the value at a dotted `path` (e.g. `output.response`, `observations.0.output`)
 * out of a trace. Numeric segments index arrays. Returns `undefined` when ANY
 * segment is absent (no value at that path) — the caller treats that as
 * UNRESOLVED. An empty path reads the whole trace object. PURE.
 */
function readPath(root: unknown, path: string): unknown {
  const segments = path.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(rec, seg)) return undefined;
      cur = rec[seg];
      continue;
    }
    // a primitive with path remaining ⇒ the path does not exist.
    return undefined;
  }
  return cur;
}

/**
 * Resolve one structured ref against a batch of traces. GA-D1 obs+path-aware:
 *   1. LOCATE the trace/observation the ref's `obs` names (no batch fall-back —
 *      an `obs` that names nothing in the batch is UNRESOLVED).
 *   2. READ the value AT the cited `path` within that trace (an absent path is
 *      UNRESOLVED — never a whole-trace scan).
 *   3. EXACT (whitespace-normalized) substring match of `value` against the
 *      serialized value-at-path.
 * Returns the located trace id in `matchedIn` on a match. PURE — same (ref,
 * traces) ⇒ same resolution.
 */
export function resolveRef(ref: DiscoveryRef, traces: EvalTrace[]): RefResolution {
  const needle = normalizeRefText(ref.value);
  if (needle.length === 0) return { ref, resolved: false };
  // (1) the cited obs MUST name a trace/observation in the batch.
  const located = locateByObs(ref.obs, traces);
  if (located === undefined) return { ref, resolved: false };
  // (2) read the value AT the cited path (absent path ⇒ unresolved).
  const at = readPath(located, ref.path);
  if (at === undefined) return { ref, resolved: false };
  // (3) exact (whitespace-normalized) value match AT that path.
  if (normalizeRefText(serializeValue(at)).includes(needle)) {
    return { ref, resolved: true, matchedIn: located.id };
  }
  return { ref, resolved: false };
}

/** The result of binding a criterion's terms (its referents) to a situation. */
export interface BindResult {
  bound: boolean;
  /** refs that did NOT resolve in the situation — each an unbound term. */
  unbound: DiscoveryRef[];
}

/**
 * GA-2 L1 BIND — does every referent VALUE the criterion presupposes have a
 * grounded referent in the SITUATION trace(s)? A criterion's referents are its
 * discovery evidence refs (extendable via `extraTerms`). If ANY referent is
 * unbound the verdict must be `indeterminate(factual-intent)`, never a fail.
 *
 * NOTE (vs GA-1 GATHER): a ref's `obs` names the DISCOVERY-time trace it was
 * minted from — at judge time the SITUATION is a DIFFERENT trace with an
 * unrelated id. So BIND asks the value-presence question against the situation
 * itself (re-pointing each referent's `obs` to each situation trace), NOT the
 * obs-fidelity question `resolveRef` answers for GATHER. A referent binds iff its
 * value is present in some situation trace. PURE.
 */
export function bindCriterionTerms(
  refs: DiscoveryRef[],
  situation: EvalTrace[],
  extraTerms: DiscoveryRef[] = [],
): BindResult {
  const all = [...refs, ...extraTerms];
  const boundInSituation = (r: DiscoveryRef): boolean =>
    situation.some((t) => resolveRef({ ...r, obs: t.id, path: "" }, [t]).resolved);
  const unbound = all.filter((r) => !boundInSituation(r));
  return { bound: unbound.length === 0, unbound };
}
