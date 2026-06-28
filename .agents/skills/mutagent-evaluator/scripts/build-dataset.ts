/**
 * scripts/build-dataset.ts — EV-046 `*build-dataset` deterministic half (Type A — DATA only).
 * ---------------------------------------------------------------------------
 * The Code-only piece of the 3-way `*build-dataset` Hybrid (operation-inventory):
 *   - HITL seed interview (~10 tuples)        → AskUserQuestion / chat gate
 *   - tuple gen · NL query · quality judgment  → `assets/agents/dataset-builder.md`
 *   - cartesian expand · dedup · near-dup · id · append  → THIS FILE
 *
 * Holds NO prompt prose and makes NO realism judgment (that is the agent's). It
 * only does the deterministic shape: enumerate the dimension cartesian product,
 * drop exact + near-duplicate cases, assign a content-derived id, and merge into
 * the growing dataset MONOTONICALLY (existing cases are never dropped). The
 * near-duplicate REMOVAL is deterministic token-Jaccard — the agent PROPOSES
 * realism, the script ENFORCES non-redundancy.
 *
 * PURE — no clock / random / network. Same (input) → same output (reproducible
 * datasets, C-PIN-adjacent). Subject-agnostic (dimensions are DATA).
 */
import {
  type Dataset,
  type DatasetCase,
  type DatasetTuple,
  type Dimension,
  type CaseSourceValue,
  tupleKey,
} from "./contracts/dataset.ts";
import { appendOnly, assertMonotonicGrowth } from "./living-suite.ts";

// ── cartesian tuples (generate-synthetic-data Step 2 mechanics) ──────────────

/** Guard so a pathological dimension set can't blow up memory. */
const DEFAULT_MAX_TUPLES = 5000;

/**
 * The full cartesian product of the dimensions' values, in a DETERMINISTIC
 * order (dimensions in given order, values in given order). THROWS if the
 * product would exceed `maxTuples` (fail-loud, not silent truncation). PURE.
 */
export function cartesianTuples(
  dimensions: Dimension[],
  maxTuples = DEFAULT_MAX_TUPLES,
): DatasetTuple[] {
  if (dimensions.length === 0) return [];
  const total = dimensions.reduce((n, d) => n * d.values.length, 1);
  if (total > maxTuples) {
    throw new Error(
      `cartesianTuples: ${total} combinations exceeds maxTuples=${maxTuples}. ` +
        "Reduce dimensions/values or raise the cap explicitly (no silent truncation).",
    );
  }
  let acc: DatasetTuple[] = [{}];
  for (const dim of dimensions) {
    const next: DatasetTuple[] = [];
    for (const partial of acc) {
      for (const v of dim.values) next.push({ ...partial, [dim.name]: v });
    }
    acc = next;
  }
  return acc;
}

/** Remove exact-duplicate tuples by canonical key, preserving first-seen order. PURE. */
export function dedupTuples(tuples: DatasetTuple[]): DatasetTuple[] {
  const seen = new Set<string>();
  const out: DatasetTuple[] = [];
  for (const t of tuples) {
    const k = tupleKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

// ── near-duplicate query filter (generate-synthetic-data Step 5) ─────────────

/** Normalize a query to a token set (lowercase word tokens). PURE. */
export function queryTokens(q: string): Set<string> {
  return new Set(
    q
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Token-set Jaccard similarity in [0,1]. Two empty sets → 1 (identical). PURE. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Drop cases whose query is ≥ `threshold` Jaccard-similar to an already-kept
 * case (the "queries too similar to each other" filter). DETERMINISTIC — first
 * occurrence in input order is kept. PURE.
 */
export function dedupNearQueries(cases: DatasetCase[], threshold = 0.8): DatasetCase[] {
  const keptTokens: Set<string>[] = [];
  const out: DatasetCase[] = [];
  for (const c of cases) {
    const toks = queryTokens(c.query);
    const dup = keptTokens.some((k) => jaccard(toks, k) >= threshold);
    if (!dup) {
      keptTokens.push(toks);
      out.push(c);
    }
  }
  return out;
}

// ── deterministic content-derived case id (no clock/random) ──────────────────

/** FNV-1a 32-bit hex of a string — a stable, dependency-free content hash. PURE. */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A stable id derived from the tuple + query (so re-builds collide → dedup). PURE. */
export function caseId(tuple: DatasetTuple, query: string): string {
  return `case-${fnv1aHex(`${tupleKey(tuple)}::${query}`)}`;
}

/** Assemble a DatasetCase with a content-derived id. PURE. */
export function buildCase(
  tuple: DatasetTuple,
  query: string,
  source: CaseSourceValue,
  originTraceId?: string,
  extra?: { selectedBy?: string; rationale?: string },
): DatasetCase {
  const c: DatasetCase = { id: caseId(tuple, query), tuple, query, source };
  if (originTraceId !== undefined) c.originTraceId = originTraceId;
  if (extra?.selectedBy !== undefined) c.selectedBy = extra.selectedBy;
  if (extra?.rationale !== undefined) c.rationale = extra.rationale;
  return c;
}

// ── monotonic merge into the growing dataset (EV-053 co-develop) ─────────────

/**
 * Merge incoming cases into existing, deduped by id AND near-duplicate query,
 * MONOTONICALLY — every existing case is retained (the suite never shrinks); only
 * genuinely-novel, non-near-duplicate incoming cases are added. DETERMINISTIC.
 * Routes the append through `living-suite.ts` (`appendOnly` for the id-dedup +
 * `assertMonotonicGrowth` for the EV-053 invariant); the near-duplicate-query
 * filter is the dataset-specific specialization layered on top.
 */
export function mergeCases(
  existing: DatasetCase[],
  incoming: DatasetCase[],
  threshold = 0.8,
): DatasetCase[] {
  const byId = new Set(existing.map((c) => c.id));
  // near-dup filter the novel cases against the existing queries first, then each other.
  const keptTokens: Set<string>[] = existing.map((c) => queryTokens(c.query));
  const novel: DatasetCase[] = [];
  for (const c of incoming) {
    if (byId.has(c.id)) continue;
    const toks = queryTokens(c.query);
    if (keptTokens.some((k) => jaccard(toks, k) >= threshold)) continue;
    keptTokens.push(toks);
    novel.push(c);
  }
  const out = appendOnly(existing, novel, (c) => c.id); // monotonic append via living-suite
  assertMonotonicGrowth(existing, out, (c) => c.id); // EV-053 invariant (fail-loud)
  return out;
}

/**
 * Append cases into a Dataset, bumping the version. MONOTONIC: `cases` only
 * grows. Returns a NEW Dataset (no mutation). DETERMINISTIC.
 */
export function appendToDataset(dataset: Dataset, incoming: DatasetCase[], threshold = 0.8): Dataset {
  const cases = mergeCases(dataset.cases, incoming, threshold);
  return { ...dataset, cases, version: dataset.version + 1 };
}
