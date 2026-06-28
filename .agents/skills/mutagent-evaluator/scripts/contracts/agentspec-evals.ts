/**
 * scripts/contracts/agentspec-evals.ts — the MINIMAL agentspec.evals slice the
 * EVAL stage consumes (standalone — NEVER imports the agentspec skill's schema).
 * ---------------------------------------------------------------------------
 * The ADL `*build` stage emits an agentspec whose `definition.evals` block carries
 * the SEED material the evaluator materializes into a real dataset (F8) + criteria:
 *
 *   - dataset_categories[] — `{ id, description, edge_cases[] }` — the golden
 *     eval-suite slices + the explicit edge_cases each must exercise (the dataset
 *     DEFINITION the spec hands forward; "seed, don't duplicate").
 *   - scenarios[]          — `{ id, description, expected_behavior, category?,
 *     edge_case? }` — representative situations + the correct behavior (extra seed
 *     material, optionally tagged into a category).
 *   - success_criteria[]   — `{ id, criterion, type, goal }` — binary-actionable
 *     pass/fail criteria (type ∈ llm-judge | code-check).
 *
 * We DECLARE only the fields we read, with `additionalProperties: true` on the
 * objects so a richer agentspec still parses (forward-compatible). The cross-skill
 * import ban (coding-rules "Sealed-Sibling" + standalone discipline) is why this is
 * a local re-declaration, not an import. PURE — no clock / random / network.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A dataset CATEGORY slice + the edge-cases it must exercise. */
export const AgentspecDatasetCategorySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    edge_cases: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);
export type AgentspecDatasetCategory = Static<typeof AgentspecDatasetCategorySchema>;

/** A representative SCENARIO (the situation + correct behavior). */
export const AgentspecScenarioSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    expected_behavior: Type.String({ minLength: 1 }),
    category: Type.Optional(Type.String()),
    edge_case: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
export type AgentspecScenario = Static<typeof AgentspecScenarioSchema>;

/** A binary-actionable SUCCESS CRITERION. */
export const AgentspecSuccessCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    criterion: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("llm-judge"), Type.Literal("code-check")]),
    goal: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);
export type AgentspecSuccessCriterion = Static<typeof AgentspecSuccessCriterionSchema>;

/** The `definition.evals` slice. Each array may be empty structurally. */
export const AgentspecEvalsSchema = Type.Object(
  {
    success_criteria: Type.Array(AgentspecSuccessCriterionSchema),
    scenarios: Type.Array(AgentspecScenarioSchema),
    dataset_categories: Type.Array(AgentspecDatasetCategorySchema),
  },
  { additionalProperties: true },
);
export type AgentspecEvals = Static<typeof AgentspecEvalsSchema>;

/**
 * Parse + narrow the agentspec.evals slice (guarded). THROWS on schema violation —
 * a malformed seed must never silently reach materialization. PURE.
 */
export function parseAgentspecEvals(value: unknown): AgentspecEvals {
  if (!Value.Check(AgentspecEvalsSchema, value)) {
    const first = [...Value.Errors(AgentspecEvalsSchema, value)][0];
    throw new Error(
      `parseAgentspecEvals: schema violation at '${first?.path ?? "(root)"}': ` +
        `${first?.message ?? "invalid agentspec evals slice"}`,
    );
  }
  return value;
}
