/**
 * scripts/slicer.ts
 * Dynamic-cluster and window-based trace slicer — PR-017
 * Type A — Pure Script (deterministic math + cap-of-5 clustering)
 *
 * Reads a Tier0Report + TraceMetadata list, emits a slice plan (array of slices,
 * each being a list of traceIds for one analyzer to process).
 *
 * Usage: bun scripts/slicer.ts <tier0-report.json> <traces-metadata.json> [--cap N]
 */

import { readFileSync } from "fs";
import type { TraceMetadata } from "./normalize/trace.ts";
import type { Tier0Report } from "./tier0-scan.ts";

export interface SlicePlan {
  totalSlices: number;
  slices: TraceSlice[];
  /** Why this slicing strategy was chosen */
  rationale: string;
}

export interface TraceSlice {
  sliceId: string;
  strategy: "dynamic-cluster" | "window-based";
  /** Cluster label for dynamic-cluster slices */
  clusterLabel?: string;
  traceIds: string[];
  /** Scope context passed to the analyzer */
  scope: {
    hasError: boolean;
    hasFeedback: boolean;
    isPrimarySignal: boolean;
    estimatedComplexity: "low" | "medium" | "high";
  };
}

const DEFAULT_CAP = 5;

export function computeSlicePlan(
  tier0: Tier0Report,
  traces: TraceMetadata[],
  cap = DEFAULT_CAP
): SlicePlan {
  if (traces.length === 0) {
    return {
      totalSlices: 0,
      slices: [],
      rationale: "No traces to analyze.",
    };
  }

  if (tier0.recommendedSlicing === "dynamic-cluster") {
    return dynamicClusterSlice(tier0, traces, cap);
  }

  return windowBasedSlice(traces, cap);
}

function dynamicClusterSlice(
  tier0: Tier0Report,
  traces: TraceMetadata[],
  cap: number
): SlicePlan {
  const clusters: Map<string, TraceMetadata[]> = new Map();

  // Cluster 1: errors
  const errors = traces.filter((t) => t.hasError);
  if (errors.length > 0) clusters.set("errors", errors);

  // Cluster 2: low-score + feedback
  const scoredNegative = traces.filter(
    (t) =>
      t.hasFeedback ||
      (t.normalizedScore !== undefined && t.normalizedScore <= 0.4)
  );
  if (scoredNegative.length > 0) clusters.set("negative-feedback", scoredNegative);

  // Cluster 3: high-latency (not already in errors)
  const highLatency = traces.filter(
    (t) => !t.hasError && t.latencyMs !== undefined && t.latencyMs > 10_000
  );
  if (highLatency.length > 0) clusters.set("high-latency", highLatency);

  // Fill remaining slots with unclustered traces
  const clusteredIds = new Set([...clusters.values()].flatMap((ts) => ts.map((t) => t.traceId)));
  const unclustered = traces.filter((t) => !clusteredIds.has(t.traceId));
  if (unclustered.length > 0 && clusters.size < cap) {
    clusters.set("remaining", unclustered);
  }

  const slices: TraceSlice[] = [...clusters.entries()]
    .slice(0, cap)
    .map(([label, ts], i) => ({
      sliceId: `slice-${i + 1}`,
      strategy: "dynamic-cluster" as const,
      clusterLabel: label,
      traceIds: ts.map((t) => t.traceId),
      scope: {
        hasError: ts.some((t) => t.hasError),
        hasFeedback: ts.some((t) => t.hasFeedback),
        isPrimarySignal: label === "negative-feedback" || label === "errors",
        estimatedComplexity:
          ts.length > 20 ? "high" : ts.length > 5 ? "medium" : "low",
      },
    }));

  return {
    totalSlices: slices.length,
    slices,
    rationale: `Dynamic-cluster slicing: ${slices.length} cluster(s) from ${traces.length} traces. Clusters: ${slices.map((s) => s.clusterLabel).join(", ")}.`,
  };
}

function windowBasedSlice(traces: TraceMetadata[], cap: number): SlicePlan {
  const windowSize = Math.ceil(traces.length / cap);
  const slices: TraceSlice[] = [];

  for (let i = 0; i < cap && i * windowSize < traces.length; i++) {
    const window = traces.slice(i * windowSize, (i + 1) * windowSize);
    slices.push({
      sliceId: `slice-${i + 1}`,
      strategy: "window-based",
      traceIds: window.map((t) => t.traceId),
      scope: {
        hasError: window.some((t) => t.hasError),
        hasFeedback: window.some((t) => t.hasFeedback),
        isPrimarySignal: false,
        estimatedComplexity:
          window.length > 20 ? "high" : window.length > 5 ? "medium" : "low",
      },
    });
  }

  return {
    totalSlices: slices.length,
    slices,
    rationale: `Window-based slicing (no a-priori signal): ${slices.length} window(s) of ~${windowSize} traces each.`,
  };
}

// CLI entrypoint
if (import.meta.main) {
  const tier0Path = process.argv[2];
  const tracesPath = process.argv[3];
  const capArg = process.argv.indexOf("--cap");
  const cap = capArg >= 0 ? parseInt(process.argv[capArg + 1] ?? "5", 10) : DEFAULT_CAP;

  if (!tier0Path || !tracesPath) {
    process.stderr.write(
      "Usage: bun scripts/slicer.ts <tier0-report.json> <traces-metadata.json> [--cap N]\n"
    );
    process.exit(1);
  }

  try {
    const tier0: Tier0Report = JSON.parse(readFileSync(tier0Path, "utf8"));
    const traces: TraceMetadata[] = JSON.parse(readFileSync(tracesPath, "utf8"));
    const plan = computeSlicePlan(tier0, traces, cap);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
