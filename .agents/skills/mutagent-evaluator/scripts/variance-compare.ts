/**
 * scripts/variance-compare.ts
 * ---------------------------------------------------------------------------
 * The variant comparator — Track-2 TREND (R7, decisions #9/#12). A COORDINATOR
 * (a role distinct from the audit executors) compares TWO run bundles on the
 * fixed 15-dimension determinism scorecard. The byte-identity masking contract
 * (mask.ts) is applied first: "byte-identical across runs" is only testable
 * AFTER masking the declared injected fields (runId / timestamps / abs-paths).
 *
 * Each dimension has a Measure and a per-Phase Target. A dimension is:
 *   - identical      : masked values byte-identical
 *   - within-target  : differ but inside the phase target
 *   - diverged       : differ beyond target (counts toward varianceScore)
 *   - not-evaluated  : the inputs needed for this dimension were absent
 *
 * Pure + deterministic: same two bundles -> same trend, always. No clock/random.
 */
import { type RunBundle, type TrendDimension } from "./contracts/types.ts";
import { maskedCanonicalJson } from "./mask.ts";

/**
 * The FIXED 15 determinism dimensions (manual §11.1). Each carries its Measure
 * and a default target. `extract` pulls the comparable value from a bundle; when
 * it returns undefined the dimension is not-evaluated for that pair.
 */
export interface VarianceDimensionSpec {
  readonly name: string;
  readonly measure: string;
  readonly target: string;
  readonly extract: (bundle: RunBundle) => unknown;
}

function path(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export const VARIANCE_DIMENSIONS: readonly VarianceDimensionSpec[] = [
  {
    name: "headline-latency-p50",
    measure: "primary-signal latency p50 magnitude",
    target: "identical magnitude (no 10s<->54s flip)",
    extract: (b) => path(b.data.renderInput, "bigStat", "p50"),
  },
  {
    name: "render-crashes",
    measure: "count of post-gate render TypeErrors",
    target: "0",
    extract: (b) => path(b.data.runMeta, "renderCrashes") ?? 0,
  },
  {
    name: "gate-fail-loud-completeness",
    measure: "all missing fields surfaced in ONE error",
    target: "single-pass",
    extract: (b) => path(b.data.runMeta, "gateFailMode"),
  },
  {
    name: "analyzer-count",
    measure: "(n, analyzerCount) dispatch sizing",
    target: "identical across runs/machines",
    extract: (b) => path(b.data.runMeta, "dispatch", "analyzerCount"),
  },
  {
    name: "primary-signal",
    measure: "runMeta.primarySignal.name",
    target: "identical",
    extract: (b) => path(b.data.runMeta, "primarySignal", "name"),
  },
  {
    name: "finding-id-set",
    measure: "set of findingIds after dedup+cluster",
    target: "identical set",
    extract: (b) => path(b.data.renderInput, "findingIds"),
  },
  {
    name: "remedy-ranking",
    measure: "star-recommended remedy id ordering",
    target: "identical",
    extract: (b) => path(b.data.renderInput, "recommendedRemedyId"),
  },
  {
    name: "slice-plan",
    measure: "SlicePlan trace assignment",
    target: "byte-identical",
    extract: (b) => path(b.data.runMeta, "slicePlan"),
  },
  {
    name: "sampling-buckets",
    measure: "representative sampler buckets",
    target: "byte-identical",
    extract: (b) => path(b.data.runMeta, "sampling", "buckets"),
  },
  {
    name: "coverage-confidence",
    measure: "coverageConfidence value",
    target: "identical",
    extract: (b) => path(b.data.runMeta, "coverageConfidence"),
  },
  {
    name: "tier0-signals",
    measure: "Tier0Report signal set",
    target: "identical",
    extract: (b) => path(b.data.runMeta, "tier0", "signals"),
  },
  {
    name: "entity-identity",
    measure: "diagnosedEntity name",
    target: "identical",
    extract: (b) => path(b.data.entityContext, "diagnosedEntity"),
  },
  {
    name: "caps-firstToTrip",
    measure: "enforceCaps firstToTrip",
    target: "identical",
    extract: (b) => path(b.data.runMeta, "caps", "firstToTrip"),
  },
  {
    name: "awareness-fire",
    measure: "awareness fired vs skipped decision",
    target: "identical",
    extract: (b) => path(b.data.runMeta, "awareness", "fired"),
  },
  {
    name: "heatmap-cells",
    measure: "24-cell hourly heatmap",
    target: "byte-identical after generatedAt mask",
    extract: (b) => path(b.data.renderInput, "hourlyHeatmap"),
  },
];

export interface VarianceCompareResult {
  dimensions: TrendDimension[];
  varianceScore: number;
  runPair: { a: string; b: string };
}

/**
 * Compare two bundles across the 15 dimensions. Each value is masked + canonical-
 * serialized before comparison so injected fields never count as divergence.
 */
export function varianceCompare(
  a: RunBundle,
  b: RunBundle,
): VarianceCompareResult {
  const dimensions: TrendDimension[] = VARIANCE_DIMENSIONS.map((spec) => {
    const va = spec.extract(a);
    const vb = spec.extract(b);
    let divergence: TrendDimension["divergence"];
    if (va === undefined && vb === undefined) {
      divergence = "not-evaluated";
    } else {
      const ma = maskedCanonicalJson(va ?? null);
      const mb = maskedCanonicalJson(vb ?? null);
      divergence = ma === mb ? "identical" : "diverged";
    }
    return {
      name: spec.name,
      measure: spec.measure,
      target: spec.target,
      divergence,
    };
  });

  const varianceScore = dimensions.filter(
    (d) => d.divergence === "diverged",
  ).length;

  return {
    dimensions,
    varianceScore,
    runPair: { a: a.runId, b: b.runId },
  };
}
