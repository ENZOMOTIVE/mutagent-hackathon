/**
 * scripts/enrich/build-render-input.ts
 * Wave-5 R1.4: deterministic enricher — (tier0-out, slice-plan, findings,
 * trace-metadata) → a fully-populated RenderInput for the gold-standard renderer.
 * Type A — Pure Script (DETERMINISTIC + IDEMPOTENT — no network, no LLM, no random,
 * no clock beyond an injected `generatedAt`).
 *
 * Ported from wave-5-refs/build-render-input.ts (the hand-authored
 * gold-standard body builder). The reference hardcoded its numbers; this enricher
 * DERIVES them from the inputs so the pipeline never hand-authors a report again.
 *
 * Fail-loud (R1 §9.3): if ≥3 of the 4 internal render shapes (diagnosedEntity /
 * bigStat / hourlyHeatmap / signalCensus) cannot be built, THROW — never emit a
 * silently-degraded RenderInput (the regression's root cause).
 *
 * R1.7 (APPENDIX-A): `diagnosedEntity` is PULLED FROM the normalizer's
 * EntityContext (passed in via opts.entityContext), NOT re-synthesized here.
 */

import type {
  Finding,
  TraceMetadata,
  EntityContext,
  Assumption,
} from "../normalize/trace.ts";
import type {
  RenderInput,
  Entity,
  BigStat,
  SignalCensusRow,
  ScanFunnel,
  HourlyHeatmap,
  HourlyHeatCell,
  DecisionLogRow,
  RunMeta,
} from "../report/render.ts";
import { entityFromContext } from "../report/render.ts";
import { rankRemedies } from "./rank-remedies.ts";
import type {
  TrajectoryCorroboration,
  TrajectorySignal,
} from "../scan/trajectory.ts";
import type { DeepReadLedgerEntry } from "../library/types.ts";

// ── Input shapes ──────────────────────────────────────────────────────────────

/** Subset of tier0-scan.ts output the enricher reads. */
export interface Tier0Input {
  totalTraces: number;
  withError?: number;
  withFeedback?: number;
  withLowScore?: number;
  withHighLatency?: number;
  hasPrimarySignal?: boolean;
  recommendedSlicing?: string;
  estimatedSlots?: number;
  patterns?: Array<{ patternId: string; name: string; matchCount: number }>;
}

/**
 * W11-01: PrimarySignal — the reconciled primary signal for a diagnostic run.
 * Emitted by buildSignalCensus and threaded to RunMeta.primarySignal for
 * census badge · heatmap · funnel to read from a single authoritative source.
 */
export interface PrimarySignal {
  /** The selected primary signal name (e.g. "latency-spike"). */
  name: string;
  /** One-sentence rationale for selection (impact×prevalence + deep-read corroboration). */
  why: string;
  /** Signals ruled out BEFORE scoring (e.g. benign observability artifacts). */
  ruledOut: string[];
  /** Confidence level based on deep-read corroboration. */
  confidence: "high" | "medium" | "low";
}

/** Subset of slicer.ts output the enricher reads. */
export interface SlicePlanInput {
  totalSlices?: number;
  slices?: Array<{ sliceId?: string; traceIds?: string[] }>;
  rationale?: string;
}

/**
 * The findings document (already RenderInput-shaped from the RCA layer): carries
 * sessionId, findings, runMeta, audience, isMetaReport, plus story-led copy.
 */
export interface FindingsInput {
  sessionId: string;
  diagnosedAt: string;
  sourcePlatform: string;
  targetPlatform: string;
  totalTraces: number;
  findings: Finding[];
  audience?: "client" | "internal";
  isMetaReport?: boolean;
  runMeta?: RunMeta;
  entities?: Entity[];
  // Story-led overview copy (optional — passed through verbatim).
  headerTitle?: string;
  overviewTitle?: string;
  overviewSub?: string;
  overviewHeadline?: string;
  overviewLeverage?: string;
  decisionsBundle?: string;
  mermaidSequence?: string;
  decisionLog?: DecisionLogRow[];
}

/** Trace metadata as emitted by the normalizers (+ optional cost). */
export interface MetadataInput extends TraceMetadata {
  totalCostUsd?: number;
}

export interface EnricherInputs {
  tier0: Tier0Input;
  slicePlan: SlicePlanInput;
  findings: FindingsInput;
  metadata: MetadataInput[];
}

export interface EnricherOptions {
  /** Injected ISO8601 timestamp — keeps the enricher deterministic in tests. */
  generatedAt: string;
  /** R1.7: EntityContext from the normalizer (preferred over findings.entities). */
  entityContext?: EntityContext;
  /**
   * SD self-diag: set when `config.self_diagnostics.enabled`. Forces isMetaReport,
   * audience=internal, a `[INTERNAL]` sessionId prefix, and a skill-typed entity.
   * When supplied, `selfDiag.skillEntity` is the EntityContext built from the
   * skill's own SKILL.md + scripts/ (via buildSkillSelfEntityContext).
   */
  selfDiag?: {
    enabled: boolean;
    /** Skill-typed EntityContext (entityType:"skill", codeAccess:true). */
    skillEntity?: EntityContext;
  };
  /**
   * W17-C (SELECTION HUB integration seam): the discovered-signal context threaded into
   * buildSignalCensus — trajectory corroborations (R1 floor), folded ledger digests (R2)
   * + the sampled-trace count (R6 honest prevalence). OPTIONAL: Block B (ledger fold) and
   * Block D1 (trajectory scan) populate it upstream; until then the enricher runs the
   * legacy Tier-0-only census (discovered signals, if any, surface as suspected-unconfirmed
   * — never silently crowned, because no corroboration = no PRIMARY eligibility).
   */
  signalCtx?: SignalCensusContext;
}

// ── Deterministic numeric helpers ─────────────────────────────────────────────

/** Nearest-rank percentile over a numeric array (deterministic). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[rank];
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/** Round to N decimals deterministically. */
function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Format a millisecond latency as a compact seconds string ("39s"). */
function ms2s(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

// ── Heatmap aggregation (the core R1.4 deterministic computation) ──────────────

/**
 * F3 (UR-2): the heatmap metric MODE, keyed to the primary signal. The cell metric
 * + colour FOLLOWS the primary failure mode rather than being latency-locked.
 *
 *   latency-spike  → avg latency (absolute bands, the historic default)
 *   cost-overshoot → avg $/trace (relative bands)
 *   error-WHAT     → error rate  (relative bands)
 *   else           → volume      (relative bands)
 *
 * Default (no primarySignal / unrecognized) = "latency" so a latency-primary run is
 * byte-identical to the pre-F3 behaviour.
 */
type HeatMetricMode = "latency" | "cost" | "error" | "volume";

/** WHAT-categories that map to the error-rate heatmap mode. */
const ERROR_WHATS = new Set([
  "wrong-output",
  "hallucination",
  "missing-output",
  "format-violation",
]);

/**
 * W17-C (R6): discovered WHY-style signals (from the trajectory map — tool-misuse ·
 * handoff-loss · prompt-underspec) have NO direct per-trace numeric metric (unlike
 * latency/cost/error). When one of these is the discovery-only primary, the heatmap
 * falls back to the MECHANICAL metric the enricher can ALWAYS compute from metadata:
 * trace VOLUME. This keeps the heatmap honest (a real per-hour mechanical metric) rather
 * than fabricating a per-hour "tool-misuse rate" the metadata cannot support.
 */
const DISCOVERY_ONLY_VOLUME_SIGNALS = new Set([
  "tool-misuse",
  "handoff-loss",
  "prompt-underspec",
  "loop",
]);

/** Resolve the heatmap metric mode from a primary-signal name (deterministic). */
export function resolveHeatMetricMode(primarySignalName?: string): HeatMetricMode {
  if (primarySignalName === "cost-overshoot") return "cost";
  if (primarySignalName && ERROR_WHATS.has(primarySignalName)) return "error";
  if (primarySignalName === "latency-spike" || !primarySignalName) return "latency";
  // W17-C (R6): discovery-only WHY-style primaries have no per-trace numeric metric →
  // mechanical-metric fallback = volume (the metric metadata can always supply).
  if (primarySignalName && DISCOVERY_ONLY_VOLUME_SIGNALS.has(primarySignalName)) return "volume";
  // volume / no-signal / any other admissible signal → volume view.
  return "volume";
}

/**
 * F3: classify a value into an l0..l4 bucket using RELATIVE bands (quintiles of the
 * observed max). Used for cost / error / volume modes where there are no absolute
 * gold-standard boundaries (latency keeps its absolute bands via classifyHeatLevel).
 * Deterministic. maxValue 0 → all cells l0.
 */
function classifyRelativeLevel(value: number, maxValue: number): number {
  if (maxValue <= 0 || value <= 0) return 0;
  const frac = value / maxValue;
  if (frac >= 0.8) return 4;
  if (frac >= 0.6) return 3;
  if (frac >= 0.4) return 2;
  if (frac >= 0.2) return 1;
  return 0;
}

/** Absolute latency→l0..l4 bands (mirrors render.ts classifyHeatLevel for parity). */
function classifyLatencyLevel(avgS: number): number {
  if (avgS < 50) return 0;
  if (avgS < 65) return 1;
  if (avgS < 85) return 2;
  if (avgS < 100) return 3;
  return 4;
}

/**
 * Aggregate a 24h heatmap from per-trace startTime + latencyMs (+ cost + error).
 * Each cell = one hour bucket: trace count, avg latency (s), max latency (s), plus
 * F3 dynamic-metric fields (level / metricValue / metricLabel) keyed to the primary
 * signal. Cells with zero traces are still emitted (count 0) so the 24-cell grid is
 * complete. DETERMINISTIC — pure function of the metadata + the (data-derived)
 * primary-signal name.
 *
 * F3 default = latency: when primarySignalName is latency/absent the cell colour is
 * the historic absolute-band latency colour, so a latency-primary run is unchanged.
 */
export function aggregateHourlyHeatmap(
  metadata: MetadataInput[],
  primarySignalName?: string
): HourlyHeatmap {
  const buckets: Array<{ latencies: number[]; costs: number[]; errors: number }> =
    Array.from({ length: 24 }, () => ({ latencies: [], costs: [], errors: 0 }));

  for (const t of metadata) {
    if (!t.startTime || t.latencyMs === undefined) continue;
    const hour = new Date(t.startTime).getUTCHours();
    if (Number.isNaN(hour)) continue;
    buckets[hour].latencies.push(t.latencyMs);
    buckets[hour].costs.push(t.totalCostUsd ?? 0);
    if (t.hasError) buckets[hour].errors += 1;
  }

  const mode = resolveHeatMetricMode(primarySignalName);

  // First pass: latency stats + the raw active-metric value per cell.
  const interim = buckets.map((b, hour) => {
    const count = b.latencies.length;
    const avgS = count > 0 ? round(sum(b.latencies) / count / 1000) : 0;
    const maxS = count > 0 ? round(Math.max(...b.latencies) / 1000) : 0;
    const avgCost = count > 0 ? round(sum(b.costs) / count, 4) : 0;
    const errorRate = count > 0 ? round((b.errors / count) * 100) : 0;
    const metricValue =
      mode === "cost" ? avgCost : mode === "error" ? errorRate : mode === "volume" ? count : avgS;
    return { hour, count, avgS, maxS, avgCost, errorRate, metricValue };
  });

  // Relative-band modes need the observed max across cells.
  const maxMetric = Math.max(0, ...interim.map((c) => c.metricValue));

  const cells: HourlyHeatCell[] = interim.map((c) => {
    const level =
      mode === "latency"
        ? classifyLatencyLevel(c.avgS)
        : classifyRelativeLevel(c.metricValue, maxMetric);
    const metricLabel =
      mode === "cost"
        ? `avg $${c.avgCost.toFixed(2)}`
        : mode === "error"
          ? `${c.errorRate}% errors`
          : mode === "volume"
            ? `${c.count} traces`
            : `avg ${c.avgS}s`;
    return {
      hour: c.hour,
      count: c.count,
      avgS: c.avgS,
      maxS: c.maxS,
      level,
      metricValue: c.metricValue,
      metricLabel,
    };
  });

  // Narrative: top volume + top active-metric hours.
  const byVol = cells.filter((c) => c.count > 0).slice().sort((a, b) => b.count - a.count);
  const byMetric = cells
    .filter((c) => c.count > 0)
    .slice()
    .sort((a, b) => (b.metricValue ?? 0) - (a.metricValue ?? 0));
  const fmt = (c: HourlyHeatCell) => `${c.hour.toString().padStart(2, "0")}h`;
  const metricWord =
    mode === "cost" ? "cost" : mode === "error" ? "error rate" : mode === "volume" ? "volume" : "latency";
  const narrative =
    byVol.length > 0 && byMetric.length > 0
      ? `Volume peaks at ${byVol.slice(0, 3).map(fmt).join(", ")}; ${metricWord} peaks at ${byMetric.slice(0, 3).map(fmt).join(", ")}.`
      : undefined;

  const metric: HourlyHeatmap["metric"] = {
    signal: primarySignalName ?? "latency-spike",
    label:
      mode === "cost" ? "avg cost" : mode === "error" ? "error rate" : mode === "volume" ? "volume" : "avg latency",
    unit: mode === "cost" ? "$" : mode === "error" ? "%" : mode === "volume" ? "" : "s",
  };

  const heatmap: HourlyHeatmap = { cells, metric };
  if (narrative) heatmap.narrative = narrative;
  return heatmap;
}

// ── Big-stat row ───────────────────────────────────────────────────────────────

/** Build the 6-tile big-stat row from latency percentiles + cost + counts. */
export function buildBigStat(
  metadata: MetadataInput[],
  tier0: Tier0Input
): BigStat[] {
  // Truly starved: no traces at all → no big-stat row to build (fail-loud signal).
  if (metadata.length === 0) return [];

  const latencies = metadata
    .map((t) => t.latencyMs)
    .filter((v): v is number => v !== undefined);
  const cost = round(sum(metadata.map((t) => t.totalCostUsd ?? 0)), 2);
  const errors = tier0.withError ?? metadata.filter((t) => t.hasError).length;

  // PRD-SO-07: cost tile color-coded: red > $50, yellow > $10, muted <= $10.
  const costColor = cost > 50 ? "var(--r)" : cost > 10 ? "var(--y)" : "var(--muted)";

  return [
    { value: latencies.length ? ms2s(percentile(latencies, 50)) : "—", label: "latency p50", color: "var(--y)" },
    { value: latencies.length ? ms2s(percentile(latencies, 95)) : "—", label: "latency p95", color: "var(--y)" },
    { value: latencies.length ? ms2s(Math.max(...latencies)) : "—", label: "latency max", color: "var(--r)" },
    { value: cost > 0 ? `$${cost.toFixed(2)}` : "—", label: "cost / window", color: costColor },
    { value: metadata.length.toLocaleString("en-US"), label: "traces", color: "var(--muted)" },
    { value: String(errors), label: "errors", color: errors > 0 ? "var(--r)" : "var(--g)" },
  ];
}

// ── Signal census ──────────────────────────────────────────────────────────────

/**
 * W11-01: Impact weight per WHAT category.
 * Signals that map to user-facing failure WHATs (correctness / cost / latency)
 * score higher than observability artifacts (missing-metadata, etc.).
 * Scale: 3 = direct user harm, 2 = indirect / degraded UX, 1 = mild / uncertain.
 *
 * W17-C (R3 — default impact ≥ 2): the DISCOVERED taxonomy (deep-read-found WHATs
 * + ledger-folded digests + trajectory-corroborated signals) is keyed here so a
 * discovered signal NEVER falls back to the impact-1 default — at impact 1 a fresh,
 * genuine discovery would silently lose to latency-spike (impact 2) on prevalence
 * tiebreak. The discovered WHY-style signals come from the trajectory map
 * (loop/latency · tool-misuse · handoff-loss · prompt-underspec); `correctness` and
 * `loop` carry impact 3. `hallucination` is already 3 (a correctness WHAT).
 */
const SIGNAL_IMPACT: Record<string, number> = {
  "wrong-output":        3,
  "hallucination":       3,
  "missing-output":      3,
  "loop":                3,
  "cost-overshoot":      3,
  "latency-spike":       2,
  "format-violation":    2,
  "user-complaint":      2,
  "low-score":           2,
  "missing-context":     1,

  // ── W17-C (R3): discovered taxonomy — impact ≥ 2 floor (never the default 1) ──
  "correctness":         3, // umbrella correctness WHAT (≥ latency on a tie)
  "handoff-loss":        2, // abandoned-call → degraded multi-step UX
  "prompt-underspec":    2, // oscillation → wasted turns / wrong path
  "tool-misuse":         2, // tool-error → broken action, degraded UX
};

/**
 * W17-C (R3): DISCOVERED-signal default impact. Any discovered signal NOT explicitly
 * keyed in SIGNAL_IMPACT falls back to 2 (NOT the cheap-signal default of 1), so an
 * unknown but genuine discovered category cannot silently lose to latency-spike on the
 * prevalence tiebreak. Tier-0 cheap signals keep the impact-1 default (DEFAULT_IMPACT).
 */
const DISCOVERED_DEFAULT_IMPACT = 2;

/** Tier-0 cheap-signal default impact (unchanged — mild / uncertain). */
const DEFAULT_IMPACT = 1;

/**
 * W11-01: Benign observability artifacts that NEVER qualify as a primary signal
 * (failure-validity gate). These patterns may appear in the Tier-0 census but are
 * ruled out before impact×prevalence scoring because they do not map to a user-
 * visible WHAT failure category.
 *
 * W12-05 (PR-051 propose): `low-tagging-rate` was REMOVED — its Tier-0 emitter
 * (LF-002) is deleted, so it is now dead. The BENIGN_SIGNALS mechanism is RETAINED
 * as a forward-looking guard for genuine future observability artifacts.
 */
const BENIGN_SIGNALS = new Set([
  "missing-metadata",
  "missing-score",
]);

/**
 * W12-05 (PR-051 propose): signal source-allowlist. The census admits only
 * MECHANICAL signals that map to a user-visible failure WHAT. Any Tier-0 pattern
 * whose name is neither a known mechanical signal NOR a deep-read failure-WHAT
 * category is observability hygiene by construction and is ruled out BEFORE
 * scoring — observability hygiene can never leak in as a signal/census row even
 * if a future Tier-0 module emits one. Deep-read `failureOrigin.what` categories
 * are admitted via SIGNAL_IMPACT (which keys them) at the corroboration step.
 */
const MECHANICAL_SIGNALS = new Set([
  "error-spike",
  "latency-spike",
  "feedback-cluster",
  "low-score-concentration",
  "api-exhaustion",
  "context-compaction-cluster",
  "high-teammate-ratio",
]);

/**
 * True when a Tier-0 pattern name is an admissible census signal — i.e. a
 * mechanical signal, a deep-read failure-WHAT category, OR a recognized benign
 * artifact (which earns a visible "ruled out" row rather than a silent drop).
 * Anything else is observability hygiene and is dropped silently (W12-05).
 */
function isAdmissibleSignal(name: string): boolean {
  return MECHANICAL_SIGNALS.has(name) || name in SIGNAL_IMPACT || BENIGN_SIGNALS.has(name);
}

// ── W17-C SELECTION HUB — discovered-signal pool + the R1 evidence floor ──────────
//
// Wave-17 makes deep-read-DISCOVERED signals FIRST-CLASS census candidates (the old
// `validPatterns.some(p => p.name === llmWhat)` gate is deleted). A discovered signal
// is any failure-WHAT surfaced by the LLM analyzer (findings[].failureOrigin.what) OR
// folded from a still-valid cross-run ledger digest (Block G). But first-class ≠ free:
//   R1 — a discovered signal may be PRIMARY only if MECHANICALLY corroborated by an
//        analyzeTrajectory() corroboration whose signal (via PATTERN_SIGNAL_MAP) maps
//        to the discovered WHAT, with a RESOLVABLE evidenceRef. LLM-asserted citation
//        alone is NOT enough. Unevidenced discovered → capped at SECONDARY.
//   R2 — a ledger-folded digest must RE-PASS the SAME floor (its evidenceRef must still
//        resolve + corroborate). A digest is never trusted blindly.

/**
 * W17-C (R1/R4): does a trajectory corroboration `signal` corroborate a discovered
 * WHAT? The trajectory layer emits coarse WHY-style signal labels (loop/latency ·
 * tool-misuse · handoff-loss · prompt-underspec — see PATTERN_SIGNAL_MAP); the
 * discovered WHAT may be a WhatCategory (loop · latency-spike · hallucination …) OR a
 * WhyCategory-style label (tool-misuse · handoff-loss · prompt-underspec). The compound
 * `loop/latency` corroborates EITHER `loop` OR `latency-spike`. Exact-label matches
 * (tool-misuse / handoff-loss / prompt-underspec) pass through. `hallucination` has no
 * mechanical trajectory signal → never corroborated here (it is content-only; R1 caps
 * it at SECONDARY unless an exact-named trajectory signal ever maps to it).
 */
function trajectorySignalMatchesWhat(signal: TrajectorySignal, what: string): boolean {
  if (signal === "loop/latency") return what === "loop" || what === "latency-spike";
  // The remaining trajectory signals are exact WHY-style labels.
  return signal === what;
}

/**
 * W17-C (R1): a single resolved mechanical corroboration for a discovered WHAT.
 * Carries the concrete evidenceRef so the census/selection card can CITE it (not just
 * assert it). `undefined` from resolveCorroboration() means "unevidenced → cap at
 * SECONDARY".
 */
interface ResolvedCorroboration {
  signal: TrajectorySignal;
  evidenceRef: string;
}

/**
 * W17-C (R1 — evidence-cited floor): find a trajectory corroboration that mechanically
 * evidences `what`. A corroboration counts ONLY when:
 *   (a) its signal maps (via PATTERN_SIGNAL_MAP semantics) to `what`, AND
 *   (b) its evidenceRef RESOLVES — i.e. is a non-empty, well-formed trace span pointer
 *       (`trace:<id>#msg[...]`, the makeEvidenceRef shape). An empty/garbled ref is NOT
 *       resolvable, so a corroboration carrying one does not satisfy the floor.
 * Returns the first matching resolvable corroboration (deterministic — input order),
 * or undefined when none corroborates `what` (→ discovered signal capped at SECONDARY).
 */
function resolveCorroboration(
  what: string,
  corroborations: ReadonlyArray<TrajectoryCorroboration>
): ResolvedCorroboration | undefined {
  for (const c of corroborations) {
    if (!trajectorySignalMatchesWhat(c.signal, what)) continue;
    if (!isResolvableEvidenceRef(c.evidenceRef)) continue;
    return { signal: c.signal, evidenceRef: c.evidenceRef };
  }
  return undefined;
}

/**
 * W17-C (R1/R2): an evidenceRef is RESOLVABLE when it matches the deterministic
 * trajectory-evidence shape `trace:<traceId>#msg[<indices>]` (makeEvidenceRef in
 * scan/trajectory.ts) with at least one span index. This is the mechanical "does the
 * citation point at a real span" check the floor demands — an LLM that merely asserts
 * a signal without a span pointer, or a stale ledger digest whose evidenceRef no longer
 * conforms, fails here and cannot reach PRIMARY. Pure + deterministic.
 */
export function isResolvableEvidenceRef(ref: string | undefined): boolean {
  return typeof ref === "string" && /^trace:[^#]+#msg\[\d+(?:,\d+)*\]$/.test(ref);
}

/**
 * W17-C (selection hub): one merged candidate in the discovered-signal pool. `origin`
 * records WHERE the candidate came from (deep-read finding vs folded ledger digest) so
 * the selection card + residual-surfacing copy can be honest. `seenCount` is the count
 * of distinct traces the signal was observed on (deep-read finding sourceTraceIds OR
 * 1-per-folded-digest) — the basis for the HONEST prevalence measure (R6: "seen in k/n
 * sampled", never a fabricated corpus rate).
 */
interface DiscoveredCandidate {
  what: string;
  origin: "deep-read" | "ledger";
  /** Distinct traces this discovered signal was observed on (honest prevalence numerator). */
  seenCount: number;
  /** R1: the resolved mechanical corroboration (undefined → cap at SECONDARY). */
  corroboration?: ResolvedCorroboration;
}

/**
 * W12-F1 (UI-2op): the auditable signal-selection metadata the enricher derives
 * from the SAME census scoring data. Threaded into runMeta so the Methodology tab
 * can SHOW THE WORK (per-signal score cards + a mermaid decision-path trace)
 * instead of falling back to the generic 5-step blurb. DETERMINISTIC — no LLM,
 * no clock, no random; purely a function of the impact×prevalence scoring already
 * computed for the census + the deep-read corroboration outcome (PR-049 / PR-038).
 */
export interface SignalSelectionMeta {
  /** Per-signal selection-rule cards (RunMeta.selectionRules shape). */
  selectionRules: NonNullable<RunMeta["selectionRules"]>;
  /** Mermaid decision-path trace (RunMeta.signalSelectionTrace shape). */
  signalSelectionTrace: string;
}

/**
 * W17-C (R7 — residual surfacing): emitted when the top DISCOVERED signal is capped at
 * SECONDARY for lack of mechanical evidence (R1 floor) AND primary falls back to a cheap
 * signal. Block E (the renderer) reads this to show "suspected primary — unconfirmed"
 * instead of silently crowning the cheap signal (e.g. latency-spike). When the discovered
 * signal IS evidence-floored (passes R1) this is absent — there is nothing unconfirmed.
 */
export interface SuspectedPrimary {
  /** The discovered WHAT that was suspected-but-uncorroborated. */
  signal: string;
  /** Distinct sampled traces it was seen on (honest prevalence numerator). */
  seenCount: number;
  /** Sampled-trace denominator (R6 — "seen in k/n sampled"). */
  sampledCount: number;
  /** Why it was capped at SECONDARY (the R1-floor reason). */
  reason: string;
}

/**
 * W17-C (R7): RunMeta + the residual-surfacing field. The canonical `RunMeta` lives in
 * report/render.ts (Block E's scope) and does not yet declare `suspectedPrimaryUnconfirmed`;
 * the enricher (Block C) is the PRODUCER of the field. We model it locally as a superset
 * so the enricher stays type-safe WITHOUT editing render.ts (out of this block's scope).
 * Block E adds the canonical slot to RunMeta when it lands the renderer consumption; the
 * shape here is the contract Block E reads. Structurally a RunMetaW17 IS a RunMeta, so it
 * threads transparently into RenderInput.runMeta.
 */
export type RunMetaW17 = RunMeta & {
  /** R7: present only when a discovered top signal was capped at SECONDARY (unevidenced). */
  suspectedPrimaryUnconfirmed?: SuspectedPrimary;
};

/**
 * W17-C (SELECTION HUB): the discovered-signal wiring the census reads to make
 * deep-read findings + folded ledger digests FIRST-CLASS candidates under the R1
 * evidence floor. All OPTIONAL — a caller that passes only `tier0`/`total`/`findings`
 * gets the legacy Tier-0-only behaviour (backward-compat: existing 3-arg callers and
 * tests are unaffected). Block C (this file) owns this object; Block B threads the
 * folded ledger in, Block D1 threads the trajectory corroborations in.
 */
export interface SignalCensusContext {
  /**
   * R1 evidence floor surface: mechanical corroborations from analyzeTrajectory()
   * across the sampled traces. A discovered signal reaches PRIMARY only if one of
   * these corroborates it (signal maps via PATTERN_SIGNAL_MAP + resolvable evidenceRef).
   */
  corroborations?: ReadonlyArray<TrajectoryCorroboration>;
  /**
   * R2 surface: ledger digests folded down to the still-VALID set by
   * store.foldValidDigests(). Each is re-admitted as a discovered candidate and MUST
   * re-pass the SAME evidence floor (its evidenceRef must still resolve + corroborate)
   * — never trusted blindly.
   */
  foldedDigests?: ReadonlyArray<DeepReadLedgerEntry>;
  /**
   * R6 honest-prevalence denominator: how many traces were actually SAMPLED (deep-read).
   * A discovered primary's measure reads "seen in k/n sampled" against THIS n — never a
   * fabricated corpus rate over `total`. Defaults to `total` when absent (best-effort).
   */
  sampledCount?: number;
}

/**
 * Finding subset the census reads (widened W17-C: + sourceTraceIds for honest
 * prevalence; widened D3: + the RCA-narrative fields the dataset-candidate cards
 * derive from — failureOrigin.{why,where,whatHappened} · severity · problem ·
 * title · subDesc · whyChain origin). All optional — the real Finding is a strict
 * superset, so passing normalizedFindings (full Finding[]) satisfies this type.
 */
type CensusFinding = {
  findingId?: string;
  failureOrigin?: { what?: string; why?: string; where?: string; whatHappened?: string };
  sourceTraceIds?: string[];
  severity?: "crit" | "high" | "med" | "info";
  problem?: string;
  title?: string;
  subDesc?: string;
  whyChain?: Array<{ why?: string; isOrigin?: boolean }>;
};

/**
 * W11-01 + W17-C: Build the signal census as the SELECTION HUB. Pipeline:
 *   1. Failure-validity gate — drop non-admissible signals; benign → ruled-out row.
 *   2. Tier-0 cheap-signal scoring: impact × (matchCount/total), default impact 1.
 *   3. DISCOVERED pool (W17-C, first-class): findings[].failureOrigin.what ∪ folded
 *      ledger digests. Impact-dominant ranking (impact first, prevalence tiebreak),
 *      default impact 2 (R3). The OLD gate `validPatterns.some(p => p.name === llmWhat)`
 *      is DELETED — a discovered signal no longer needs a matching Tier-0 pattern.
 *   4. R1 evidence floor: a discovered signal is PRIMARY-eligible ONLY when mechanically
 *      corroborated (trajectory corroboration maps to its WHAT + resolvable evidenceRef).
 *      R2: folded digests re-pass the SAME floor. Unevidenced discovered → SECONDARY.
 *   5. PRIMARY selection: an evidence-floored discovered signal beats the top cheap
 *      signal (deep-read mechanical > static frequency). Else primary falls back to the
 *      top cheap signal; if a discovered top signal was capped for lack of evidence,
 *      `suspectedPrimaryUnconfirmed` is emitted (R7) so Block E shows "suspected primary
 *      — unconfirmed" instead of silently crowning latency.
 *
 * Returns rows AND attaches primarySignal + selectionRules + signalSelectionTrace +
 * (W17-C) suspectedPrimaryUnconfirmed to the array so callers thread them into RunMeta.
 *
 * @param tier0   - Tier-0 scan output
 * @param total   - Denominator for prevalence (total traces in window)
 * @param findings - Optional findings (deep-read discovered WHATs + sourceTraceIds)
 * @param ctx     - W17-C selection-hub context (corroborations · foldedDigests · sampledCount)
 */
export function buildSignalCensus(
  tier0: Tier0Input,
  total: number,
  findings?: ReadonlyArray<CensusFinding>,
  ctx?: SignalCensusContext
): SignalCensusRow[] &
  { primarySignal?: PrimarySignal } &
  Partial<SignalSelectionMeta> &
  { suspectedPrimaryUnconfirmed?: SuspectedPrimary } {
  const rawPatterns = (tier0.patterns ?? []).slice();
  const corroborations = ctx?.corroborations ?? [];
  const foldedDigests = ctx?.foldedDigests ?? [];
  // R6: honest prevalence denominator = sampled count (falls back to total).
  const sampledN = ctx?.sampledCount ?? total;

  // ── W17-C: assemble the DISCOVERED candidate pool (first-class) ───────────────
  // Source A: deep-read findings — every failureOrigin.what is a discovered signal.
  // Source B (R2): folded ledger digests — each digest.signal re-admits as discovered.
  // Both are merged + deduped by WHAT; seenCount sums distinct evidence (honest prev).
  const discovered = buildDiscoveredPool(findings ?? [], foldedDigests, corroborations);

  // Truly starved: no detected patterns AND no signal counts AND no discovered pool →
  // no census to build (fail-loud signal). A census with only rule-out rows requires
  // that tier0 at least measured the signals (or a discovery exists).
  const hasSignalData =
    rawPatterns.length > 0 ||
    discovered.length > 0 ||
    tier0.withError !== undefined ||
    tier0.withLowScore !== undefined ||
    tier0.withFeedback !== undefined;
  if (!hasSignalData)
    return Object.assign([], {
      primarySignal: undefined,
      selectionRules: undefined,
      signalSelectionTrace: undefined,
      suspectedPrimaryUnconfirmed: undefined,
    });

  // ── Step 1: failure-validity gate (Tier-0 cheap signals) ─────────────────────
  // 1a. Signal source-allowlist (W12-05 / PR-051 propose): drop non-admissible
  //     signals SILENTLY (no census row at all — not even ruled-out). Observability
  //     hygiene must never surface anywhere in the census.
  // 1b. BENIGN_SIGNALS: admissible-but-benign artifacts get a visible "ruled out"
  //     row (forward-looking guard; currently {missing-metadata, missing-score}).
  const ruledOut: string[] = [];
  const validPatternsAll = rawPatterns.filter((p) => {
    if (!isAdmissibleSignal(p.name)) {
      // Not a mechanical signal and not a deep-read failure WHAT → observability
      // hygiene. Dropped silently; never rendered (W12-05).
      return false;
    }
    if (BENIGN_SIGNALS.has(p.name)) {
      ruledOut.push(p.name);
      return false;
    }
    return true;
  });

  // ── W17-C: dedupe overlapping signals across the cheap + discovered pools ──────
  // A signal name may appear in BOTH Tier-0 (cheap pattern) AND the discovered pool
  // (same failure surfaced by deep-read). It is ONE signal — render ONE row. Ownership:
  //   - CORROBORATED discovered name → owned by the discovered pool (it can be PRIMARY
  //     via the evidence floor). Suppress the cheap row so there is no duplicate.
  //   - UNCORROBORATED discovered name that ALSO has a cheap Tier-0 pattern → owned by
  //     the cheap pool (normal prevalence scoring; the discovered duplicate is dropped —
  //     no extra "suspected-unconfirmed" row for a signal Tier-0 already measures).
  // A discovered name with NO cheap pattern always stays in the discovered pool.
  const corroboratedDiscoveredNames = new Set(
    discovered.filter((d) => d.corroboration !== undefined).map((d) => d.what)
  );
  const cheapPatternNames = new Set(validPatternsAll.map((p) => p.name));

  // Cheap pool: drop any pattern whose name is owned by a CORROBORATED discovered signal.
  const validPatterns = validPatternsAll.filter((p) => !corroboratedDiscoveredNames.has(p.name));

  // Discovered pool: drop an UNCORROBORATED discovered signal that a cheap pattern already
  // covers (avoid a duplicate suspected-unconfirmed row for a Tier-0-measured signal).
  const discoveredDeduped = discovered.filter(
    (d) => d.corroboration !== undefined || !cheapPatternNames.has(d.what)
  );

  // ── Step 2: Tier-0 cheap-signal scoring (UNCHANGED real invariant) ────────────
  // score = impact * (matchCount / total).  Ties broken by matchCount, then name.
  // Cheap signals keep the impact-1 DEFAULT_IMPACT fallback.
  const scored = validPatterns
    .map((p) => {
      const impact = SIGNAL_IMPACT[p.name] ?? DEFAULT_IMPACT;
      const prevalence = p.matchCount / Math.max(1, total);
      return { ...p, score: impact * prevalence };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      return a.name.localeCompare(b.name);
    });

  // ── Step 3: DISCOVERED impact-dominant ranking (R3 default impact ≥ 2) ────────
  // Rank discovered signals by IMPACT first (impact-dominant), prevalence (seenCount)
  // tiebreak, then name. Unknown discovered categories get DISCOVERED_DEFAULT_IMPACT
  // (2) — never the cheap-signal default of 1 (else a fresh discovery silently loses
  // to latency-spike). This is intentionally NOT impact×prevalence: a low-prevalence
  // but high-impact freshly-discovered failure should not be buried.
  const discoveredScored = discoveredDeduped
    .map((d) => ({
      ...d,
      impact: SIGNAL_IMPACT[d.what] ?? DISCOVERED_DEFAULT_IMPACT,
    }))
    .sort((a, b) => {
      if (b.impact !== a.impact) return b.impact - a.impact; // impact-dominant
      if (b.seenCount !== a.seenCount) return b.seenCount - a.seenCount; // prevalence tiebreak
      return a.what.localeCompare(b.what);
    });

  // ── Step 4 + 5: R1 evidence floor → PRIMARY selection ────────────────────────
  // The top discovered signal that PASSES the evidence floor (has a resolved mechanical
  // corroboration) is PRIMARY-eligible and beats the top cheap signal. If the top
  // discovered signal exists but is UNEVIDENCED, it is capped at SECONDARY and the
  // residual flag is raised (R7).
  const topDiscovered = discoveredScored[0];
  const evidencedDiscovered = discoveredScored.find((d) => d.corroboration !== undefined);

  const cheapPrimary = scored[0]?.name;
  let primaryName: string | undefined;
  let corroborationNote = "";
  let confidence: PrimarySignal["confidence"] = "medium";
  let primaryEvidenceRef: string | undefined;
  let primaryIsDiscovered = false;
  // R7: when the top discovered signal is capped at SECONDARY for lack of evidence and
  // primary falls back to a cheap signal, surface it so Block E can render "suspected
  // primary — unconfirmed" instead of silently crowning the cheap signal.
  let suspected: SuspectedPrimary | undefined;

  if (evidencedDiscovered) {
    // R1 PASS — an evidence-floored discovered signal wins (deep-read mechanical >
    // static frequency).
    primaryName = evidencedDiscovered.what;
    primaryIsDiscovered = true;
    primaryEvidenceRef = evidencedDiscovered.corroboration!.evidenceRef;
    confidence = "high";
    corroborationNote =
      evidencedDiscovered.origin === "ledger"
        ? `discovered (ledger-folded) — mechanically corroborated (${primaryEvidenceRef})`
        : `discovered (deep-read) — mechanically corroborated (${primaryEvidenceRef})`;
  } else {
    // No evidence-floored discovered signal → primary is the top cheap signal.
    primaryName = cheapPrimary;
    if (cheapPrimary) {
      corroborationNote = "impact×prevalence (no deep-read corroboration)";
      confidence = scored[0].score > 0.5 ? "medium" : "low";
    }
    // R7: a discovered signal WAS surfaced but failed the floor → suspected-unconfirmed.
    if (topDiscovered) {
      suspected = {
        signal: topDiscovered.what,
        seenCount: topDiscovered.seenCount,
        sampledCount: sampledN,
        reason:
          "discovered but UNCONFIRMED — no mechanical trajectory corroboration with a resolvable evidenceRef (R1 evidence floor); capped at SECONDARY",
      };
    }
  }

  // ── Build census rows ─────────────────────────────────────────────────────────
  const rows: SignalCensusRow[] = [];

  // Tier-0 cheap-signal rows. A cheap signal is PRIMARY only when it actually won.
  for (const p of scored) {
    const isPrimary = !primaryIsDiscovered && p.name === primaryName;
    rows.push({
      signal: p.name,
      present: "YES",
      presentColor: "var(--r)",
      measure: `${p.matchCount}/${total} (${round((p.matchCount / total) * 100)}%)`,
      decision: isPrimary
        ? `<span class="badge b-crit">★ PRIMARY</span>`
        : `<span class="badge b-med">SECONDARY</span>`,
      primary: isPrimary,
    });
  }

  // W17-C discovered-signal rows. Honest prevalence (R6): "seen in k/n sampled" — NOT a
  // corpus rate. The evidence-floored winner is ★ PRIMARY; the rest (incl. the capped
  // suspected one) are SECONDARY with an explicit reason.
  for (const d of discoveredScored) {
    const isPrimary = primaryIsDiscovered && d.what === primaryName;
    const evidenced = d.corroboration !== undefined;
    rows.push({
      signal: d.what,
      present: "YES",
      presentColor: evidenced ? "var(--r)" : "var(--y)",
      // R6 honest prevalence — sampled denominator, never a fabricated corpus rate.
      measure: `seen in ${d.seenCount}/${sampledN} sampled`,
      decision: isPrimary
        ? `<span class="badge b-crit">★ PRIMARY</span>`
        : evidenced
          ? `<span class="badge b-med">SECONDARY</span>`
          : `<span class="badge b-med">SECONDARY — discovered, unconfirmed (no mechanical evidence)</span>`,
      primary: isPrimary,
    });
  }

  // Ruled-out rows (benign observability artifacts).
  for (const name of ruledOut) {
    const p = rawPatterns.find((x) => x.name === name)!;
    const rate = p.matchCount / Math.max(1, total);
    rows.push({
      signal: name,
      present: "YES",
      presentColor: rate >= 0.2 ? "var(--y)" : "var(--g)",
      measure: `${p.matchCount}/${total} (${round(rate * 100)}%)`,
      decision:
        rate >= 0.2
          ? "ruled out — benign observability artifact (>20% rate)"
          : "ruled out — benign observability artifact",
    });
  }

  // W11-04: Always-present rule-out rows for absent/low error+score signals.
  const withErrorVal = tier0.withError ?? 0;
  const withErrorRate = withErrorVal / Math.max(1, total);
  rows.push({
    signal: "wrong-output / hallucination",
    present: String(withErrorVal),
    presentColor: withErrorVal === 0
      ? "var(--g)"
      : withErrorRate >= 0.2
        ? "var(--r)"
        : "var(--y)",
    measure: `${withErrorVal} errors`,
    decision:
      withErrorVal === 0
        ? "excluded — no signal"
        : withErrorRate >= 0.2
          ? `<span class="badge b-crit">potential signal — check rate ${round(withErrorRate * 100)}%</span>`
          : "potential signal — ruled out (benign success:false / <20% rate)",
  });
  rows.push({
    signal: "low-score",
    present: String(tier0.withLowScore ?? 0),
    presentColor: "var(--g)",
    measure: `${tier0.withFeedback ?? 0} feedback`,
    decision: "excluded — no signal",
  });

  // ── Attach primarySignal to result array ─────────────────────────────────────
  const primarySignal: PrimarySignal | undefined = primaryName
    ? {
        name: primaryName,
        why: corroborationNote
          ? primaryIsDiscovered
            ? `${primaryName} selected as ${corroborationNote}`
            : `${primaryName} selected by impact×prevalence; ${corroborationNote}`
          : `${primaryName} selected by impact×prevalence`,
        ruledOut,
        confidence,
      }
    : undefined;

  // ── W12-F1 (UI-2op) + W17-C: auditable selection metadata ─────────────────────
  // selectionRules: one card per cheap-signal + discovered candidate — score + verdict.
  // The primary card cites WHY it won (impact×prevalence corroboration OR mechanical
  // discovered corroboration); discovered-unevidenced cards cite the floor cap.
  // signalSelectionTrace: a deterministic mermaid of the decision path. Pure functions
  // of the scoring + floor outcome — NO LLM, NO clock, NO random (PR-038 / PR-049).
  // D3: index the deep-read findings by failureOrigin.what so each selection card can
  // link back to its finding's RCA narrative (first finding per WHAT wins — deterministic
  // input order). Used by buildSelectionMeta to DERIVE the dataset-candidate copy.
  const findingsByWhat = new Map<string, CensusFinding>();
  for (const f of findings ?? []) {
    const what = f.failureOrigin?.what;
    if (what && !findingsByWhat.has(what)) findingsByWhat.set(what, f);
  }

  const selection = primaryName
    ? buildSelectionMeta(scored, discoveredScored, {
        primaryName,
        primaryIsDiscovered,
        corroborationNote,
        ruledOut,
        total,
        sampledN,
        suspected,
        findingsByWhat,
      })
    : undefined;

  return Object.assign(rows, {
    primarySignal,
    selectionRules: selection?.selectionRules,
    signalSelectionTrace: selection?.signalSelectionTrace,
    suspectedPrimaryUnconfirmed: suspected,
  });
}

/**
 * W17-C: merge the discovered-signal pool from deep-read findings + folded ledger
 * digests, deduped by WHAT. For each distinct WHAT:
 *   - seenCount = distinct traces it was observed on (findings.sourceTraceIds ∪ one per
 *     folded digest) — the HONEST-prevalence numerator (R6).
 *   - origin = "deep-read" when any finding contributed it, else "ledger".
 *   - corroboration = the resolved mechanical trajectory corroboration (R1), if any.
 *     R2: ledger-folded WHATs re-pass the SAME floor here — never trusted blindly.
 * Deterministic: output ordering is the first-seen order; callers re-sort.
 */
function buildDiscoveredPool(
  findings: ReadonlyArray<CensusFinding>,
  foldedDigests: ReadonlyArray<DeepReadLedgerEntry>,
  corroborations: ReadonlyArray<TrajectoryCorroboration>
): DiscoveredCandidate[] {
  // WHAT → set of distinct trace ids (for honest prevalence) + origin tracking.
  const byWhat = new Map<string, { traces: Set<string>; fromDeepRead: boolean; idx: number }>();
  let order = 0;
  const note = (what: string, traceIds: string[], fromDeepRead: boolean): void => {
    if (!what) return;
    let rec = byWhat.get(what);
    if (!rec) {
      rec = { traces: new Set<string>(), fromDeepRead: false, idx: order++ };
      byWhat.set(what, rec);
    }
    for (const t of traceIds) if (t) rec.traces.add(t);
    rec.fromDeepRead = rec.fromDeepRead || fromDeepRead;
  };

  // Source A: deep-read findings.
  for (const f of findings) {
    const what = f.failureOrigin?.what;
    if (!what) continue;
    note(what, f.sourceTraceIds ?? [], true);
  }
  // Source B (R2): folded ledger digests. Each digest = one (entity, trace) observation.
  for (const d of foldedDigests) {
    note(d.signal, [d.traceId], false);
  }

  return Array.from(byWhat.entries())
    .sort((a, b) => a[1].idx - b[1].idx) // stable first-seen order
    .map(([what, rec]) => ({
      what,
      origin: rec.fromDeepRead ? ("deep-read" as const) : ("ledger" as const),
      // seenCount is the distinct-trace count; ≥1 even when sourceTraceIds were absent
      // (a finding with no listed traces still counts as one observation).
      seenCount: Math.max(1, rec.traces.size),
      // R1/R2 evidence floor: resolve a mechanical corroboration for this WHAT.
      corroboration: resolveCorroboration(what, corroborations),
    }));
}

/** W17-C: the resolved-scoring inputs buildSelectionMeta reads (keeps the arg list sane). */
interface SelectionMetaContext {
  primaryName: string;
  /** True when the winning primary is a DISCOVERED signal (evidence-floored). */
  primaryIsDiscovered: boolean;
  corroborationNote: string;
  ruledOut: string[];
  total: number;
  /** R6: sampled-trace denominator for discovered prevalence cards. */
  sampledN: number;
  /** R7: the suspected-but-uncorroborated discovered signal, if any. */
  suspected?: SuspectedPrimary;
  /** D3: findings indexed by failureOrigin.what — source for dataset-candidate card copy. */
  findingsByWhat?: Map<string, CensusFinding>;
}

/** D3: severity → human label for the "why high-value" rationale. */
const SEVERITY_LABEL: Record<string, string> = {
  crit: "critical",
  high: "high",
  med: "medium",
  info: "low",
};

/**
 * D3: derive the dataset-candidate enrichment fields for ONE selection card from its
 * linked finding (matched by failureOrigin.what). Pure + deterministic. Each field is
 * DERIVED from an existing finding field; when the source is absent the field is left
 * undefined (omitted gracefully by the renderer — never fabricated).
 *
 *   scenario     ← failureOrigin.whatHappened (plain-words trace narration)
 *   useCase      ← finding.subDesc ?? title   (the edge-case it represents)
 *   whyFailed    ← why-chain ORIGIN entry .why ?? failureOrigin.why (root cause)
 *   whyHighValue ← severity · prevalence · novelty (composed from real signals)
 *   prevents     ← finding.problem ?? title   (the regression it guards against)
 */
function deriveCandidateEnrichment(
  finding: CensusFinding | undefined,
  opts: {
    /** Honest prevalence phrase (e.g. "seen in 12/40 sampled"). */
    prevalence: string;
    /** Novelty phrase (deep-read fresh vs ledger-recurring); omitted for cheap signals. */
    novelty?: string;
  }
): {
  linkedFindingId?: string;
  scenario?: string;
  useCase?: string;
  whyFailed?: string;
  whyHighValue?: string;
  prevents?: string;
} {
  if (!finding) return {};
  const scenario = finding.failureOrigin?.whatHappened?.trim() || undefined;
  const useCaseRaw = (finding.subDesc ?? finding.title)?.trim() || undefined;
  // Avoid echoing the scenario verbatim in the edge-case slot.
  const useCase = useCaseRaw && useCaseRaw !== scenario ? useCaseRaw : undefined;
  const originEntry = finding.whyChain?.find((w) => w.isOrigin);
  const whyFailed =
    originEntry?.why?.trim() || finding.failureOrigin?.why?.trim() || undefined;
  const preventsRaw = (finding.problem ?? finding.title)?.trim() || undefined;
  const prevents = preventsRaw && preventsRaw !== scenario ? preventsRaw : undefined;

  // whyHighValue — compose ONLY from signals we actually have (severity · prevalence ·
  // novelty). Empty when none are available.
  const valueParts: string[] = [];
  if (finding.severity) valueParts.push(`${SEVERITY_LABEL[finding.severity] ?? finding.severity} severity`);
  if (opts.prevalence) valueParts.push(opts.prevalence);
  if (opts.novelty) valueParts.push(opts.novelty);
  const whyHighValue = valueParts.length > 0 ? valueParts.join(" · ") : undefined;

  return {
    linkedFindingId: finding.findingId,
    scenario,
    useCase,
    whyFailed,
    whyHighValue,
    prevents,
  };
}

/**
 * W12-F1 (UI-2op / PR-038 / PR-049) + W17-C: deterministically derive the per-signal
 * selection-rule cards + the mermaid decision-path trace from the cheap-signal scoring
 * AND the discovered-pool ranking. PURE — same inputs → byte-identical output.
 *
 * Cheap signals: `score` = "impact × prevalence = score" (the auditable arithmetic).
 * Discovered signals: `score` = "impact (discovered) · seen k/n" (impact-dominant, R3).
 * Verdict cites the floor outcome: ★ PRIMARY (mechanically corroborated) for the
 * evidence-floored winner, "secondary — discovered, unconfirmed (no mechanical evidence)"
 * for capped discovered signals (R7), "secondary" otherwise, "ruled-out" for benign.
 */
export function buildSelectionMeta(
  scored: Array<{ name: string; matchCount: number; score: number }>,
  discoveredScored: Array<{ what: string; impact: number; seenCount: number; corroboration?: ResolvedCorroboration; origin?: "deep-read" | "ledger" }>,
  ctx: SelectionMetaContext
): SignalSelectionMeta {
  const { primaryName, primaryIsDiscovered, corroborationNote, ruledOut, total, sampledN, findingsByWhat } = ctx;
  const safeTotal = Math.max(1, total);

  // Cheap-signal cards (impact × prevalence = score).
  const selectionRules: NonNullable<RunMeta["selectionRules"]> = scored.map((p) => {
    const impact = SIGNAL_IMPACT[p.name] ?? DEFAULT_IMPACT;
    const prevalencePct = round((p.matchCount / safeTotal) * 100);
    const isPrimary = !primaryIsDiscovered && p.name === primaryName;
    const verdict = isPrimary
      ? corroborationNote.includes("deep-read")
        ? "★ PRIMARY (corroborated by deep-read)"
        : "★ PRIMARY"
      : "secondary";
    // D3: link the cheap signal to its finding (by WHAT) and derive the candidate copy.
    const enrich = deriveCandidateEnrichment(findingsByWhat?.get(p.name), {
      prevalence: `seen in ${p.matchCount}/${safeTotal} traces (${prevalencePct}%)`,
    });
    return {
      signal: p.name,
      // "impact × prevalence = score" — the auditable arithmetic.
      score: `${impact} × ${prevalencePct}% = ${round(p.score, 2)}`,
      verdict,
      ...enrich,
    };
  });

  // W17-C discovered-signal cards (impact-dominant, R3; honest prevalence, R6).
  for (const d of discoveredScored) {
    const isPrimary = primaryIsDiscovered && d.what === primaryName;
    const evidenced = d.corroboration !== undefined;
    const verdict = isPrimary
      ? "★ PRIMARY (discovered, mechanically corroborated)"
      : evidenced
        ? "secondary (discovered, corroborated)"
        : "secondary — discovered, unconfirmed (no mechanical evidence — R1 floor)";
    // D3: link the discovered signal to its finding (by WHAT) and derive the candidate
    // copy. Novelty reflects WHERE it surfaced (fresh deep-read vs recurring ledger fold).
    const enrich = deriveCandidateEnrichment(findingsByWhat?.get(d.what), {
      prevalence: `seen in ${d.seenCount}/${sampledN} sampled`,
      novelty:
        d.origin === "ledger"
          ? "recurring across runs (ledger-folded)"
          : "newly surfaced via deep-read (not a Tier-0 pattern)",
    });
    selectionRules.push({
      signal: d.what,
      // impact-dominant card: impact (discovered default ≥2) · honest sampled prevalence.
      score: `impact ${d.impact} (discovered) · seen ${d.seenCount}/${sampledN}`,
      verdict,
      discoveredByAwareness: true,
      ...enrich,
    });
  }

  // Ruled-out signals get an explicit "ruled-out" card so the gate is visible.
  for (const name of ruledOut) {
    selectionRules.push({
      signal: name,
      score: "n/a (gated)",
      verdict: "ruled-out: benign observability artifact (failure-validity gate)",
    });
  }

  // Mermaid decision path. W17-C extends the historic chain with the discovered pool +
  // the R1 evidence floor + the R7 residual branch. Deterministic string.
  const candidateList = scored.map((p) => p.name).join(", ") || "(none)";
  const discoveredList = discoveredScored.map((d) => d.what).join(", ") || "(none)";
  const gateNote = ruledOut.length > 0 ? `ruled out: ${ruledOut.join(", ")}` : "none ruled out";
  const floorNote = primaryIsDiscovered
    ? `discovered PASSED floor: ${corroborationNote}`
    : ctx.suspected
      ? `discovered CAPPED (suspected-unconfirmed: ${ctx.suspected.signal})`
      : "no discovered candidate";
  const signalSelectionTrace = [
    "graph TD",
    `  A["Tier-0 candidates: ${candidateList}"] --> B["failure-validity gate (${gateNote})"]`,
    "  B --> C[\"impact × prevalence (cheap signals)\"]",
    `  C --> D["discovered pool: ${discoveredList}"]`,
    `  D --> F["R1 evidence floor (${floorNote})"]`,
    `  F --> E["★ PRIMARY: ${primaryName}"]`,
  ].join("\n");

  return { selectionRules, signalSelectionTrace };
}

// ── Scan funnel ────────────────────────────────────────────────────────────────

/**
 * W11-03: Build the 4-stage scan-coverage funnel from tier0 + slice-plan.
 * Stages: total → Tier-0 scan → representative sample N → deep-read 6/N.
 *
 * The deep-read denominator is the SAMPLE size (honest: "6 of N sampled"),
 * not the population ("6 of total"), which was misleadingly low before.
 * When no representative sample metadata is available, the sample segment is
 * omitted and we fall back to the 3-stage display.
 */
export function buildScanFunnel(
  tier0: Tier0Input,
  slicePlan: SlicePlanInput,
  runMeta?: RunMeta
): ScanFunnel {
  const total = tier0.totalTraces;
  const scanned = runMeta?.tier0ScannedCount ?? total;
  const llm = runMeta?.llmReadCount ?? 0;
  const sliceNote = slicePlan.totalSlices
    ? `${slicePlan.totalSlices} slices · ${tier0.recommendedSlicing ?? "window-based"}`
    : tier0.recommendedSlicing ?? "window-based";

  // W11-03: representative sample N (from deepRead metadata when available).
  // deepRead.tierReached is the LLM read ceiling; population is total scope.
  const sampleN = runMeta?.deepRead?.tierReached ?? 0;
  const hasSample = sampleN > 0;

  // Coverage confidence annotation for the deep-read segment.
  const coverage = runMeta?.deepRead?.coverageConfidence;
  const coverageNote = coverage ? ` · coverage: ${coverage}` : "";

  // Deep-read detail: "6 of N sampled" when sample present, else "X% of population".
  const llmDetail = hasSample
    ? `${llm} of ${sampleN} sampled (100% of sample)${coverageNote}`
    : `${round((llm / Math.max(1, total)) * 100)}%${coverageNote}`;

  const funnel: ScanFunnel = {
    total: { value: total.toLocaleString("en-US"), label: "traces in window", detail: sliceNote },
    code: {
      value: scanned.toLocaleString("en-US"),
      label: "code-level scan (Tier 0)",
      detail: `${round((scanned / Math.max(1, total)) * 100)}% · no LLM`,
    },
    llm: {
      value: llm.toLocaleString("en-US"),
      label: "LLM deep-read (analyzers)",
      detail: llmDetail,
    },
  };

  // W11-03: attach sample segment when deepRead metadata is present.
  if (hasSample) {
    funnel.sample = {
      value: sampleN.toLocaleString("en-US"),
      label: "representative sample",
      detail: `${round((sampleN / Math.max(1, total)) * 100)}% of window · worst/med/best/rand`,
    };
  }

  return funnel;
}

// ── Diagnosed entity ───────────────────────────────────────────────────────────

/**
 * Resolve the diagnosed entity. R1.7: prefer the normalizer's EntityContext
 * (passed through transparently); fall back to findings.entities[0] only when no
 * EntityContext is supplied (legacy path).
 *
 * W9-08 portability: when neither EntityContext nor findings.entities is available
 * but findings ARE present, this is the "Path-B missing" case. The function returns
 * undefined and the caller's assertShapesBuildable will catch it. The silent jq
 * Path-B fallback (auto-construct entity from jq-extracted fields) is RETIRED —
 * callers MUST pass --entity-context or populate findings.entities explicitly.
 */
function resolveDiagnosedEntity(
  findings: FindingsInput,
  entityContext?: EntityContext
): Entity | undefined {
  if (entityContext) return entityFromContext(entityContext);
  // Path-B (legacy): findings.entities[0]. Retained for backward-compat with pre-W9 inputs.
  // NOTE: silent jq Path-B fallback (auto-synthesize entity from jq field extraction) is
  // RETIRED (W9-08 portability). Provide --entity-context or populate findings.entities.
  return findings.entities?.[0];
}

// ── Assumption normalization (R1.3: legacy free-text → structured) ─────────────

/**
 * Parse a single inline VERIFIED/UNVERIFIED/HYPOTHESIS marker out of a free-text
 * assumption. Deterministic. When no marker is present, defaults to "unverified"
 * (the conservative status — an un-annotated assumption is not yet confirmed).
 */
function parseAssumptionStatus(text: string): Assumption["status"] {
  const upper = text.toUpperCase();
  if (/\bHYPOTHESIS\b/.test(upper)) return "hypothesis-pending";
  if (/\bUNVERIFIED\b|\bASSUMED\b/.test(upper)) return "unverified";
  if (/\bVERIFIED\b|\bCONFIRMED\b/.test(upper)) return "verified";
  return "unverified";
}

/**
 * Normalize a finding's assumptions into the structured Assumption[] shape.
 * Already-structured entries pass through unchanged; legacy free-text strings are
 * converted (status parsed from any inline marker, basis = the marker tail or a
 * default note). Idempotent. Strips inline HTML pills so the renderer re-adds them.
 */
export function normalizeAssumptions(
  raw: ReadonlyArray<string | Assumption> | undefined
): Assumption[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((a) => {
    if (typeof a !== "string") return a; // already structured
    const stripped = a.replace(/<[^>]*>/g, "").trim();
    const status = parseAssumptionStatus(stripped);
    // basis = text after an em-dash marker, else a generic note.
    const dash = stripped.indexOf("—");
    const basis =
      dash >= 0 && dash < stripped.length - 1
        ? stripped.slice(dash + 1).trim()
        : "derived during RCA — not directly confirmed";
    const text = dash >= 0 ? stripped.slice(0, dash).trim() : stripped;
    return { text, status, basis };
  });
}

/**
 * PRD-CC-10: Inject a hypothesis-pending no-code-access disclaimer assumption
 * when entity.codeAccess === false AND finding.assumptions is null/empty.
 * Never overrides analyzer-emitted assumptions.
 */
export function synthesizeNoCodeAccessAssumption(
  finding: Finding,
  entity: EntityContext | undefined
): Assumption[] | undefined {
  if (!entity || entity.codeAccess !== false) return finding.assumptions;
  const existing = finding.assumptions;
  if (existing && existing.length > 0) return existing;
  return [
    {
      text: `Source code for ${entity.name} was not provided; findings are evidence-only.`,
      status: "hypothesis-pending",
      basis: "entity.codeAccess === false — source code unavailable for direct verification",
    },
  ];
}

/** Apply assumption normalization + remedy-rank backfill across all findings (immutably). */
function normalizeFindings(findings: Finding[], entityContext?: EntityContext): Finding[] {
  return findings.map((f) => {
    const assumptions = normalizeAssumptions(
      f.assumptions as ReadonlyArray<string | Assumption> | undefined
    );
    const withNormalized = assumptions ? { ...f, assumptions } : f;
    // PRD-CC-10: inject no-code-access disclaimer when needed.
    // W12-08: Finding.assumptions is now required (≥1). synthesizeNoCodeAccessAssumption
    // may still return undefined for the legacy/empty path; coerce to the original
    // (now-required) array so the enriched Finding keeps a non-undefined assumptions.
    const synthesized =
      synthesizeNoCodeAccessAssumption(withNormalized, entityContext) ??
      withNormalized.assumptions;
    const withAssumptions =
      synthesized !== withNormalized.assumptions
        ? { ...withNormalized, assumptions: synthesized }
        : withNormalized;

    // W13-C (D-1): deterministically derive remedy.rank from cost × correctness
    // (orchestrator-protocol §8 — finally implemented in code). This closes the
    // last leg of the D-1 contract triad: cost/correctness are analyzer-required
    // (gate-enforced at Step 7.1), rank is ALWAYS backfilled here. So a remedy can
    // never reach the renderer with rank/cost/correctness undefined. The backfill
    // is reproducible (no LLM judgment), removing an agent-discretion variance source.
    return Array.isArray(withAssumptions.remedies) && withAssumptions.remedies.length > 0
      ? { ...withAssumptions, remedies: rankRemedies(withAssumptions.remedies) }
      : withAssumptions;
  });
}

// ── Fail-loud predicate ────────────────────────────────────────────────────────

/**
 * R1 §9.3 + W12-06: fail-loud guard over the 4 internal render shapes.
 *
 * TWO-tier threshold — the shapes are NOT all equivalent:
 *
 *  - `diagnosedEntity` is INDIVIDUALLY REQUIRED. A run WITH findings always has a
 *    diagnosed subject; a missing entity yields an empty entity card despite the
 *    "no silent placeholder" promise (W12-06 / OP-7). So a lone missing entity
 *    (1-of-4) MUST refuse — it can never be a legitimate empty on a findings run.
 *
 *  - `bigStat` / `hourlyHeatmap` / `signalCensus` can be LEGITIMATELY empty on a
 *    clean no-signal run (no latencies → no big-stat; no startTimes → empty
 *    heatmap; no patterns → empty census). These keep the COLLECTIVE ≥3-of-4
 *    threshold: 3+ simultaneously empty signals a genuinely starved input, but any
 *    one alone is tolerated.
 *
 * Mirrors the renderer's guard so the enricher fails BEFORE handing a starved
 * input downstream.
 */
function assertShapesBuildable(
  shapes: {
    diagnosedEntity?: Entity;
    bigStat: BigStat[];
    hourlyHeatmap: HourlyHeatmap;
    signalCensus: SignalCensusRow[];
  },
  hasFindings: boolean
): void {
  if (!hasFindings) return;

  // W12-06: diagnosedEntity is individually required — refuse on its own absence,
  // independent of the ≥3-of-4 count. A findings run always has a diagnosed entity;
  // its absence is never a legitimate empty.
  if (!shapes.diagnosedEntity) {
    throw new Error(
      `build-render-input: refusing to enrich — diagnosedEntity is missing on a run ` +
        `that HAS findings. A findings run always has a diagnosed subject; an empty ` +
        `entity card is forbidden (no silent placeholder). Pass --entity-context or ` +
        `populate findings.entities. Fail-loud (W12-06 / OP-7).`
    );
  }

  // R1 §9.3: the other three may each be legitimately empty on a clean run; only
  // a ≥3-of-4 collective miss signals a genuinely starved input.
  const missing: string[] = [];
  if (shapes.bigStat.length === 0) missing.push("bigStat");
  if (shapes.hourlyHeatmap.cells.every((c) => c.count === 0)) missing.push("hourlyHeatmap");
  if (shapes.signalCensus.length === 0) missing.push("signalCensus");
  // diagnosedEntity is present here (guarded above) — count it among the 4 so the
  // threshold semantics ("3 of 4") stay intact even though it can't be the missing one.
  if (missing.length >= 3) {
    throw new Error(
      `build-render-input: refusing to enrich — ${missing.length} of 4 internal render ` +
        `shapes could not be built (${missing.join(", ")}). Inputs are starved: ` +
        `check tier0/metadata/findings. Fail-loud (R1 §9.3) — no silent placeholder.`
    );
  }
}


/**
 * W9-08 (R-CP-2): Assert RunMeta required fields are present before enrichment.
 * Fails loud when findings are present but runMeta is absent or missing key fields.
 * Required fields: totalTraces, tier0ScannedCount, llmReadCount, scopeFilter,
 * samplingStrategy, decisions, deepRead.
 *
 * NOTE: all RunMeta fields are optional for backward-compat. This check only fires
 * when findings are present — empty-findings runs are exempt (no run = no meta).
 */
function assertRunMetaPresent(runMeta: RunMeta | undefined, hasFindings: boolean): void {
  if (!hasFindings) return;
  if (!runMeta) {
    // Soft warning — RunMeta absent on pre-Wave-9 runs is expected; not a hard fail.
    // Hard fail only when a specific required field is missing on a run that SHOULD have it.
    return;
  }
  const missing: string[] = [];
  if (runMeta.totalTraces === undefined) missing.push("runMeta.totalTraces");
  if (runMeta.tier0ScannedCount === undefined) missing.push("runMeta.tier0ScannedCount");
  if (runMeta.llmReadCount === undefined) missing.push("runMeta.llmReadCount");
  if (missing.length > 0) {
    // These three are mandatory on Wave-9+ runs — fail loud to catch misconfigured enrichers.
    throw new Error(
      `build-render-input: RunMeta is present but missing required fields ` +
        `(${missing.join(", ")}). Check the orchestrator's Step 8.5 enricher wiring. ` +
        `Fail-loud (W9-08 R-CP-2) — no silent placeholder fallback.`
    );
  }
}

// ── S7-render: enricher-output self-validation ───────────────────────────────────

/** Local non-empty-string check (enricher-scoped; mirrors the validators' helper). */
function isNonEmptyEnrichString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * S7-render (Wave-15 Block B, operator option B): self-validate the assembled
 * RenderInput BEFORE it is returned to the orchestrator.
 *
 * WHY: previously the only RenderInput-shape gates were render.ts's
 * `validatePreRender` / `assertRenderShapesPresent`, which run AFTER 23×
 * `template.replaceAll()`. A field the enricher dropped (or built with the wrong
 * type) therefore reached broken markup before any gate fired. This guard moves
 * the catch UPSTREAM to the PRODUCER: the enricher asserts its own output shape —
 * every required RenderInput field present with the correct type — and THROWS
 * before returning, so a dropped field is caught pre-template at the producer.
 *
 * SCOPE: asserts the type-level required RenderInput contract (the six
 * non-optional members) plus, on a findings-bearing run, the internal Overview
 * shapes render.ts dereferences without a guard (diagnosedEntity / bigStat /
 * signalCensus / hourlyHeatmap.cells). It COMPLEMENTS — never replaces —
 * `assertShapesBuildable` (input-starvation predicate) and `assertRunMetaPresent`
 * (runMeta field presence): those gate the INPUTS, this gates the OUTPUT.
 *
 * DETERMINISTIC: pure structural assertion, no I/O.
 */
function assertRenderInputShape(input: RenderInput): void {
  const missing: string[] = [];

  // ── Type-required RenderInput fields (the six non-optional members) ──────────
  if (!isNonEmptyEnrichString(input.sessionId)) missing.push("sessionId (non-empty string)");
  if (!isNonEmptyEnrichString(input.diagnosedAt)) missing.push("diagnosedAt (non-empty string)");
  if (!isNonEmptyEnrichString(input.sourcePlatform)) missing.push("sourcePlatform (non-empty string)");
  if (!isNonEmptyEnrichString(input.targetPlatform)) missing.push("targetPlatform (non-empty string)");
  if (typeof input.totalTraces !== "number" || Number.isNaN(input.totalTraces)) {
    missing.push("totalTraces (number)");
  }
  if (!Array.isArray(input.findings)) missing.push("findings (array)");

  // ── Findings-bearing runs: the internal shapes render.ts dereferences raw ────
  // Empty-findings runs are exempt — a zero-finding report legitimately omits the
  // Overview tiles (mirrors assertShapesBuildable / completeness-check semantics).
  if (Array.isArray(input.findings) && input.findings.length > 0) {
    if (!input.diagnosedEntity) missing.push("diagnosedEntity (Entity)");
    if (!Array.isArray(input.bigStat)) missing.push("bigStat (BigStat[])");
    if (!Array.isArray(input.signalCensus)) missing.push("signalCensus (SignalCensusRow[])");
    if (!input.hourlyHeatmap || !Array.isArray(input.hourlyHeatmap.cells)) {
      missing.push("hourlyHeatmap.cells (HourlyHeatCell[])");
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `build-render-input: refusing to return a malformed RenderInput — ` +
        `${missing.length} required field(s) absent or wrong-typed (${missing.join(", ")}). ` +
        `A producer-side drop must be caught HERE (S7-render), before the renderer's ` +
        `template.replaceAll() reaches broken markup. Fail-loud — no silent placeholder.`
    );
  }
}

// ── Main entry ─────────────────────────────────────────────────────────────────

/**
 * Build a fully-populated RenderInput from the 4 deterministic inputs.
 * DETERMINISTIC + IDEMPOTENT: same inputs (+ same opts.generatedAt) → byte-identical
 * RenderInput. Fail-loud when the inputs are starved.
 */
export function buildRenderInput(
  inputs: EnricherInputs,
  opts: EnricherOptions
): RenderInput {
  const { tier0, slicePlan, findings, metadata } = inputs;

  // SD self-diag: when config.self_diagnostics.enabled, the report diagnoses the
  // diagnostics skill ITSELF — force meta-report mode (cluster-grouped findings),
  // internal-only audience (PR-022), a [INTERNAL] sessionId prefix, and a
  // skill-typed entity. These overrides happen BEFORE the shapes are built so the
  // whole render input is consistent.
  const isSelfDiag = opts.selfDiag?.enabled === true;
  const isMetaReport = isSelfDiag ? true : findings.isMetaReport;
  const sessionId = isSelfDiag && !findings.sessionId.startsWith("[INTERNAL]")
    ? `[INTERNAL] ${findings.sessionId}`
    : findings.sessionId;

  // R1.3: normalize any legacy free-text assumptions → structured Assumption[].
  // PRD-CC-10: pass entityContext for no-code-access disclaimer synthesis.
  const entityContextForNorm = isSelfDiag && opts.selfDiag?.skillEntity
    ? opts.selfDiag.skillEntity
    : opts.entityContext;
  const normalizedFindings = normalizeFindings(findings.findings, entityContextForNorm);

  const bigStat = buildBigStat(metadata, tier0);
  // W11-01: pass normalizedFindings for deep-read corroboration (PR-049 step 3).
  // F3: build the census BEFORE the heatmap so the resolved primarySignal can key
  // the heatmap's metric + colour (cell metric FOLLOWS the primary signal).
  const signalCensus = buildSignalCensus(
    tier0,
    tier0.totalTraces || metadata.length || 1,
    normalizedFindings,
    // W17-C: discovered-signal context (corroborations · foldedDigests · sampledCount).
    // Absent until Block B/D1 wire it upstream → discovered signals stay capped at
    // SECONDARY (suspected-unconfirmed), never silently crowned.
    opts.signalCtx
  );
  // F3 (UR-2): heatmap metric follows the primary signal (default = latency, so a
  // latency-primary run is byte-identical to the pre-F3 behaviour).
  const hourlyHeatmap = aggregateHourlyHeatmap(
    metadata,
    signalCensus.primarySignal?.name
  );
  const scanFunnel = buildScanFunnel(tier0, slicePlan, findings.runMeta);
  // R1.7 + SD: self-diag uses the skill-typed EntityContext; otherwise the
  // normalizer's EntityContext (or legacy findings.entities[0]).
  const diagnosedEntity = isSelfDiag && opts.selfDiag?.skillEntity
    ? entityFromContext(opts.selfDiag.skillEntity)
    : resolveDiagnosedEntity(findings, opts.entityContext);

  assertShapesBuildable(
    { diagnosedEntity, bigStat, hourlyHeatmap, signalCensus },
    normalizedFindings.length > 0
  );

  // W9-08 (R-CP-2): assert RunMeta required fields when present + findings non-empty.
  assertRunMetaPresent(findings.runMeta, normalizedFindings.length > 0);

  // ── W12-F1/F4 + W17-C: assemble the enriched runMeta ──────────────────────────
  // PRESERVE all upstream/LLM-produced fields from findings.runMeta — including the
  // threaded methodology widgets (tierBreakdown · blindSpots · awarenessSample) the
  // orchestrator assigned pre-enrich (codified in orchestrator-protocol Step 8.5).
  // The enricher NEVER recomputes those (they need an LLM); it only adds the fields
  // it can derive deterministically from the census scoring: primarySignal +
  // selectionRules + signalSelectionTrace (F1 / PR-038 / PR-049) + (W17-C, R7)
  // suspectedPrimaryUnconfirmed. The spread is unconditional so widget fields are
  // never dropped on a no-primary run.
  const enrichedRunMeta: RunMetaW17 | undefined = findings.runMeta
    ? {
        ...findings.runMeta,
        ...(signalCensus.primarySignal
          ? { primarySignal: signalCensus.primarySignal }
          : {}),
        // F1: enricher-computed selection metadata wins over any stale upstream copy
        // (they are deterministically re-derived from this run's census scoring).
        ...(signalCensus.selectionRules
          ? { selectionRules: signalCensus.selectionRules }
          : {}),
        ...(signalCensus.signalSelectionTrace !== undefined
          ? { signalSelectionTrace: signalCensus.signalSelectionTrace }
          : {}),
        // W17-C (R7): residual surfacing. When the top discovered signal is capped at
        // SECONDARY for lack of mechanical evidence and primary fell back to a cheap
        // signal, thread the flag so Block E (renderer) shows "suspected primary —
        // unconfirmed" instead of silently crowning the cheap signal.
        ...(signalCensus.suspectedPrimaryUnconfirmed
          ? { suspectedPrimaryUnconfirmed: signalCensus.suspectedPrimaryUnconfirmed }
          : {}),
      }
    : findings.runMeta;

  const renderInput: RenderInput = {
    sessionId,
    diagnosedAt: findings.diagnosedAt,
    sourcePlatform: findings.sourcePlatform,
    targetPlatform: findings.targetPlatform,
    totalTraces: findings.totalTraces || metadata.length,
    findings: normalizedFindings,
    generatedAt: opts.generatedAt,
    // SD/PR-022: meta-reports are ALWAYS internal — never strippable.
    audience: isMetaReport ? "internal" : findings.audience,
    isMetaReport,
    // Internal render shapes (R1.3/R1.7):
    diagnosedEntity,
    bigStat,
    signalCensus,
    scanFunnel,
    hourlyHeatmap,
    // Story-led copy (passed through verbatim when present):
    // W11-01/F1/F4: enriched runMeta — primarySignal + selectionRules +
    // signalSelectionTrace injected; upstream widget fields preserved (see above).
    runMeta: enrichedRunMeta,
    entities: findings.entities,
    decisionLog: findings.decisionLog ?? mapDecisionsToLog(findings.runMeta?.decisions),
    mermaidSequence: findings.mermaidSequence ?? findings.runMeta?.mermaidTopology,
    headerTitle: findings.headerTitle,
    overviewTitle: findings.overviewTitle,
    overviewSub: findings.overviewSub,
    overviewHeadline: findings.overviewHeadline,
    overviewLeverage: findings.overviewLeverage,
    decisionsBundle: findings.decisionsBundle,
  };

  // S7-render: self-validate the assembled output shape BEFORE returning, so a
  // dropped/wrong-typed field is caught at the producer — never reaching the
  // renderer's template.replaceAll() and broken markup.
  assertRenderInputShape(renderInput);

  return renderInput;
}

/**
 * Minimal escaper for the decision-log grade badge text.
 * W13-C (D-5): hardened with `String(s ?? "")` — a decision row with an absent
 * rationale/reason field previously crashed on `s.slice` (hard render-input failure).
 * Now an absent field degrades to an empty badge instead of crashing.
 */
function escapeBadge(s: unknown): string {
  return String(s ?? "")
    .slice(0, 48)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * W13-C (D-5): map RunMeta.decisions[] → DecisionLogRow[] for the Methodology tab.
 *
 * Tolerates the producer/consumer field-name desync between the canonical decision
 * shape `{step, choice, rationale}` (scripts/normalize/trace.ts RunMeta.decisions)
 * and the alias names `{stepId, decision, reason}` that appeared in some
 * orchestrator-protocol examples. An orchestrator that followed those examples
 * literally would otherwise produce all-undefined rows (and crash escapeBadge).
 * We read the canonical name first, then the alias, so BOTH shapes render correctly.
 *
 * Pure + deterministic. Returns undefined when there are no decisions (preserves the
 * prior `?.map` semantics so the field stays absent rather than an empty array).
 */
export function mapDecisionsToLog(
  decisions: ReadonlyArray<Record<string, unknown>> | undefined
): DecisionLogRow[] | undefined {
  if (!decisions || decisions.length === 0) return undefined;
  return decisions.map((d) => ({
    // canonical `step` → alias `stepId`
    decision: String(d.step ?? d.stepId ?? ""),
    // canonical `choice` → alias `decision`
    what: String(d.choice ?? d.decision ?? ""),
    // canonical `rationale` → alias `reason`; escapeBadge guards undefined either way
    grade: `<span class="badge b-info">${escapeBadge(d.rationale ?? d.reason)}</span>`,
  }));
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const tier0Path = get("--tier0");
  const slicePath = get("--slice-plan");
  const findingsPath = get("--findings");
  const metadataPath = get("--metadata");
  const outPath = get("--output");
  const generatedAt = get("--generated-at") ?? "1970-01-01T00:00:00.000Z";
  // PRD-CC-10: --entity-context takes precedence over findings.entities[0].
  const entityContextPath = get("--entity-context");
  // SD-3: --self-diag turns on the meta-report path (isMetaReport + internal
  // audience + [INTERNAL] sessionId prefix + skill-typed entity). It pairs with
  // --skill-entity <path>, an EntityContext JSON produced by the claude-code
  // normalizer's self-diag CLI (SD-2: `--mode self-diag --out-entity`). Without
  // the CLI flag this path was programmatic-only (EnricherOptions.selfDiag),
  // so the self-diag report could not run end-to-end via run.sh.
  const selfDiag = argv.includes("--self-diag");
  const skillEntityPath = get("--skill-entity");
  // W17-WIRING: --signal-ctx <path> threads the discovered-signal SELECTION-HUB
  // context (SignalCensusContext) into buildSignalCensus end-to-end. The orchestrator
  // assembles this JSON at Step 6.5 from THREE deterministic sources:
  //   • corroborations — scripts/scan/trajectory.ts CLI over the sampled deep-read bodies
  //   • foldedDigests  — store.foldValidDigests(entity, …) over the entity's ledger
  //   • sampledCount   — the honest deep-read denominator (R6)
  // Additive + safe-by-default (Zone-1.5): flag ABSENT → signalCtx undefined → legacy
  // Tier-0-only census → discovered signals stay suspected-unconfirmed (never crowned).
  const signalCtxPath = get("--signal-ctx");

  if (!tier0Path || !slicePath || !findingsPath || !metadataPath || !outPath) {
    process.stderr.write(
      "Usage: bun scripts/enrich/build-render-input.ts --tier0 <f> --slice-plan <f> " +
        "--findings <f> --metadata <f> --output <f> [--generated-at <iso>] [--entity-context <f>] " +
        "[--signal-ctx <f>] [--self-diag --skill-entity <f>]\n"
    );
    process.exit(1);
  }

  // SD-3: --self-diag and --skill-entity are paired — neither is useful alone.
  // --skill-entity without --self-diag would load a skill entity the enricher
  // ignores (selfDiag gate is off); --self-diag without --skill-entity would
  // synthesize a skill-typed card from findings only, defeating the SD-2 → SD-3
  // entity handoff. Fail loud rather than silently degrade.
  if (selfDiag && !skillEntityPath) {
    process.stderr.write("Error: --self-diag requires --skill-entity <path>\n");
    process.exit(1);
  }
  if (skillEntityPath && !selfDiag) {
    process.stderr.write("Error: --skill-entity requires --self-diag\n");
    process.exit(1);
  }

  try {
    const inputs: EnricherInputs = {
      tier0: JSON.parse(readFileSync(resolve(tier0Path), "utf8")),
      slicePlan: JSON.parse(readFileSync(resolve(slicePath), "utf8")),
      findings: JSON.parse(readFileSync(resolve(findingsPath), "utf8")),
      metadata: JSON.parse(readFileSync(resolve(metadataPath), "utf8")),
    };
    // PRD-CC-10: load entity context from file when --entity-context is supplied.
    // When both file and findings.entities[0] differ, file takes precedence (Q1: override + warn).
    let entityContext: EntityContext | undefined;
    if (entityContextPath) {
      entityContext = JSON.parse(readFileSync(resolve(entityContextPath), "utf8")) as EntityContext;
      if (inputs.findings.entities && inputs.findings.entities.length > 0) {
        process.stderr.write(
          `[warn] --entity-context overrides findings.entities[0] (Q1 recommendation: override + warn)\n`
        );
      }
    }
    // SD-3: load the skill-typed EntityContext (SD-2 self-diag output) and wire
    // the EnricherOptions.selfDiag path so the meta-report renders end-to-end.
    let selfDiagOpt: EnricherOptions["selfDiag"];
    if (selfDiag) {
      const skillEntity = JSON.parse(
        readFileSync(resolve(skillEntityPath as string), "utf8")
      ) as EntityContext;
      selfDiagOpt = { enabled: true, skillEntity };
    }
    // W17-WIRING: load the SELECTION-HUB context when --signal-ctx is supplied.
    // Block C owns the consuming logic (buildSignalCensus); the CLI only threads the
    // orchestrator-assembled JSON through. Absent flag → undefined → safe-by-default.
    let signalCtx: SignalCensusContext | undefined;
    if (signalCtxPath) {
      signalCtx = JSON.parse(
        readFileSync(resolve(signalCtxPath), "utf8")
      ) as SignalCensusContext;
    }
    const renderInput = buildRenderInput(inputs, {
      generatedAt,
      entityContext,
      selfDiag: selfDiagOpt,
      signalCtx,
    });
    writeFileSync(resolve(outPath), JSON.stringify(renderInput, null, 2), "utf8");
    process.stdout.write(`RenderInput written to: ${outPath}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
