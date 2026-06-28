/**
 * scripts/tier0/langfuse.ts
 * R-SELF-11-a: Per-platform Tier 0 module for langfuse source.
 *
 * Langfuse traces carry explicit score + feedback + latency signals
 * as first-class fields — this module produces a Tier 0 report tuned
 * to Langfuse's signal density.
 *
 * Invoked by tier0-scan.ts when `sourcePlatform === "langfuse"`.
 * Type A — Pure Script (deterministic pattern matching, no LLM calls)
 */

import type { TraceMetadata } from "../normalize/trace.ts";
import type { Tier0Report, PatternMatch } from "../tier0-scan.ts";

const HIGH_LATENCY_MS = 10_000;
const LOW_SCORE_RAW_MAX = 0.4;
const MAX_ESTIMATED_SLOTS = 5;

export function runLangfuseTier0(traces: TraceMetadata[]): Tier0Report {
  const withError = traces.filter((t) => t.hasError);
  const withFeedback = traces.filter((t) => t.hasFeedback);
  const withLowScore = traces.filter((t) => {
    if (t.normalizedScore !== undefined) return t.normalizedScore <= LOW_SCORE_RAW_MAX;
    return typeof t.rawScore === "number" && t.rawScore < 3;
  });
  const withHighLatency = traces.filter(
    (t) => t.latencyMs !== undefined && t.latencyMs > HIGH_LATENCY_MS
  );

  // Langfuse-specific: check API exhaustion (v0.3 apiErrors — may be populated
  // if the Langfuse normalizer captures SDK retry events)
  const withApiExhaustion = traces.filter(
    (t) =>
      Array.isArray(t.apiErrors) &&
      t.apiErrors.some((e) => e.retryAttempt >= e.maxRetries)
  );
  const hasApiExhaustion = withApiExhaustion.length > 0;

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

  // LF-001: score concentration in low tier (>30% below threshold — strong signal density)
  const lowScoreRate = withLowScore.length / Math.max(traces.length, 1);
  if (lowScoreRate > 0.3 && withLowScore.length > 2) {
    patterns.push({
      patternId: "LF-001",
      name: "low-score-concentration",
      matchCount: withLowScore.length,
      traceIds: withLowScore.map((t) => t.traceId),
    });
  }

  // NOTE: a former LF-002 "low-tagging-rate" pattern (>80% untagged) was REMOVED
  // (W12-05 / PR-051 propose). Empty `tags[]` is Langfuse dashboard hygiene, NOT
  // agent behavior — it is not a failure WHAT and must never surface as a signal,
  // census row, or finding. The Tier-0 census admits only mechanical signals that
  // map to a user-visible failure (loop / latency / cost / error / feedback / score);
  // observability hygiene is out of scope by construction.
  // See references/principles.md PR-049 step-2 + feedback_signal_discipline_evidence_first.

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
