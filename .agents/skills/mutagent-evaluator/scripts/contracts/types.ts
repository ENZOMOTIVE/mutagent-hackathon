/**
 * scripts/contracts/types.ts
 * ---------------------------------------------------------------------------
 * Canonical TypeBox contracts + exported TS types for the generic evaluator
 * engine. These are the single source of truth that load-bundle / run-
 * deterministic / assemble-scorecard / variance-compare / render-report all
 * consume — no downstream guessing.
 *
 * Kept in lockstep with the human-readable shape contracts under schemas/*.yaml.
 */
import { type Static, Type } from "@sinclair/typebox";

// ── Categorical constants (no magic strings — coding-rules) ─────────────────
export const Dimension = {
  OperationCorrectness: "operation-correctness",
  DataCorrectness: "data-correctness",
  OperationalDeviation: "operational-deviation",
} as const;
export type DimensionValue = (typeof Dimension)[keyof typeof Dimension];

export const CheckMethod = {
  DeterministicScript: "deterministic-script",
  TypeboxSchema: "typebox-schema",
  Gate: "gate",
  TraceCrossRef: "trace-cross-ref",
  TrajectoryDiff: "trajectory-diff",
  // SF-2 (DEC-16) — additive generic content-judge checkMethod. Judge-track (it is
  // NOT in DETERMINISTIC_CHECK_METHODS, so trackForCheckMethod routes it to Judge).
  // Lets a v1 eval-matrix row be a generic LLM content judge, not only the
  // diagnostics-specific trace-cross-ref / trajectory-diff. v2 MinedCriterion carries
  // its own 3-value router (eval-types.ts check_method); the two coexist.
  LlmJudge: "llm-judge",
} as const;
export type CheckMethodValue = (typeof CheckMethod)[keyof typeof CheckMethod];

export const Severity = {
  Crit: "CRIT",
  High: "HIGH",
  Med: "MED",
  Low: "LOW",
} as const;
export type SeverityValue = (typeof Severity)[keyof typeof Severity];

export const ExistingCoverage = {
  Covered: "covered",
  Partial: "partial",
  None: "none",
} as const;
export type ExistingCoverageValue =
  (typeof ExistingCoverage)[keyof typeof ExistingCoverage];

export const Track = {
  Deterministic: "deterministic",
  Judge: "judge",
} as const;
export type TrackValue = (typeof Track)[keyof typeof Track];

export const RowResult = {
  Pass: "pass",
  Fail: "fail",
  Skip: "skip",
  /** GA — a CRIT/HIGH criterion that adjudicated indeterminate (uncertain). It
   *  does NOT fail the component but blocks certification ⇒ component/run
   *  `incomplete`. Additive; the v1 audit path never emits it (back-compat). */
  Incomplete: "incomplete",
} as const;
export type RowResultValue = (typeof RowResult)[keyof typeof RowResult];

/** GA — the run/component ternary lattice `fail ▸ incomplete ▸ pass`. */
export const RunVerdict = {
  Pass: "pass",
  Fail: "fail",
  Incomplete: "incomplete",
} as const;
export type RunVerdictValue = (typeof RunVerdict)[keyof typeof RunVerdict];

/**
 * The deterministic-vs-judge split is a pure function of checkMethod
 * (decision #4): deterministic-script | typebox-schema | gate run with NO
 * model; trace-cross-ref | trajectory-diff run under the pinned judge.
 */
export const DETERMINISTIC_CHECK_METHODS: ReadonlySet<string> = new Set([
  CheckMethod.DeterministicScript,
  CheckMethod.TypeboxSchema,
  CheckMethod.Gate,
]);

export function trackForCheckMethod(checkMethod: string): TrackValue {
  return DETERMINISTIC_CHECK_METHODS.has(checkMethod)
    ? Track.Deterministic
    : Track.Judge;
}

// ── Eval-matrix (subject profile) ───────────────────────────────────────────
export const CriterionSchema = Type.Object(
  {
    dimension: Type.Union([
      Type.Literal(Dimension.OperationCorrectness),
      Type.Literal(Dimension.DataCorrectness),
      Type.Literal(Dimension.OperationalDeviation),
    ]),
    statement: Type.String({ minLength: 1 }),
    checkMethod: Type.Union([
      Type.Literal(CheckMethod.DeterministicScript),
      Type.Literal(CheckMethod.TypeboxSchema),
      Type.Literal(CheckMethod.Gate),
      Type.Literal(CheckMethod.TraceCrossRef),
      Type.Literal(CheckMethod.TrajectoryDiff),
      Type.Literal(CheckMethod.LlmJudge), // SF-2 additive (DEC-16)
    ]),
    passCondition: Type.String({ minLength: 1 }),
    severity: Type.Union([
      Type.Literal(Severity.Crit),
      Type.Literal(Severity.High),
      Type.Literal(Severity.Med),
      Type.Literal(Severity.Low),
    ]),
    existingCoverage: Type.Union([
      Type.Literal(ExistingCoverage.Covered),
      Type.Literal(ExistingCoverage.Partial),
      Type.Literal(ExistingCoverage.None),
    ]),
    evidenceSource: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Criterion = Static<typeof CriterionSchema>;

export const ComponentSchema = Type.Object(
  {
    componentId: Type.String({ minLength: 1 }),
    componentName: Type.String({ minLength: 1 }),
    componentType: Type.Union([
      Type.Literal("agent"),
      Type.Literal("skill-orchestrator-step"),
      Type.Literal("star-command"),
      Type.Literal("script"),
      Type.Literal("gate"),
      // SF-1 additive — product-feature / pipeline-stage component kinds (a
      // multi-stage generation subject is a CHAIN of stages; §6a).
      Type.Literal("feature"),
      Type.Literal("pipeline-stage"),
    ]),
    criteria: Type.Array(CriterionSchema),
  },
  { additionalProperties: false },
);
export type Component = Static<typeof ComponentSchema>;

export const EvalMatrixSchema = Type.Object(
  {
    subject: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    generatedAt: Type.String(),
    designPrinciples: Type.Array(Type.String()),
    components: Type.Array(ComponentSchema),
  },
  { additionalProperties: false },
);
export type EvalMatrix = Static<typeof EvalMatrixSchema>;

// ── Scorecard (two-track) ───────────────────────────────────────────────────
export const ScorecardCriterionSchema = Type.Object(
  {
    dimension: Type.String(),
    severity: Type.String(),
    checkMethod: Type.String(),
    track: Type.Union([
      Type.Literal(Track.Deterministic),
      Type.Literal(Track.Judge),
    ]),
    result: Type.Union([
      Type.Literal(RowResult.Pass),
      Type.Literal(RowResult.Fail),
      Type.Literal(RowResult.Skip),
      Type.Literal(RowResult.Incomplete), // GA — additive (back-compat)
    ]),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ScorecardCriterion = Static<typeof ScorecardCriterionSchema>;

export const GateComponentSchema = Type.Object(
  {
    componentId: Type.String(),
    pass: Type.Boolean(),
    /** GA — the component ternary verdict (optional/back-compat; `pass` mirrors
     *  `verdict === "pass"`). `incomplete` when a CRIT/HIGH row is indeterminate. */
    verdict: Type.Optional(
      Type.Union([
        Type.Literal(RunVerdict.Pass),
        Type.Literal(RunVerdict.Fail),
        Type.Literal(RunVerdict.Incomplete),
      ]),
    ),
    criteria: Type.Array(ScorecardCriterionSchema),
  },
  { additionalProperties: false },
);
export type GateComponent = Static<typeof GateComponentSchema>;

export const TrendDimensionSchema = Type.Object(
  {
    name: Type.String(),
    measure: Type.String(),
    target: Type.String(),
    divergence: Type.Union([
      Type.Literal("identical"),
      Type.Literal("within-target"),
      Type.Literal("diverged"),
      Type.Literal("not-evaluated"),
    ]),
  },
  { additionalProperties: false },
);
export type TrendDimension = Static<typeof TrendDimensionSchema>;

// Coverage honesty (EV-OUT-002): graded-vs-total + skip-rate warning. Optional
// so older scorecards (without it) still validate; warning-only — never gates.
export const CoverageSchema = Type.Object(
  {
    graded: Type.Integer(),
    total: Type.Integer(),
    skipped: Type.Integer(),
    skipRate: Type.Number(),
    skipRateWarnThreshold: Type.Number(),
    coverageWarning: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Coverage = Static<typeof CoverageSchema>;

export const ScorecardSchema = Type.Object(
  {
    subject: Type.String(),
    runId: Type.String(),
    generatedAt: Type.String(),
    coverage: Type.Optional(CoverageSchema),
    gate: Type.Object(
      {
        runPass: Type.Boolean(),
        /** GA — the ternary run verdict `fail ▸ incomplete ▸ pass` (optional/
         *  back-compat; `runPass` is `runVerdict === "pass"`). */
        runVerdict: Type.Optional(
          Type.Union([
            Type.Literal(RunVerdict.Pass),
            Type.Literal(RunVerdict.Fail),
            Type.Literal(RunVerdict.Incomplete),
          ]),
        ),
        components: Type.Array(GateComponentSchema),
        totals: Type.Object(
          {
            pass: Type.Integer(),
            fail: Type.Integer(),
            skip: Type.Integer(),
            critFail: Type.Integer(),
            highFail: Type.Integer(),
            /** GA — CRIT/HIGH indeterminate count (optional/back-compat). */
            incomplete: Type.Optional(Type.Integer()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    trend: Type.Object(
      {
        runPair: Type.Optional(
          Type.Object(
            { a: Type.String(), b: Type.String() },
            { additionalProperties: false },
          ),
        ),
        dimensions: Type.Array(TrendDimensionSchema),
        varianceScore: Type.Number(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Scorecard = Static<typeof ScorecardSchema>;

// ── Run-bundle (the audited run's artifacts) ────────────────────────────────
/**
 * The validated audit input produced by load-bundle.ts. A run-bundle is a
 * .mutagent-diagnostics/{runId}/ directory. The evaluator is subject-agnostic:
 * it loads whatever artifacts the subject's run produced and exposes them as a
 * flat, validated map. Only `runId` is structurally required; everything else
 * is best-effort per the subject.
 */
export interface RunBundle {
  runId: string;
  bundleDir: string;
  /** absolute paths to artifact files discovered in the bundle */
  artifacts: Record<string, string>;
  /** parsed JSON artifacts keyed by logical name (runMeta, tracesMetadata, ...) */
  data: Record<string, unknown>;
  /** non-fatal load warnings (missing-but-optional artifacts) */
  warnings: string[];
}
