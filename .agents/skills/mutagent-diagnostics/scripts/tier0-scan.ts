/**
 * scripts/tier0-scan.ts
 * Tier 0 static pattern scan — runs BEFORE any LLM call (PR-001)
 * Type A — Pure Script (deterministic pattern matching + counts)
 *
 * Reads a JSON array of TraceMetadata, computes signal counts, emits a structured
 * route-guess that tells the orchestrator whether to use dynamic-cluster or window-based slicing.
 *
 * R-SELF-11-a: When all traces share a single sourcePlatform, dispatches to the
 * per-platform Tier 0 module for richer signal extraction. Falls back to generic
 * path for mixed-platform or unknown batches.
 *
 * I-020: Relative threshold mode (PR-033). Anomaly detection uses per-session
 * p95/IQR comparisons instead of hardcoded numeric thresholds. Default: "relative".
 *
 * Usage: bun scripts/tier0-scan.ts <traces-metadata.json>
 */

import { readFileSync } from "fs";
import type { TraceMetadata, SourcePlatform } from "./normalize/trace.ts";

/**
 * I-020: Scan configuration for anomaly threshold mode (PR-033).
 */
export interface Tier0ScanConfig {
  /**
   * Threshold mode for latency anomaly detection.
   * "relative" (default): IQR-based per-session outlier detection — no hardcoded ms values.
   *   A trace is "high latency" if its latencyMs is above Q3 + 1.5 * IQR of the batch.
   *   Falls back to absolute when fewer than 4 latency samples are available.
   * "absolute" (legacy): fixed HIGH_LATENCY_MS = 10_000 ms threshold (backward-compat).
   */
  thresholdMode: "absolute" | "relative";
}

const DEFAULT_TIER0_CONFIG: Tier0ScanConfig = {
  thresholdMode: "relative",
};

export interface Tier0Report {
  totalTraces: number;
  withError: number;
  withFeedback: number;
  withLowScore: number;
  withHighLatency: number;
  /**
   * R-SELF-06-b: true when ANY trace has retryAttempt === maxRetries
   * (provider exhausted all retries — a primary failure signal regardless of score).
   */
  hasApiExhaustion: boolean;
  /**
   * I-012: true when ANY trace has skill workflow deviations detected
   * (TraceMetadata.skillBehaviorDeviationCount > 0).
   * Covers: skipped signal census, omitted assumption enumeration, bypassed scope construct.
   * Optional for backward-compat with platform-specific tier0 modules (claude-code, langfuse).
   */
  hasSkillBehaviorDeviation?: boolean;
  /** Whether score/feedback signal is present (determines slicing strategy) */
  hasPrimarySignal: boolean;
  /** Recommended slicing: dynamic-cluster (scored) or window-based (naive) */
  recommendedSlicing: "dynamic-cluster" | "window-based";
  /** Estimated number of analyzer slots needed (capped at 5) */
  estimatedSlots: number;
  /** Known failure patterns matched */
  patterns: PatternMatch[];
  /**
   * I-012: Typed Axis-1 signals — includes skill-behavior-deviation and future signal types.
   * Separate from `patterns` (which are structural patterns P-001/P-002/P-003).
   * Each entry has a `type` field for jq-queryable enumeration.
   * Optional for backward-compat with platform-specific tier0 modules (claude-code, langfuse).
   */
  signals?: SignalMatch[];
  /**
   * I-020: Scan configuration applied for this report.
   * Present when using runTier0Scan or runTier0ScanPlatformAware directly.
   * Optional to avoid breaking per-platform modules (claude-code, langfuse) that return
   * Tier0Report without config — runTier0ScanPlatformAware merges config in after dispatch.
   */
  config?: Tier0ScanConfig;
  /**
   * Wave-6 R2.3: class-memory library matches, MATCHED FIRST (before generic
   * heuristics). Each entry carries the 3× prior weight. Present only when the scan
   * was run via runTier0ScanWithLibrary against an entity with library priors.
   * Optional (backward-compat — absent on every pre-R2.3 path).
   */
  libraryMatches?: LibraryMatchSummary[];
}

/**
 * Wave-6 R2.3: a single library-prior match surfaced in a Tier-0 report.
 * Mirrors scripts/library/match.ts LibraryMatch (kept structural here so
 * tier0-scan.ts does not hard-depend on the library on the generic path).
 */
export interface LibraryMatchSummary {
  patternId: string;
  signal: string;
  matchCount: number;
  traceIds: string[];
  /** 3× prior weight (library priors outrank fresh Tier-0 signals). */
  weight: number;
}


/**
 * I-012: Typed signal match — one entry per detected signal category.
 * Used to surface skill workflow deviations and other Axis-1 signals.
 */
export interface SignalMatch {
  /** Signal category type (e.g. "skill-behavior-deviation") */
  type: string;
  /** Number of traces where this signal was detected */
  matchCount: number;
  /** Trace IDs that exhibited this signal */
  traceIds: string[];
}

export interface PatternMatch {
  patternId: string;
  name: string;
  matchCount: number;
  traceIds: string[];
}

const HIGH_LATENCY_MS = 10_000; // used only when thresholdMode === "absolute"
const LOW_SCORE_RAW_MAX = 0.4; // used when normalizedScore present

// ── I-020: Per-session relative threshold helpers (PR-033) ────────────────────

/**
 * Compute the p95 (95th percentile) of a numeric array using linear interpolation.
 * Returns null for empty arrays.
 */
export function computeP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = 0.95 * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Compute the Tukey IQR upper fence (Q3 + 1.5 × IQR) for outlier detection.
 * A value above this fence is considered an anomaly relative to the batch.
 *
 * Uses linear interpolation for Q1/Q3 (same as computeP95).
 * Returns null when fewer than 4 values are available (insufficient for IQR).
 * Falls back to HIGH_LATENCY_MS (absolute) in the caller when null.
 */
export function iqrUpperFence(values: number[]): number | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length - 1;
  const q1Idx = 0.25 * n;
  const q3Idx = 0.75 * n;
  const q1 =
    sorted[Math.floor(q1Idx)] +
    (q1Idx - Math.floor(q1Idx)) * (sorted[Math.ceil(q1Idx)] - sorted[Math.floor(q1Idx)]);
  const q3 =
    sorted[Math.floor(q3Idx)] +
    (q3Idx - Math.floor(q3Idx)) * (sorted[Math.ceil(q3Idx)] - sorted[Math.floor(q3Idx)]);
  const iqr = q3 - q1;
  return q3 + 1.5 * iqr;
}

/**
 * R-SELF-11-a: Detect the dominant platform in a batch of traces.
 * Returns the platform if ALL traces share the same sourcePlatform, else null.
 */
function detectSinglePlatform(traces: TraceMetadata[]): SourcePlatform | null {
  if (traces.length === 0) return null;
  const first = traces[0].sourcePlatform;
  if (!first) return null;
  return traces.every((t) => t.sourcePlatform === first) ? first : null;
}

/**
 * R-SELF-11-a: Dispatch to per-platform Tier 0 module when batch is homogeneous.
 * Falls back to generic path for mixed-platform or unknown-platform batches.
 */
async function dispatchPlatformTier0(
  traces: TraceMetadata[],
  platform: SourcePlatform
): Promise<Tier0Report | null> {
  try {
    if (platform === "claude-code") {
      const mod = await import("./tier0/claude-code.ts");
      return mod.runClaudeCodeTier0(traces);
    }
    if (platform === "langfuse") {
      const mod = await import("./tier0/langfuse.ts");
      return mod.runLangfuseTier0(traces);
    }
  } catch {
    // Module load failure — fall through to generic path
  }
  return null;
}

/**
 * Generic (platform-agnostic) Tier 0 scan.
 * Used as the fallback when platform dispatch is unavailable or not applicable.
 * Also exported for use by per-platform modules that want to extend the base result.
 *
 * @param traces  Batch of TraceMetadata to scan.
 * @param config  I-020: Scan configuration. Defaults to { thresholdMode: "relative" }.
 */
export function runTier0Scan(traces: TraceMetadata[], config: Tier0ScanConfig = DEFAULT_TIER0_CONFIG): Tier0Report {
  const withError = traces.filter((t) => t.hasError);
  const withFeedback = traces.filter((t) => t.hasFeedback);
  // R-SELF-04-a: treat null rawScore correctly — only count traces where
  // rawScore is an actual number below threshold, not null/undefined.
  const withLowScore = traces.filter((t) => {
    if (t.normalizedScore !== undefined) {
      return t.normalizedScore <= LOW_SCORE_RAW_MAX;
    }
    // rawScore must be a non-null number strictly below 3
    return typeof t.rawScore === "number" && t.rawScore < 3;
  });

  // I-020: High-latency detection — relative (IQR) or absolute (hardcoded ms).
  // In "relative" mode, the threshold is derived per-session from the batch's own
  // latency distribution using the Tukey IQR upper fence (Q3 + 1.5 × IQR).
  // This means no hardcoded ms values drive the anomaly gate (PR-033).
  let highLatencyThreshold: number;
  if (config.thresholdMode === "relative") {
    const latencySamples = traces
      .filter((t) => t.latencyMs !== undefined)
      .map((t) => t.latencyMs as number);
    // iqrUpperFence returns null when <4 samples — fall back to absolute threshold.
    highLatencyThreshold = iqrUpperFence(latencySamples) ?? HIGH_LATENCY_MS;
  } else {
    highLatencyThreshold = HIGH_LATENCY_MS;
  }

  const withHighLatency = traces.filter(
    (t) => t.latencyMs !== undefined && t.latencyMs > highLatencyThreshold
  );

  // R-SELF-06-b: API exhaustion = retryAttempt reached maxRetries on any trace
  const hasApiExhaustion = traces.some(
    (t) =>
      Array.isArray(t.apiErrors) &&
      t.apiErrors.some((e) => e.retryAttempt >= e.maxRetries)
  );

  // I-012: skill-behavior-deviation — skill deviated from documented workflow
  // (e.g., skipped signal census, omitted assumption enumeration, bypassed scope construct)
  const withSkillDeviation = traces.filter(
    (t) => typeof t.skillBehaviorDeviationCount === "number" && t.skillBehaviorDeviationCount > 0
  );
  const hasSkillBehaviorDeviation = withSkillDeviation.length > 0;

  const hasPrimarySignal = withFeedback.length > 0 || withLowScore.length > 0 || hasApiExhaustion;

  // Pattern: error spike (>20% error rate)
  const patterns: PatternMatch[] = [];
  const errorRate = withError.length / Math.max(traces.length, 1);
  if (errorRate > 0.2) {
    patterns.push({
      patternId: "P-001",
      name: "error-spike",
      matchCount: withError.length,
      traceIds: withError.map((t) => t.traceId),
    });
  }

  // Pattern: latency spike (>10% high latency)
  const latencyRate = withHighLatency.length / Math.max(traces.length, 1);
  if (latencyRate > 0.1) {
    patterns.push({
      patternId: "P-002",
      name: "latency-spike",
      matchCount: withHighLatency.length,
      traceIds: withHighLatency.map((t) => t.traceId),
    });
  }

  // Pattern: feedback cluster (>5% feedback bearing)
  const feedbackRate = withFeedback.length / Math.max(traces.length, 1);
  if (feedbackRate > 0.05) {
    patterns.push({
      patternId: "P-003",
      name: "feedback-cluster",
      matchCount: withFeedback.length,
      traceIds: withFeedback.map((t) => t.traceId),
    });
  }

  // I-012: Build Axis-1 signals array (typed signal categories, separate from patterns)
  const signals: SignalMatch[] = [];
  if (hasSkillBehaviorDeviation) {
    signals.push({
      type: "skill-behavior-deviation",
      matchCount: withSkillDeviation.length,
      traceIds: withSkillDeviation.map((t) => t.traceId),
    });
  }

  // Estimate slots: one slot per distinct signal cluster, capped at 5 (PR-005)
  const slots = Math.min(
    Math.max(1, patterns.length + (hasPrimarySignal ? 1 : 0)),
    5
  );

  return {
    totalTraces: traces.length,
    withError: withError.length,
    withFeedback: withFeedback.length,
    withLowScore: withLowScore.length,
    withHighLatency: withHighLatency.length,
    hasApiExhaustion,
    hasSkillBehaviorDeviation,
    hasPrimarySignal,
    recommendedSlicing: hasPrimarySignal ? "dynamic-cluster" : "window-based",
    estimatedSlots: slots,
    patterns,
    signals,
    // I-020: record the config used so callers / jq queries can inspect thresholdMode
    config,
  };
}

/**
 * R-SELF-11-a: Platform-aware entry point.
 * Detects dominant sourcePlatform and dispatches to the appropriate per-platform
 * module. Falls back to generic runTier0Scan for mixed or unknown batches.
 *
 * I-020: config is merged into the result regardless of path so that
 * `.config.thresholdMode` is always present in CLI output (PR-033 audit surface).
 *
 * This is the preferred entrypoint for the orchestrator. The synchronous
 * runTier0Scan export is kept for testing and for per-platform modules that
 * call it internally.
 */
export async function runTier0ScanPlatformAware(
  traces: TraceMetadata[],
  config: Tier0ScanConfig = DEFAULT_TIER0_CONFIG
): Promise<Tier0Report> {
  const platform = detectSinglePlatform(traces);
  if (platform) {
    const result = await dispatchPlatformTier0(traces, platform);
    // Merge config into platform-specific result so .config.thresholdMode is always present
    if (result) return { ...result, config };
  }
  // Generic fallback
  return runTier0Scan(traces, config);
}

/**
 * Wave-6 R2.3 / PRD-MP-07 (PR-037): library-FIRST Tier-0 entry point.
 * Takes PRE-COMPUTED library matches (the caller runs scripts/library/match.ts
 * FIRST, before this scan) and attaches them to the report's `libraryMatches`
 * so the promoted patterns are surfaced ahead of the generic heuristics.
 * The generic scan is unchanged — library matches are ADDITIVE prior signals
 * carrying the 3× weight.
 *
 * PRD-MP-07 ENFORCEMENT: This function is now the PREFERRED entry point for
 * the orchestrator at Step 4 (Tier-0). The orchestrator MUST:
 *   1. Call matchLibraryPatterns() from scripts/library/match.ts FIRST.
 *   2. Call this function with the resulting matches (empty array = no-op).
 *   3. When matches.length > 0: skip Step 3.5 awareness mini-sample (buildPriorSignalsRef
 *      provides the ref to pass to shouldFireAwareness({ priorSignalsRef })).
 *   4. Record the skip in runMeta.exemptions: [{ stepId: 'awareness-sample',
 *      reason: 'library-priors:' + ref, declaredBy: 'orchestrator' }].
 *
 * Library writes are approved-only — never auto-promoted without operator gate.
 * Keeping the matcher OUT of this function keeps it dependency-light (pure wrapper).
 *
 * When there are no library matches, this behaves identically to
 * runTier0ScanPlatformAware.
 */
export async function runTier0ScanWithLibrary(
  traces: TraceMetadata[],
  libraryMatches: LibraryMatchSummary[],
  config: Tier0ScanConfig = DEFAULT_TIER0_CONFIG
): Promise<Tier0Report> {
  const base = await runTier0ScanPlatformAware(traces, config);
  if (libraryMatches.length === 0) return base;
  // LIBRARY FIRST: promoted patterns are surfaced ahead of generic heuristics.
  // PRD-MP-07: hasPrimarySignal is re-evaluated to include library hits.
  const hasPrimarySignalWithLib = base.hasPrimarySignal || libraryMatches.length > 0;
  return {
    ...base,
    libraryMatches,
    hasPrimarySignal: hasPrimarySignalWithLib,
    recommendedSlicing: hasPrimarySignalWithLib ? "dynamic-cluster" : base.recommendedSlicing,
  };
}

// CLI entrypoint
if (import.meta.main) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("Usage: bun scripts/tier0-scan.ts <traces-metadata.json>\n");
    process.exit(1);
  }

  try {
    const raw = readFileSync(inputPath, "utf8");
    const traces: TraceMetadata[] = JSON.parse(raw);
    // R-SELF-11-a: use platform-aware entry for CLI execution
    const report = await runTier0ScanPlatformAware(traces);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
