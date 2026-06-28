/**
 * scripts/contract/agentspec.schema.ts
 * TypeBox schema + TypeScript types for the portable agentspec.yaml (agentspec.v0.2.0).
 * Type A — Pure Script (schema + types + a pure validate function — no I/O side effects).
 *
 * The agentspec.yaml is the ADL ① SPEC Definition: WHAT an agent IS, framework-independent
 * (PR-001 def/impl separation). It has four top-level blocks:
 *   - meta       — canonical identity (spec_id) + loop position (loop_state). NO downstream links
 *                  (PR-013 backwards-only linking): the spec never enumerates its subjects/impls.
 *   - definition — the interface: persona · system_prompt · jobs · context_sources · tools ·
 *                  agent_type · triggers · modeling · sop · evals. Descriptions are VERBOSE
 *                  (PR-015) — the primary field the implementing LLM reads.
 *   - build      — the implementation target (guided choice). target_framework is a String so it
 *                  accepts `harness:*` + future targets (PR-005 target-may-be-a-harness). `runtime`
 *                  is pinned at spec-time so *build implements ONCE (no pick-then-rebuild — dogfood F4).
 *   - appendix   — pinned framework doc roots the *build agent crawls FRESH (PR-002), + references.
 *
 * Every object is CLOSED (additionalProperties:false) so an undeclared field — a typo or a
 * smuggled downstream `links` block — is REJECTED rather than silently passed (PR-013).
 *
 * Mirrors the handover-contract.ts validation pattern: a compiled TypeCompiler checker + a pure
 * `validateAgentSpec(obj) => { ok, errors[] }`. Fail-loud, never throws.
 */

import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

/**
 * The FROZEN spec schema version. Bump only via an explicit, reviewed migration.
 * 0.1.0 → 0.2.0 (dogfood-driven migration): evals gains required `scenarios` + `dataset_categories`
 * (F1/F2 — the spec must carry the situations the agent handles + the golden eval-suite slices), and
 * build gains a required `runtime` pin (F4 — implement once, no bash→Bun rebuild).
 */
export const AGENTSPEC_SCHEMA_VERSION = "0.2.0" as const;

// ── Categorical constants (no magic strings) ───────────────────────────────────

/** Identity kind — what the spec describes. A2A-aligned. */
export const IdentityKind = {
  Agent: "agent",
  Skill: "skill",
  Composite: "composite",
} as const;
export type IdentityKindValue = (typeof IdentityKind)[keyof typeof IdentityKind];

/** Where the agent's context comes from. */
export const ContextSourceKind = {
  Api: "api",
  Saas: "saas",
  InternalService: "internal-service",
  Mcp: "mcp",
  Cli: "cli",
} as const;
export type ContextSourceKindValue =
  (typeof ContextSourceKind)[keyof typeof ContextSourceKind];

/** Integration-tool binding kind. Binding preference is target-conditional (revised PR-004):
 *  CLI-first for harness targets, MCP/Composio/SDK-first for code-frameworks. */
export const IntegrationKind = {
  Cli: "cli",
  Saas: "saas",
  Mcp: "mcp",
} as const;
export type IntegrationKindValue =
  (typeof IntegrationKind)[keyof typeof IntegrationKind];

/** The agent's top-level type. */
export const AgentType = {
  Conversational: "conversational",
  Automation: "automation",
  Orchestrator: "orchestrator",
} as const;
export type AgentTypeValue = (typeof AgentType)[keyof typeof AgentType];

/**
 * How the DESIGNED agent is ACTIVATED — its inbound event sources (PR-017). DISTINCT from the
 * in-system *monitor agent: these are the designed agent's own triggers, not loop re-entry events.
 */
export const TriggerKind = {
  A2a: "a2a",
  Webhook: "webhook",
  Schedule: "schedule",
  Queue: "queue",
  Event: "event",
  Mcp: "mcp",
  Manual: "manual",
} as const;
export type TriggerKindValue = (typeof TriggerKind)[keyof typeof TriggerKind];

/** Eval criterion check type — binary-actionable (PR-019). */
export const EvalType = {
  LlmJudge: "llm-judge",
  CodeCheck: "code-check",
} as const;
export type EvalTypeValue = (typeof EvalType)[keyof typeof EvalType];

/** ADL loop stage the spec currently sits at (meta.loop_state.stage, PR-010). */
export const LoopStage = {
  Spec: "spec",
  Build: "build",
  Eval: "eval",
  Ship: "ship",
  Diagnose: "diagnose",
  Discover: "discover",
  Improve: "improve",
} as const;
export type LoopStageValue = (typeof LoopStage)[keyof typeof LoopStage];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** A closed object — undeclared fields rejected (PR-013 leak/typo catch). */
function closed<T extends Parameters<typeof Type.Object>[0]>(props: T) {
  return Type.Object(props, { additionalProperties: false });
}

// ── META ────────────────────────────────────────────────────────────────────────

/**
 * Loop position. The spec IS the subject record (PR-010): loop_state lives here, not in a
 * separate registry. `last_verdict` is optional (a freshly-spec'd agent has none yet).
 */
export const LoopStateSchema = closed({
  stage: Type.Union([
    Type.Literal(LoopStage.Spec),
    Type.Literal(LoopStage.Build),
    Type.Literal(LoopStage.Eval),
    Type.Literal(LoopStage.Ship),
    Type.Literal(LoopStage.Diagnose),
    Type.Literal(LoopStage.Discover),
    Type.Literal(LoopStage.Improve),
  ]),
  last_verdict: Type.Optional(Type.String()),
  updated_at: Type.String({ minLength: 1 }),
});
export type LoopState = Static<typeof LoopStateSchema>;

/**
 * Canonical identity + loop position. `spec_id` is the stable identity anchor that survives every
 * version (PR-012). NOTE: there is intentionally NO downstream `links`/`subjects` field — the spec
 * is implementation-agnostic and never enumerates its impls (PR-013 backwards-only linking).
 */
export const MetaSchema = closed({
  spec_id: Type.String({ minLength: 1 }),
  spec_version: Type.String({ minLength: 1 }),
  loop_state: LoopStateSchema,
});
export type Meta = Static<typeof MetaSchema>;

// ── DEFINITION ───────────────────────────────────────────────────────────────────

/** A2A-aligned identity. */
export const IdentitySchema = closed({
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal(IdentityKind.Agent),
    Type.Literal(IdentityKind.Skill),
    Type.Literal(IdentityKind.Composite),
  ]),
});
export type Identity = Static<typeof IdentitySchema>;

/** Who the agent IS — role + verbose persona (PR-014 first-class fields). */
export const PersonaSchema = closed({
  role: Type.String({ minLength: 1 }),
  persona: Type.String({ minLength: 1 }),
});
export type Persona = Static<typeof PersonaSchema>;

/**
 * A job-to-be-done (the "Requirements"). Verbose description + expected output (PR-015).
 * `backed_by` (optional, PR-024) names the `tools.code[].id`s that IMPLEMENT this job — the spec-time
 * signal of which jobs are code-backed vs NL-only. The build-faithfulness gate validates these refs
 * resolve and that each backing tool is implemented + tested. Additive/optional — no version bump.
 */
export const JobSchema = closed({
  id: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  expected_output: Type.String({ minLength: 1 }),
  backed_by: Type.Optional(Type.Array(Type.String())),
});
export type Job = Static<typeof JobSchema>;

/** What context the agent needs + where it comes from (PR-015 verbose). */
export const ContextSourceSchema = closed({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal(ContextSourceKind.Api),
    Type.Literal(ContextSourceKind.Saas),
    Type.Literal(ContextSourceKind.InternalService),
    Type.Literal(ContextSourceKind.Mcp),
    Type.Literal(ContextSourceKind.Cli),
  ]),
  description: Type.String({ minLength: 1 }),
  where_from: Type.String({ minLength: 1 }),
  auth_ref: Type.Optional(Type.String()),
});
export type ContextSource = Static<typeof ContextSourceSchema>;

/** An integration tool (CLI / SaaS / MCP). Binding preference is target-conditional (revised PR-004):
 *  CLI-first for harness targets, MCP/Composio/SDK-first for code-frameworks. */
export const IntegrationToolSchema = closed({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal(IntegrationKind.Cli),
    Type.Literal(IntegrationKind.Saas),
    Type.Literal(IntegrationKind.Mcp),
  ]),
  ref: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
});
export type IntegrationTool = Static<typeof IntegrationToolSchema>;

/** A code tool the agent can run (verbose description, sandbox flag). */
export const CodeToolSchema = closed({
  id: Type.String({ minLength: 1 }),
  lang: Type.String({ minLength: 1 }),
  sandbox: Type.Boolean(),
  description: Type.String({ minLength: 1 }),
});
export type CodeTool = Static<typeof CodeToolSchema>;

/** A reusable skill the agent invokes. */
export const SkillToolSchema = closed({
  id: Type.String({ minLength: 1 }),
  ref: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
});
export type SkillTool = Static<typeof SkillToolSchema>;

/**
 * A sub-agent the designed agent dispatches. Verbose description + instructions; optional tools /
 * model. `model` is honored verbatim downstream (PR-003 model-intent-sacred).
 */
export const SubagentToolSchema = closed({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  instructions: Type.String({ minLength: 1 }),
  tools: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
});
export type SubagentTool = Static<typeof SubagentToolSchema>;

/** The four tool buckets, each with verbose descriptions (PR-015). */
export const ToolsSchema = closed({
  integration: Type.Array(IntegrationToolSchema),
  code: Type.Array(CodeToolSchema),
  skills: Type.Array(SkillToolSchema),
  subagents: Type.Array(SubagentToolSchema),
});
export type Tools = Static<typeof ToolsSchema>;

/** How THIS agent is ACTIVATED — its inbound event sources (PR-017, distinct from *monitor). */
export const TriggerSchema = closed({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal(TriggerKind.A2a),
    Type.Literal(TriggerKind.Webhook),
    Type.Literal(TriggerKind.Schedule),
    Type.Literal(TriggerKind.Queue),
    Type.Literal(TriggerKind.Event),
    Type.Literal(TriggerKind.Mcp),
    Type.Literal(TriggerKind.Manual),
  ]),
  description: Type.String({ minLength: 1 }),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Trigger = Static<typeof TriggerSchema>;

/** A LangGraph-aligned decision-graph edge. */
export const GraphEdgeSchema = closed({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  condition: Type.Optional(Type.String()),
});
export type GraphEdge = Static<typeof GraphEdgeSchema>;

/** The decision graph (LangGraph-aligned) + freeform workflows. */
export const ModelingSchema = closed({
  decision_graph: closed({
    state: Type.String({ minLength: 1 }),
    nodes: Type.Array(Type.String()),
    edges: Type.Array(GraphEdgeSchema),
  }),
  workflows: Type.Array(Type.String()),
});
export type Modeling = Static<typeof ModelingSchema>;

/** A standardized SOP entry: when + context + procedure (+ optional outcomes) (PR-016). */
export const SopEntrySchema = closed({
  id: Type.String({ minLength: 1 }),
  when: Type.String({ minLength: 1 }),
  context: Type.String({ minLength: 1 }),
  procedure: Type.String({ minLength: 1 }),
  on_outcome: Type.Optional(
    closed({
      success: Type.Optional(Type.String()),
      failure: Type.Optional(Type.String()),
    }),
  ),
});
export type SopEntry = Static<typeof SopEntrySchema>;

/** A binary-actionable success criterion (PR-019 append-extensible). */
export const SuccessCriterionSchema = closed({
  id: Type.String({ minLength: 1 }),
  criterion: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal(EvalType.LlmJudge),
    Type.Literal(EvalType.CodeCheck),
  ]),
  goal: Type.String({ minLength: 1 }),
});
export type SuccessCriterion = Static<typeof SuccessCriterionSchema>;

/**
 * A representative SCENARIO the agent must handle (dogfood F1). This is the situation the agent
 * faces + the behavior a correct agent exhibits — the seed material an evaluator turns into eval
 * items. `category` groups it under a dataset_categories slice; `edge_case` flags the hard/adversarial
 * situations a naive spec forgets. Verbose descriptions (PR-015).
 */
export const ScenarioSchema = closed({
  id: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  expected_behavior: Type.String({ minLength: 1 }),
  category: Type.Optional(Type.String()),
  edge_case: Type.Optional(Type.Boolean()),
});
export type Scenario = Static<typeof ScenarioSchema>;

/**
 * A DATASET CATEGORY — a slice of the golden eval-suite the *eval stage must cover (dogfood F2).
 * Each category is a use-case bucket (by job / situation) with the explicit edge_cases it must
 * exercise. This is the dataset DEFINITION the spec hands to the evaluator (seed, don't duplicate,
 * PR-018). Verbose descriptions (PR-015).
 */
export const DatasetCategorySchema = closed({
  id: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  edge_cases: Type.Array(Type.String()),
});
export type DatasetCategory = Static<typeof DatasetCategorySchema>;

/**
 * Evals block — the eval design the spec carries forward (PR-019 append-extensible):
 *   - success_criteria — binary-actionable pass/fail criteria
 *   - scenarios — the situations the agent must handle (dogfood F1)
 *   - dataset_categories — the golden eval-suite slices + edge-cases the dataset must cover (F2)
 * All three are required keys (the 0.2.0 migration); each array may be empty structurally, but the
 * interview + worked template populate them richly.
 */
export const EvalsSchema = closed({
  success_criteria: Type.Array(SuccessCriterionSchema),
  scenarios: Type.Array(ScenarioSchema),
  dataset_categories: Type.Array(DatasetCategorySchema),
});
export type Evals = Static<typeof EvalsSchema>;

/** The Definition — the interface (WHAT the agent is). */
export const DefinitionSchema = closed({
  identity: IdentitySchema,
  persona: PersonaSchema,
  // The ACTUAL operative system prompt the runtime sends — the full text, not a summary (PR-014).
  system_prompt: Type.String({ minLength: 1 }),
  jobs_to_be_done: Type.Array(JobSchema),
  context_sources: Type.Array(ContextSourceSchema),
  tools: ToolsSchema,
  agent_type: Type.Union([
    Type.Literal(AgentType.Conversational),
    Type.Literal(AgentType.Automation),
    Type.Literal(AgentType.Orchestrator),
  ]),
  triggers: Type.Array(TriggerSchema),
  modeling: ModelingSchema,
  sop: Type.Array(SopEntrySchema),
  evals: EvalsSchema,
});
export type Definition = Static<typeof DefinitionSchema>;

// ── BUILD ────────────────────────────────────────────────────────────────────────

/**
 * The implementation target (guided choice, lives INSIDE the spec so editing it cascade-updates
 * the impl, PR-001). `target_framework` is a STRING, not a closed Union — it must accept framework
 * targets (mastra · deepagents · pydantic-ai · langgraph) AND harness targets (`harness:claude-code`,
 * `harness:codex`, `harness:<other>`) AND not-yet-enumerated future targets (PR-005).
 *
 * Example values: "mastra" | "deepagents" | "pydantic-ai" | "langgraph" |
 *                 "harness:claude-code" | "harness:codex" | "harness:<other>".
 *
 * `runtime` is the execution runtime the implementation targets ("bun" | "node" | "deno" | "python"
 * | "shell" | …) — pinned at SPEC time so the *build agent implements ONCE. Dogfood F4: lab-overseer
 * was built in bash then re-built in Bun because the runtime was never pinned; this closes that gap.
 */
export const BuildSchema = closed({
  target_framework: Type.String({ minLength: 1 }),
  runtime: Type.String({ minLength: 1 }),
  target_eval_framework: Type.String({ minLength: 1 }),
});
export type Build = Static<typeof BuildSchema>;

// ── APPENDIX ──────────────────────────────────────────────────────────────────────

/**
 * Pinned references the *build agent crawls FRESH at build time (PR-002 fetched-at-build).
 * `framework_docs` maps a framework id → its doc-root URLs; PIN the roots, never vendor the bodies.
 */
export const AppendixSchema = closed({
  framework_docs: Type.Record(Type.String(), Type.Array(Type.String())),
  references: Type.Array(Type.String()),
});
export type Appendix = Static<typeof AppendixSchema>;

// ── ROOT ──────────────────────────────────────────────────────────────────────────

/** The full agentspec.v0.1.0 contract. Closed object — undeclared top-level fields rejected. */
export const AgentSpecSchema = closed({
  schema_version: Type.Literal(AGENTSPEC_SCHEMA_VERSION),
  meta: MetaSchema,
  definition: DefinitionSchema,
  build: BuildSchema,
  appendix: AppendixSchema,
});
export type AgentSpec = Static<typeof AgentSpecSchema>;

// ── Validation ──────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

// Compiled checker — compiled once at module load (mirrors handover-contract.ts).
const AgentSpecChecker = TypeCompiler.Compile(AgentSpecSchema);

/**
 * Validate an arbitrary value against the agentspec.v0.1.0 contract.
 *
 * STRUCTURAL floor: the compiled TypeBox checker. Catches missing / wrong-typed / out-of-enum /
 * non-frozen-version fields AND undeclared extra fields (additionalProperties:false — the
 * typo / smuggled-downstream-link case, PR-013).
 *
 * Pure: no I/O, no clock. Never throws — a non-object input yields ok:false.
 */
export function validateAgentSpec(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!AgentSpecChecker.Check(obj)) {
    for (const e of AgentSpecChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
