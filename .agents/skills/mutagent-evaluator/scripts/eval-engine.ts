/**
 * scripts/eval-engine.ts — the ADL EVAL-stage ENGINE FORK resolver (Type A — PURE).
 * ---------------------------------------------------------------------------
 * F7 / F9 / F14. When the ADL `*build` stage hands the evaluator a freshly-built
 * agent, `*build-evals` / `*evaluate` must ASK which eval engine to implement:
 *
 *   - Path A `native-matrix` — mutagent NATIVE eval-matrix + LLM-judge SUB-AGENTS.
 *     HARD DEPENDENCY on a Claude-Code host (to spawn the judges). For a CODE
 *     framework target (Mastra/TS) it ALSO needs the built agent to EMIT
 *     logs/traces to a known sink for the judge to read (F9). The CC dependency +
 *     sink requirement are SURFACED in the menu (F7) — never discovered late.
 *   - Path B `code-written` — evals written in the TARGET'S OWN language
 *     (bun/TS for Mastra): deterministic code-checks + an LLM-judge call VIA SDK +
 *     eval-criteria checks. PORTABLE — no CC sub-agents, so a non-CC user is not
 *     trapped in the matrix (F14).
 *
 * The fork is TARGET-CONDITIONAL (F9): a code FRAMEWORK target may pick EITHER
 * engine; a `harness:*` target is native-only (there is no target language to
 * write portable evals into). This module is PURE DATA + gates — the
 * AskUserQuestion prompt and the actual codegen live elsewhere
 * (codegen-evals.ts). Subject-agnostic; no clock / random / network.
 */
import {
  EvalEngine,
  type EvalEngineValue,
  type EvalEngineOption,
  type EvalEnginePlan,
  type EngineTargetInput,
} from "./contracts/eval-engine.ts";

const HARNESS_PREFIX = "harness:";

/**
 * Is the target a coding FRAMEWORK (mastra · langgraph · pydantic-ai · …) rather
 * than a `harness:*` runtime? A framework has a target LANGUAGE we can write
 * portable code-written evals into; a harness does not. PURE.
 */
export function isFrameworkTarget(target: EngineTargetInput): boolean {
  return !target.targetFramework.startsWith(HARNESS_PREFIX);
}

/**
 * The discoverable OUTPUT SINK an engine writes (and, for native-on-framework,
 * the sink the built agent must EMIT to). Always relative to the host project
 * root — the discoverability success-gate ("outputs land in a discoverable
 * sink"). PURE.
 */
export function defaultOutputSink(engine: EvalEngineValue, target: EngineTargetInput): string {
  if (engine === EvalEngine.CodeWritten) {
    // Path B writes the eval suite + its results in the target's own tree.
    return ".mutagent-evaluator/code-evals/";
  }
  // Path A. On a CODE framework the built agent emits logs/traces HERE for the
  // matrix judge to read; on a harness target the judge reads CC transcripts
  // directly, but the verdicts + scorecard still land under the run dir.
  return isFrameworkTarget(target)
    ? ".mutagent-evaluator/agent-logs/"
    : ".mutagent-evaluator/runs/";
}

/**
 * The target-conditional ENGINE MENU (F9). A code framework offers BOTH paths
 * (Path A + Path B); a `harness:*` target is native-only. The Claude-Code
 * dependency + the log-sink requirement are SURFACED on each option (F7) so the
 * picker never silently traps a user in the matrix. Deterministic order:
 * code-written first (the recommended, portable default for a framework), then
 * native-matrix. PURE.
 */
export function chooseEvalEngineOptions(target: EngineTargetInput): EvalEngineOption[] {
  const framework = isFrameworkTarget(target);
  const nativeNeedsSink = framework; // a code framework must emit to a sink (F9)
  const nativeOption: EvalEngineOption = {
    engine: EvalEngine.NativeMatrix,
    label: "Path A — mutagent native eval-matrix (LLM-judge sub-agents)",
    summary: framework
      ? "Eval-matrix judged by Claude-Code sub-agents. Requires a Claude-Code host AND the " +
        "built agent to emit logs/traces to a known sink for the judge to read."
      : "Eval-matrix judged by Claude-Code sub-agents reading the harness session transcripts. " +
        "Requires a Claude-Code host.",
    requiresClaudeCode: true,
    requiresLogSink: nativeNeedsSink,
    portable: false,
    recommended: !framework, // native is the only (thus default) choice for a harness
  };
  if (!framework) {
    // harness:* — native-only (no target language for portable code-written evals).
    return [nativeOption];
  }
  const codeOption: EvalEngineOption = {
    engine: EvalEngine.CodeWritten,
    label: `Path B — code-written evals in ${target.runtime}/${target.targetFramework}`,
    summary:
      "Evals written in the target's own language: deterministic code-checks + an LLM-judge " +
      "call via SDK + eval-criteria checks. Portable — runs WITHOUT Claude Code.",
    requiresClaudeCode: false,
    requiresLogSink: false,
    portable: true,
    recommended: true, // portability-first default for a code framework
  };
  return [codeOption, nativeOption];
}

/**
 * Gate: an engine choice must MATCH the target (F9). `code-written` needs a
 * target LANGUAGE — it is rejected on a `harness:*` target. `native-matrix`
 * matches any target. THROWS (fail-loud, no silent re-route). PURE.
 */
export function assertEngineMatchesTarget(
  engine: EvalEngineValue,
  target: EngineTargetInput,
): void {
  if (engine === EvalEngine.CodeWritten && !isFrameworkTarget(target)) {
    throw new Error(
      `assertEngineMatchesTarget: code-written evals require a code-FRAMEWORK target ` +
        `with a writable language, but target_framework='${target.targetFramework}' is a ` +
        `harness target. A harness target is native-matrix only (Path A). ` +
        `Choose native-matrix or re-target to a code framework.`,
    );
  }
}

/**
 * Resolve a user's engine choice into the RESOLVED plan `*evaluate` runs against.
 * Surfaces the Path-A dependencies (Claude Code + log sink) explicitly. Unknown
 * engine → THROW (no silent default). PURE.
 */
export function resolveEvalEngine(
  choice: EvalEngineValue,
  target: EngineTargetInput,
): EvalEnginePlan {
  if (choice !== EvalEngine.NativeMatrix && choice !== EvalEngine.CodeWritten) {
    throw new Error(
      `resolveEvalEngine: unknown eval engine '${String(choice)}'. ` +
        `Choose one of {${EvalEngine.NativeMatrix}, ${EvalEngine.CodeWritten}}.`,
    );
  }
  assertEngineMatchesTarget(choice, target);
  const framework = isFrameworkTarget(target);
  const requiresClaudeCode = choice === EvalEngine.NativeMatrix;
  const requiresLogSink = choice === EvalEngine.NativeMatrix && framework;
  const outputSink = defaultOutputSink(choice, target);
  const rationale =
    choice === EvalEngine.CodeWritten
      ? `Code-written evals in ${target.runtime}/${target.targetFramework} — portable, ` +
        `runs without Claude Code (F14). Results land in ${outputSink}.`
      : framework
        ? `Native eval-matrix judged by Claude-Code sub-agents. The built agent MUST emit ` +
          `logs/traces to ${outputSink} for the judge to read (F9).`
        : `Native eval-matrix judged by Claude-Code sub-agents reading the harness ` +
          `session transcripts directly.`;
  return {
    engine: choice,
    target,
    targetIsFramework: framework,
    requiresClaudeCode,
    requiresLogSink,
    outputSink,
    rationale,
  };
}
