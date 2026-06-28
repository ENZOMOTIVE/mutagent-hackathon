/**
 * scripts/materialize-dataset.ts — F8: MATERIALIZE real dataset items from the
 * agentspec (Type A — PURE). Seed → ACTUAL items, not just definitions.
 * ---------------------------------------------------------------------------
 * The ADL `*build` stage emits an agentspec whose `definition.evals` carries the
 * dataset DEFINITION (dataset_categories[] × edge_cases[]) + scenarios[]. The old
 * `*build-dataset` only had the dimensions/definitions; F8 requires it to
 * MATERIALIZE real, runnable DatasetCases — ≥1 per category, plus one per declared
 * edge_case — BEFORE the dataset-builder agent expands them synthetically.
 *
 * The materialized cases are the SEED layer (source: "seed"):
 *   - one BASE item per category — from a category-tagged scenario when present,
 *     else synthesized from the category description ("seed, don't duplicate").
 *   - one EDGE item per declared edge_case — query = the edge_case phrase in the
 *     category's context; flagged `edge_case: "true"` in its tuple.
 *
 * These are REAL queries (non-empty NL), not category definitions. The
 * dataset-builder agent then expands them; build-dataset.ts's deterministic
 * id/dedup/merge dedups any overlap. Subject-agnostic. DETERMINISTIC — stable
 * content-derived ids, scenarios/categories/edge_cases consumed in given order;
 * no clock / random / network → re-materializing is byte-identical (C-PIN).
 */
import {
  type Dataset,
  type DatasetCase,
  type DatasetTuple,
  type Dimension,
} from "./contracts/dataset.ts";
import type { AgentspecEvals, AgentspecScenario } from "./contracts/agentspec-evals.ts";
import { buildCase, appendToDataset } from "./build-dataset.ts";
import { CaseSource } from "./contracts/dataset.ts";

/** The literal tuple values for the boolean edge_case dimension (DatasetTuple is string-valued). */
const EDGE_TRUE = "true";
const EDGE_FALSE = "false";

/**
 * The dimensions the materialized dataset varies over: `category` (values = the
 * category ids) + `edge_case` (boolean). Subject-agnostic — derived from the
 * agentspec, never hard-coded. PURE.
 */
export function dimensionsFromAgentspec(evals: AgentspecEvals): Dimension[] {
  const categories = evals.dataset_categories.map((c) => c.id);
  const dims: Dimension[] = [];
  if (categories.length > 0) {
    dims.push({ name: "category", description: "the dataset-category slice", values: categories });
  }
  dims.push({ name: "edge_case", description: "is this an edge/adversarial case", values: [EDGE_FALSE, EDGE_TRUE] });
  return dims;
}

/** The first scenario tagged into `categoryId` (given order), if any. PURE. */
function baseScenarioFor(evals: AgentspecEvals, categoryId: string): AgentspecScenario | undefined {
  return evals.scenarios.find((s) => s.category === categoryId && s.edge_case !== true);
}

/** The base query for a category — the scenario text when tagged, else the description. PURE. */
function baseQueryFor(evals: AgentspecEvals, categoryId: string, description: string): string {
  const scenario = baseScenarioFor(evals, categoryId);
  return scenario !== undefined ? scenario.description : description;
}

/** The edge query for an edge_case phrase in a category context. PURE. */
function edgeQueryFor(categoryId: string, edgePhrase: string): string {
  // A real NL query expressing the edge condition in the category's context.
  return `[${categoryId}] handle the edge case: ${edgePhrase}`;
}

/**
 * MATERIALIZE real DatasetCases from the agentspec.evals seed (F8). For EACH
 * category: one base item (≥1 per category — the success gate) + one item per
 * declared edge_case (flagged edge_case). DETERMINISTIC, deduped by content id.
 * Returns [] for an empty evals block (no categories → no items). PURE.
 */
export function materializeFromAgentspec(evals: AgentspecEvals): DatasetCase[] {
  const out: DatasetCase[] = [];
  const seen = new Set<string>();
  const push = (tuple: DatasetTuple, query: string): void => {
    const c = buildCase(tuple, query, CaseSource.Seed);
    if (seen.has(c.id)) return; // content-id dedup (re-materialize collides → drop)
    seen.add(c.id);
    out.push(c);
  };
  for (const cat of evals.dataset_categories) {
    // base item — one real query per category.
    push(
      { category: cat.id, edge_case: EDGE_FALSE },
      baseQueryFor(evals, cat.id, cat.description),
    );
    // edge items — one real query per declared edge_case.
    for (const edge of cat.edge_cases) {
      if (edge.length === 0) continue;
      push({ category: cat.id, edge_case: EDGE_TRUE }, edgeQueryFor(cat.id, edge));
    }
  }
  return out;
}

/**
 * Assemble (or extend) a Dataset seeded with the materialized real items. When
 * `existing` is supplied, the materialized cases are merged MONOTONICALLY (no
 * duplicates, version bumps). Subject-agnostic. DETERMINISTIC. PURE.
 */
export function materializeToDataset(
  subject: string,
  evals: AgentspecEvals,
  existing?: Dataset,
): Dataset {
  const dimensions = dimensionsFromAgentspec(evals);
  const cases = materializeFromAgentspec(evals);
  const base: Dataset = existing ?? { subject, dimensions, cases: [], version: 0 };
  return appendToDataset(base, cases);
}
