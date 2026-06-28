/**
 * scripts/check-method-router.ts — P3 (EX-2): the load-bearing v2 check_method router.
 * ---------------------------------------------------------------------------
 * Once `*discover` types a metric (§5b `check_method`), THIS routes each
 * MinedCriterion to its execution path — the router the dogfood (M1/M2) found
 * missing:
 *   - `deterministic` → CODE-EXEC: run the extracted code-eval (NO judge, zero
 *                       tokens, byte-identical reruns — full C-PIN on code rows).
 *   - `llm-judge`     → JUDGE: the LLM judge seam (agent-dispatch DEFAULT / run-judge).
 *   - `hybrid`        → CODE pre-filter THEN judge: code runs first; if code FAILS
 *                       the pre-filter the judge is GATED OFF (the cheap path caught
 *                       it — zero tokens); if code PASSES, the judge confirms the
 *                       subjective half. Both results are recorded in provenance.
 *   - unknown         → THROW (exhaustive, fail-loud — mirrors `resolveSubstrate`).
 *
 * EX-2: "code before judge" lives INSIDE the evaluator agent (it runs the code-eval
 * via Bash for code rows, LLM-judges only judge rows). This module is the pure
 * routing + provenance core the agent's protocol follows. JUDGE-ONLY (EV-051): a
 * code-eval is a DETERMINISTIC JUDGE, never a fix — nothing here edits the subject.
 *
 * The provenance type (`RoutedCriterionVerdict`) lives HERE (a v2-code-track shape),
 * NOT in eval-types — it is a structural SUPERSET of `CriterionVerdict`, so the
 * `evaluate.ts` GATE rollup consumes a routed verdict UNCHANGED (it reads `.result`).
 *
 * PURE except for the injected judge seam (which, under agent-dispatch, only READS
 * a verdict file). The code path is fully deterministic — no clock/random/network.
 */
import { runCodeEval, type CodeEvalResult, type CodeEvalSpec } from "./code-eval.ts";
import {
  CheckMethod,
  OutcomeVerdict,
  type CriterionVerdict,
  type EvalTrace,
  type MinedCriterion,
} from "./contracts/eval-types.ts";

/** Which executor produced a verdict (additive provenance, v2-code-track). */
export type ProducedBy = "code" | "judge" | "hybrid";

/**
 * A routed verdict = a `CriterionVerdict` + the execution provenance. Structural
 * superset → flows into `evaluate.ts` rollup unchanged (rollup reads `.result`).
 */
export interface RoutedCriterionVerdict extends CriterionVerdict {
  producedBy: ProducedBy;
  /** the deterministic code result (code/hybrid rows); omitted for pure judge rows. */
  codeResult?: "pass" | "fail";
  /** the code-eval detail (code/hybrid rows). */
  codeDetail?: string;
  /** whether an LLM judge was actually invoked (false on code rows + gated hybrids). */
  judgeReached: boolean;
}

/** The LLM judge seam — produces a CriterionVerdict for a judge-class row. Under
 *  the agent-dispatch DEFAULT this READS a verdict file (no provider call). */
export type CriterionJudge = (
  criterion: MinedCriterion,
  trace: EvalTrace,
) => Promise<CriterionVerdict>;

/** The deterministic code seam — runs a criterion's extracted code-eval. */
export type CriterionCodeRunner = (criterion: MinedCriterion, trace: EvalTrace) => CodeEvalResult;

export interface RouteDeps {
  runCode: CriterionCodeRunner;
  judge: CriterionJudge;
}

/** Build a CriterionVerdict from a deterministic code result (confidence = 1). */
function verdictFromCode(
  criterion: MinedCriterion,
  trace: EvalTrace,
  code: CodeEvalResult,
): CriterionVerdict {
  return {
    criterionId: criterion.id,
    traceId: trace.id,
    result: code.result === "pass" ? OutcomeVerdict.Pass : OutcomeVerdict.Fail,
    confidence: 1, // deterministic certainty
    critique: code.detail,
  };
}

/**
 * Route + execute one criterion against one trace. EXHAUSTIVE on check_method;
 * an unknown value THROWS (no silent default — a metric of unknown method must
 * never be silently passed or judged). Returns a routed verdict carrying the
 * execution provenance.
 */
export async function evaluateCriterion(
  criterion: MinedCriterion,
  trace: EvalTrace,
  deps: RouteDeps,
): Promise<RoutedCriterionVerdict> {
  const cm = criterion.metadata.check_method;

  if (cm === CheckMethod.Deterministic) {
    const code = deps.runCode(criterion, trace);
    return {
      ...verdictFromCode(criterion, trace, code),
      producedBy: "code",
      codeResult: code.result,
      codeDetail: code.detail,
      judgeReached: false,
    };
  }

  if (cm === CheckMethod.LlmJudge) {
    const jv = await deps.judge(criterion, trace);
    return { ...jv, producedBy: "judge", judgeReached: true };
  }

  if (cm === CheckMethod.Hybrid) {
    const code = deps.runCode(criterion, trace);
    if (code.result === "fail") {
      // code pre-filter caught it → the judge is GATED OFF (zero tokens).
      return {
        ...verdictFromCode(criterion, trace, code),
        producedBy: "hybrid",
        codeResult: code.result,
        codeDetail: code.detail,
        judgeReached: false,
      };
    }
    // code passed the pre-filter → the judge confirms the subjective half.
    const jv = await deps.judge(criterion, trace);
    return {
      ...jv,
      producedBy: "hybrid",
      codeResult: code.result,
      codeDetail: code.detail,
      judgeReached: true,
    };
  }

  throw new Error(
    `evaluateCriterion: unknown check_method '${String(cm)}' for criterion ` +
      `'${criterion.id}'. Known: deterministic | llm-judge | hybrid (no silent default).`,
  );
}

// ── Per-subject code-eval extraction ────────────────────────────────────────

/** A per-subject registry mapping a code-class criterionId → its extracted spec. */
export type CodeEvalRegistry = Record<string, CodeEvalSpec>;

/**
 * Look up a criterion's extracted code-eval spec from the per-subject registry.
 * FAIL-LOUD: a code-class criterion with no registered spec THROWS — code-class
 * rows REQUIRE an extracted script; the harness must never silently fall back to
 * an LLM judge for a metric typed as code (that would waste the deterministic
 * signal + break C-PIN — the M1 defect this phase closes).
 */
export function extractCodeEval(criterion: MinedCriterion, registry: CodeEvalRegistry): CodeEvalSpec {
  const spec = registry[criterion.id];
  if (spec === undefined) {
    throw new Error(
      `extractCodeEval: no code-eval spec registered for code-class criterion ` +
        `'${criterion.id}'. Code-class rows require an extracted code-eval script; ` +
        "refusing to silently LLM-judge a metric typed as code (M1).",
    );
  }
  return spec;
}

/** Build a `CriterionCodeRunner` that extracts + runs a criterion's code-eval. */
export function makeCodeRunner(registry: CodeEvalRegistry): CriterionCodeRunner {
  return (criterion: MinedCriterion, trace: EvalTrace): CodeEvalResult =>
    runCodeEval(extractCodeEval(criterion, registry), trace);
}
