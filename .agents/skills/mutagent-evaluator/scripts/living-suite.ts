/**
 * scripts/living-suite.ts — EV-053 the append-only LIVING-SUITE writer (Type A — Code-only).
 * ---------------------------------------------------------------------------
 * The cross-cutting monotonic-growth primitive shared by the eval-suite (the
 * discovered criteria / judges) AND the datasets (`*build-dataset` /
 * `*derive-dataset`). Its single invariant: a living artifact NEVER shrinks —
 * every entry once added is retained; appends only grow it.
 *
 * Generic over the entry type `T` + a caller-supplied `keyOf` so it serves any
 * keyed collection (DatasetCase by id, DiscoveredCriterion by id, …). Carries
 * provenance (a monotonically-increasing version + counts) WITHOUT a clock —
 * stamping `appendedAt` would break byte-identity (C-PIN), so provenance is a
 * pure counter. PURE — no clock / random / network; same (suite, incoming) →
 * same grown suite.
 *
 * Austerity: holds NO LLM reasoning, makes NO pass/fail decision — it is pure
 * set algebra with a fail-loud monotonicity guard. The dataset scripts route
 * their appends through `appendOnly` + `assertMonotonicGrowth` here.
 */

/**
 * Append `incoming` onto `existing`, deduped by `keyOf`, MONOTONICALLY: every
 * existing entry is retained (in its original order) and only entries with a
 * not-yet-seen key are appended (in input order). DETERMINISTIC. PURE.
 */
export function appendOnly<T>(existing: T[], incoming: T[], keyOf: (t: T) => string): T[] {
  const seen = new Set(existing.map(keyOf));
  const out = [...existing];
  for (const item of incoming) {
    const k = keyOf(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/**
 * Enforce the monotonic-growth invariant: every key present in `before` MUST
 * still be present in `after`, and the set never shrinks. THROWS on any
 * violation — a living suite/dataset that lost an entry is a contract breach
 * (EV-053), never silently accepted. PURE.
 */
export function assertMonotonicGrowth<T>(
  before: T[],
  after: T[],
  keyOf: (t: T) => string,
): void {
  const afterKeys = new Set(after.map(keyOf));
  for (const b of before) {
    const k = keyOf(b);
    if (!afterKeys.has(k)) {
      throw new Error(
        `assertMonotonicGrowth: entry '${k}' was DROPPED — a living suite must never ` +
          "shrink (EV-053). Appends may only grow the set.",
      );
    }
  }
  if (after.length < before.length) {
    throw new Error(
      `assertMonotonicGrowth: suite shrank from ${before.length} to ${after.length} entries ` +
        "(EV-053 monotonic-growth violation).",
    );
  }
}

/** Provenance for a living suite — a pure counter (NO clock, for byte-identity). */
export interface SuiteProvenance {
  /** monotonically-increasing version, bumped on every append. */
  version: number;
  /** total entries after the append. */
  total: number;
  /** how many genuinely-novel entries the last append added. */
  lastAppended: number;
}

/** A keyed, append-only growing collection. */
export interface LivingSuite<T> {
  entries: T[];
  provenance: SuiteProvenance;
}

/** A fresh empty living suite (version 0, no entries). PURE. */
export function emptySuite<T>(): LivingSuite<T> {
  return { entries: [], provenance: { version: 0, total: 0, lastAppended: 0 } };
}

/**
 * Grow a living suite by appending `incoming` (deduped by `keyOf`). Enforces the
 * monotonic-growth invariant, bumps the version, and records how many novel
 * entries landed. Returns a NEW suite (no mutation). DETERMINISTIC. PURE.
 */
export function growLivingSuite<T>(
  suite: LivingSuite<T>,
  incoming: T[],
  keyOf: (t: T) => string,
): LivingSuite<T> {
  const entries = appendOnly(suite.entries, incoming, keyOf);
  assertMonotonicGrowth(suite.entries, entries, keyOf);
  return {
    entries,
    provenance: {
      version: suite.provenance.version + 1,
      total: entries.length,
      lastAppended: entries.length - suite.entries.length,
    },
  };
}
