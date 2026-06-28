/**
 * scripts/library/match.ts
 * R2.3 — library-first Tier-0 matching. Promoted regex patterns are matched
 * BEFORE the generic Tier-0 heuristics so a known failure mode is recognised
 * cheaply on the next run.
 * Type A — Pure Script (deterministic regex matching; library is loaded read-only).
 *
 * PRD-MP-07 (PR-037): Step 4.5 library-match is MANDATORY when this function
 * returns priors for the entity. The orchestrator MUST:
 *   1. Call matchLibraryPatterns() before runTier0ScanPlatformAware()
 *   2. Pass matches to runTier0ScanWithLibrary() (attaches 3× weight priors)
 *   3. When ≥1 approved prior exists: SKIP the Step 3.5 awareness mini-sample
 *      (shouldFireAwareness({priorSignalsRef}) will return fire:false)
 *   4. Record the skip in runMeta.exemptions or runMeta.decisions
 *
 * Library writes are approved-only (scripts/library/store.ts addPattern — operator gate).
 * Per-host storage: ~/.mutagent-diagnostics/library/ (gitignored).
 * 3× weight is HARD-CODED (Q15: not configurable — prevents tuning drift).
 */

import type { TraceMetadata } from "../normalize/trace.ts";
import type { LibraryPattern } from "./types.ts";
import { loadEntity } from "./store.ts";
import { entitySlug } from "./paths.ts";

export interface LibraryMatch {
  patternId: string;
  signal: string;
  /** Trace IDs that matched the pattern. */
  traceIds: string[];
  /** PRIOR_SIGNAL_WEIGHT applied (3×) — library priors outrank fresh Tier-0 signals. */
  weight: number;
}

/**
 * Build a deterministic text surface for a trace to match patterns against. Uses
 * stable, content-derived fields only (tags + agentId + platform). No clock/random.
 */
function traceText(t: TraceMetadata): string {
  const parts = [t.agentId ?? "", t.sourcePlatform, ...(t.tags ?? [])];
  return parts.join(" ");
}

/** Compile a library pattern to a RegExp, returning null on an invalid source. */
function compile(p: LibraryPattern): RegExp | null {
  try {
    return new RegExp(p.regex, p.flags ?? "");
  } catch {
    return null; // a malformed stored pattern is skipped, never throws.
  }
}

/**
 * R2.3 — match library patterns for an entity against a batch of traces. Returns
 * one LibraryMatch per pattern that hit at least one trace. Deterministic: patterns
 * iterate in stored order, traces in input order. The 3× prior weight is attached.
 */
export function matchLibraryPatterns(
  entityName: string,
  traces: TraceMetadata[],
  home?: string,
  weight: number = 3
): LibraryMatch[] {
  const entity = loadEntity(entitySlug(entityName), home);
  if (!entity || entity.patterns.length === 0) return [];

  const matches: LibraryMatch[] = [];
  for (const pattern of entity.patterns) {
    const re = compile(pattern);
    if (!re) continue;
    const hitIds: string[] = [];
    for (const t of traces) {
      if (re.test(traceText(t))) hitIds.push(t.traceId);
    }
    if (hitIds.length > 0) {
      matches.push({ patternId: pattern.patternId, signal: pattern.signal, traceIds: hitIds, weight });
    }
  }
  return matches;
}

/**
 * PRD-MP-07: Convenience predicate — true when the library has ≥1 approved prior
 * for the entity. The orchestrator uses this to decide whether to skip the
 * Step 3.5 awareness mini-sample (Q18: require ≥1 approved prior, not ≥3).
 *
 * NOTE: This does NOT run the match (no traces needed) — it checks whether the
 * entity record exists AND has at least one pattern. Callers that need actual
 * match counts should use matchLibraryPatterns(). For a pure existence check
 * (without loading match state), scripts/library/store.ts hasPriors() is sufficient.
 *
 * Preferred match-aware predicate: call matchLibraryPatterns() and check length.
 * This function provides a quick path when trace data is not yet available.
 */
export function hasLibraryPriors(entityName: string, home?: string): boolean {
  const entity = loadEntity(entitySlug(entityName), home);
  return entity !== null && entity.patterns.length > 0;
}

/**
 * PRD-MP-07: Build a priorSignalsRef string for matchLibraryPatterns results,
 * suitable for passing to shouldFireAwareness(). Returns undefined when no
 * matches so the awareness layer fires normally.
 *
 * Format: "<entity>:<matchCount> library hits" — stable, human-readable, grep-able.
 * Use this AFTER calling matchLibraryPatterns() to build the ref from actual hits.
 */
export function buildMatchPriorSignalsRef(
  entityName: string,
  matches: LibraryMatch[]
): string | undefined {
  if (matches.length === 0) return undefined;
  return `${entitySlug(entityName)}:${matches.length} library hits`;
}
