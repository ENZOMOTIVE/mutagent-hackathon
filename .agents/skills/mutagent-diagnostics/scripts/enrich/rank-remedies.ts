/**
 * scripts/enrich/rank-remedies.ts
 * W13-C (D-1): deterministic remedy-rank derivation.
 *
 * The orchestrator protocol (§8) states "Remedies: ranked by cost × correctness",
 * but no code implemented it — so `remedy.rank` reached the renderer as `undefined`
 * (one leg of the D-1 contract-triad desync). This module finally implements that
 * rule in code: `rank` is DERIVED here from the analyzer's `cost` + `correctness`
 * categoricals, never analyzer-supplied. That:
 *   1. guarantees every remedy carries a `rank` before render (no `RANK undefined`);
 *   2. removes an agent-discretion variance source — ranking is now reproducible
 *      (honors the variance program: deterministic, no LLM judgment on rank).
 *
 * `cost`/`correctness` themselves are analyzer-emitted and contract-required
 * (findings-contract.ts REQUIRED_REMEDY_FIELDS) — so they are guaranteed present
 * by the time this runs (Step 8.5 enricher, post Step-7.1 gate).
 *
 * Type A — Pure Script (deterministic, no I/O, no clock, no random).
 */

import type { Remedy } from "../normalize/trace.ts";

/** Categorical → ordinal weight. Higher correctness and LOWER cost are better. */
const CORRECTNESS_WEIGHT: Record<Remedy["correctness"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const COST_WEIGHT: Record<Remedy["cost"], number> = {
  // Lower cost is better, so it contributes MORE priority when cheaper.
  low: 3,
  medium: 2,
  high: 1,
};

/**
 * Priority score for a remedy — HIGHER means a better (higher-priority) remedy.
 *
 * Correctness is weighted to dominate cost: a correct-but-pricey fix outranks a
 * cheap-but-weak one. We achieve strict dominance by scaling correctness above the
 * cost range (cost ∈ [1..3] can never overturn a correctness step):
 *
 *   score = correctnessWeight * 10 + costWeight
 *
 * Deterministic: same inputs → same score, every run.
 */
export function remedyPriorityScore(remedy: Pick<Remedy, "cost" | "correctness">): number {
  return CORRECTNESS_WEIGHT[remedy.correctness] * 10 + COST_WEIGHT[remedy.cost];
}

/**
 * Assign a 1-based `rank` to every remedy by descending priority score
 * (lower rank = higher priority, per the canonical Remedy.rank contract).
 *
 * Pure: returns a new array of new remedy objects; the input is not mutated.
 * Stable + reproducible: score ties are broken deterministically by `remedyId`
 * ascending, so parallel-analyzer output ranks identically on every run.
 */
export function rankRemedies(remedies: readonly Remedy[]): Remedy[] {
  // Index-tag first so the sort is fully deterministic even on duplicate ids.
  const ordered = remedies
    .map((remedy, index) => ({ remedy, index }))
    .sort((a, b) => {
      const scoreDelta = remedyPriorityScore(b.remedy) - remedyPriorityScore(a.remedy);
      if (scoreDelta !== 0) return scoreDelta;
      // Tie-break 1: remedyId ascending (stable, content-addressed).
      const idDelta = a.remedy.remedyId.localeCompare(b.remedy.remedyId);
      if (idDelta !== 0) return idDelta;
      // Tie-break 2: original input order (never relies on Array.sort stability).
      return a.index - b.index;
    });

  return ordered.map(({ remedy }, i) => ({ ...remedy, rank: i + 1 }));
}
