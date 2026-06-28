/**
 * scripts/contracts/validation.ts — the W2 TRUST-layer data contracts.
 * ---------------------------------------------------------------------------
 * The executable (TypeBox) companion for the W2 trust track:
 *   - `HumanLabel` — one ground-truth annotation produced by `*review`
 *     (`scripts/build-review-ui.ts`) and consumed by `*validate`
 *     (`scripts/validate-judge.ts`). This is the human-judgment a judge is
 *     calibrated AGAINST (validate-evaluator.md TPR/TNR).
 *
 * Strict austerity (operator directive): this file is **Type A — data contract
 * only**. It holds NO judge prompt, NO LLM-reasoning, makes NO pass/fail
 * decision. It only declares + validates the label shapes the deterministic
 * scripts read/write. PURE — no clock / random / network.
 *
 * Disjointness (W2-OWN): this is a NEW W2 contract file. It does NOT touch the
 * shared `contracts/eval-types.ts` (W3 may touch shared types — kept out of it).
 * The confusion-matrix / validation-result shapes (`*validate` numbers) are
 * appended to this same file by the W2 *validate task.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── HumanLabel verdict (the annotation the reviewer picks) ───────────────────
//
// Mirrors the determiner's OutcomeVerdict closed set (pass/fail) PLUS `defer`
// — the review UI's third button for genuinely uncertain traces. A deferred
// label is NOT a judgment: it is excluded from TPR/TNR (it provides no ground
// truth), and it drives uncertainty resampling. We keep the set local to the
// trust layer rather than importing OutcomeVerdict, because `defer` is a
// review-UI concept (a human punting), not a determiner outcome.
export const HumanVerdict = {
  Pass: "pass",
  Fail: "fail",
  /** reviewer is uncertain — excluded from confusion-matrix math, never coerced. */
  Defer: "defer",
} as const;
export type HumanVerdictValue = (typeof HumanVerdict)[keyof typeof HumanVerdict];

// ── HumanLabel — one reviewer annotation for one trace ───────────────────────
export const HumanLabelSchema = Type.Object(
  {
    /** the trace this label judges. */
    traceId: Type.String({ minLength: 1 }),
    /** the reviewer's binary verdict (or `defer`). */
    label: Type.Union([
      Type.Literal(HumanVerdict.Pass),
      Type.Literal(HumanVerdict.Fail),
      Type.Literal(HumanVerdict.Defer),
    ]),
    /** free-text note describing what went wrong/right (build-review-interface.md). */
    notes: Type.Optional(Type.String()),
    /**
     * which data SPLIT this labeled trace belongs to (train/dev/test). Carried so
     * `*validate` can enforce split-disjointness + the test-once guard. Optional —
     * the review UI may collect labels before the split is assigned.
     */
    split: Type.Optional(
      Type.Union([Type.Literal("train"), Type.Literal("dev"), Type.Literal("test")]),
    ),
    /** the annotator id (for two-annotator agreement). Optional. */
    annotator: Type.Optional(Type.String()),
    /**
     * ISO timestamp stamped by the BROWSER on save (non-deterministic). The
     * deterministic script core NEVER stamps this (mask discipline / C-PIN); it
     * only round-trips + dedups by traceId. Optional so masked fixtures validate.
     */
    labeledAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type HumanLabel = Static<typeof HumanLabelSchema>;

/**
 * Validate + parse a labels file (raw JSON text = `HumanLabel[]`). ENFORCES the
 * schema (closed label set, traceId non-empty); THROWS on any violation — a
 * malformed labels file is never silently accepted. PURE.
 */
export function parseHumanLabels(raw: string): HumanLabel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`parseHumanLabels: not valid JSON: ${raw.slice(0, 120)}`);
  }
  const schema = Type.Array(HumanLabelSchema);
  if (!Value.Check(schema, parsed)) {
    const first = [...Value.Errors(schema, parsed)][0];
    throw new Error(
      `parseHumanLabels: schema violation at '${first?.path ?? "?"}': ` +
        `${first?.message ?? "invalid HumanLabel[]"}`,
    );
  }
  return parsed;
}

/** Assert one HumanLabel conforms (used before persisting). THROWS on violation. */
export function assertHumanLabel(label: unknown): asserts label is HumanLabel {
  if (!Value.Check(HumanLabelSchema, label)) {
    const first = [...Value.Errors(HumanLabelSchema, label)][0];
    throw new Error(
      `assertHumanLabel: schema violation at '${first?.path ?? "?"}': ` +
        `${first?.message ?? "invalid HumanLabel"}`,
    );
  }
}

// ── *validate (EV-044) result shapes — the trust layer numbers ───────────────
//
// The output of calibrating a judge against human labels (validate-evaluator.md):
// a 2×2 confusion matrix → TPR/TNR → Rogan-Gladen bias-corrected true rate →
// bootstrap CI, with a `validated`/`unvalidated` status that degrades gracefully
// when there are too few human labels (the loop NEVER blocks on a human).

/** A judge's calibration status. */
export const ValidationStatus = {
  /** ≥ MIN_LABELS labels AND TPR/TNR clear the target — verdicts are trusted. */
  Validated: "validated",
  /**
   * too few labels OR TPR/TNR below target — the judge's aggregate rate is
   * reported BIAS-CORRECTED (not raw) and flagged; never blocks the loop.
   */
  Unvalidated: "unvalidated",
} as const;
export type ValidationStatusValue = (typeof ValidationStatus)[keyof typeof ValidationStatus];

/** 2×2 confusion matrix (Pass = positive class). `defer`/`uncertain` excluded. */
export const ConfusionMatrixSchema = Type.Object(
  {
    /** judge Pass AND human Pass. */
    tp: Type.Integer({ minimum: 0 }),
    /** judge Pass AND human Fail (false pass — judge too lenient). */
    fp: Type.Integer({ minimum: 0 }),
    /** judge Fail AND human Fail. */
    tn: Type.Integer({ minimum: 0 }),
    /** judge Fail AND human Pass (false fail — judge too strict). */
    fn: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ConfusionMatrix = Static<typeof ConfusionMatrixSchema>;

/** A bootstrap confidence interval for the corrected rate. */
export const ConfidenceIntervalSchema = Type.Object(
  {
    lo: Type.Number({ minimum: 0, maximum: 1 }),
    hi: Type.Number({ minimum: 0, maximum: 1 }),
    /** the 2-sided level (e.g. 0.95). */
    level: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type ConfidenceInterval = Static<typeof ConfidenceIntervalSchema>;

/** The full `*validate` result for ONE judge (one criterion). */
export const ValidationResultSchema = Type.Object(
  {
    criterionId: Type.String({ minLength: 1 }),
    /** the PINNED judge model the numbers belong to (C-PIN — re-validate on change). */
    judgeModel: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal(ValidationStatus.Validated),
      Type.Literal(ValidationStatus.Unvalidated),
    ]),
    /** total non-deferred human labels used (the calibration sample size). */
    labelCount: Type.Integer({ minimum: 0 }),
    /** true-positive rate (judge agrees on Pass); null when no human Pass exists. */
    tpr: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    /** true-negative rate (judge agrees on Fail); null when no human Fail exists. */
    tnr: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    /** observed judge Pass-rate on the unlabeled production set (p_obs). */
    observedPassRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    /** Rogan-Gladen bias-corrected true rate; null when invalid (judge ≈ random). */
    correctedRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    /** whether the Rogan-Gladen correction was valid (TPR+TNR−1 not ≈ 0). */
    correctionValid: Type.Boolean(),
    ci: Type.Optional(ConfidenceIntervalSchema),
    /** human-readable note on the status (why unvalidated, etc.). */
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ValidationResult = Static<typeof ValidationResultSchema>;

/** Assert a ValidationResult conforms (used before stamping the scorecard). THROWS. */
export function assertValidationResult(r: unknown): asserts r is ValidationResult {
  if (!Value.Check(ValidationResultSchema, r)) {
    const first = [...Value.Errors(ValidationResultSchema, r)][0];
    throw new Error(
      `assertValidationResult: schema violation at '${first?.path ?? "?"}': ` +
        `${first?.message ?? "invalid ValidationResult"}`,
    );
  }
}
