/**
 * scripts/contracts/eval-matrix.ts — the v2 EVAL-MATRIX × TRAJECTORY judging contract.
 * ---------------------------------------------------------------------------
 * The executable (TypeBox) companion to `schemas/eval-matrix.schema.yaml`. This
 * file defines the DATA shapes for the **headline judging cell** — the Judge
 * Agent (`assets/agents/eval-matrix-judge.md`): a host-runtime subagent that
 * takes a subject's EVAL MATRIX (the criteria set) + ONE agent TRAJECTORY +
 * TRANSCRIPT and emits a per-criterion verdict for that trajectory. Fan-out is
 * per-TRAJECTORY (one judge scores the WHOLE matrix for one session) — high
 * throughput for evaluating many sessions.
 *
 * Strict austerity (operator directive): this file is **Type A — data contract
 * only**. It holds NO judge prompt and NO LLM-reasoning logic — the judging
 * RUBRIC lives in the Judge Agent def. Here we only declare + validate the
 * packet the parent PREPs (DATA) and the verdict file the subagent writes, and
 * map verdicts into the deterministic GATE rollup (`evaluate.ts`).
 *
 * Bridges the v1 `subjects/<name>/eval-matrix.yaml` concept: a MatrixCriterion
 * is one eval-matrix row reduced to the fields a per-trajectory judge needs.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AssumptionKind, AssumptionStatus, CheckMethod, CodeEvalSpecSchema, OutcomeVerdict, type MinedCriterion } from "./eval-types.ts";
import { Severity } from "./types.ts";

// ── T1 (B-U3) tier-0 code-eval spec — the deterministic pre-pass primitive ───
// The executable companion of `scripts/code-eval.ts` `CodeEvalSpec`. A matrix row
// typed `checkMethod: deterministic | hybrid` carries one of these so the tier-0
// pre-pass can run it via the generic code-eval primitives (NO judge, zero tokens,
// byte-identical). REUSES the canonical `CodeEvalSpecSchema` (the uniform-standard
// single source of truth in eval-types) so the matrix row and the MinedCriterion
// accept BYTE-IDENTICAL specs — extending the registry (e.g. the new
// recovery-after-failure / tool-output-failure primitives) lands on BOTH at once,
// with no drift.
export const MatrixCodeEvalSchema = CodeEvalSpecSchema;
export type MatrixCodeEval = Static<typeof MatrixCodeEvalSchema>;

// ── GA shared sub-schemas (structured refs · typed assumptions · blockedBy) ──
/** GA-1 structured grounding ref (closed). */
export const GaRefSchema = Type.Object(
  { obs: Type.String({ minLength: 1 }), path: Type.String(), value: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/** GA-3 typed assumption (closed; kind optional for grandfather). */
export const GaAssumptionSchema = Type.Object(
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
/** GA-4 the assumption-blocked payload on an indeterminate verdict (closed). */
export const GaBlockedBySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal(AssumptionKind.FactualIntent),
      Type.Literal(AssumptionKind.Normative),
      Type.Literal(AssumptionKind.Scope),
    ]),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

// ── MatrixCriterion — one eval-matrix row as judging DATA ────────────────────
export const MatrixCriterionSchema = Type.Object(
  {
    criterionId: Type.String({ minLength: 1 }),
    /** the conformance assertion for this row (eval-matrix `statement`). */
    statement: Type.String({ minLength: 1 }),
    /** the concrete binary pass condition (eval-matrix `passCondition`). */
    passCondition: Type.String({ minLength: 1 }),
    /** gating severity (reuse v1 Severity enum). */
    severity: Type.Union([
      Type.Literal(Severity.Crit),
      Type.Literal(Severity.High),
      Type.Literal(Severity.Med),
      Type.Literal(Severity.Low),
    ]),
    /** the 3-dimension MECE coverage tag (optional context for the judge). */
    dimension: Type.Optional(Type.String()),
    /** what the judge should read for this row (write-judge-prompt "choose what to pass"). */
    judgeInputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // ── T1 (B-U3) tier-0 router (ADDITIVE, OPTIONAL — grandfather) ──────────────
    /**
     * The §5b code-vs-judge router for the tier-0 pre-pass. ABSENT ⇒ `llm-judge`
     * (the legacy behavior — every row is dispatched to a judge), so existing
     * all-judge matrices are byte-stable. `deterministic` runs the row's `codeEval`
     * in the tier-0 pre-pass (NO judge, zero tokens); `hybrid` runs the code
     * pre-filter then judges the residual; `llm-judge` dispatches to the judge.
     */
    checkMethod: Type.Optional(
      Type.Union([
        Type.Literal(CheckMethod.Deterministic),
        Type.Literal(CheckMethod.LlmJudge),
        Type.Literal(CheckMethod.Hybrid),
      ]),
    ),
    /** the extracted code-eval spec — REQUIRED iff checkMethod ∈ {deterministic, hybrid}. */
    codeEval: Type.Optional(MatrixCodeEvalSchema),
  },
  { additionalProperties: false },
);
export type MatrixCriterion = Static<typeof MatrixCriterionSchema>;

/**
 * Bridge a MINED criterion (the `*discover` / living-suite shape) → a judging
 * MATRIX row, carrying the UNIFORM-STANDARD fields end-to-end: the `check_method`
 * router AND its executable `codeEval` flow onto the matrix row so the tier-0
 * pre-pass runs the code-check deterministically (zero judge tokens) instead of
 * dispatching a code/hybrid row to the LLM judge. This is the explicit wiring
 * point between the mined suite and the `*evaluate` tier-0 path — without it a
 * mined criterion's `codeEval` would be dropped at matrix-build time (tier-0
 * inert). PURE — a pure structural projection; no clock/random/network.
 *
 * `passCondition` defaults to the criterion `statement` (the binary Pass=… ); the
 * judge inputs prefer the §5b `metadata.judge_inputs`, falling back to the base
 * `judgeInputs`. A criterion with NO `codeEval` simply omits it (a pure judge row).
 */
export function minedToMatrixCriterion(c: MinedCriterion): MatrixCriterion {
  const judgeInputs =
    c.metadata.judge_inputs.length > 0 ? c.metadata.judge_inputs : c.judgeInputs;
  const row: MatrixCriterion = {
    criterionId: c.id,
    statement: c.statement,
    passCondition: c.statement,
    severity: c.metadata.severity,
    dimension: c.metadata.dimension,
    checkMethod: c.metadata.check_method,
    ...(judgeInputs.length > 0 ? { judgeInputs } : {}),
    ...(c.codeEval !== undefined ? { codeEval: c.codeEval } : {}),
  };
  return row;
}

// ── Trajectory + transcript (platform-agnostic, DATA only) ───────────────────
export const TrajectoryStepSchema = Type.Object(
  {
    /** tool / step name in call order. */
    name: Type.String({ minLength: 1 }),
    input: Type.Optional(Type.Unknown()),
    output: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type TrajectoryStep = Static<typeof TrajectoryStepSchema>;

export const TranscriptTurnSchema = Type.Object(
  {
    role: Type.String({ minLength: 1 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);
export type TranscriptTurn = Static<typeof TranscriptTurnSchema>;

// ── §9.4.4 v2.2 — M1 Subject Profile (the judge-packet identity card) ─────────
//
// M1: the judge gets WHO the agent is BEFORE it judges — identity · purpose · tools
// · skill · scope. Either GIVEN (code/metadata access) or RECONSTRUCTED from the
// trace batch (no access). version-aware. The `harness` is MARKED UNKNOWN when it
// cannot be known from the inputs — NEVER confabulated. ADDITIVE/OPTIONAL: a packet
// without a profile still validates (the judge reconstructs at reason-time).
export const SubjectProfileProvenance = {
  Given: "given",
  Reconstructed: "reconstructed",
} as const;
export type SubjectProfileProvenanceValue =
  (typeof SubjectProfileProvenance)[keyof typeof SubjectProfileProvenance];

/** The sentinel a profile field carries when the input cannot establish it (M1 —
 *  harness/skill marked UNKNOWN, never confabulated). */
export const PROFILE_UNKNOWN = "unknown" as const;

export const SubjectProfileSchema = Type.Object(
  {
    /** what the agent IS (name / role identity). */
    identity: Type.String({ minLength: 1 }),
    /** the KIND of subject (e.g. `autonomous-agent` · `skill` · `tool`), when known
     *  (GIVEN — code/metadata access). ABSENT ⇒ the renderer marks it `unknown`. */
    entityType: Type.Optional(Type.String()),
    /** what the agent is FOR (its purpose / goal). */
    purpose: Type.String({ minLength: 1 }),
    /** the tools the agent wields (GIVEN inventory or reconstructed from the trace batch). */
    tools: Type.Array(Type.String({ minLength: 1 })),
    /** the skill the agent runs under, when known (`unknown` ≠ confabulated). */
    skill: Type.Optional(Type.String()),
    /** the agent's responsibility boundary / scope. */
    scope: Type.String({ minLength: 1 }),
    /** the agent's system prompt, when GIVEN (code access) — rendered COLLAPSED in the
     *  hero card. ABSENT ⇒ the renderer marks it not-supplied (never confabulated). */
    systemPrompt: Type.Optional(Type.String()),
    /** the execution harness — MARKED `unknown` when unknowable, NEVER guessed. */
    harness: Type.String({ minLength: 1 }),
    /** GIVEN (code access) vs RECONSTRUCTED (from traces) — the judge must know which. */
    provenance: Type.Union([
      Type.Literal(SubjectProfileProvenance.Given),
      Type.Literal(SubjectProfileProvenance.Reconstructed),
    ]),
    /** version-aware: the subject version this profile describes (when known). */
    version: Type.Optional(Type.String()),
    /** the fields that are INFERRED (not given) — honesty about what is reconstructed. */
    inferredFields: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type SubjectProfile = Static<typeof SubjectProfileSchema>;

// ── MatrixPacket — the Judge Agent INPUT (one per trajectory) ────────────────
export const MatrixPacketSchema = Type.Object(
  {
    subject: Type.String({ minLength: 1 }),
    /** the agent session under evaluation. */
    trajectoryId: Type.String({ minLength: 1 }),
    /** the WHOLE matrix this trajectory is scored against. */
    criteria: Type.Array(MatrixCriterionSchema, { minItems: 1 }),
    /** ordered tool-call steps (DATA from the trace). */
    trajectory: Type.Array(TrajectoryStepSchema),
    /** the session messages (DATA from the trace). */
    transcript: Type.Array(TranscriptTurnSchema),
    /**
     * §9.4.4 M1 — the SUBJECT PROFILE (identity·purpose·tools·skill·scope) the judge
     * reads BEFORE it judges. GIVEN or RECONSTRUCTED, version-aware, harness marked
     * `unknown` when unknowable. ADDITIVE/OPTIONAL: a packet without it still validates
     * (the judge reconstructs the profile at reason-time) → byte-stable for legacy.
     */
    subjectProfile: Type.Optional(SubjectProfileSchema),
    /** the pinned envelope the host runtime must honor (C-PIN). */
    pin: Type.Object(
      { model: Type.String({ minLength: 1 }), temperature: Type.Literal(0) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type MatrixPacket = Static<typeof MatrixPacketSchema>;

// ── MatrixVerdict — one criterion verdict for one trajectory ─────────────────
export const MatrixVerdictSchema = Type.Object(
  {
    criterionId: Type.String({ minLength: 1 }),
    /** critique BEFORE verdict — a bare verdict is rejected (see parseMatrixVerdictFile). */
    critique: Type.String({ minLength: 1 }),
    result: Type.Union([
      Type.Literal(OutcomeVerdict.Pass),
      Type.Literal(OutcomeVerdict.Fail),
      Type.Literal(OutcomeVerdict.Uncertain),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    /**
     * Judge DAG v2 node 6 (CONFIDENCE band) — a side-signal BESIDE the binary
     * verdict, NOT a Likert verdict. OPTIONAL/additive: present when the judge
     * emits the v2 walk; `confidence` (the scalar) is unchanged. Reported for
     * calibration; it NEVER alters the binary `result` or the gate.
     */
    confidenceBand: Type.Optional(
      Type.Union([Type.Literal("high"), Type.Literal("med"), Type.Literal("low")]),
    ),
    // ── GA additive (OPTIONAL — grandfather; NO silent drop downstream) ──────
    /** GA-1 the field-level resolvable evidence the claim cites. */
    refs: Type.Optional(Type.Array(GaRefSchema)),
    /** GA-3 the typed assumptions the judge surfaced. */
    assumptions: Type.Optional(Type.Array(GaAssumptionSchema)),
    /** GA-4 set iff `result === uncertain` AND the abstain is assumption-driven. */
    blockedBy: Type.Optional(GaBlockedBySchema),
  },
  { additionalProperties: false },
);
export type MatrixVerdict = Static<typeof MatrixVerdictSchema>;

// ── §9.4.2 Judge DAG v2 shapes (ADDITIVE, OPTIONAL — the B-U2 emit contract) ──
// The 2026-06-23 §9.4.2 judge-contract: judges EMIT an ordered, agent-step-anchored
// reasoning WALK (`judgeSteps[]`, kind ∈ the DAG node names) + the target-agent
// step lane (`agentSteps[]`) so the report draws the Target-Agent‖Judge side-by-side,
// PLUS a dense na-explicit per-criterion map, a fidelity gate (early-INCOMPLETE on a
// truncated trace), a confidence band beside each binary verdict, and CANDIDATE
// items for unmatched detections (node 2.5 → *build-dataset). All OPTIONAL
// (grandfather): a judge that does NOT emit them still validates, and the renderer
// degrades to the per-trajectory scorecard. NO silent drop downstream.
//
// §9.4-judge-emit CLOSED (T2): the JUDGE AGENT now MANDATES these in
// `evaluator.md #mode-judge-trajectory` (+ the criterion-axis output contract in
// `judge-prompt-template.ts`); the schema (here) + the renderer CONSUMPTION
// (render-eval-report.ts) carry them as additive optional contract fields.

/** The Judge DAG v2 node names — `judgeSteps[].kind` SHOULD be one of these.
 *  v2.2 (§9.4.4) ADDS two pre-examine train-of-thought nodes: `gather` (node 0 —
 *  M2 gather-context = understand the agent/does/scope/skill + intent, rephrase to
 *  prove understanding) and `expect` (node 0.5 — M3 build-expected-trajectory: how
 *  the target SHOULD have acted, decided BEFORE examine). Both ADDITIVE — a v2.1
 *  judge that omits them still validates (`kind` is a free string). */
export const JudgeStepKind = {
  Gather: "gather",
  Expect: "expect",
  Context: "context",
  Examine: "examine",
  Detect: "detect",
  Bind: "bind",
  Ground: "ground",
  Critique: "critique",
  Decide: "decide",
  Verify: "verify",
  Localize: "localize",
} as const;
export type JudgeStepKindValue = (typeof JudgeStepKind)[keyof typeof JudgeStepKind];

// ── §9.4.4 v2.2 — M2 understanding (node-0 train-of-thought) ──────────────────
/** The judge's node-0 GATHER-CONTEXT train-of-thought: a rephrase that proves it
 *  understood the agent/does/scope/intent, plus an explicit given-vs-inferred split
 *  (M2 + M4). ADDITIVE/OPTIONAL. */
export const UnderstandingSchema = Type.Object(
  {
    /** rephrase the agent's job in the judge's own words — proves understanding (M2). */
    rephrase: Type.String({ minLength: 1 }),
    /** what was GIVEN (read from the packet / profile / code). */
    given: Type.Optional(Type.Array(Type.String())),
    /** what was INFERRED (reconstructed from the trace, not handed to the judge). */
    inferred: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type Understanding = Static<typeof UnderstandingSchema>;

// ── §9.4.4 v2.2 — M3 expected-trajectory (node-0.5) ───────────────────────────
/** One node-0.5 EXPECTED step: how the target SHOULD have acted at this point,
 *  decided BEFORE examine. `examine` then compares actual-vs-expected (M3). */
export const ExpectedStepSchema = Type.Object(
  {
    /** the ordered position in the expected decision-tree. */
    step: Type.Optional(Type.Number()),
    /** what the target SHOULD do here (the expected action / decision). */
    expected: Type.String({ minLength: 1 }),
    /** why this is the right move (the decision-tree rationale). */
    rationale: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ExpectedStep = Static<typeof ExpectedStepSchema>;

/** One target-agent step (the left lane of the §2 side-by-side). */
export const AgentStepSchema = Type.Object(
  {
    n: Type.Number(),
    tool: Type.Optional(Type.String()),
    /** ok | error | warn | false-success */
    status: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One ordered judge micro-step, anchored to an agent step (§9.4.2 `judge_steps[]`).
 *  `kind` is a free string for grandfather-compat but SHOULD be a `JudgeStepKind`. */
export const JudgeStepSchema = Type.Object(
  {
    /** context | examine | detect | bind | ground | critique | decide | verify | localize */
    kind: Type.String({ minLength: 1 }),
    text: Type.Optional(Type.String()),
    /**
     * a grounding citation for this micro-step. TOLERANT (string | structured ref):
     * real judges emit EITHER a verbatim "obs:detail" string OR the same structured
     * `{obs, path, value}` ref shape they use on verdicts — accept both (the renderer
     * coerces a structured ref to a readable string) so a strict-string schema does
     * not reject an otherwise-valid real verdict file.
     */
    ref: Type.Optional(Type.Union([Type.String(), GaRefSchema])),
    /**
     * the agent-step index this judge step anchors to (0 / context = gather band).
     * TOLERANT (number | string): real judges naturally emit string anchors —
     * a stringified index ("4"), a step label ("step-3"), or a RANGE ("1-6"). The
     * renderer coerces a numeric-string anchor to match its agent step and ignores
     * non-numeric ones (graceful degrade) — so a strict-number schema must not
     * reject an otherwise-valid real verdict file.
     */
    anchor: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  },
  { additionalProperties: false },
);

/**
 * §9.4.2 node 2.5 — a CANDIDATE eval/dataset item the judge emits for an UNMATCHED
 * detection (a real behaviour with no matching criterion). Consumed by the discover
 * → dataset-candidates handoff (T6) → `*build-dataset`. OPTIONAL/additive.
 */
export const CandidateItemSchema = Type.Object(
  {
    /** `eval` = a candidate criterion to mine · `dataset` = a candidate test case. */
    kind: Type.Union([Type.Literal("eval"), Type.Literal("dataset")]),
    /** the detected behaviour (the would-be criterion statement / case description). */
    detection: Type.String({ minLength: 1 }),
    /** the agent-step the detection anchors to (number | string — see JudgeStep.anchor). */
    anchor: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    /** a grounding citation for the detection — a string OR a structured {obs,path,value} ref. */
    ref: Type.Optional(Type.Union([Type.String(), GaRefSchema])),
  },
  { additionalProperties: false },
);
export type CandidateItem = Static<typeof CandidateItemSchema>;

// ── MatrixVerdictFile — the Judge Agent OUTPUT (one per trajectory) ──────────
export const MatrixVerdictFileSchema = Type.Object(
  {
    trajectoryId: Type.String({ minLength: 1 }),
    /** C-PIN provenance — the pinned host model + temperature the judge ran under. */
    judgeModel: Type.String({ minLength: 1 }),
    temperature: Type.Literal(0),
    verdicts: Type.Array(MatrixVerdictSchema),
    // ── §9.4 judge-walk (OPTIONAL — present iff the judge emitted it) ──
    /** the route cohort this trajectory falls in (drives the §3 heatmap columns). */
    route: Type.Optional(Type.String()),
    /** §9.4.5 E3 — the trace's wall-clock timestamp (ISO), when the source carried it.
     *  Powers the Overview eval-HEALTH temporal heatmap (correctness over time). When the
     *  source provides no timestamp the field is simply absent → that trajectory falls into
     *  the heatmap's data-pending bucket (the structure renders, never faked). OPTIONAL/additive. */
    timestamp: Type.Optional(Type.String()),
    /**
     * §9.4.4 M1 — the subject profile the judge reasoned UNDER (echoed from the packet,
     * or RECONSTRUCTED at reason-time when the packet carried none). Powers the INTERNAL
     * calibration tab's "who is the agent" lens. OPTIONAL/additive.
     */
    subjectProfile: Type.Optional(SubjectProfileSchema),
    /**
     * §9.4.4 M2 — the node-0 GATHER-CONTEXT train-of-thought: a rephrase proving the
     * judge understood the agent + an explicit given-vs-inferred split. OPTIONAL/additive.
     */
    understanding: Type.Optional(UnderstandingSchema),
    /**
     * §9.4.4 M3 — the node-0.5 EXPECTED-TRAJECTORY: how the target SHOULD have acted,
     * built BEFORE examine. `examine` then compares actual-vs-expected. OPTIONAL/additive.
     */
    expectedTrajectory: Type.Optional(Type.Array(ExpectedStepSchema)),
    /** the judge's gather-context band (harness / scenario / exit states). TOLERANT
     *  (string | string[]): real judges naturally emit exit-states / scenarios as a
     *  LIST — accept both so a strict-string schema does not reject an otherwise-valid
     *  verdict file (the renderer coerces an array to a readable string). */
    context: Type.Optional(
      Type.Object(
        {
          harness: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
          scenario: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
          exitStates: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
        },
        { additionalProperties: false },
      ),
    ),
    /** the target-agent step lane. */
    agentSteps: Type.Optional(Type.Array(AgentStepSchema)),
    /** the ordered, agent-step-anchored judge reasoning walk. */
    judgeSteps: Type.Optional(Type.Array(JudgeStepSchema)),
    /** the root-not-symptom localization (the §2 localize band). TOLERANT (string |
     *  structured band): real judges naturally emit a `{root, symptom?, ref?, routeTo?}`
     *  object rather than a bare string — accept both so a strict-string schema does not
     *  reject an otherwise-valid verdict file (consumers coerce to a readable string via
     *  `localizeText`). The `root` is what consolidate-by-locus clusters on. */
    localize: Type.Optional(
      Type.Union([
        Type.String(),
        Type.Object(
          {
            root: Type.String({ minLength: 1 }),
            symptom: Type.Optional(Type.String()),
            ref: Type.Optional(Type.Union([Type.String(), GaRefSchema])),
            routeTo: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    /**
     * §9.4.2 node 9 — the DENSE, na-explicit per-criterion map (`cid → pass | fail |
     * uncertain | na`). Every matrix criterion appears (na = not-applicable to this
     * trajectory, ≠ fail). When present the renderer uses it verbatim; when absent
     * the renderer synthesizes it from `verdicts[]` (na for any unjudged row).
     */
    denseMap: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([
          Type.Literal(OutcomeVerdict.Pass),
          Type.Literal(OutcomeVerdict.Fail),
          Type.Literal(OutcomeVerdict.Uncertain),
          Type.Literal("na"),
        ]),
      ),
    ),
    /**
     * §9.4.2 node 1 — the EXAMINE fidelity gate. `complete:false` means the trace
     * was truncated / unreadable → the trajectory EXITS early as INCOMPLETE (no
     * fabricated pass/fail from a partial trace). OPTIONAL/additive.
     */
    fidelity: Type.Optional(
      Type.Object(
        { complete: Type.Boolean(), reason: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    /** §9.4.2 node 2.5 — candidate eval/dataset items for UNMATCHED detections. */
    candidates: Type.Optional(Type.Array(CandidateItemSchema)),
    /**
     * the per-trajectory judge SELF-REPORTED health micro-summary. NOTE: this is
     * IGNORED for the report's health roll-up — T4 DERIVES health from the walk
     * (`deriveWalkHealth`), never trusting the self-graded field. TOLERANT shapes:
     * real judges emit `grounded`/`assumed` as EITHER a count (number) OR a boolean
     * — accept both so a strict schema does not reject an otherwise-valid verdict.
     */
    health: Type.Optional(
      Type.Object(
        {
          contextGathered: Type.Optional(Type.Boolean()),
          grounded: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
          assumed: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
          stoppedAtSymptom: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type MatrixVerdictFile = Static<typeof MatrixVerdictFileSchema>;

/**
 * Coerce a tolerant `localize` band (string | `{root, symptom?, …}`) to a single
 * readable root string. The structured form's `root` is authoritative (it is what
 * consolidate-by-locus clusters on); a bare string passes through. PURE.
 */
export function localizeText(localize: MatrixVerdictFile["localize"]): string {
  if (localize === undefined) return "";
  if (typeof localize === "string") return localize;
  return localize.symptom !== undefined ? `${localize.root} (symptom: ${localize.symptom})` : localize.root;
}

/**
 * Validate + parse a Judge Agent verdict file (raw JSON text). ENFORCES the
 * schema (critique non-empty → critique-before-verdict, result in the closed
 * set, temperature pinned 0). THROWS on any violation — a malformed verdict is
 * never silently accepted. PURE (no clock/random/network).
 */
export function parseMatrixVerdictFile(raw: string): MatrixVerdictFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`parseMatrixVerdictFile: not valid JSON: ${raw.slice(0, 120)}`);
  }
  if (!Value.Check(MatrixVerdictFileSchema, parsed)) {
    const first = [...Value.Errors(MatrixVerdictFileSchema, parsed)][0];
    throw new Error(
      `parseMatrixVerdictFile: schema violation at '${first?.path ?? "?"}': ` +
        `${first?.message ?? "invalid MatrixVerdictFile"}`,
    );
  }
  return parsed;
}

/** Assert a MatrixPacket conforms (used by PREP before emit). THROWS on violation. */
export function assertMatrixPacket(packet: unknown): asserts packet is MatrixPacket {
  if (!Value.Check(MatrixPacketSchema, packet)) {
    const first = [...Value.Errors(MatrixPacketSchema, packet)][0];
    throw new Error(
      `assertMatrixPacket: schema violation at '${first?.path ?? "?"}': ` +
        `${first?.message ?? "invalid MatrixPacket"}`,
    );
  }
}
