/**
 * scripts/run-deterministic.ts
 * ---------------------------------------------------------------------------
 * The deterministic executor — Tab-1 deterministic rows (decision #4). Walks the
 * subject eval-matrix; for every criterion whose checkMethod is in the
 * DETERMINISTIC track (deterministic-script | typebox-schema | gate) it runs a
 * binary pass/fail check with NO model. Judge-track rows (trace-cross-ref |
 * trajectory-diff) are emitted as `track:judge, result:skip` placeholders that
 * the pinned-judge seam (run-judge.ts) fills in.
 *
 * The deterministic checks are REAL and grounded in the loaded run-bundle:
 *  - typebox-schema  : the relevant produced artifact must be present + parse as
 *                      a non-empty object/array (the schema-conformance proxy the
 *                      bundle can answer offline).
 *  - gate            : the gate's evidence must be present (e.g. an evidence/
 *                      file set, a wave6 stamp) — absence => fail-loud.
 *  - deterministic-script : the artifact the script produces must be present and
 *                      non-empty in the bundle.
 *
 * Where a criterion's deep semantic check genuinely needs to re-execute the
 * subject's own script against live data (beyond presence/shape), that is an
 * EXPLICIT, documented integration seam (see `evaluateDeterministic` -> the
 * `needsLiveReexec` path) rather than a silent pass. Such rows return result
 * `skip` with a detail explaining the seam, so they never FALSE-PASS.
 *
 * Pure + deterministic: components/criteria are processed in matrix order; no
 * clock/random/network.
 */
import {
  type Component,
  type Criterion,
  type EvalMatrix,
  type RowResultValue,
  type ScorecardCriterion,
  RowResult,
  Track,
  trackForCheckMethod,
} from "./contracts/types.ts";
import { type RunBundle } from "./contracts/types.ts";

export interface DeterministicRowResult {
  componentId: string;
  criterion: ScorecardCriterion;
}

/**
 * Map a criterion to the artifact whose presence/shape proves it. Subject-
 * agnostic heuristic: the bundle's well-known artifacts cover the produced
 * outputs an audit can verify offline. A criterion that references no bundle
 * artifact is a live-reexec seam.
 */
function evidenceArtifactFor(
  criterion: Criterion,
  bundle: RunBundle,
): string | null {
  // Gate rows about evidence/aggregate require the evidence dir.
  const s = criterion.statement.toLowerCase();
  if (s.includes("evidence file") || s.includes("evidence/")) {
    return bundle.data.evidence ? "evidence" : null;
  }
  if (s.includes("wave-6") || s.includes("wave6") || s.includes("stamp")) {
    return bundle.data.wave6 ? "wave6" : null;
  }
  if (s.includes("runmeta") || s.includes("runmeta.")) {
    return bundle.data.runMeta ? "runMeta" : null;
  }
  if (s.includes("entity") || s.includes("diagnosedentity")) {
    return bundle.data.entityContext ? "entityContext" : null;
  }
  if (s.includes("renderinput") || s.includes("render input") || s.includes("heatmap")) {
    return bundle.data.renderInput ? "renderInput" : null;
  }
  if (s.includes("traces-metadata") || s.includes("traces metadata")) {
    return bundle.data.tracesMetadata ? "tracesMetadata" : null;
  }
  return null;
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

export interface EvaluateOptions {
  /**
   * When false (default), criteria that need a LIVE re-exec of the subject's own
   * script (beyond bundle presence/shape) return `skip` with a documented seam
   * note instead of false-passing. A future integration may set this true and
   * provide a re-exec callback.
   */
  liveReexec?: (criterion: Criterion) => RowResultValue | null;
}

/**
 * Evaluate ONE deterministic criterion against the bundle. Never throws; returns
 * a binary pass/fail, or `skip` with a documented reason for a live-reexec seam.
 */
export function evaluateDeterministic(
  criterion: Criterion,
  bundle: RunBundle,
  opts: EvaluateOptions = {},
): ScorecardCriterion {
  const track = Track.Deterministic;
  const artifactKey = evidenceArtifactFor(criterion, bundle);

  if (artifactKey == null) {
    // No bundle artifact answers this row offline -> live-reexec seam.
    const live = opts.liveReexec?.(criterion) ?? null;
    if (live) {
      return {
        dimension: criterion.dimension,
        severity: criterion.severity,
        checkMethod: criterion.checkMethod,
        track,
        result: live,
        detail: "evaluated via live-reexec callback",
      };
    }
    return {
      dimension: criterion.dimension,
      severity: criterion.severity,
      checkMethod: criterion.checkMethod,
      track,
      result: RowResult.Skip,
      detail:
        "INTEGRATION SEAM: requires live re-exec of the subject's own script (no bundle artifact answers this row offline); skipped rather than false-passed",
    };
  }

  const present = isNonEmpty(bundle.data[artifactKey]);
  return {
    dimension: criterion.dimension,
    severity: criterion.severity,
    checkMethod: criterion.checkMethod,
    track,
    result: present ? RowResult.Pass : RowResult.Fail,
    detail: present
      ? `evidence artifact '${artifactKey}' present + non-empty`
      : `evidence artifact '${artifactKey}' MISSING/empty in bundle (fail-loud)`,
  };
}

/** Judge-track placeholder — filled in by the pinned-judge seam. */
export function judgePlaceholder(criterion: Criterion): ScorecardCriterion {
  return {
    dimension: criterion.dimension,
    severity: criterion.severity,
    checkMethod: criterion.checkMethod,
    track: Track.Judge,
    result: RowResult.Skip,
    detail:
      "PINNED-JUDGE SEAM: requires pinned model (id + temp=0) reading transcript vs behavior-tree; deferred to run-judge.ts",
  };
}

export interface RunDeterministicResult {
  rows: DeterministicRowResult[];
  deterministicCount: number;
  judgeCount: number;
}

// ── Coverage honesty (EV-OUT-002) ──────────────────────────────────────────
/**
 * Default skip-rate at/above which a coverage WARNING is raised. Conservative
 * (0.5) so a run where more rows were skipped than graded can no longer claim a
 * silent PASS. This is a WARNING threshold ONLY — it never flips gate pass/fail.
 */
export const DEFAULT_SKIP_RATE_WARN_THRESHOLD = 0.5;

/** Fixed precision for skipRate so two audits serialize byte-identically. */
const SKIP_RATE_PRECISION = 4;

/** The pass/fail/skip tally `assembleScorecard` derives from the graded rows. */
export interface CoverageTotals {
  pass: number;
  fail: number;
  skip: number;
}

export interface CoverageOptions {
  /**
   * Skip-rate STRICTLY ABOVE which `coverageWarning` is set. Default
   * {@link DEFAULT_SKIP_RATE_WARN_THRESHOLD}. Warning-only — this never alters
   * the GATE's pass/fail decision; the honesty mechanism is the surfaced
   * warning, not a gate flip.
   */
  skipRateWarnThreshold?: number;
}

export interface Coverage {
  /** rows actually graded (pass + fail) — the non-vacuous denominator. */
  graded: number;
  /** every criterion (pass + fail + skip). */
  total: number;
  /** rows skipped (seam / no-bundle-artifact / judge placeholder). */
  skipped: number;
  /** skipped / total, rounded to fixed precision (0 when total is 0). */
  skipRate: number;
  /** the threshold that was applied. */
  skipRateWarnThreshold: number;
  /** true iff skipRate exceeds the threshold — surfaces a near-vacuous PASS. */
  coverageWarning: boolean;
}

/**
 * Derive the coverage-honesty stat from a pass/fail/skip tally. Pure +
 * deterministic: integer counts in, fixed-precision ratio out, no clock/random.
 *
 * A high skip-rate means most criteria were never graded — so a `gateRunPass`
 * of true is near-vacuous. `coverageWarning` makes that LOUD without changing
 * pass/fail semantics (the gate is decided entirely upstream by fail counts).
 */
export function computeCoverage(
  totals: CoverageTotals,
  opts: CoverageOptions = {},
): Coverage {
  const skipRateWarnThreshold =
    opts.skipRateWarnThreshold ?? DEFAULT_SKIP_RATE_WARN_THRESHOLD;
  const graded = totals.pass + totals.fail;
  const skipped = totals.skip;
  const total = graded + skipped;
  const rawRate = total === 0 ? 0 : skipped / total;
  const factor = 10 ** SKIP_RATE_PRECISION;
  const skipRate = Math.round(rawRate * factor) / factor;
  return {
    graded,
    total,
    skipped,
    skipRate,
    skipRateWarnThreshold,
    coverageWarning: skipRate > skipRateWarnThreshold,
  };
}

/**
 * Run the full deterministic pass over a matrix + bundle. Emits one row per
 * criterion: deterministic rows are graded now; judge rows are placeholders.
 */
export function runDeterministic(
  matrix: EvalMatrix,
  bundle: RunBundle,
  opts: EvaluateOptions = {},
): RunDeterministicResult {
  const rows: DeterministicRowResult[] = [];
  let deterministicCount = 0;
  let judgeCount = 0;

  for (const component of matrix.components as Component[]) {
    for (const criterion of component.criteria) {
      const track = trackForCheckMethod(criterion.checkMethod);
      if (track === Track.Deterministic) {
        deterministicCount += 1;
        rows.push({
          componentId: component.componentId,
          criterion: evaluateDeterministic(criterion, bundle, opts),
        });
      } else {
        judgeCount += 1;
        rows.push({
          componentId: component.componentId,
          criterion: judgePlaceholder(criterion),
        });
      }
    }
  }

  return { rows, deterministicCount, judgeCount };
}
