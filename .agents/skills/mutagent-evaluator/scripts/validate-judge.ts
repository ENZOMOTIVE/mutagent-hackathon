/**
 * scripts/validate-judge.ts — EV-044 `*validate` (Type A — Code-only, pure math).
 * ---------------------------------------------------------------------------
 * Calibrate a judge against human labels (the rubric is `references/validate-
 * evaluator.md`; this is the deterministic STATS that implement it):
 *   - 2×2 confusion matrix → TPR / TNR (NOT raw accuracy — misleading under
 *     class imbalance);
 *   - split-disjointness + TEST-ONCE guards (dev for iteration, test measured
 *     exactly once — looking at test then iterating is data leakage);
 *   - Rogan-Gladen bias correction  θ = (p_obs + TNR − 1) / (TPR + TNR − 1)
 *     with clip to [0,1] and `invalid` when the denominator ≈ 0 (judge no better
 *     than random);
 *   - a DETERMINISTIC bootstrap CI (seeded LCG resample — NO Math.random, so the
 *     interval is byte-identical across reruns, C-PIN-adjacent);
 *   - graceful degradation: a criterion with < MIN_LABELS human labels (or TPR/
 *     TNR below target) stays `unvalidated` and is reported BIAS-CORRECTED, never
 *     blocking — the autonomous loop has no human to wait on.
 *
 * Austerity: NO judge prompt, NO LLM — this PREPs/AGGREGATEs the numbers; the
 * verdicts it consumes come from the dispatched eval-judge (read back from
 * verdict files). The pinned judge model is recorded on the result (a model
 * change invalidates the numbers — re-validate). PURE — no clock/random/network.
 */
import { OutcomeVerdict, type OutcomeVerdictValue } from "./contracts/eval-types.ts";
import {
  HumanVerdict,
  ValidationStatus,
  type ConfidenceInterval,
  type ConfusionMatrix,
  type HumanLabel,
  type ValidationResult,
} from "./contracts/validation.ts";

// ── calibration thresholds (validate-evaluator.md) ───────────────────────────
/** Below this many labels the CIs get wide → the judge stays `unvalidated`. */
export const MIN_LABELS = 60;
/** Target TPR/TNR (validate-evaluator.md step 5); below → `unvalidated`. */
export const TARGET_TPR = 0.9;
export const TARGET_TNR = 0.9;
/** Rogan-Gladen denominator floor — below this the judge is ≈ random → invalid. */
export const RG_DENOM_MIN = 1e-6;

// ── binary class projection (defer / uncertain are excluded) ─────────────────
type BinaryClass = "pass" | "fail";

/** Project a human verdict to the binary class, or null for `defer`. */
function humanBinary(v: HumanLabel["label"]): BinaryClass | null {
  if (v === HumanVerdict.Pass) return "pass";
  if (v === HumanVerdict.Fail) return "fail";
  return null; // defer — no ground truth
}

/** Project a judge verdict to the binary class, or null for `uncertain`. */
function judgeBinary(v: OutcomeVerdictValue): BinaryClass | null {
  if (v === OutcomeVerdict.Pass) return "pass";
  if (v === OutcomeVerdict.Fail) return "fail";
  return null; // uncertain — excluded from confusion math
}

/** One judge prediction for a trace (read back from a verdict file). */
export interface JudgePred {
  traceId: string;
  result: OutcomeVerdictValue;
}

/** A paired human/judge binary judgment for one trace (defer/uncertain dropped). */
export interface LabeledPair {
  traceId: string;
  human: BinaryClass;
  judge: BinaryClass;
}

// ── split-disjointness + test-once guards ────────────────────────────────────

/**
 * Assert no traceId is assigned to more than one split (train/dev/test must
 * partition cleanly — an overlap is leakage). THROWS on a conflict. PURE.
 */
export function assertSplitsDisjoint(labels: HumanLabel[]): void {
  const splitOf = new Map<string, string>();
  for (const l of labels) {
    if (l.split === undefined) continue;
    const prior = splitOf.get(l.traceId);
    if (prior !== undefined && prior !== l.split) {
      throw new Error(
        `assertSplitsDisjoint: trace '${l.traceId}' is in both '${prior}' and '${l.split}' ` +
          "splits — train/dev/test must be disjoint (data leakage).",
      );
    }
    splitOf.set(l.traceId, l.split);
  }
}

/**
 * Enforce the test-once rule: the held-out test split is measured EXACTLY once.
 * THROWS if a prior test measurement is already recorded. The caller persists
 * the flag in run state; this guards the transition. PURE.
 */
export function assertTestUsedOnce(testAlreadyMeasured: boolean): void {
  if (testAlreadyMeasured) {
    throw new Error(
      "assertTestUsedOnce: the test split was already measured — re-running on test after " +
        "seeing results is data leakage (validate-evaluator.md step 6). Go back to dev.",
    );
  }
}

// ── pairing + confusion matrix ───────────────────────────────────────────────

/**
 * Pair human labels with judge predictions by traceId, dropping `defer` /
 * `uncertain` (no ground truth / no judge call). Optionally restrict to one
 * split. DETERMINISTIC (ordered by traceId). PURE.
 */
export function pairLabels(
  human: HumanLabel[],
  judge: JudgePred[],
  split?: "train" | "dev" | "test",
): LabeledPair[] {
  const judgeById = new Map(judge.map((j) => [j.traceId, j.result]));
  const out: LabeledPair[] = [];
  for (const l of human) {
    if (split !== undefined && l.split !== split) continue;
    const h = humanBinary(l.label);
    if (h === null) continue;
    const jr = judgeById.get(l.traceId);
    if (jr === undefined) continue;
    const j = judgeBinary(jr);
    if (j === null) continue;
    out.push({ traceId: l.traceId, human: h, judge: j });
  }
  return out.sort((a, b) => a.traceId.localeCompare(b.traceId));
}

/** Build a 2×2 confusion matrix from paired judgments (Pass = positive). PURE. */
export function confusionMatrix(pairs: LabeledPair[]): ConfusionMatrix {
  const cm: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const p of pairs) {
    if (p.human === "pass" && p.judge === "pass") cm.tp++;
    else if (p.human === "fail" && p.judge === "pass") cm.fp++;
    else if (p.human === "fail" && p.judge === "fail") cm.tn++;
    else cm.fn++; // human pass, judge fail
  }
  return cm;
}

/** TPR = tp / (tp + fn); null when there are no human-Pass examples. PURE. */
export function tprOf(cm: ConfusionMatrix): number | null {
  const denom = cm.tp + cm.fn;
  return denom === 0 ? null : cm.tp / denom;
}

/** TNR = tn / (tn + fp); null when there are no human-Fail examples. PURE. */
export function tnrOf(cm: ConfusionMatrix): number | null {
  const denom = cm.tn + cm.fp;
  return denom === 0 ? null : cm.tn / denom;
}

// ── Rogan-Gladen bias correction ─────────────────────────────────────────────

function clip01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface RoganGladen {
  /** the bias-corrected true rate, clipped to [0,1]; null when invalid. */
  corrected: number | null;
  /** false when TPR+TNR−1 ≈ 0 (judge no better than random → uncorrectable). */
  valid: boolean;
}

/**
 * Rogan-Gladen correction: θ = (p_obs + TNR − 1) / (TPR + TNR − 1). Clipped to
 * [0,1]. INVALID (corrected=null) when the denominator's magnitude is below
 * `denomMin` — the judge is no better than random, so the raw rate cannot be
 * de-biased. PURE.
 */
export function roganGladen(
  pObs: number,
  tpr: number,
  tnr: number,
  denomMin = RG_DENOM_MIN,
): RoganGladen {
  const denom = tpr + tnr - 1;
  if (Math.abs(denom) < denomMin) return { corrected: null, valid: false };
  return { corrected: clip01((pObs + tnr - 1) / denom), valid: true };
}

/** Observed judge Pass-rate over unlabeled predictions (p_obs); null if none. PURE. */
export function observedPassRate(preds: JudgePred[]): number | null {
  let pass = 0;
  let total = 0;
  for (const p of preds) {
    const b = judgeBinary(p.result);
    if (b === null) continue;
    total++;
    if (b === "pass") pass++;
  }
  return total === 0 ? null : pass / total;
}

// ── deterministic bootstrap CI (seeded LCG — no Math.random) ─────────────────

/** A small seeded LCG → [0,1). Deterministic; NEVER Math.random (byte-identity). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Percentile of an ASCENDING-sorted array (linear interpolation). PURE. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = clip01(p) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export interface BootstrapOptions {
  iterations?: number;
  /** 2-sided level (default 0.95). */
  level?: number;
  /** LCG seed — fixed by default so the CI is reproducible (C-PIN). */
  seed?: number;
}

/**
 * Bootstrap a CI for the Rogan-Gladen corrected rate: resample the labeled pairs
 * (with replacement, deterministic LCG) `iterations` times, recompute TPR/TNR/θ
 * per resample, and take the level-tailed percentiles of the valid θ values.
 * Returns undefined when too few valid resamples exist. `pObs` is fixed (the
 * production observation), only the calibration sample is resampled. PURE.
 */
export function bootstrapCorrectedCI(
  pairs: LabeledPair[],
  pObs: number,
  opts: BootstrapOptions = {},
): ConfidenceInterval | undefined {
  const iterations = opts.iterations ?? 1000;
  const level = opts.level ?? 0.95;
  const n = pairs.length;
  if (n < 2) return undefined;
  const rand = lcg(opts.seed ?? 0x2545f491);
  const thetas: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const cm: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
    for (let k = 0; k < n; k++) {
      const p = pairs[Math.floor(rand() * n)];
      if (p.human === "pass" && p.judge === "pass") cm.tp++;
      else if (p.human === "fail" && p.judge === "pass") cm.fp++;
      else if (p.human === "fail" && p.judge === "fail") cm.tn++;
      else cm.fn++;
    }
    const tpr = tprOf(cm);
    const tnr = tnrOf(cm);
    if (tpr === null || tnr === null) continue;
    const rg = roganGladen(pObs, tpr, tnr);
    if (rg.corrected !== null) thetas.push(rg.corrected);
  }
  if (thetas.length < 2) return undefined;
  thetas.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { lo: percentile(thetas, tail), hi: percentile(thetas, 1 - tail), level };
}

// ── top-level orchestration ──────────────────────────────────────────────────

export interface ValidateJudgeInput {
  criterionId: string;
  /** the PINNED judge model these numbers belong to (required — C-PIN). */
  judgeModel: string;
  /** human labels (with split tags). */
  humanLabels: HumanLabel[];
  /** judge predictions on the labeled set (read back from verdict files). */
  judgeVerdicts: JudgePred[];
  /** judge predictions on UNLABELED production traces (for p_obs). */
  unlabeledVerdicts?: JudgePred[];
  /** has the test split already been measured? (test-once guard). */
  testAlreadyMeasured?: boolean;
  /** override the min-labels gate (default MIN_LABELS). */
  minLabels?: number;
}

/**
 * Validate ONE judge against human labels → a `ValidationResult`. Picks the
 * final-measurement split (test if present — enforcing test-once — else dev,
 * else all labeled), computes TPR/TNR, the Rogan-Gladen corrected rate from the
 * unlabeled p_obs, and a bootstrap CI. DEGRADES GRACEFULLY: < minLabels labels or
 * sub-target TPR/TNR → `unvalidated` (reported bias-corrected, never blocking).
 * THROWS only on a contract breach (missing pinned model, split overlap,
 * test-reuse). PURE.
 */
export function validateJudge(input: ValidateJudgeInput): ValidationResult {
  if (input.judgeModel.length === 0) {
    throw new Error("validateJudge: judgeModel is required (C-PIN — the numbers are model-specific).");
  }
  assertSplitsDisjoint(input.humanLabels);
  const minLabels = input.minLabels ?? MIN_LABELS;

  // choose the final-measurement split: test (once) > dev > all.
  const hasTest = input.humanLabels.some((l) => l.split === "test");
  const hasDev = input.humanLabels.some((l) => l.split === "dev");
  let split: "dev" | "test" | undefined;
  if (hasTest) {
    assertTestUsedOnce(input.testAlreadyMeasured ?? false);
    split = "test";
  } else if (hasDev) {
    split = "dev";
  } else {
    split = undefined; // no split tags → use all labeled
  }

  const pairs = pairLabels(input.humanLabels, input.judgeVerdicts, split);
  const cm = confusionMatrix(pairs);
  const tpr = tprOf(cm);
  const tnr = tnrOf(cm);
  const labelCount = pairs.length;

  const pObs = observedPassRate(input.unlabeledVerdicts ?? []);
  const rg =
    tpr !== null && tnr !== null && pObs !== null
      ? roganGladen(pObs, tpr, tnr)
      : { corrected: null, valid: false };
  const ci =
    pObs !== null && rg.valid ? bootstrapCorrectedCI(pairs, pObs) : undefined;

  // status + note (graceful degradation).
  const reasons: string[] = [];
  if (labelCount < minLabels) reasons.push(`only ${labelCount} labels (< ${minLabels})`);
  if (tpr === null) reasons.push("no human-Pass examples (TPR undefined)");
  else if (tpr < TARGET_TPR) reasons.push(`TPR ${tpr.toFixed(2)} < ${TARGET_TPR}`);
  if (tnr === null) reasons.push("no human-Fail examples (TNR undefined)");
  else if (tnr < TARGET_TNR) reasons.push(`TNR ${tnr.toFixed(2)} < ${TARGET_TNR}`);
  const status = reasons.length === 0 ? ValidationStatus.Validated : ValidationStatus.Unvalidated;

  const result: ValidationResult = {
    criterionId: input.criterionId,
    judgeModel: input.judgeModel,
    status,
    labelCount,
    tpr,
    tnr,
    observedPassRate: pObs,
    correctedRate: rg.corrected,
    correctionValid: rg.valid,
    note:
      status === ValidationStatus.Validated
        ? `validated on ${labelCount} labels (split: ${split ?? "all"})`
        : `unvalidated — ${reasons.join("; ")}. Reporting bias-corrected, not raw; loop not blocked.`,
  };
  return ci === undefined ? result : { ...result, ci };
}
