/**
 * scripts/sample/representative.ts
 * R2.5 + W9-09 — Sampling representativeness proof + tiered batch escalation.
 * Type A — Pure Script (deterministic — NO clock, NO random, NO LLM, NO I/O).
 *
 * This module is the SHARED sampler used by both:
 *   - R2.1 mandatory LLM deep-read (which traces get read by the LLM), and
 *   - R2.5 representativeness proof (does the chosen sample cover the population?).
 *
 * Determinism contract: given the same TraceMetadata[] in the same order, the
 * sampler returns byte-identical buckets and the coverage proof returns identical
 * numbers. Ties break by stable index order (never Math.random, never Date.now).
 *
 * 4-BUCKET MODEL (R2.1): worst · median · best · random.
 *   - worst:  highest "badness" score (low normalizedScore, high latency, error/feedback).
 *   - best:   lowest badness.
 *   - median: closest to the median badness.
 *   - random: deterministic stride pick across the remaining population (no RNG).
 * The worst bucket is over-weighted (worst-weighted floor — see buildBucketSample).
 *
 * 4-DIM COVERAGE (R2.5): latency · score · temporal · tool-trajectory.
 *   Each dimension's coverage = (distinct buckets of the population that the sample
 *   touches) / (distinct buckets present in the population). coverageConfidence is the
 *   mean across the 4 dims, mapped to high/med/low via 90/70 thresholds.
 *
 * W9-09 additions:
 *   - buildBatchSample()    : produce a deterministic batch up to `tier` using
 *                             the 4-bucket worst-weighted sampler (no clock/random).
 *   - isSufficient()        : stop predicate — coverageConfidence==='high' AND
 *                             newFailureCategoriesInLastBatch===0.
 */

import type { TraceMetadata, FindingCoverageProof } from "../normalize/trace.ts";

// ── Bucket model (R2.1) ──────────────────────────────────────────────────────

export type SampleBucket = "worst" | "median" | "best" | "random";

export interface BucketAssignment {
  traceId: string;
  bucket: SampleBucket;
  /** Computed badness score (higher = worse) — surfaced for audit + determinism proof. */
  badness: number;
}

export interface BucketSample {
  /** Trace IDs selected for LLM deep-read, in deterministic order. */
  selected: BucketAssignment[];
  /** Count selected per bucket (audit). */
  perBucketCount: Record<SampleBucket, number>;
  /** Total population size the sample was drawn from. */
  populationSize: number;
  /** True when the sample exceeds 30% of the population (R-6 small-pop warning). */
  oversampledSmallPopulation: boolean;
}

/**
 * The minimum number of traces an LLM deep-read sample must contain on a fresh
 * run (R2.1 15-trace floor). Tunable by the caller. Worst-weighted: the floor is
 * filled by pulling additional worst-bucket traces first.
 */
export const DEFAULT_SAMPLE_FLOOR = 15;

/**
 * D-9 (W13-D): worst-bucket weight. Of the discretionary budget (the slots left
 * after the 3 anchors), at least this FRACTION is reserved for the worst-ranked
 * tail and labelled `worst` — BEFORE the random stride runs. This is what makes
 * the sampler "worst-weighted" in fact, not just in name.
 *
 * Why 0.4: a representativeness sampler for a latency/cost diagnosis must guarantee
 * meaningful tail coverage. Before this floor, the random stride (walking from
 * rank 0 = the worst) consumed the whole budget and mislabelled the worst traces
 * as `random` (the audit's "worst:1/median:1/best:1/random:137" — the tail was
 * present but the bucket census lied, and on partial samples the tail was not
 * over-represented at all). Reserving 40% of the discretionary budget for the
 * worst tail over-weights the tail honestly while leaving 60% for the random
 * stride's spread across the rest of the population.
 *
 * Deterministic: a pure ratio applied via integer floor — no clock, no random.
 */
export const WORST_BUCKET_WEIGHT = 0.4;

/**
 * Deterministic "badness" score for a trace. Higher = worse. Pure function of
 * the trace metadata — NO clock, NO random. Combines (in priority order):
 *   - error presence         (+0.40)
 *   - feedback presence       (+0.20)
 *   - low normalized score    (+ (1 - normalizedScore) * 0.30)   when present
 *   - high latency            (+ min(latencyMs / 60000, 1) * 0.10)  when present
 * Missing fields contribute 0 — they never inflate badness.
 */
export function computeBadness(t: TraceMetadata): number {
  let b = 0;
  if (t.hasError) b += 0.4;
  if (t.hasFeedback) b += 0.2;
  if (typeof t.normalizedScore === "number") {
    b += (1 - clamp01(t.normalizedScore)) * 0.3;
  }
  if (typeof t.latencyMs === "number") {
    b += Math.min(t.latencyMs / 60_000, 1) * 0.1;
  }
  return b;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * R2.1 4-bucket sampler. Assigns every trace a badness score, sorts deterministically
 * (badness desc, then original index asc for stable ties), then selects:
 *   - the single worst, median, and best traces (the bucket "anchors"), and
 *   - a deterministic stride of "random"-bucket traces,
 * filling up to `floor` total by pulling additional worst-ranked traces first
 * (worst-weighted). When the population is smaller than the floor, the whole
 * population is selected.
 *
 * Determinism: stride uses integer arithmetic over the sorted index — no RNG.
 */
export function buildBucketSample(
  traces: TraceMetadata[],
  floor: number = DEFAULT_SAMPLE_FLOOR
): BucketSample {
  const populationSize = traces.length;
  const perBucketCount: Record<SampleBucket, number> = {
    worst: 0,
    median: 0,
    best: 0,
    random: 0,
  };

  if (populationSize === 0) {
    return { selected: [], perBucketCount, populationSize: 0, oversampledSmallPopulation: false };
  }

  // Stable-sorted by badness desc, original index asc on ties.
  const ranked = traces
    .map((t, idx) => ({ t, idx, badness: computeBadness(t) }))
    .sort((a, b) => (b.badness - a.badness) || (a.idx - b.idx));

  const selectedIdx = new Set<number>();
  const assignments: BucketAssignment[] = [];

  const assign = (rankPos: number, bucket: SampleBucket): void => {
    if (rankPos < 0 || rankPos >= ranked.length) return;
    if (selectedIdx.has(rankPos)) return;
    selectedIdx.add(rankPos);
    assignments.push({ traceId: ranked[rankPos].t.traceId, bucket, badness: ranked[rankPos].badness });
    perBucketCount[bucket] += 1;
  };

  // Anchors: worst (rank 0), best (last rank), median (middle rank).
  assign(0, "worst");
  assign(ranked.length - 1, "best");
  assign(Math.floor((ranked.length - 1) / 2), "median");

  const target = Math.min(floor, ranked.length);

  // D-9: worst-bucket FLOOR — reserve a fraction of the discretionary budget for
  // the worst-ranked tail BEFORE the random stride, so the sampler is genuinely
  // worst-weighted (not just in name). Run only when the population is larger than
  // the sample target (i.e. the sample is a true subset that must be representative);
  // when target === population every trace is selected anyway, so over-weighting is
  // a no-op there. Pulls the next-worst ranked traces (rank 1, 2, … — rank 0 is the
  // worst anchor) and labels them `worst`. Deterministic: integer floor, no random.
  if (ranked.length > target) {
    const discretionary = Math.max(0, target - assignments.length);
    const worstFloor = Math.floor(discretionary * WORST_BUCKET_WEIGHT);
    for (let pos = 0; pos < ranked.length && perBucketCount.worst < worstFloor + 1; pos++) {
      // +1 because the rank-0 worst anchor already counts toward perBucketCount.worst.
      assign(pos, "worst");
    }
  }

  // Random bucket: deterministic stride across the remaining population. After the
  // worst floor reserved the tail, the stride spreads the remaining budget across
  // the whole ranked range so non-tail bands stay covered (coverage stays honest).
  if (ranked.length > assignments.length) {
    const remainingNeededForStride = Math.max(0, target - assignments.length);
    if (remainingNeededForStride > 0) {
      const stride = Math.max(1, Math.floor(ranked.length / remainingNeededForStride));
      for (let pos = 0; pos < ranked.length && countUnseen(selectedIdx, target); pos += stride) {
        assign(pos, "random");
      }
    }
  }

  // Worst-weighted floor fill: top up to target by pulling the next-worst ranked
  // traces (e.g. when the stride could not reach target due to collisions).
  for (let pos = 0; pos < ranked.length && assignments.length < target; pos++) {
    assign(pos, "worst");
  }

  const oversampledSmallPopulation = populationSize > 0 && assignments.length / populationSize > 0.3;

  return {
    selected: assignments,
    perBucketCount,
    populationSize,
    oversampledSmallPopulation,
  };
}

function countUnseen(seen: Set<number>, target: number): boolean {
  return seen.size < target;
}

// ── 4-dimensional coverage proof (R2.5) ──────────────────────────────────────

export type CoverageDimension = "latency" | "score" | "temporal" | "tool-trajectory";

export interface DimensionCoverage {
  dimension: CoverageDimension;
  /** Distinct population buckets present in this dimension. */
  populationBuckets: number;
  /** Of those, how many the sample touches. */
  coveredBuckets: number;
  /** coveredBuckets / populationBuckets * 100, or 100 when the dimension is absent. */
  coveragePct: number;
}

export interface PopulationStats {
  populationSize: number;
  sampleSize: number;
  /** Fraction of the population that was sampled (0..1). */
  sampleFraction: number;
  /** Mean badness of the WHOLE population (bias proof — compare to sample mean). */
  populationMeanBadness: number;
  /** Mean badness of the SAMPLE (bias proof — should track the population). */
  sampleMeanBadness: number;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface CoverageProof {
  /** Per-finding confidence value 0..100 (mean of the 4 dimension coveragePcts). */
  coverageConfidence: number;
  /** high (≥90) · medium (≥70) · low (else). */
  level: ConfidenceLevel;
  dimensions: DimensionCoverage[];
  population: PopulationStats;
  /** True when level === "low" (drives the WARN-only banner). */
  isLow: boolean;
}

/** R2.5 thresholds (operator-locked): ≥90 high · ≥70 medium · else low. */
export const COVERAGE_THRESHOLD_HIGH = 90;
export const COVERAGE_THRESHOLD_MED = 70;

export function confidenceLevel(pct: number): ConfidenceLevel {
  if (pct >= COVERAGE_THRESHOLD_HIGH) return "high";
  if (pct >= COVERAGE_THRESHOLD_MED) return "medium";
  return "low";
}

/**
 * Bucket a latency (ms) into a coarse band for coverage comparison. Deterministic.
 * Bands: <1s · 1-5s · 5-15s · 15-60s · >60s.
 */
function latencyBand(latencyMs: number): string {
  if (latencyMs < 1_000) return "l<1s";
  if (latencyMs < 5_000) return "l1-5s";
  if (latencyMs < 15_000) return "l5-15s";
  if (latencyMs < 60_000) return "l15-60s";
  return "l>60s";
}

/** Bucket a normalized score [0,1] into quintiles. Deterministic. */
function scoreBand(normalizedScore: number): string {
  const s = clamp01(normalizedScore);
  const q = Math.min(4, Math.floor(s * 5));
  return `s-q${q}`;
}

/** Bucket a start time (ISO8601) into its UTC hour-of-day [0..23]. Deterministic. */
function temporalBand(startTime: string): string | null {
  const d = new Date(startTime);
  const h = d.getUTCHours();
  if (Number.isNaN(h)) return null;
  return `h${h}`;
}

/**
 * Tool-trajectory band: a stable signature of the trace's tool-usage shape.
 * Uses tags as a deterministic proxy (sorted, joined) since the canonical
 * TraceMetadata does not carry the full message list. Absent → null.
 */
function toolTrajectoryBand(t: TraceMetadata): string | null {
  if (!t.tags || t.tags.length === 0) return null;
  return "tt:" + [...t.tags].sort().join(",");
}

function bandsFor(dim: CoverageDimension, t: TraceMetadata): string | null {
  switch (dim) {
    case "latency":
      return typeof t.latencyMs === "number" ? latencyBand(t.latencyMs) : null;
    case "score":
      return typeof t.normalizedScore === "number" ? scoreBand(t.normalizedScore) : null;
    case "temporal":
      return t.startTime ? temporalBand(t.startTime) : null;
    case "tool-trajectory":
      return toolTrajectoryBand(t);
  }
}

const ALL_DIMENSIONS: CoverageDimension[] = ["latency", "score", "temporal", "tool-trajectory"];

function dimensionCoverage(
  dim: CoverageDimension,
  population: TraceMetadata[],
  sampleIds: Set<string>
): DimensionCoverage {
  const populationBands = new Set<string>();
  const coveredBands = new Set<string>();
  for (const t of population) {
    const band = bandsFor(dim, t);
    if (band === null) continue;
    populationBands.add(band);
    if (sampleIds.has(t.traceId)) coveredBands.add(band);
  }
  const populationBuckets = populationBands.size;
  const coveredBuckets = coveredBands.size;
  // Absent dimension (no bands in population) → vacuously fully covered (100%).
  const coveragePct = populationBuckets === 0 ? 100 : (coveredBuckets / populationBuckets) * 100;
  return { dimension: dim, populationBuckets, coveredBuckets, coveragePct };
}

/**
 * R2.5 main entry: prove the sample's representativeness over the population
 * across all 4 dimensions, compute population vs sample badness means (bias proof),
 * and derive a single coverageConfidence + level for the finding.
 *
 * Pure + deterministic: re-running on the same inputs returns identical numbers.
 */
export function buildCoverageProof(
  population: TraceMetadata[],
  sample: BucketSample
): CoverageProof {
  const sampleIds = new Set(sample.selected.map((s) => s.traceId));

  const dimensions = ALL_DIMENSIONS.map((d) => dimensionCoverage(d, population, sampleIds));
  const coverageConfidence = dimensions.length === 0
    ? 100
    : round2(dimensions.reduce((sum, d) => sum + d.coveragePct, 0) / dimensions.length);
  const level = confidenceLevel(coverageConfidence);

  const populationMeanBadness = population.length === 0
    ? 0
    : round4(population.reduce((sum, t) => sum + computeBadness(t), 0) / population.length);
  const sampledTraces = population.filter((t) => sampleIds.has(t.traceId));
  const sampleMeanBadness = sampledTraces.length === 0
    ? 0
    : round4(sampledTraces.reduce((sum, t) => sum + computeBadness(t), 0) / sampledTraces.length);

  const populationStats: PopulationStats = {
    populationSize: population.length,
    sampleSize: sampleIds.size,
    sampleFraction: population.length === 0 ? 0 : round4(sampleIds.size / population.length),
    populationMeanBadness,
    sampleMeanBadness,
  };

  return {
    coverageConfidence,
    level,
    dimensions,
    population: populationStats,
    isLow: level === "low",
  };
}

// ── W12-13 (OP-4): per-finding coverage proof ─────────────────────────────────

/**
 * W12-13: Map the sampler's population-level `CoverageProof` onto the
 * render-facing `FindingCoverageProof` shape (defined in trace.ts so the renderer
 * stays dependency-light). The renderer's `renderCoverageProof(finding)` reads
 * `finding.coverageProof` — until now the sampler computed a population proof but
 * never attached a per-finding proof, so the "Sampling coverage" slot rendered
 * blank. This mapper is the missing bridge.
 *
 * Pure + deterministic (drops only the `isLow` boolean, which the render shape
 * derives from `level` itself).
 */
export function toFindingCoverageProof(proof: CoverageProof): FindingCoverageProof {
  return {
    coverageConfidence: proof.coverageConfidence,
    level: proof.level,
    dimensions: proof.dimensions.map((d) => ({
      dimension: d.dimension,
      populationBuckets: d.populationBuckets,
      coveredBuckets: d.coveredBuckets,
      coveragePct: d.coveragePct,
    })),
    population: {
      populationSize: proof.population.populationSize,
      sampleSize: proof.population.sampleSize,
      sampleFraction: proof.population.sampleFraction,
      populationMeanBadness: proof.population.populationMeanBadness,
      sampleMeanBadness: proof.population.sampleMeanBadness,
    },
  };
}

/**
 * W12-13: Convenience entry for the orchestrator — compute a `FindingCoverageProof`
 * for ONE finding directly from the population and the finding's evidence sample.
 * The `findingSample` is the BucketSample whose `selected[]` are the trace IDs that
 * back THIS finding's evidence (a subset of the population). When a finding's
 * evidence is not separately sampled, callers may reuse the run-level sample —
 * the proof then reflects the run-level representativeness for that finding.
 *
 * When no per-finding proof can be computed, the orchestrator should leave
 * `finding.coverageProof` undefined; the renderer emits an explicit
 * "representativeness not computed" marker in that case (W12-13 render slot).
 */
export function buildFindingCoverageProof(
  population: TraceMetadata[],
  findingSample: BucketSample,
): FindingCoverageProof {
  return toFindingCoverageProof(buildCoverageProof(population, findingSample));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── WARN-only gate (R2.5) ─────────────────────────────────────────────────────

export interface CoverageWarning {
  /** Human-readable warning line for the run log / banner. */
  message: string;
  /** The confidence value that tripped the warning. */
  coverageConfidence: number;
}

/**
 * R2.5 WARN-only gate. A "low" coverage proof NEVER blocks — it emits a warning
 * UNLESS the operator passed `--accept-low-confidence` (acceptLowConfidence=true),
 * in which case the warning is suppressed. This is the only behaviour difference
 * the flag controls; the report still renders the coverage widget either way.
 *
 * Returns null when no warning is warranted (level !== "low", or flag set).
 */
export function coverageWarning(
  proof: CoverageProof,
  acceptLowConfidence: boolean
): CoverageWarning | null {
  if (!proof.isLow) return null;
  if (acceptLowConfidence) return null;
  return {
    message:
      `WARN: low sampling coverage (${proof.coverageConfidence.toFixed(1)}%). ` +
      `Evidence may under-represent the population. Non-blocking. ` +
      `Pass --accept-low-confidence to suppress.`,
    coverageConfidence: proof.coverageConfidence,
  };
}

/**
 * Parse the `--accept-low-confidence` flag from a CLI argv slice. Deterministic.
 */
export function parseAcceptLowConfidence(argv: string[]): boolean {
  return argv.includes("--accept-low-confidence");
}

// ── W9-09: Batch escalation helper + sufficiency predicate ───────────────────

/**
 * W9-09: Result of a single escalation batch.
 * The orchestrator stores these as RunMeta.deepRead.batches[].
 */
export interface BatchResult {
  /** The tier/rung up to which this batch was sampled. */
  tier: number;
  /** The sample produced for this tier. */
  sample: BucketSample;
  /** Coverage proof for this batch's sample. */
  coverageProof: CoverageProof;
  /**
   * Number of NEW distinct failureOrigin.what categories surfaced in this batch
   * (compared to all previously seen categories). The orchestrator tracks the
   * running set and passes the count here.
   */
  newFailureCategories: number;
}

/**
 * W9-09: Produce a deterministic batch sample up to `tier` traces using the
 * existing 4-bucket worst-weighted sampler. Reuses buildBucketSample() with
 * `floor = tier` so the returned sample is always up to `tier` traces.
 *
 * Determinism: NO clock, NO random. Same population + tier → same output.
 * Small populations (size < tier) return the whole population.
 *
 * @param population  All trace metadata in scope (not yet filtered).
 * @param tier        The escalation rung (e.g. 50, 100, 250, 500, 1000).
 */
export function buildBatchSample(
  population: TraceMetadata[],
  tier: number,
): BatchResult {
  const sample = buildBucketSample(population, tier);
  const coverageProof = buildCoverageProof(population, sample);
  // newFailureCategories is 0 by default — caller updates the running set
  // before recording the batch and passes the count; this default is safe for
  // the first call when no prior batches exist.
  return { tier, sample, coverageProof, newFailureCategories: 0 };
}

/**
 * W9-09: Sufficiency predicate — returns true when the escalation loop can stop
 * because evidence is convincing:
 *   coverageConfidence === 'high' AND newFailureCategoriesInLastBatch === 0
 *
 * Pure, deterministic. The loop calls this after each batch to decide whether
 * to escalate to the next rung.
 *
 * @param proof                         Coverage proof from the latest batch.
 * @param newFailureCategoriesInLastBatch  Count of NEW what-categories in the last batch.
 */
export function isSufficient(
  proof: CoverageProof,
  newFailureCategoriesInLastBatch: number,
): boolean {
  return proof.level === "high" && newFailureCategoriesInLastBatch === 0;
}

// ── CLI entrypoint (PRD-SO-05) ────────────────────────────────────────────────
//
// Usage:
//   bun scripts/cli/run.sh scripts/sample/representative.ts \
//       --metadata <traces-metadata.json> --output <out.json> \
//       [--n <floor>] [--accept-low-confidence]
//
// Reads TraceMetadata[] from --metadata, runs buildBucketSample + buildCoverageProof,
// writes { sample, coverageProof, warning } JSON to --output (stdout when omitted).

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const args = process.argv.slice(2);

  function argVal(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  }

  const metadataPath = argVal("--metadata");
  if (!metadataPath) {
    console.error("Usage: representative.ts --metadata <file> --output <file> [--n N] [--accept-low-confidence]");
    process.exit(2);
  }

  const outputPath = argVal("--output");
  const floorRaw = argVal("--n");
  const floor = floorRaw !== undefined && !isNaN(Number(floorRaw)) ? Number(floorRaw) : DEFAULT_SAMPLE_FLOOR;
  const acceptLow = parseAcceptLowConfidence(args);

  const traces = JSON.parse(readFileSync(resolve(metadataPath), "utf-8")) as Parameters<typeof buildBucketSample>[0];
  const sample = buildBucketSample(traces, floor);
  const proof = buildCoverageProof(traces, sample);
  const warning = coverageWarning(proof, acceptLow);

  const out = { sample, coverageProof: proof, warning };
  const json = JSON.stringify(out, null, 2);

  if (outputPath) {
    writeFileSync(resolve(outputPath), json, "utf-8");
    console.info(`representative sample written to ${outputPath}`);
  } else {
    console.info(json);
  }

  if (warning) {
    console.warn(warning.message);
  }
}
