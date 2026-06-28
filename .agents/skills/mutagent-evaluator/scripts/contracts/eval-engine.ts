/**
 * scripts/contracts/eval-engine.ts — the ADL EVAL-stage ENGINE FORK contract.
 * ---------------------------------------------------------------------------
 * The TypeBox companion for the F7/F9/F14 eval-implementation fork: when the ADL
 * `*build` stage hands a freshly-built agent to the evaluator, the user must
 * choose HOW the eval suite is implemented. Two engines:
 *
 *   - Path A — `native-matrix`  (mutagent NATIVE evals): the eval-matrix format
 *     judged by LLM-as-judge SUB-AGENTS. HARD DEPENDENCY on a Claude-Code host
 *     to spawn the judge sub-agents. For a CODE-framework target (Mastra/TS) the
 *     native matrix ALSO requires the built agent to EMIT logs/traces to a known
 *     output SINK (CC session transcripts / a declared log file) for the judge to
 *     read. Surfaced UP FRONT so a user is never silently "stuck with the matrix".
 *   - Path B — `code-written`  (CODE-written evals): evals written in the target's
 *     OWN language (bun/TS for Mastra) — deterministic code-checks + an LLM-judge
 *     call VIA SDK + eval-criteria checks. PORTABLE — needs NO Claude-Code
 *     sub-agents, so a non-CC user is NOT trapped in the matrix (F14).
 *
 * The fork is TARGET-CONDITIONAL (F9): a code-framework target (e.g. Mastra/TS)
 * may pick EITHER engine; a harness target (harness:claude-code) is native-only.
 * This file declares the DATA (the menu options + the resolved plan + the gates);
 * the AskUserQuestion gate + the actual codegen live elsewhere. Subject-agnostic.
 *
 * Standalone: this skill NEVER imports the agentspec schema (cross-skill import is
 * banned). It consumes a MINIMAL local slice (`EngineTargetInput`) the caller maps
 * from the agentspec's `build` block. PURE — no clock / random / network.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── EvalEngine — the two implementation paths (the fork) ─────────────────────
export const EvalEngine = {
  /** Path A — mutagent native eval-matrix + LLM-judge SUB-AGENTS (needs a CC host). */
  NativeMatrix: "native-matrix",
  /** Path B — code-written evals in the target's language (portable, no CC sub-agents). */
  CodeWritten: "code-written",
} as const;
export type EvalEngineValue = (typeof EvalEngine)[keyof typeof EvalEngine];

// ── EngineTargetInput — the MINIMAL slice the caller maps from agentspec.build ─
//
// We do NOT import the agentspec contract (standalone skill). The caller reads
// `agentspec.build.{target_framework, runtime}` and hands us this slice.
export const EngineTargetInputSchema = Type.Object(
  {
    /** e.g. "mastra" | "deepagents" | "langgraph" | "harness:claude-code" | "harness:codex". */
    targetFramework: Type.String({ minLength: 1 }),
    /** e.g. "bun" | "node" | "deno" | "python" | "shell". */
    runtime: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type EngineTargetInput = Static<typeof EngineTargetInputSchema>;

// ── EvalEngineOption — one selectable menu entry (target-conditional) ─────────
//
// What the AskUserQuestion gate renders. `requiresClaudeCode` + `requiresLogSink`
// are the F7/F9 SURFACED dependencies — shown UP FRONT, never discovered late.
export const EvalEngineOptionSchema = Type.Object(
  {
    engine: Type.Union([
      Type.Literal(EvalEngine.NativeMatrix),
      Type.Literal(EvalEngine.CodeWritten),
    ]),
    /** short human label for the picker. */
    label: Type.String({ minLength: 1 }),
    /** one-line description of what this engine does for THIS target. */
    summary: Type.String({ minLength: 1 }),
    /** TRUE iff this engine needs a Claude-Code host to spawn judge sub-agents (Path A). */
    requiresClaudeCode: Type.Boolean(),
    /** TRUE iff this engine needs the built agent to emit logs/traces to a sink (F9). */
    requiresLogSink: Type.Boolean(),
    /** TRUE iff this engine is portable to a non-CC user (Path B). */
    portable: Type.Boolean(),
    /** TRUE iff this is the recommended default for the target. */
    recommended: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type EvalEngineOption = Static<typeof EvalEngineOptionSchema>;

// ── EvalEnginePlan — the RESOLVED choice (what *evaluate runs against) ────────
export const EvalEnginePlanSchema = Type.Object(
  {
    engine: Type.Union([
      Type.Literal(EvalEngine.NativeMatrix),
      Type.Literal(EvalEngine.CodeWritten),
    ]),
    target: EngineTargetInputSchema,
    /** TRUE iff the target is a coding-FRAMEWORK (vs a `harness:*` target). */
    targetIsFramework: Type.Boolean(),
    /** the SURFACED dependency: needs a CC host (Path A). */
    requiresClaudeCode: Type.Boolean(),
    /**
     * the SURFACED dependency: the built agent must emit logs/traces to THIS sink
     * for the native matrix judge to read it. Present iff `requiresLogSink`.
     */
    requiresLogSink: Type.Boolean(),
    /** the discoverable OUTPUT SINK the engine writes to (always set — discoverability gate). */
    outputSink: Type.String({ minLength: 1 }),
    /** human-readable rationale (echoed into the entity card + report). */
    rationale: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type EvalEnginePlan = Static<typeof EvalEnginePlanSchema>;

/** Parse + narrow an EvalEnginePlan (guarded). THROWS on schema violation. PURE. */
export function parseEvalEnginePlan(value: unknown): EvalEnginePlan {
  if (!Value.Check(EvalEnginePlanSchema, value)) {
    const first = [...Value.Errors(EvalEnginePlanSchema, value)][0];
    throw new Error(
      `parseEvalEnginePlan: schema violation at '${first?.path ?? "(root)"}': ` +
        `${first?.message ?? "invalid EvalEnginePlan"}`,
    );
  }
  return value;
}
