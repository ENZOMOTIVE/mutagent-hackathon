/**
 * scripts/tier0/claude-code.ts
 * R-SELF-11-a: Per-platform Tier 0 module for claude-code source.
 *
 * Uses v0.3 TraceMetadata extensions (apiErrors, compactionEvents) to produce
 * a richer Tier 0 report for claude-code transcripts than the generic path.
 *
 * Invoked by tier0-scan.ts when `sourcePlatform === "claude-code"`.
 * Type A — Pure Script (deterministic pattern matching, no LLM calls)
 */

import type { TraceMetadata } from "../normalize/trace.ts";
import type { Tier0Report, PatternMatch } from "../tier0-scan.ts";

const HIGH_LATENCY_MS = 10_000;
const LOW_SCORE_RAW_MAX = 0.4;
const MAX_ESTIMATED_SLOTS = 5;

export function runClaudeCodeTier0(traces: TraceMetadata[]): Tier0Report {
  const withError = traces.filter((t) => t.hasError);
  const withFeedback = traces.filter((t) => t.hasFeedback);
  const withLowScore = traces.filter((t) => {
    if (t.normalizedScore !== undefined) return t.normalizedScore <= LOW_SCORE_RAW_MAX;
    return typeof t.rawScore === "number" && t.rawScore < 3;
  });
  const withHighLatency = traces.filter(
    (t) => t.latencyMs !== undefined && t.latencyMs > HIGH_LATENCY_MS
  );

  // CC-native: API exhaustion (v0.3 apiErrors extension)
  const withApiExhaustion = traces.filter(
    (t) =>
      Array.isArray(t.apiErrors) &&
      t.apiErrors.some((e) => e.retryAttempt >= e.maxRetries)
  );
  const hasApiExhaustion = withApiExhaustion.length > 0;

  // CC-native: compaction events indicate context-overflow risk
  const withCompaction = traces.filter(
    (t) => Array.isArray(t.compactionEvents) && t.compactionEvents.length > 0
  );

  // CC-native: teammate vs lead sessions
  const withTeammateSessions = traces.filter((t) => t.isTeammate === true);

  const hasPrimarySignal =
    withFeedback.length > 0 || withLowScore.length > 0 || hasApiExhaustion;

  const patterns: PatternMatch[] = [];

  // P-001: error spike (>20% error rate)
  const errorRate = withError.length / Math.max(traces.length, 1);
  if (errorRate > 0.2) {
    patterns.push({
      patternId: "P-001",
      name: "error-spike",
      matchCount: withError.length,
      traceIds: withError.map((t) => t.traceId),
    });
  }

  // P-002: latency spike (>10% high latency)
  const latencyRate = withHighLatency.length / Math.max(traces.length, 1);
  if (latencyRate > 0.1) {
    patterns.push({
      patternId: "P-002",
      name: "latency-spike",
      matchCount: withHighLatency.length,
      traceIds: withHighLatency.map((t) => t.traceId),
    });
  }

  // P-003: feedback cluster (>5% feedback bearing)
  const feedbackRate = withFeedback.length / Math.max(traces.length, 1);
  if (feedbackRate > 0.05) {
    patterns.push({
      patternId: "P-003",
      name: "feedback-cluster",
      matchCount: withFeedback.length,
      traceIds: withFeedback.map((t) => t.traceId),
    });
  }

  // P-CC-001: API exhaustion pattern (CC-native)
  if (hasApiExhaustion) {
    patterns.push({
      patternId: "P-CC-001",
      name: "api-exhaustion",
      matchCount: withApiExhaustion.length,
      traceIds: withApiExhaustion.map((t) => t.traceId),
    });
  }

  // P-CC-002: compaction-heavy sessions (>20% of sessions had compaction)
  const compactionRate = withCompaction.length / Math.max(traces.length, 1);
  if (compactionRate > 0.2) {
    patterns.push({
      patternId: "P-CC-002",
      name: "context-compaction-cluster",
      matchCount: withCompaction.length,
      traceIds: withCompaction.map((t) => t.traceId),
    });
  }

  // P-CC-003: high teammate ratio (>50%) — may indicate orchestration issue
  const teammateRate = withTeammateSessions.length / Math.max(traces.length, 1);
  if (teammateRate > 0.5 && withTeammateSessions.length > 1) {
    patterns.push({
      patternId: "P-CC-003",
      name: "high-teammate-ratio",
      matchCount: withTeammateSessions.length,
      traceIds: withTeammateSessions.map((t) => t.traceId),
    });
  }

  const slots = Math.min(
    Math.max(1, patterns.length + (hasPrimarySignal ? 1 : 0)),
    MAX_ESTIMATED_SLOTS
  );

  return {
    totalTraces: traces.length,
    withError: withError.length,
    withFeedback: withFeedback.length,
    withLowScore: withLowScore.length,
    withHighLatency: withHighLatency.length,
    hasApiExhaustion,
    hasPrimarySignal,
    recommendedSlicing: hasPrimarySignal ? "dynamic-cluster" : "window-based",
    estimatedSlots: slots,
    patterns,
  };
}
