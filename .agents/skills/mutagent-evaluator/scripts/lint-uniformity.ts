/**
 * scripts/lint-uniformity.ts — the UNIFORM EVAL-STANDARD validator (loud, deterministic).
 * ---------------------------------------------------------------------------
 * The operator-signed-off "uniform eval standard": every MinedCriterion carries a
 * uniform check representation, and the EXECUTABLE half (`codeEval`) must MATCH
 * the declared `check_method`. This is the deterministic, code-only gate that
 * makes the standard real — it kills the "tier-0 inert" defect where a criterion
 * is TYPED code/hybrid but ships no runnable `codeEval`, so the tier-0 pre-pass
 * silently falls back to the LLM judge (wasting the deterministic signal +
 * breaking C-PIN). Mirrors `lint-grounding.ts`: pure, criterion-ordered findings.
 *
 * THE STANDARD (per `metadata.check_method`):
 *   - `deterministic` ⇒ codeEval REQUIRED            (pure code row — runs in tier-0)
 *   - `hybrid`        ⇒ codeEval REQUIRED + judge_inputs non-empty
 *                                                     (code pre-filter THEN judge)
 *   - `llm-judge`     ⇒ judge_inputs non-empty + NO codeEval
 *                                                     (subjective — judge owns it)
 *
 * A code/hybrid criterion WITHOUT a `codeEval` is a HARD error — not a warning,
 * not grandfathered. Uniformity is a structural contract: a violation means the
 * suite is mis-built (a row that claims to be deterministic but can't run
 * deterministically), so EVERY finding is an ERROR (`ok=false`). PURE — no
 * clock/random/network.
 */
import {
  CheckMethod,
  type MinedCriterion,
} from "./contracts/eval-types.ts";

export type UniformityRule =
  | "U1-deterministic-requires-codeeval"
  | "U2-hybrid-requires-codeeval"
  | "U3-llm-judge-forbids-codeeval"
  | "U4-judge-inputs-required";

export interface UniformityFinding {
  criterionId: string;
  rule: UniformityRule;
  /** always "error" — a uniformity breach means the suite is mis-built. */
  level: "error";
  message: string;
}

export interface UniformityResult {
  findings: UniformityFinding[];
  errorCount: number;
  /** false iff ≥1 finding — uniformity is all-or-nothing (no warn tier). */
  ok: boolean;
}

/** Does this criterion carry a runnable code-eval spec? */
function hasCodeEval(c: MinedCriterion): boolean {
  return c.codeEval !== undefined;
}

/** Does this criterion declare the minimal judge inputs a judge row needs? */
function hasJudgeInputs(c: MinedCriterion): boolean {
  return Array.isArray(c.metadata.judge_inputs) && c.metadata.judge_inputs.length > 0;
}

/**
 * Validate ONE mined criterion against the uniform standard. Returns the findings
 * (all ERROR-level). PURE.
 */
export function lintUniformityCriterion(c: MinedCriterion): UniformityFinding[] {
  const out: UniformityFinding[] = [];
  const cm = c.metadata.check_method;

  if (cm === CheckMethod.Deterministic) {
    // pure code row — MUST carry a runnable codeEval (else tier-0 inert).
    if (!hasCodeEval(c)) {
      out.push({
        criterionId: c.id,
        rule: "U1-deterministic-requires-codeeval",
        level: "error",
        message:
          "check_method=deterministic but NO codeEval — a deterministic row MUST ship a runnable " +
          "code-eval spec (else the tier-0 pre-pass silently falls back to the LLM judge: tier-0 inert).",
      });
    }
    return out;
  }

  if (cm === CheckMethod.Hybrid) {
    // code pre-filter THEN judge — needs BOTH halves.
    if (!hasCodeEval(c)) {
      out.push({
        criterionId: c.id,
        rule: "U2-hybrid-requires-codeeval",
        level: "error",
        message:
          "check_method=hybrid but NO codeEval — a hybrid row MUST ship a code-eval spec for the " +
          "deterministic pre-filter half (else there is nothing to pre-filter: tier-0 inert).",
      });
    }
    if (!hasJudgeInputs(c)) {
      out.push({
        criterionId: c.id,
        rule: "U4-judge-inputs-required",
        level: "error",
        message:
          "check_method=hybrid but judge_inputs is empty — a hybrid row MUST declare the judge_inputs " +
          "the LLM judge reads for the subjective half.",
      });
    }
    return out;
  }

  if (cm === CheckMethod.LlmJudge) {
    // subjective row — judge owns it; a codeEval here is contradictory.
    if (hasCodeEval(c)) {
      out.push({
        criterionId: c.id,
        rule: "U3-llm-judge-forbids-codeeval",
        level: "error",
        message:
          "check_method=llm-judge but a codeEval is present — a judge-only row must NOT carry a " +
          "code-eval (it would never run: tier-0 routes only deterministic/hybrid). Re-tag the " +
          "criterion deterministic|hybrid, or drop the codeEval.",
      });
    }
    if (!hasJudgeInputs(c)) {
      out.push({
        criterionId: c.id,
        rule: "U4-judge-inputs-required",
        level: "error",
        message:
          "check_method=llm-judge but judge_inputs is empty — a judge row MUST declare the judge_inputs " +
          "the LLM judge reads.",
      });
    }
    return out;
  }

  // unreachable for a parsed MinedCriterion (check_method is a closed union), but
  // fail-loud rather than silently pass an unknown method.
  out.push({
    criterionId: c.id,
    rule: "U1-deterministic-requires-codeeval",
    level: "error",
    message: `unknown check_method '${String(cm)}' — cannot validate uniformity (no silent pass).`,
  });
  return out;
}

/**
 * Validate a batch of mined criteria against the uniform standard. PURE —
 * deterministic, criterion order. `ok` is false iff ANY finding exists.
 */
export function lintUniformity(criteria: MinedCriterion[]): UniformityResult {
  const findings = criteria.flatMap((c) => lintUniformityCriterion(c));
  return { findings, errorCount: findings.length, ok: findings.length === 0 };
}

/**
 * Assert the uniform standard — THROWS with a loud, multi-line summary on ANY
 * violation. The hard gate the discover AGGREGATE / build path can call to refuse
 * shipping a mis-built suite. PURE (throws or returns void).
 */
export function assertUniform(criteria: MinedCriterion[]): void {
  const { findings, ok } = lintUniformity(criteria);
  if (ok) return;
  const lines = findings.map((f) => `  - [${f.rule}] ${f.criterionId}: ${f.message}`);
  throw new Error(
    `assertUniform: ${findings.length} uniform-standard violation(s) — the eval suite is mis-built ` +
      `(a criterion's executable codeEval does not match its declared check_method):\n${lines.join("\n")}`,
  );
}
