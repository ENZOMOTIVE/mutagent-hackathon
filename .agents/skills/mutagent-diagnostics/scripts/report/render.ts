/**
 * scripts/report/render.ts
 * Template + findings data → report.html (4-layer HITL report)
 * Type A — Pure Script (template interpolation — no LLM, no I/O side effects except file write)
 *
 * R-SELF-14-b: Renderer emits semantic JSON-LD (<script type="application/ld+json">) for
 * the full findings graph. Template embeds it via {{FINDINGS_JSONLD}} placeholder.
 * Web-component slots in the default template can read this data without re-parsing HTML.
 *
 * Phase 3-B (Wave-3): flat iter9 anatomy, audience flag (FU-INT-1), Methodology + Trajectory
 * internal tabs (I-024/I-030/I-041), entity cards (I-026/I-038), funnel/heatmap (I-027),
 * meta-report cluster layout (I-029/I-034/I-036), copyDecisions handoff (I-033).
 *
 * RISK-05 (template-stamp fallback): procedural HTML-building is preserved as the primary
 * rendering path. The template-stamp engine (template file + {{PLACEHOLDER}} substitution)
 * was introduced in P4 and is the canonical rendering surface. Both coexist.
 *
 * Usage:
 *   bun scripts/report/render.ts --findings <findings.json> --output <report.html> [options]
 *   Options:
 *     --template <path>           Override template file (default: assets/templates/report.html.tpl)
 *     --audience client|internal  Audience mode (default: client — leak-safe). NODE-STRIP removes
 *                                 class="internal" nodes when audience=client.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname as pathDirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { Value } from "@sinclair/typebox/value";
import type {
  Finding,
  Remedy,
  DiffStatus,
  FailureOrigin,
  EntityContext,
  SizedText,
  ToolInventoryEntry,
  FeedbackSource,
  TranslatedFeedback,
  FeedbackOnFix,
} from "../normalize/trace.ts";
import {
  SelfDiagnosisContractSchema,
  type SelfDiagnosisContract,
} from "../contract/types.ts";

// ── Audience type (FU-INT-1) ─────────────────────────────────────────────────

/** FU-INT-1: Audience for this render pass. Default: "internal" (safe). */
export type Audience = "client" | "internal";

// ── Run metadata (I-024, I-030 — Methodology tab) ───────────────────────────

/**
 * W17-E (R7 — residual surfacing): the canonical "suspected primary — unconfirmed"
 * record. PRODUCED by buildSignalCensus in build-render-input.ts (Block C, which
 * modelled it locally as a superset of this type because render.ts was out of its
 * scope); CONSUMED here by the renderer. Present ONLY when the top DISCOVERED signal
 * was capped at SECONDARY for lack of mechanical evidence (R1 evidence floor) AND
 * primary fell back to a cheap signal. The renderer reads this to show a clear
 * "suspected primary — unconfirmed" note instead of silently crowning the cheap
 * fallback. Absent when the discovered signal passed the evidence floor (nothing
 * unconfirmed) or no discovered signal was surfaced. All-primitive shape, so the
 * enricher's local copy threads into RunMeta.suspectedPrimaryUnconfirmed structurally.
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

export interface RunMeta {
  /** Total traces in the session (may differ from totalTraces in RenderInput when filtered) */
  totalTraces?: number;
  /** How many traces were scanned by tier-0 static patterns */
  tier0ScannedCount?: number;
  /** How many traces were sent to LLM for deep analysis */
  llmReadCount?: number;
  /** Scope filter expression applied before sampling */
  scopeFilter?: string;
  /** Sampling strategy description */
  samplingStrategy?: string;
  /** Decision log: key choices made during the diagnostic run */
  decisions?: Array<{ step: string; choice: string; rationale: string }>;
  /** Signal census: how many of each signal type were surfaced */
  signalCensus?: Array<{ signal: string; count: number }>;
  /** Mermaid topology diagram source (agent/tool graph) */
  mermaidTopology?: string;
  /**
   * W11-01 (PR-049): The reconciled primary signal for this run.
   * Selected by: failure-validity gate → impact×prevalence → deep-read corroboration.
   * Authoritative source for census badge · heatmap signal flag · funnel coverage note.
   * Set by buildSignalCensus in build-render-input.ts.
   */
  primarySignal?: {
    /** Selected primary signal name (e.g. "latency-spike"). */
    name: string;
    /** One-sentence rationale (impact×prevalence + deep-read corroboration). */
    why: string;
    /** Signals ruled out by the failure-validity gate before scoring. */
    ruledOut: string[];
    /** Confidence level based on deep-read corroboration. */
    confidence: "high" | "medium" | "low";
  };

  // ── Wave-6 R2.1 (+D1) — mandatory LLM deep-read accounting ────────────────
  /**
   * R2.1/D1: a cap-exceeded banner line. When an active cap tripped (max_trace /
   * time / cost), the run STOPS, emits findings, and this banner is rendered at
   * the top of the Methodology tab. Absent when no cap tripped.
   */
  capBanner?: string;
  /**
   * R2.1: the deep-read gate verdict + reason. When the gate REFUSED, this carries
   * the refusal banner (rendered prominently). Present on every fresh run.
   */
  deepReadGate?: { verdict: "refuse" | "proceed" | "proceed-with-priors"; reason: string };

  // ── Wave-6 R2.2 — awareness-layer LLM mini-sample ─────────────────────────
  /**
   * R2.2: a 5-trace LLM mini-sample fired BEFORE primary-signal selection to
   * surface signals Tier-0 cannot MEASURE (the measurement-layer fix). Absent
   * (with blindSpots placeholder) when library priors already exist (SKIP).
   */
  awarenessSample?: {
    traces: string[];
    findings: string[];
    firedAt: string;
  };
  /**
   * R2.2: blind-spots table — signals + whether Tier-0 can measure them + how they
   * were checked + the result. Rendered as Methodology Step 1.5.
   */
  blindSpots?: Array<{
    signal: string;
    measurable: "Tier-0" | "No";
    checkedBy: string;
    result: string;
  }>;

  // ── Wave-6 R2.4 — methodology widgets ─────────────────────────────────────
  /**
   * R2.4: tier-coverage breakdown for the SVG arc pie. Each entry = one tier with
   * a finding count. The pie handles the 0-finding-tier case (renders an empty arc).
   */
  tierBreakdown?: Array<{ tier: string; count: number; color?: string }>;
  /**
   * R2.4: per-signal selection-rule cards. Each card shows the signal's score +
   * verdict; `discoveredByAwareness` marks signals surfaced by R2.2 (badge).
   */
  selectionRules?: Array<{
    signal: string;
    score: string;
    verdict: string;
    discoveredByAwareness?: boolean;
    /**
     * D3 (dataset-candidate enrichment): when this signal links to a finding (by
     * failureOrigin.what), these fields are DERIVED from that finding so each
     * candidate card answers — in plain language — which scenario it is, what
     * edge-case it represents, why it failed, why it is a high-value dataset
     * candidate, and what regression it would guard against. All OPTIONAL and
     * omitted gracefully when the source field is absent (never fabricated).
     */
    /** The linked finding's id (for citation). */
    linkedFindingId?: string;
    /** SCENARIO — plain-words narration of what happened in the trace (failureOrigin.whatHappened). */
    scenario?: string;
    /** USE-CASE / EDGE-CASE this candidate represents (finding subDesc / title). */
    useCase?: string;
    /** WHY it failed — the root cause (why-chain origin / failureOrigin.why). */
    whyFailed?: string;
    /** WHY it is a high-value dataset candidate (severity · prevalence · novelty — derived). */
    whyHighValue?: string;
    /** What regression it would PREVENT (the finding's problem statement). */
    prevents?: string;
  }>;
  /**
   * R2.4: mermaid decision-tree source for the signal-selection trace. Rendered
   * with partial data (the renderer tolerates an empty/short trace).
   */
  signalSelectionTrace?: string;

  // ── W17-E (R7) — residual surfacing (canonical slot) ──────────────────────
  /**
   * W17-E (R7): set ONLY when the top DISCOVERED signal was capped at SECONDARY for
   * lack of mechanical evidence (R1 evidence floor) and primary fell back to a cheap
   * signal. The renderer surfaces a "suspected primary — unconfirmed" note so the
   * cheap fallback is NOT silently presented as the confident primary. Absent when
   * the discovered signal passed the floor, or none was discovered. Produced by
   * buildSignalCensus (build-render-input.ts, Block C).
   */
  suspectedPrimaryUnconfirmed?: SuspectedPrimary;

  // ── Wave-6 R2.6 (+D2) — operator invocation ────────────────────────────────
  /**
   * D2: the VERBATIM operator brief string. Stored even when parsing succeeds, so
   * the brief can be re-parsed later + for library authenticity. Rendered as
   * Methodology Step 0 ("Operator invocation (verbatim)").
   */
  operatorInvocation?: string;
  /**
   * R2.6/D2: the parsed invocation shape (agent / timeWindow / focus / residual).
   * Drives the 🎯 Guided tab + tooltip when `focus` is set.
   */
  parsedInvocation?: {
    agent?: string;
    timeWindow?: string;
    focus?: string;
    /**
     * W12-03: optional — a bare invocation on a neutral-survey run leaves
     * `residual` undefined. The renderer guards with a `—` fallback; the type now
     * reflects the runtime reality (was `string`, which masked the crash path).
     */
    residual?: string;
  };

  // ── W9-09 (PR-048): Deep-read escalation telemetry (mirrors trace.ts RunMeta.deepRead) ──
  /**
   * W9-07/W9-09: Deep-read coverage record populated by the trace-hungry escalation
   * loop. Surfaced in the report header bigStat tile (tier reached · tier0 scanned ·
   * llmReadCount · coverageConfidence · stopReason). Backward-compatible — absent on
   * pre-Wave-9 runs.
   */
  deepRead?: {
    population: number;
    tierReached: number;
    llmReadCount: number;
    coverageConfidence: "high" | "medium" | "low";
    stopReason: "evidence-sufficient" | "ceiling-reached" | "time-budget";
    batches: Array<{
      tier: number;
      newFailureCategories: number;
      coverageConfidence: string;
    }>;
  };

  // ── W9-07: Coverage warning flags (from deep-read-gate) ───────────────────
  /**
   * W9-07: Set by the deep-read-gate when trace pool is too thin for high confidence.
   * Triggers a low-confidence banner in the coverage tile.
   */
  coverageWarning?: boolean;
  /**
   * W9-07: Set by representative.ts when the sample is below the minimum useful size.
   */
  tooThin?: boolean;
}

// ── Entity type (I-026+I-038 — entity-definition card) ──────────────────────

export interface Entity {
  /** Entity identifier / display name */
  name: string;
  /** Category: agent, tool, skill, or model */
  entityType: "agent" | "tool" | "skill" | "model";
  /** Whether source code is accessible for diagnostics */
  codeAccess: boolean;
  /** Short summary of entity purpose */
  summary?: string;
  /** Expandable definition content: system prompt / SKILL.md / source snippet */
  definition?: string;

  // ── Wave-5 R1.2 — gold-standard entity-card rows (all OPTIONAL) ────────────
  /** Type-row text: "Multi-step agentic email-drafting agent (…)". */
  typeLabel?: string;
  /** Model identifier (rendered with <code>). */
  model?: string;
  /** System-prompt row (may contain HTML, e.g. char count + READABLE pill). */
  systemPrompt?: string;
  /** Tool names — rendered as `.b-tool` chips. */
  tools?: string[];
  /** Code-access row prose (overrides the boolean for richer client copy). */
  codeAccessNote?: string;
  /** Apply-target row prose (e.g. "client-side (client codebase)…"). */
  applyTarget?: string;
  /** Expandable agent-input / prompt sample (gold-standard `details.expand > pre`). */
  inputSample?: string;
  /** Summary text for the input-sample <summary> (defaults to a generic label). */
  inputSampleSummary?: string;
  /**
   * SD self-diag: host runtime for the diagnosed skill ("claude-code" | "codex" | "cursor").
   * Rendered as an extra entity-card row when entityType === "skill".
   */
  hostRuntime?: "claude-code" | "codex" | "cursor";

  // ── Wave-5 R1.7 (APPENDIX-A) — rich EntityContext fields (extracted at ingest) ─
  // These make Entity a strict SUPERSET of EntityContext. When present, the
  // renderer prefers them over the legacy string fields and wraps any field
  // > 1 KB in an ExpandableSection. The normalizer populates these deterministically.
  /** Rich system prompt with size metadata — ALWAYS rendered expandable + collapsed (PII). */
  systemPromptCtx?: SizedText;
  /** Aggregated per-tool usage stats — chip strip visible + nested expandable per-tool stats. */
  toolInventory?: ToolInventoryEntry[];
  /** Rich input sample with size metadata — expandable when > 1 KB. */
  inputSampleCtx?: SizedText & { sanitized: boolean };
  /** Provenance string from the normalizer (e.g. "langfuse-export"). */
  source?: string;
}

/**
 * Wave-5 R1.7: lift a normalizer-emitted EntityContext into the render-layer
 * Entity shape. The rich fields land on the *Ctx-suffixed slots so the renderer's
 * ExpandableSection logic engages, while legacy display fields stay untouched.
 */
export function entityFromContext(ctx: EntityContext): Entity {
  const e: Entity = {
    name: ctx.name,
    entityType: ctx.entityType,
    codeAccess: ctx.codeAccess,
    source: ctx.source,
  };
  if (ctx.model) e.model = ctx.model;
  if (ctx.applyTarget) e.applyTarget = ctx.applyTarget;
  if (ctx.systemPrompt) e.systemPromptCtx = ctx.systemPrompt;
  if (ctx.toolInventory) e.toolInventory = ctx.toolInventory;
  if (ctx.inputSample) e.inputSampleCtx = ctx.inputSample;
  return e;
}

// ── Wave-5 R1.3 — gold-standard render-only shapes ───────────────────────────

/** One tile in the 6-tile `.big-stat` row (Overview). */
export interface BigStat {
  /** Display value (e.g. "54s", "$156.74", "1,946", "0"). */
  value: string;
  /** Small uppercase label under the value (e.g. "latency p50"). */
  label: string;
  /** Optional inline colour CSS var (e.g. "var(--y)", "var(--r)", "var(--g)"). */
  color?: string;
}

/** A row in the signal-census table (Overview). */
export interface SignalCensusRow {
  /** Signal / failure-mode name (e.g. "latency-spike"). Rendered bold if `primary`. */
  signal: string;
  /** "Present?" cell prose (e.g. "YES", "0", "?"). */
  present: string;
  /** Optional colour for the present cell. */
  presentColor?: string;
  /** Measure cell prose (may contain <code>). */
  measure: string;
  /** Decision cell prose (may contain a badge). */
  decision: string;
  /** Marks the ★ PRIMARY row. */
  primary?: boolean;
}

/**
 * W11-03: 4-segment scan-coverage funnel (Overview).
 * Stages: total → tier0-scan → representative-sample N → deep-read 6/N.
 * Denominator for the deep-read segment is the SAMPLE (not population) to be
 * honest about what was actually read. Backward-compat: sample is optional;
 * absent → funnel falls back to 3-segment display (total/code/llm).
 */
export interface ScanFunnel {
  /** s-total segment. */
  total: { value: string; label: string; detail: string };
  /** s-code segment (Tier-0 static scan). */
  code: { value: string; label: string; detail: string };
  /**
   * W11-03: s-sample segment (representative sample N drawn from tier0 output).
   * Optional for backward-compat: absent → funnel renders without this segment.
   */
  sample?: { value: string; label: string; detail: string };
  /** s-llm segment (deep-read LLM analyzers; denominator = sample when present). */
  llm: { value: string; label: string; detail: string };
}

/** One hourly cell in the 24h latency heatmap. */
export interface HourlyHeatCell {
  /** Hour 0..23. */
  hour: number;
  /** Trace count for the hour (rendered as the cell number). */
  count: number;
  /** Average latency in seconds — drives the l0..l4 colour bucket. */
  avgS: number;
  /** Max latency in seconds (shown in the cell tooltip). */
  maxS: number;
  /** Optional extra tooltip note (e.g. "VOLUME SPIKE", "SLOWEST"). */
  note?: string;
  /**
   * F3 (UR-2): the l0..l4 colour level for THIS cell's active metric. When present,
   * the renderer uses it directly (dynamic-metric heatmap); when absent it falls
   * back to classifying avgS (latency — backward-compat).
   */
  level?: number;
  /** F3: the active-metric value for this cell (e.g. avg $/trace, error-rate). */
  metricValue?: number;
  /** F3: human label for the active metric value (e.g. "avg $0.04", "12% errors"). */
  metricLabel?: string;
}

/** F3 (UR-2): which metric the heatmap cells are keyed to. */
export interface HourlyHeatmapMetric {
  /** The primary-signal name driving the metric choice (e.g. "cost-overshoot"). */
  signal: string;
  /** Legend / caption label (e.g. "avg latency", "avg cost", "error rate"). */
  label: string;
  /** Unit suffix for tooltips (e.g. "s", "$", "%"). */
  unit: string;
}

/** The 24h heatmap (Overview). Metric follows the primary signal (F3 / UR-2). */
export interface HourlyHeatmap {
  /** 24 hourly cells (one per hour). */
  cells: HourlyHeatCell[];
  /** l0..l4 legend boundaries label (e.g. "<50s · 50–65s · …"). Optional. */
  legendLabels?: string[];
  /** Narrative paragraph under the heatmap. */
  narrative?: string;
  /**
   * F3 (UR-2): the active metric the cells are coloured by. Default = latency (so a
   * latency-primary run is byte-identical to the pre-F3 behaviour). Absent → latency.
   */
  metric?: HourlyHeatmapMetric;
}

/** A graded decision-log row (Methodology). */
export interface DecisionLogRow {
  /** Decision name (e.g. "Source ingest"). */
  decision: string;
  /** What the skill did. */
  what: string;
  /** Grade HTML (e.g. a badge span). */
  grade: string;
}

// ── Session trajectory (I-041 — Trajectory internal tab) ────────────────────

export interface SessionTrajectoryData {
  /** Ordered steps in the session (tool calls, messages, etc.) */
  steps?: Array<{ step: number; type: string; content: string; timestamp?: string }>;
  /** Mermaid DAG source for the session flow diagram */
  mermaidDag?: string;
}

// ── Render input ─────────────────────────────────────────────────────────────

export interface RenderInput {
  sessionId: string;
  diagnosedAt: string;
  sourcePlatform: string;
  targetPlatform: string;
  totalTraces: number;
  findings: Finding[];
  discoveredChecks?: DiscoveredCheck[];

  // ── Wave-5 R1.3 — gold-standard render shapes (built by the enricher) ──────
  /** Header title text (e.g. "DIAGNOSTICS · SAMPLE-EMAIL-AGENT LATENCY"). */
  headerTitle?: string;
  /** Header meta line HTML (generated · source · traces · findings · model). */
  headerMetaHtml?: string;
  /** The diagnosed entity (gold-standard entity card on the Overview tab). */
  diagnosedEntity?: Entity;
  /** 6-tile big-stat row (Overview). */
  bigStat?: BigStat[];
  /** Signal-census table rows (Overview + Methodology). */
  signalCensus?: SignalCensusRow[];
  /** Scan-coverage funnel (Overview). */
  scanFunnel?: ScanFunnel;
  /** 24h latency heatmap (Overview). */
  hourlyHeatmap?: HourlyHeatmap;
  /** Graded decision-log rows (Methodology). */
  decisionLog?: DecisionLogRow[];
  /** Overview headline callout (gold-standard `.crit` box). */
  overviewHeadline?: string;
  /** Overview leverage callout (gold-standard `.alert` box). */
  overviewLeverage?: string;
  /** Overview h2 title + sub (story-led). */
  overviewTitle?: string;
  overviewSub?: string;
  /** Decisions-tab recommended-bundle callout (`.alert`). */
  decisionsBundle?: string;
  /** Mermaid sequence-diagram source for the Methodology topology. */
  mermaidSequence?: string;
  /**
   * FU-INT-1: Audience for this render pass. Default: "internal" (safe — full report).
   * When "client": NODE-STRIP removes all class="internal" nodes (Methodology tab,
   * Trajectory tab, internal-banner) — they are not emitted into the HTML at all.
   */
  audience?: Audience;
  /**
   * I-024 + I-030: Run metadata for Methodology tab (INTERNAL).
   * If absent, Methodology tab renders with a placeholder message.
   */
  runMeta?: RunMeta;
  /**
   * I-026 + I-038: Entities involved in the diagnostic session (agents, tools, skills, models).
   * Rendered as entity cards in the Methodology tab.
   */
  entities?: Entity[];
  /**
   * I-041: Session trajectory data for the Trajectory tab (INTERNAL).
   */
  sessionTrajectory?: SessionTrajectoryData;
  /**
   * I-035: Override the generated-at timestamp (ISO8601).
   * Defaults to the current time at render. Override useful in tests.
   */
  generatedAt?: string;
  /**
   * I-029 + I-034 + I-036: Meta-report mode — findings are grouped by cluster (failureOrigin.what)
   * instead of one tab per finding. Used when diagnosing the diagnostics tool itself.
   */
  isMetaReport?: boolean;
  /**
   * D-8 (Wave-13 Block A): Methodology/variance self-audit variant.
   *
   * A self-diagnosis can be one of two shapes:
   *   (a) the TRACE-METRIC variant — the skill diagnosed against real runtime
   *       traces, so latency/cost tiles (bigStat / hourlyHeatmap / signalCensus)
   *       exist and the R1 §9.3 fail-loud predicate rightly requires them; or
   *   (b) the PROCESS/METHODOLOGY variant — a variance / operational-deviance
   *       audit of the skill's OWN behaviour. It has NO runtime traces, so the
   *       metric tiles legitimately do not exist. Requiring them would force the
   *       renderer to either refuse or fabricate metrics.
   *
   * When `methodologyAudit` is true the renderer treats this as variant (b):
   * it EXEMPTS the report from the trace-metric tile requirement (the tiles are
   * absent by nature, not starved) WITHOUT relaxing the predicate for ordinary
   * reports. It implies `isMetaReport` semantics and therefore `audience` is
   * forced to internal (PR-022). The metric-shaped Overview tiles simply omit
   * (they are already conditional); a process-shaped report renders the entity
   * card, findings table, methodology tab, and clustered finding panels.
   */
  methodologyAudit?: boolean;
}

export interface DiscoveredCheck {
  checkId: string;
  name: string;
  description: string;
  affectedTraceIds: string[];
}

// ── JSON-LD (R-SELF-14-b) ────────────────────────────────────────────────────

/**
 * R-SELF-14-b: Build a JSON-LD graph for the full findings/remedies graph.
 * Wrapped in <script type="application/ld+json"> in the final HTML.
 */
export function buildFindingsJsonLd(input: RenderInput): string {
  const graph = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Diagnostic Findings",
    "description": `Session ${safeSessionId(input.sessionId)} diagnosed at ${input.diagnosedAt}`,
    "numberOfItems": input.findings.length,
    "itemListElement": input.findings.map((f, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "item": {
        "@type": "CreativeWork",
        "identifier": f.findingId,
        "name": f.actionable,
        "description": f.failureOrigin.evidence,
        "keywords": [f.failureOrigin.what, f.failureOrigin.why, f.failureOrigin.where].join(" "),
        "additionalProperty": [
          { "@type": "PropertyValue", "name": "what", "value": f.failureOrigin.what },
          { "@type": "PropertyValue", "name": "why", "value": f.failureOrigin.why },
          { "@type": "PropertyValue", "name": "where", "value": f.failureOrigin.where },
          { "@type": "PropertyValue", "name": "confidence", "value": f.failureOrigin.confidence },
        ],
        "hasPart": f.remedies.map((r) => ({
          "@type": "CreativeWork",
          "identifier": r.remedyId,
          "name": r.title,
          "additionalProperty": [
            { "@type": "PropertyValue", "name": "cost", "value": r.cost },
            { "@type": "PropertyValue", "name": "correctness", "value": r.correctness },
            { "@type": "PropertyValue", "name": "rank", "value": r.rank },
          ],
        })),
      },
    })),
  };
  return `<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>`;
}

// ── Wave-5 R1.7 — ExpandableSection widget (APPENDIX-A §A.1) ──────────────────

/** Threshold above which a field is wrapped in an ExpandableSection (1 KB). */
const EXPAND_THRESHOLD_BYTES = 1024;

/** Human-readable KB string (1 dp) for a byte count. */
function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Wave-5 R1.7 (APPENDIX-A §A.1): the ExpandableSection building block. Renders a
 * default-collapsed `<details class="expand">` with a size+token summary and the
 * content inside a scrollable `<pre>`. Set `forceExpandable` for fields that must
 * always be collapsed regardless of size (e.g. system prompt — PII).
 *
 * The `details.expand` / `summary` / `pre` CSS already lives in the gold-standard
 * report.html.tpl (max-height:340px, overflow:auto, white-space:pre-wrap).
 */
export function renderExpandableSection(
  label: string,
  content: SizedText,
  opts: { forceExpandable?: boolean } = {}
): string {
  const meta = `${formatKb(content.sizeBytes)}${content.tokensApprox ? ` · ${content.tokensApprox.toLocaleString("en-US")} tokens` : ""}`;
  const big = content.sizeBytes > EXPAND_THRESHOLD_BYTES || opts.forceExpandable;
  if (!big) {
    // Small + not force-collapsed: render inline (no details wrapper).
    return `<div class="inline-field">${escapeHtml(content.text)}</div>`;
  }
  // NOTE: never emit the `open` attribute — sections are collapsed by default.
  return `<details class="expand"><summary>${escapeHtml(label)} (${meta} · click to expand)</summary><pre>${escapeHtml(content.text)}</pre></details>`;
}

// ── Wave-5 helpers — gold-standard class mappings ────────────────────────────

/** Map a finding severity → gold-standard badge class suffix (crit/high/med/info). */
function severityBadgeClass(sev: Finding["severity"] | undefined, confidence: FailureOrigin["confidence"]): "crit" | "high" | "med" | "info" {
  if (sev) return sev;
  // Fall back from confidence when severity is not explicitly set.
  return confidence === "high" ? "crit" : confidence === "medium" ? "high" : "info";
}

/** Map a severity → gold-standard tab sev-dot class. */
function severityDotClass(sev: "crit" | "high" | "med" | "info"): string {
  return sev === "crit" ? "sev-crit" : sev === "high" ? "sev-high" : sev === "med" ? "sev-med" : "sev-info";
}

/** Map a heat avg-latency level (already classified l0..l4) — defensive clamp. */
function heatLevelClass(level: number): string {
  const l = Math.max(0, Math.min(4, Math.round(level)));
  return `l${l}`;
}

/** Classify an avg-latency value (seconds) into an l0..l4 bucket using gold-standard boundaries. */
function classifyHeatLevel(avgS: number): number {
  if (avgS < 50) return 0;
  if (avgS < 65) return 1;
  if (avgS < 85) return 2;
  if (avgS < 100) return 3;
  return 4;
}

// ── renderReport ─────────────────────────────────────────────────────────────


// ── W9-08: Pre-render validation (R-CP-1..4) ─────────────────────────────────

/**
 * W9-08 (R-CP-1/2/3/4): Validate RenderInput before HTML is emitted.
 *
 * Checks (all throw on failure — NEVER emit partial HTML):
 *   1. Template has zero unfilled {{PLACEHOLDER}} remnants vs known placeholder set.
 *      Reports any unrecognised {{...}} tokens left in the final rendered output.
 *   2. Every Finding has required fields (findingId, actionable, failureOrigin.*,
 *      whyChain, remedies, sourceTraceIds, referenceIds).
 *   3. isMetaReport implies audience === 'internal' (PR-022).
 *
 * This function is called from renderReport AFTER the template is stamped, BEFORE
 * the HTML is returned. On any miss: throws with the full missing list (R-CP-1 —
 * no partial HTML ever emitted).
 */
export function validatePreRender(
  renderedHtml: string,
  input: RenderInput
): void {
  const errors: string[] = [];

  // ── (1) Template placeholder check — no {{...}} remnants ──────────────────
  const remnants = renderedHtml.match(/\{\{[A-Z_0-9]+\}\}/g);
  if (remnants && remnants.length > 0) {
    const unique = [...new Set(remnants)];
    errors.push(
      `Unresolved template placeholders (${unique.length}): ${unique.join(", ")}`
    );
  }

  // ── (2) Finding shape validation ──────────────────────────────────────────
  for (let i = 0; i < input.findings.length; i++) {
    const f = input.findings[i];
    const prefix = `findings[${i}] (${String(f.findingId ?? "?")})`;
    if (!f.findingId || typeof f.findingId !== "string") {
      errors.push(`${prefix}: findingId missing or not a string`);
    }
    if (!f.actionable || typeof f.actionable !== "string") {
      errors.push(`${prefix}: actionable missing or not a string`);
    }
    if (!f.failureOrigin || typeof f.failureOrigin !== "object") {
      errors.push(`${prefix}: failureOrigin missing`);
    } else {
      if (!f.failureOrigin.what) errors.push(`${prefix}: failureOrigin.what missing`);
      if (!f.failureOrigin.why) errors.push(`${prefix}: failureOrigin.why missing`);
      if (!f.failureOrigin.where) errors.push(`${prefix}: failureOrigin.where missing`);
      if (!f.failureOrigin.evidence) errors.push(`${prefix}: failureOrigin.evidence missing`);
      if (!f.failureOrigin.confidence) errors.push(`${prefix}: failureOrigin.confidence missing`);
    }
    if (!Array.isArray(f.whyChain)) {
      errors.push(`${prefix}: whyChain is not an array`);
    }
    if (!Array.isArray(f.remedies)) {
      errors.push(`${prefix}: remedies is not an array`);
    }
    if (!Array.isArray(f.sourceTraceIds)) {
      errors.push(`${prefix}: sourceTraceIds is not an array`);
    }
    if (!f.referenceIds || typeof f.referenceIds !== "object") {
      errors.push(`${prefix}: referenceIds missing`);
    }
  }

  // ── (3) isMetaReport ⇒ audience === 'internal' ───────────────────────────
  // D-8: methodologyAudit implies a self-diag (meta) report, same PR-022 rule.
  if ((input.isMetaReport || input.methodologyAudit) && input.audience === "client") {
    errors.push(
      "isMetaReport is true but audience is 'client' — self-diagnosis reports MUST be internal-only (PR-022)"
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `[W9-08] pre-render validation failed — ${errors.length} error(s). REFUSING to emit HTML:\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")
    );
  }
}

/**
 * Wave-5: Render the gold-standard HTML report from the ported template + a
 * fully-populated RenderInput.
 *
 * Fail-loud predicate (R1 §9.3): the renderer REFUSES (throws) when ≥3 of the 4
 * internal render shapes (diagnosedEntity / bigStat / hourlyHeatmap / signalCensus)
 * are missing — no silent placeholder fallback. This is the guard that the whole
 * regression hinged on (silent graceful-degradation hid the starved input).
 *
 * SD self-diag: when isMetaReport===true the renderer REFUSES audience="client"
 * (PR-022 — self-diagnosis is always internal), force-renders the SELF-DIAGNOSIS
 * banner, and groups findings into clusters by failureOrigin.what.
 *
 * Backward-compat: minimal templates (without the gold-standard slots) and the
 * legacy {{FINDINGS_HTML}} / {{PANELS_HTML}} / {{TABS_NAV_HTML}} placeholders are
 * still substituted, so the open-ended regression guard test keeps passing.
 */
export function renderReport(template: string, input: RenderInput): string {
  // D-8: a methodology/variance self-audit is a self-diag (meta) report by
  // definition — it implies isMetaReport so PR-022 (internal-only) still holds.
  const isMetaReport = (input.isMetaReport ?? false) || (input.methodologyAudit ?? false);

  // SD: self-diag is ALWAYS internal — refuse client (PR-022).
  if (isMetaReport && input.audience === "client") {
    throw new Error(
      "renderReport: refusing --audience client for a self-diagnosis (isMetaReport) report. " +
        "Self-diagnosis output is INTERNAL-only (PR-022)."
    );
  }
  const audience: Audience = isMetaReport ? "internal" : input.audience ?? "client";

  // R1 §9.3 fail-loud predicate: ≥3 of 4 internal shapes missing → refuse.
  assertRenderShapesPresent(input);

  const generatedAt = input.generatedAt ?? new Date().toISOString();

  // D-4 render guard: `input.sessionId` is typed required but the enricher does
  // not always emit a top-level sessionId, so `.toUpperCase()` (and the slot
  // interpolations below) crashed / printed `undefined` when it was absent.
  // Resolve a safe sessionId ONCE and route every dereference through it.
  const sessionId = safeSessionId(input.sessionId);

  // ── Header ──
  const headerTitle = input.headerTitle ?? `— DIAGNOSTICS · ${escapeHtml(sessionId.toUpperCase())}`;
  const headerMeta = input.headerMetaHtml ?? defaultHeaderMeta(input, generatedAt);

  // ── Tab nav ──
  // R2.6: focus directive (from the parsed operator brief) swaps Overview → 🎯 Guided.
  const guidedFocus = input.runMeta?.parsedInvocation?.focus;
  const tabNavHtml = renderTabsNav(input.findings, audience, isMetaReport, guidedFocus);

  // ── Panels ──
  const overviewPanelHtml = renderOverviewTab(input);
  const findingPanelsHtml = isMetaReport
    ? renderMetaReportPanels(input.findings)
    : input.findings.map((f, idx) => renderFindingPanel(f, idx)).join("\n");
  const decisionsPanelHtml = renderDecisionsTab(input);

  // Methodology panel (INTERNAL only — NODE-STRIP for client).
  const methodologyPanelHtml = audience === "internal" ? renderMethodologyTab(input) : "";

  // FU-INT-1: internal audience banner (NODE-STRIPPED for client). The
  // class="internal-banner" string must NOT appear in client output.
  const internalBannerHtml =
    audience === "internal" && !isMetaReport
      ? `<div class="internal-banner">⚙ INTERNAL — methodology + session-trajectory data included. NODE-STRIPPED for --audience client.</div>`
      : "";

  // SD: forced self-diagnosis banner (PR-022) — only when isMetaReport.
  const internalBannerForce = isMetaReport
    ? `<div class="internal-banner" style="text-align:center;border-radius:0;margin:0;">⚙ SELF-DIAGNOSIS — analyzing the diagnostics skill itself. Findings target config.yaml / skill assets, NEVER source code (PR-022).</div>`
    : "";

  // I-027 backward-compat slot (kept so the .tpl + minimal templates substitute cleanly).
  const funnelHeatmapHtml = renderFunnelHeatmap();

  // R-SELF-14-b: JSON-LD semantic block.
  const findingsJsonLd = buildFindingsJsonLd(input);

  // PRD-CC-07: Live preview script — wires .remedy-cb + .remedy-notes + #general-feedback.
  // PRD-SD-06: self-diag banner discipline — included in the same slot.
  const mermaidScriptHtml = renderLivePreviewScript();

  // Legacy combined panels (for minimal templates using {{PANELS_HTML}} /
  // {{FINDINGS_HTML}}). Gold-standard templates ignore these.
  const legacyPanelsHtml =
    overviewPanelHtml + "\n" + findingPanelsHtml + "\n" + decisionsPanelHtml +
    (methodologyPanelHtml ? "\n" + methodologyPanelHtml : "");

  const discoveredChecksHtml =
    input.discoveredChecks && input.discoveredChecks.length > 0
      ? renderDiscoveredChecks(input.discoveredChecks)
      : "";

  const denominator = countRemedies(input.findings);

  // W9-08: Build HTML string then validate before returning (R-CP-1/2/3).
  const html = template
    .replaceAll("{{TITLE}}", escapeHtml(input.headerTitle ? stripTags(input.headerTitle) : `MUTAGENT-DIAGNOSTICS — ${sessionId}`))
    .replaceAll("{{HEADER_TITLE}}", headerTitle)
    .replaceAll("{{HEADER_META}}", headerMeta)
    .replaceAll("{{TAB_NAV_HTML}}", tabNavHtml)
    .replaceAll("{{METHODOLOGY_PANEL_HTML}}", methodologyPanelHtml)
    .replaceAll("{{OVERVIEW_PANEL_HTML}}", overviewPanelHtml)
    .replaceAll("{{FINDING_PANELS_HTML}}", findingPanelsHtml)
    .replaceAll("{{DECISIONS_PANEL_HTML}}", decisionsPanelHtml)
    .replaceAll("{{APPROVED_COUNT_DENOMINATOR}}", String(denominator))
    .replaceAll("{{INTERNAL_BANNER_FORCE}}", internalBannerForce)
    // Backward-compat + shared slots:
    .replaceAll("{{SESSION_ID}}", escapeHtml(sessionId))
    .replaceAll("{{DIAGNOSED_AT}}", escapeHtml(input.diagnosedAt))
    .replaceAll("{{SOURCE_PLATFORM}}", escapeHtml(input.sourcePlatform))
    .replaceAll("{{TARGET_PLATFORM}}", escapeHtml(input.targetPlatform))
    .replaceAll("{{TOTAL_TRACES}}", String(input.totalTraces))
    .replaceAll("{{FINDINGS_COUNT}}", String(input.findings.length))
    .replaceAll("{{GENERATED_AT}}", escapeHtml(generatedAt))
    .replaceAll("{{INTERNAL_BANNER_HTML}}", internalBannerHtml)
    .replaceAll("{{MERMAID_SCRIPT_HTML}}", mermaidScriptHtml)
    .replaceAll("{{FUNNEL_HEATMAP_HTML}}", funnelHeatmapHtml)
    .replaceAll("{{TABS_NAV_HTML}}", tabNavHtml)
    .replaceAll("{{PANELS_HTML}}", legacyPanelsHtml)
    .replaceAll("{{FINDINGS_HTML}}", legacyPanelsHtml)
    .replaceAll("{{DISCOVERED_CHECKS_HTML}}", discoveredChecksHtml)
    .replaceAll("{{FINDINGS_JSONLD}}", findingsJsonLd);

  // W9-08 (R-CP-1/2/3): validate placeholder + finding shape + isMetaReport => internal.
  // THROW before emitting partial or invalid HTML — never write broken output.
  validatePreRender(html, input);
  return html;
}

/**
 * R1 §9.3 fail-loud predicate. The 4 internal render shapes are diagnosedEntity,
 * bigStat, hourlyHeatmap, signalCensus. When ≥3 are missing the renderer refuses,
 * rather than silently degrading to placeholders (the root cause of the regression).
 *
 * Empty findings (e.g. the open-ended regression guard with findings:[]) are
 * exempt — a report with no findings legitimately has no render shapes to build.
 *
 * D-8 (Wave-13 Block A): a `methodologyAudit` report (process/variance self-audit)
 * is also exempt — it has NO runtime traces, so the latency/cost tiles legitimately
 * do not exist. The exemption is narrow (gated on the explicit flag) so it cannot
 * mask a genuinely STARVED trace report, which is what the predicate guards against.
 */
function assertRenderShapesPresent(input: RenderInput): void {
  if (input.findings.length === 0) return;
  if (input.methodologyAudit) return;
  const missing: string[] = [];
  if (!input.diagnosedEntity) missing.push("diagnosedEntity");
  if (!input.bigStat || input.bigStat.length === 0) missing.push("bigStat");
  if (!input.hourlyHeatmap || input.hourlyHeatmap.cells.length === 0) missing.push("hourlyHeatmap");
  if (!input.signalCensus || input.signalCensus.length === 0) missing.push("signalCensus");
  if (missing.length >= 3) {
    throw new Error(
      `renderReport: refusing to render — ${missing.length} of 4 internal render shapes missing ` +
        `(${missing.join(", ")}). The enricher (scripts/enrich/build-render-input.ts) must ` +
        `populate diagnosedEntity, bigStat, hourlyHeatmap, signalCensus before render. ` +
        `Fail-loud (R1 §9.3) — no silent placeholder fallback.`
    );
  }
}

/** Count total remedies across all findings (approved-count denominator). */
function countRemedies(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + f.remedies.length, 0);
}

/** Default header meta line when the enricher doesn't supply one. */
function defaultHeaderMeta(input: RenderInput, generatedAt: string): string {
  return (
    `<span class="mk">generated</span> <span class="mv">${escapeHtml(generatedAt)}</span>` +
    `<span class="sep">·</span><span class="mk">source</span> ${escapeHtml(input.sourcePlatform)}` +
    `<span class="sep">·</span><span class="mv">${input.totalTraces.toLocaleString("en-US")} traces</span>` +
    `<span class="sep">·</span><span class="mv">${input.findings.length} findings</span>`
  );
}

/** Strip HTML tags from a string (for <title>, which must be text-only). */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/^—\s*/, "MUTAGENT-DIAGNOSTICS — ").trim();
}

// ── renderTabsNav ─────────────────────────────────────────────────────────────

/**
 * Render the gold-standard tabs navigation. Emits one button per finding (client
 * mode) or one per cluster (self-diag meta-report mode), bookended by the
 * Methodology [INTERNAL] tab (t0, internal-only) and the Decisions tab.
 *
 * Tab id scheme (matches gold-standard):
 *   t0          → Methodology [INTERNAL]  (only when audience===internal)
 *   t1          → Overview
 *   t2..tN+1    → one per finding   (client mode)
 *   tcluster-K  → one per cluster   (self-diag isMetaReport mode)
 *   tN+2 / last → Decisions
 */
export function renderTabsNav(
  findings: Finding[],
  audience: Audience = "internal",
  isMetaReport: boolean = false,
  guidedFocus?: string
): string {
  const buttons: string[] = [];

  // Methodology [INTERNAL] — t0 — only for internal audience.
  if (audience === "internal") {
    buttons.push(
      `<button data-tab="t0" class="internal active">⚙ Methodology [INTERNAL]</button>`
    );
  }

  // Overview — t1. Active when there is no internal methodology tab.
  // R2.6: when a focus directive is present, 🎯 Guided REPLACES Overview (same t1
  // slot) and carries a tooltip echoing the operator's focus.
  const overviewActive = audience === "internal" ? "" : " class=\"active\"";
  if (guidedFocus && guidedFocus.trim().length > 0) {
    buttons.push(
      `<button data-tab="t1"${overviewActive} title="Guided by operator focus: ${escapeHtml(guidedFocus)}">🎯 Guided</button>`
    );
  } else {
    buttons.push(`<button data-tab="t1"${overviewActive}>① Overview</button>`);
  }

  if (isMetaReport && findings.length > 0) {
    // SD: tab-per-cluster (group by failureOrigin.what).
    const clusters = clusterFindings(findings);
    let idx = 0;
    for (const [what, group] of clusters) {
      const sev = group.some((f) => f.failureOrigin.confidence === "high")
        ? "crit"
        : group.some((f) => f.failureOrigin.confidence === "medium")
        ? "high"
        : "info";
      buttons.push(
        `<button data-tab="tcluster-${idx}"><span class="sev-dot ${severityDotClass(sev)}"></span>${escapeHtml(what)} (${group.length})</button>`
      );
      idx++;
    }
  } else {
    // Client: one tab per finding.
    findings.forEach((f, idx) => {
      const sev = severityBadgeClass(f.severity, f.failureOrigin.confidence);
      const label = escapeHtml(`${f.findingId} ${shortTitle(f)}`);
      buttons.push(
        `<button data-tab="t${idx + 2}"><span class="sev-dot ${severityDotClass(sev)}"></span>${label}</button>`
      );
    });
  }

  // Decisions — last tab.
  buttons.push(`<button data-tab="tdecisions">⑦ Decisions</button>`);

  return buttons.join("\n  ");
}

/** Short title for a finding tab (story-led title, falls back to actionable). */
function shortTitle(f: Finding): string {
  const raw = f.title ?? f.actionable;
  return raw.length > 32 ? raw.slice(0, 32) + "…" : raw;
}

// ── renderEntityCard (gold-standard .entity / .entity-grid) ──────────────────

/**
 * Wave-5 R1.2: Render the gold-standard entity-definition card.
 * Emits `.entity` → `.entity-head` + `.entity-grid` with type/model/system-prompt/
 * tools/code-access/apply-target rows, plus an expandable input-sample `details.expand`.
 *
 * SD: when entityType==="skill" the card renders skill-specific rows
 * (Diagnostic skill (self-target) · source root · code access YES · apply target
 * config.yaml/skill assets NEVER source) + an optional host-runtime row.
 */
export function renderEntityCard(entity: Entity): string {
  const isSkill = entity.entityType === "skill";

  const rows: string[] = [];

  // Type row.
  const typeText = entity.typeLabel
    ? entity.typeLabel
    : isSkill
    ? "Diagnostic skill (self-target)"
    : escapeHtml(entity.summary ?? entity.entityType);
  rows.push(`<div class="k">Type</div><div class="v">${entity.typeLabel ? entity.typeLabel : typeText}</div>`);

  // Model row.
  if (entity.model) {
    rows.push(`<div class="k">Model</div><div class="v"><code>${escapeHtml(entity.model)}</code></div>`);
  }

  // SD: source root for skill self-target.
  if (isSkill) {
    rows.push(
      `<div class="k">Source root</div><div class="v"><code>~/.claude/skills/mutagent-diagnostics/</code></div>`
    );
  }

  // System-prompt / SKILL.md row.
  // R1.7: when the rich systemPromptCtx is present, ALWAYS render it as a
  // forced-collapsed ExpandableSection (PII — explicit click to view) regardless
  // of size. Fall back to the legacy inline string field otherwise.
  const sysLabel = isSkill ? "SKILL.md" : "System prompt";
  if (entity.systemPromptCtx) {
    rows.push(
      `<div class="k">${sysLabel}</div><div class="v">${renderExpandableSection(sysLabel, entity.systemPromptCtx, { forceExpandable: true })}</div>`
    );
  } else if (entity.systemPrompt) {
    rows.push(`<div class="k">${sysLabel}</div><div class="v">${entity.systemPrompt}</div>`);
  }

  // Tools row.
  // R1.7: rich toolInventory → visible chip strip + a nested expandable per-tool
  // stats list (collapsed by default). Legacy `tools: string[]` → plain chips.
  if (entity.toolInventory && entity.toolInventory.length > 0) {
    rows.push(
      `<div class="k">Tools (${entity.toolInventory.length})</div><div class="v">${renderToolInventory(entity.toolInventory)}</div>`
    );
  } else if (entity.tools && entity.tools.length > 0) {
    const chips = entity.tools.map((t) => `<span class="b-tool">${escapeHtml(t)}</span>`).join("");
    rows.push(`<div class="k">Tools (${entity.tools.length})</div><div class="v">${chips}</div>`);
  }

  // SD: host runtime row.
  if (entity.hostRuntime) {
    rows.push(`<div class="k">Host runtime</div><div class="v"><code>${escapeHtml(entity.hostRuntime)}</code></div>`);
  }

  // Code-access row.
  const codeAccessText = entity.codeAccessNote
    ? entity.codeAccessNote
    : entity.codeAccess
    ? `<span class="access-yes">YES</span>`
    : `<span class="access-no">NO — remote export.</span>`;
  rows.push(`<div class="k">Code access</div><div class="v">${codeAccessText}</div>`);

  // Apply-target row.
  const applyTargetText = entity.applyTarget
    ? entity.applyTarget
    : isSkill
    ? `<code>config.yaml</code> / skill assets (NEVER source)`
    : "";
  if (applyTargetText) {
    rows.push(`<div class="k">Apply target</div><div class="v">${applyTargetText}</div>`);
  }

  // Expandable input / prompt sample.
  // R1.7: rich inputSampleCtx → ExpandableSection (expandable when > 1 KB).
  // Legacy `inputSample: string` → the original details.expand block.
  let inputSampleHtml = "";
  if (entity.inputSampleCtx) {
    inputSampleHtml = renderExpandableSection("Agent input / prompt sample", entity.inputSampleCtx);
  } else if (entity.inputSample) {
    inputSampleHtml = `<details class="expand"><summary>${escapeHtml(entity.inputSampleSummary ?? "View agent input / prompt sample")}</summary><pre>${escapeHtml(entity.inputSample)}</pre></details>`;
  }

  return `<div class="entity">
    <div class="entity-head"><div class="entity-name">⬡ ${escapeHtml(entity.name)}</div><span class="badge b-info">DIAGNOSED ENTITY</span></div>
    <div class="entity-grid">
      ${rows.join("\n      ")}
    </div>
    ${inputSampleHtml}
  </div>`;
}

/**
 * Wave-5 R1.7: render the tool inventory as a visible chip strip plus a nested,
 * default-collapsed ExpandableSection listing per-tool stats (callCount,
 * callsPerTrace, avg/p95 latency, signature). The chip strip is always visible;
 * the detailed stats are one click away.
 */
export function renderToolInventory(tools: ToolInventoryEntry[]): string {
  const chips = tools
    .map((t) => `<span class="b-tool">${escapeHtml(t.name)}</span>`)
    .join("");
  const statRows = tools
    .map((t) => {
      const lat =
        t.avgLatencyMs !== undefined
          ? `avg ${t.avgLatencyMs}ms${t.p95LatencyMs !== undefined ? ` · p95 ${t.p95LatencyMs}ms` : ""}`
          : "—";
      const sig = t.signature ? ` · <code>${escapeHtml(t.signature)}</code>` : "";
      return `<li><strong>${escapeHtml(t.name)}</strong> — ${t.callCount} call${t.callCount !== 1 ? "s" : ""} · ${t.callsPerTrace}/trace · ${lat}${sig}</li>`;
    })
    .join("\n      ");
  // Nested expandable per-tool stats (collapsed by default — never `open`).
  const nested = `<details class="expand"><summary>Per-tool stats (${tools.length} tool${tools.length !== 1 ? "s" : ""} · click to expand)</summary><ul>
      ${statRows}
    </ul></details>`;
  return `<div class="tool-chips">${chips}</div>${nested}`;
}

// ── renderBigStat (gold-standard .big-stat) ──────────────────────────────────

/** Wave-5 R1.2: Render the 6-tile `.big-stat` row. */
export function renderBigStat(stats: BigStat[]): string {
  if (!stats || stats.length === 0) return "";
  const tiles = stats
    .map(
      (s) =>
        `<div class="s"><div class="v"${s.color ? ` style="color:${s.color}"` : ""}>${escapeHtml(s.value)}</div><div class="l">${escapeHtml(s.label)}</div></div>`
    )
    .join("");
  return `<div class="big-stat">${tiles}</div>`;
}


// ── W9-07: Deep-read coverage tile (PR-048) ──────────────────────────────────

/**
 * W9-07 (PR-048): Render the deep-read coverage tile block for the report header
 * / Overview tab. Shows tierReached · tier0ScannedCount · llmReadCount ·
 * coverageConfidence · stopReason sourced from RunMeta.deepRead (B1's telemetry).
 *
 * Low-confidence banner: rendered when coverageConfidence !== 'high' OR when
 * RunMeta signals coverageWarning or tooThin. Brand-vars-only CSS.
 *
 * Returns "" when RunMeta.deepRead is absent (backward-compatible pre-Wave-9 runs).
 */
export function renderDeepReadTile(runMeta?: RunMeta): string {
  const dr = runMeta?.deepRead;
  if (!dr) return "";

  const isLowConf = dr.coverageConfidence !== "high";
  // tooThin / coverageWarning come from the B1 deep-read-gate (optional fields)
  const tooThin = (runMeta as Record<string, unknown>).coverageWarning === true
    || (runMeta as Record<string, unknown>).tooThin === true;
  const showBanner = isLowConf || tooThin;

  const confColor =
    dr.coverageConfidence === "high"
      ? "var(--g)"
      : dr.coverageConfidence === "medium"
      ? "var(--y)"
      : "var(--r)";

  const stopReasonLabel = {
    "evidence-sufficient": "evidence sufficient",
    "ceiling-reached": "ceiling reached",
    "time-budget": "time budget exhausted",
  }[dr.stopReason as string] ?? dr.stopReason;

  const tiles = [
    { value: String(dr.tierReached), label: "tier reached", color: "var(--p)" },
    { value: dr.population.toLocaleString("en-US"), label: "trace population", color: "var(--muted)" },
    { value: String(dr.llmReadCount), label: "llm-read", color: "var(--c)" },
    { value: dr.coverageConfidence, label: "coverage confidence", color: confColor },
    { value: stopReasonLabel, label: "stop reason", color: "var(--muted)" },
  ];

  const tileHtml = tiles
    .map(
      (t) =>
        `<div class="s"><div class="v" style="color:${t.color}">${escapeHtml(t.value)}</div><div class="l">${escapeHtml(t.label)}</div></div>`
    )
    .join("");

  const banner = showBanner
    ? `<div class="warn" style="margin-top:8px;">` +
      `<strong>Low read coverage</strong> — ` +
      `coverageConfidence: <strong>${escapeHtml(dr.coverageConfidence)}</strong>` +
      `${tooThin ? " · trace pool too thin for high confidence" : ""}` +
      `. Findings may under-represent the population. Re-run with a larger population or ` +
      `wider time window to improve coverage. (W9-07 / PR-048)</div>`
    : "";

  return `<div class="deep-read-tile">
  <h3>Deep-read coverage — trace-hungry escalation telemetry</h3>
  <div class="big-stat deep-read-stat">${tileHtml}</div>
  ${banner}
</div>`;
}

// ── W9-F: Translated feedback block (PR-046 Layer 2) ─────────────────────────

/**
 * W9-F (PR-046 Layer 2): Render translated-feedback entries for a finding.
 * Bridges raw user symptom → component-level RCA target. Shows "what the user
 * said" (rawQuote) vs "what it means for the agent" (component + reasoning).
 *
 * Backward-compatible: returns "" when translatedFeedback is absent or empty.
 */
export function renderTranslatedFeedbackBlock(finding: Finding): string {
  const entries: TranslatedFeedback[] = finding.translatedFeedback ?? [];
  if (entries.length === 0) return "";

  const confPill = (c: TranslatedFeedback["confidence"]): string => {
    const cls = c === "high" ? "b-info" : c === "medium" ? "b-med" : "b-crit";
    return `<span class="badge ${cls}">${c.toUpperCase()}</span>`;
  };

  const items = entries
    .map((e) => {
      const sourceLine = e.sourceIndex !== undefined
        ? `<span class="fb-source-type">source[${e.sourceIndex}]</span> · `
        : "";
      return `<div class="fb-item fb-translated">
  <div class="fb-head">${sourceLine}<strong>${escapeHtml(e.component)}</strong> <span class="tax-chip">${escapeHtml(e.affectedComponent)}</span> ${confPill(e.confidence)}</div>
  <blockquote class="fb-rawquote">"${escapeHtml(e.rawQuote)}"</blockquote>
  <p class="fb-reasoning">${escapeHtml(e.reasoning)}</p>
</div>`;
    })
    .join("\n");

  return `<div class="feedback-list feedback-translated">
<h3>Translated feedback <span class="r-count">(${entries.length} translation${entries.length !== 1 ? "s" : ""})</span> <span class="badge b-med">L2</span></h3>
${items}
</div>`;
}

// ── W9-F: Fix-feedback block (PR-046 Layer 3) ─────────────────────────────────

/**
 * W9-F (PR-046 Layer 3): Render per-remedy fix-outcome history from
 * Remedy.feedbackOnFix[]. Shows a status pill per outcome record.
 *
 * Backward-compatible: returns "" when feedbackOnFix is absent or empty.
 */
export function renderFeedbackOnFixBlock(remedy: Remedy): string {
  const entries: FeedbackOnFix[] = remedy.feedbackOnFix ?? [];
  if (entries.length === 0) return "";

  const outcomeConfig = {
    closed: { label: "CLOSED", color: "var(--g)" },
    partial: { label: "PARTIAL", color: "var(--y)" },
    ineffective: { label: "INEFFECTIVE", color: "var(--r)" },
    regressed: { label: "REGRESSED", color: "var(--r)" },
  } as const;

  const rows = entries
    .map((e) => {
      const cfg = outcomeConfig[e.outcome] ?? { label: e.outcome.toUpperCase(), color: "var(--muted)" };
      const pill = `<span style="font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 7px;border-radius:3px;background:${cfg.color};color:var(--bg);">${escapeHtml(cfg.label)}</span>`;
      const nextSteps =
        e.nextSteps && e.nextSteps.length > 0
          ? `<ul class="fix-next-steps">${e.nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
          : "";
      const comment = e.comment ? `<p class="fix-comment">${escapeHtml(e.comment)}</p>` : "";
      return `<div class="fix-fb-row">
  <div class="fix-fb-head">${pill} <span class="fix-session"><code>${escapeHtml(e.testSessionId)}</code></span> · ${escapeHtml(e.testedAt)}</div>
  ${comment}
  ${nextSteps}
</div>`;
    })
    .join("\n");

  return `<div class="fix-feedback-list">
<h4>Fix history <span class="r-count">(${entries.length} test${entries.length !== 1 ? "s" : ""})</span> <span class="badge b-med">L3</span></h4>
${rows}
</div>`;
}

// ── render24hHeatmap (gold-standard .heat / .cell l0..l4 / .heat-legend) ──────

/**
 * W11-02 (Wave-5 R1.2): Render the 24h latency heatmap as 24 `.cell` divs.
 * Colouring: when `runMeta.primarySignal` is present, cells where the primary
 * signal flag fires get a `sig` marker on the title tooltip; latency is the
 * fallback colour when no signal flag is available (pre-W11 backward-compat).
 *
 * W11-02: adds a window selector (default 24h, selectable 7d / 30d). The selector
 * is rendered as a small pill row above the heatmap; switching windows is
 * client-side only (the heatmap data in this render pass is always 24h — the
 * selector communicates to the operator which window they're viewing and links
 * back to a broader trace pull if needed).
 */
export function render24hHeatmap(heatmap: HourlyHeatmap, runMeta?: RunMeta): string {
  if (!heatmap || heatmap.cells.length === 0) return "";

  const primarySignalName = runMeta?.primarySignal?.name;

  // F3 (UR-2): the active metric drives cell colour + legend + caption. Default =
  // latency (backward-compat: a latency-primary heatmap is byte-identical to pre-F3).
  const metricLabel = heatmap.metric?.label ?? "avg latency";

  const cells = heatmap.cells
    .slice()
    .sort((a, b) => a.hour - b.hour)
    .map((c) => {
      // F3: prefer the enricher-supplied dynamic level; fall back to classifying
      // latency (pre-F3 cells that carry no `level`).
      const lvl = c.level !== undefined ? c.level : classifyHeatLevel(c.avgS);
      const level = heatLevelClass(lvl);
      const hh = c.hour.toString().padStart(2, "0");
      const signalNote = primarySignalName && c.note?.includes(primarySignalName)
        ? ` · ★ ${escapeHtml(primarySignalName)}`
        : "";
      // F3: tooltip leads with the active metric value (metricLabel), retaining
      // latency context (avg/max) for reference.
      const metricNote = c.metricLabel ? `${c.metricLabel} · ` : "";
      const title = `${hh}h ${metricNote}avg ${c.avgS}s max ${c.maxS}s${c.note ? " · " + c.note : ""}${signalNote}`;
      return `<div class="cell ${level}" title="${escapeHtml(title)}"><span class="ch">${hh}</span><span class="cn">${c.count}</span></div>`;
    })
    .join("\n    ");

  // F3: latency keeps its absolute-band legend; relative-metric modes get a
  // low→high relative legend (no spurious absolute boundaries).
  const isLatency = (heatmap.metric?.signal ?? "latency-spike") === "latency-spike" || heatmap.metric === undefined;
  const defaultLegend = isLatency
    ? ["<50s", "50–65s", "65–85s", "85–100s", ">100s"]
    : ["low", "", "mid", "", "high"];
  const legend = (heatmap.legendLabels ?? defaultLegend)
    .map((label, i) => `<span><span class="sw l${i}"></span>${escapeHtml(label)}</span>`)
    .join("");

  const narrative = heatmap.narrative ? `<p style="font-size:12px;color:var(--muted);">${heatmap.narrative}</p>` : "";

  // W11-02: window selector — default 24h, selectable 7d / 30d.
  // Data in this render pass is always 24h; the selector communicates the active
  // window and can be extended when multi-window data is available.
  const primaryNote = primarySignalName
    ? ` · primary signal: <strong style="color:var(--r);">${escapeHtml(primarySignalName)}</strong>`
    : "";
  const windowSelector = `<div class="heat-window-selector" style="font-size:11px;margin-bottom:4px;color:var(--muted);">
    <span class="heat-win active" data-win="24h" style="font-weight:700;color:var(--c);">24h</span>
    <span style="margin:0 4px;">·</span>
    <span class="heat-win" data-win="7d" style="cursor:pointer;">7d</span>
    <span style="margin:0 4px;">·</span>
    <span class="heat-win" data-win="30d" style="cursor:pointer;">30d</span>
    ${primaryNote}
  </div>`;

  return `${windowSelector}<div class="heat" id="heat">
    ${cells}
  </div>
  <div class="heat-legend">${escapeHtml(metricLabel)}: ${legend} · hover a cell for detail</div>
  ${narrative}`;
}

// ── renderSignalCensus (gold-standard signal-census table) ───────────────────

/** Wave-5 R1.2: Render the signal-census table. */
export function renderSignalCensus(rows: SignalCensusRow[]): string {
  if (!rows || rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const signalCell = r.primary ? `<strong>${escapeHtml(r.signal)}</strong>` : escapeHtml(r.signal);
      const presentStyle = r.presentColor ? ` style="color:${r.presentColor}"` : "";
      return `<tr><td>${signalCell}</td><td${presentStyle}>${escapeHtml(r.present)}</td><td>${r.measure}</td><td>${r.decision}</td></tr>`;
    })
    .join("\n      ");
  return `<table>
    <thead><tr><th>Signal / failure-mode</th><th>Present?</th><th>Measure</th><th>Decision</th></tr></thead>
    <tbody>
      ${body}
    </tbody>
  </table>`;
}

// ── renderAssumptionsBlock (gold-standard .assumptions w/ pills) ─────────────

/**
 * Wave-5 R1.2: Render the `.assumptions` block — one `<li>` per assumption with a
 * verified / unverified / hypothesis-pending pill.
 */
export function renderAssumptionsBlock(finding: Finding): string {
  const assumptions = finding.assumptions ?? [];
  if (assumptions.length === 0) return "";
  const items = assumptions
    .map((a) => {
      const pillClass = a.status; // "verified" | "unverified" | "hypothesis-pending"
      const pillLabel =
        a.status === "verified" ? "VERIFIED" : a.status === "unverified" ? "UNVERIFIED" : "HYPOTHESIS-PENDING";
      return `<li>${escapeHtml(a.text)} <span class="${pillClass}">${pillLabel} — ${escapeHtml(a.basis)}</span></li>`;
    })
    .join("\n    ");
  return `<div class="assumptions"><h4>⚠ Assumptions</h4><ul>
    ${items}
  </ul></div>`;
}

// ── renderRemedyCard (gold-standard .remedy.recommended) ─────────────────────

/** Map a remedy applyTarget label → gold-standard apply-pill class. */
function applyPillClass(label: string | undefined): string {
  if (!label) return "apply-none";
  const l = label.toLowerCase();
  if (l.includes("code")) return "apply-code";
  if (l.includes("prompt")) return "apply-prompt";
  if (l.includes("config")) return "apply-config";
  if (l.includes("no change") || l.includes("none")) return "apply-none";
  return "apply-config";
}

/** Map a remedy targetClass → canonical tclass-pill class. */
function tclassPillClass(targetClass: string | undefined): string {
  if (!targetClass) return "";
  const l = targetClass.toLowerCase();
  if (l.includes("local-agent")) return "tclass-local-agent";
  if (l.includes("local-code")) return "tclass-local-code-construct";
  if (l.includes("remote")) return "tclass-remote";
  return "tclass-local-agent";
}

/** Map a remedy changeType → canonical ctype-pill class. */
function ctypePillClass(changeType: Remedy["changeType"]): string {
  if (!changeType) return "";
  return `ctype-${changeType}`;
}

/** Map a remedy correctness → canonical b-correctness class. */
function correctnessPillClass(correctness: Remedy["correctness"]): string {
  // D-1 render guard: an absent correctness must NOT yield `b-correctness-undefined`.
  // Block C owns making the DATA always-present (type↔producer↔gate); this is the
  // render safety-net so a missing field can never reach the operator as `undefined`.
  return correctness ? `b-correctness-${correctness}` : "b-correctness-na";
}

/**
 * D-1 render guard. The remedy badge fields (`rank` / `cost` / `correctness`) are
 * REQUIRED on the canonical Remedy type, yet the broken-report evidence showed
 * them rendering as the literal string `undefined` when a producer/contract
 * desync left them unset at runtime. This is the render-side safety-net: an
 * absent value becomes a neutral `n/a` marker, never `undefined`.
 *
 * `value` is `unknown` deliberately — the guard must survive a value the type
 * system claims cannot be missing (defense-in-depth; Block C fixes the data).
 */
function badgeField(value: unknown): string {
  if (value === undefined || value === null || value === "") return "n/a";
  return String(value);
}

/**
 * D-4 render guard. `RenderInput.sessionId` is typed required, but the enricher
 * does not always emit a top-level sessionId — when absent the renderer crashed
 * on `sessionId.toUpperCase()` (the report would not render at all). Resolve a
 * safe, non-empty session label so the header / title / footer never crash or
 * print `undefined`. The data-side fix (enricher populating sessionId) is
 * tracked separately; this is the render-side null-guard.
 *
 * `value` is `unknown` for defense-in-depth — the guard must survive a value
 * the type system claims cannot be missing.
 */
function safeSessionId(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  return "unknown-session";
}

/**
 * PRD-CC-08: Build the pre-assembled markdown bundle for a remedy.
 * Emitted as a hidden <script type="text/plain"> so the Live Preview reader
 * can use it for deterministic, DOM-extraction-free bundle assembly.
 */
export function buildRemedyMarkdownBundle(remedy: Remedy, finding: Finding): string {
  const lines: string[] = [];
  lines.push(`## ${escapeMarkdown(remedy.remedyId)} — ${escapeMarkdown(remedy.title)}`);
  lines.push(`**Finding:** ${escapeMarkdown(finding.findingId)} — ${escapeMarkdown(finding.title ?? finding.actionable)}`);
  lines.push(`**Severity:** ${finding.severity ?? finding.failureOrigin.confidence}`);
  if (remedy.applyTarget) lines.push(`**Apply target:** ${escapeMarkdown(remedy.applyTarget)}`);
  if (remedy.targetClass) lines.push(`**Target class:** ${escapeMarkdown(remedy.targetClass)}`);
  if (remedy.changeType) lines.push(`**Change type:** ${remedy.changeType}`);
  // D-1 render guard: the copy-back markdown bundle must not leak `undefined` either.
  lines.push(`**Cost:** ${badgeField(remedy.cost)} · **Correctness:** ${badgeField(remedy.correctness)} · **Rank:** ${badgeField(remedy.rank)}`);
  lines.push("");

  if (remedy.rationale) {
    lines.push("### Why this remedy");
    lines.push(escapeMarkdown(remedy.rationale));
    lines.push("");
  }

  if (remedy.whyWorks) {
    lines.push("### Why this works");
    lines.push(escapeMarkdown(remedy.whyWorks));
    lines.push("");
  }

  if (remedy.diff) {
    lines.push("### Diff");
    lines.push("**Before:**");
    lines.push("```diff");
    lines.push(`- ${remedy.diff.before}`);
    lines.push("```");
    lines.push("**After:**");
    lines.push("```diff");
    lines.push(`+ ${remedy.diff.after}`);
    lines.push("```");
    lines.push("");
  }

  if (remedy.plan) {
    lines.push("### Apply plan");
    for (const f of remedy.plan.files) {
      lines.push(`- [${f.action}] ${f.path}${f.lineRange ? ` (${f.lineRange})` : ""}`);
    }
    if (remedy.plan.verify.length > 0) {
      lines.push("");
      lines.push("**Verify:**");
      for (const v of remedy.plan.verify) {
        lines.push(`- \`${v}\``);
      }
    }
    if (remedy.plan.acceptance) {
      lines.push(`**Acceptance:** ${remedy.plan.acceptance}`);
    }
    if (remedy.plan.commitMessage) {
      lines.push(`**Commit:** \`${remedy.plan.commitMessage}\``);
    }
    lines.push("");
  }

  if (remedy.applyInstructions && remedy.applyInstructions.length > 0) {
    lines.push("### Apply instructions");
    remedy.applyInstructions.forEach((step, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(step)}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

/** Minimal markdown escaper for inline text (not block-level). */
function escapeMarkdown(s: string): string {
  return s.replace(/[*_`[\]]/g, "\\$&");
}

/**
 * PRD-CC-03: Canonical remedy card anatomy (D1/D2/D3/D4/D7).
 * Render order:
 *   checkbox (top-right) → header row (rank · id · title) →
 *   meta strip (cost · correctness · targetClass · changeType · applyTarget pills) →
 *   purple r-rationale → cyan r-why-works →
 *   dashed r-target row (IFF applyTarget) →
 *   r-diff-grid 2-col Before/After (IFF diff) →
 *   r-apply-grid 2-col Apply plan + Apply instructions (IFF plan OR applyInstructions) →
 *   remedy-notes textarea.
 * NO <details> collapsibles. NO per-remedy Copy button.
 * Hidden <script type="text/plain"> payload for Live Preview (CC-08).
 */

/**
 * W12-08 (PR-052 proposed): render the "source not found — hypothesis" caveat
 * block shown in place of the Before/After grid when a remedy carries a
 * `diffStatus` instead of a `diff`. Honors `feedback_model_intent_sacred` — a
 * remedy with no findable source surfaces an explicit marker, never a guessed diff.
 */
export function renderDiffStatusCaveat(diffStatus: DiffStatus): string {
  const reason =
    diffStatus === "source-unavailable"
      ? "The apply target's current source is not accessible to the analyzer, so a Before/After cannot be cited."
      : "The failure origin could not be pinned to a concrete source location.";
  return `<div class="r-diff-caveat" data-diff-status="${escapeHtml(diffStatus)}">
  <div class="r-diff-caveat-label">Source not found — hypothesis</div>
  <p>${escapeHtml(reason)} No diff is shown; apply this remedy as a hypothesis and verify against the live target.</p>
</div>`;
}

export function renderRemedyCard(remedy: Remedy, findingId: string, finding?: Finding): string {
  const isRecommended = remedy.rank === 1;
  const rid = remedy.remedyId.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // ── Checkbox (top-right, part of header row) ──
  const checkbox = `<input type="checkbox" class="remedy-cb" data-id="${escapeHtml(remedy.remedyId)}" data-finding="${escapeHtml(findingId)}"${isRecommended ? " checked" : ""}>`;

  // ── Header row ──
  // W12-04: the checkbox is a direct child of `.remedy` (a flex ROW:
  // `[checkbox] [.remedy-body]`), NOT inside the header. The header is part of
  // the `.remedy-body` column. This restores the `[checkbox][.remedy-body]`
  // structure the orphaned `.remedy-body{flex:1}` rule + the template's
  // `.remedy-body`-targeting note-injection JS were written for.
  // D-1 render guard: never interpolate a bare `remedy.rank` — absent ⇒ "n/a", not "undefined".
  const rankPill = `<span class="rank-pill">RANK ${badgeField(remedy.rank)}</span>`;
  const header = `<div class="remedy-header"><div class="remedy-rank-id">${rankPill} <span class="remedy-id">${escapeHtml(remedy.remedyId)}</span></div><div class="remedy-what">${escapeHtml(remedy.title)}</div></div>`;

  // ── Meta strip ──
  // D-1 render guard: cost/correctness drive BOTH the pill text and a CSS class.
  // Guard both surfaces so a missing field never prints `undefined` nor produces
  // a `b-cost-undefined` class. The class helper for cost is inlined here.
  const costClass = remedy.cost ? `b-cost-${remedy.cost}` : "b-cost-na";
  const costPill = `<span class="${costClass}">cost:${badgeField(remedy.cost)}</span>`;
  const correctnessPill = `<span class="${correctnessPillClass(remedy.correctness)}">correct:${badgeField(remedy.correctness)}</span>`;
  const applyLabel = remedy.applyTarget ?? "";
  const applyPill = applyLabel
    ? `<span class="apply-pill ${applyPillClass(applyLabel)}">${escapeHtml(applyLabel)}</span>`
    : "";
  const tclassVal = remedy.targetClass ?? "";
  const tclassPill = tclassVal
    ? `<span class="tclass-pill ${tclassPillClass(tclassVal)}">${escapeHtml(tclassVal)}</span>`
    : "";
  const ctypePill = remedy.changeType
    ? `<span class="ctype-pill ${ctypePillClass(remedy.changeType)}">${remedy.changeType}</span>`
    : "";
  const metaStrip = `<div class="remedy-meta">${costPill}${correctnessPill}${tclassPill}${ctypePill}${applyPill}</div>`;

  // ── Purple r-rationale (D1) ──
  const rationaleText = remedy.rationale ?? `${escapeHtml(remedy.failureOrigin.what)}: ${escapeHtml(remedy.failureOrigin.why)} at ${escapeHtml(remedy.failureOrigin.where)}`;
  const rationaleBlock = `<div class="r-rationale"><span class="r-block-label">Why this remedy</span><p>${remedy.rationale ? escapeHtml(remedy.rationale) : rationaleText}</p></div>`;

  // ── Cyan r-why-works (D1) ──
  const whyWorksText = remedy.whyWorks ?? "(causal mechanism not documented)";
  const whyWorksBlock = `<div class="r-why-works"><span class="r-block-label">Why this works</span><p>${escapeHtml(whyWorksText)}</p></div>`;

  // ── Dashed r-target row (IFF applyTarget) ──
  const targetRow = applyLabel
    ? `<div class="r-target"><span class="r-target-label">Apply target</span><code>${escapeHtml(applyLabel)}</code></div>`
    : "";

  // ── r-diff-grid 2-col Before/After (IFF diff) (D3) ──
  // W12-08: when diff is absent but diffStatus is set, render a labeled
  // "source not found — hypothesis" caveat block instead of the Before/After
  // grid (renderDiffStatusCaveat). NEVER a fabricated diff (PR-052 proposed).
  let diffGrid = "";
  if (remedy.diff) {
    diffGrid = `<div class="r-diff-grid">
  <div class="diff-col"><div class="diff-label label-before">Before</div><pre>${escapeHtml(remedy.diff.before)}</pre></div>
  <div class="diff-col"><div class="diff-label label-after">After</div><pre>${escapeHtml(remedy.diff.after)}</pre></div>
</div>`;
  } else if (remedy.diffStatus) {
    diffGrid = renderDiffStatusCaveat(remedy.diffStatus);
  }

  // ── r-apply-grid 2-col Apply plan + Apply instructions (IFF plan OR applyInstructions) (D4) ──
  let applyGrid = "";
  if (remedy.plan || (remedy.applyInstructions && remedy.applyInstructions.length > 0)) {
    const planCol = remedy.plan
      ? `<div class="apply-col">
  <div class="apply-col-label">Apply plan</div>
  <ul class="r-apply-plan">
    ${remedy.plan.files.map((f) => `<li><code>${escapeHtml(f.action)}</code> ${escapeHtml(f.path)}${f.lineRange ? ` <span class="r-line-range">(${escapeHtml(f.lineRange)})</span>` : ""}</li>`).join("\n    ")}
  </ul>
  ${remedy.plan.verify.length > 0 ? `<div class="r-verify-label">Verify</div><ul class="r-apply-plan">${remedy.plan.verify.map((v) => `<li><code>${escapeHtml(v)}</code></li>`).join("")}</ul>` : ""}
  ${remedy.plan.acceptance ? `<div class="r-acceptance">${escapeHtml(remedy.plan.acceptance)}</div>` : ""}
  ${remedy.plan.commitMessage ? `<div class="r-commit"><code>${escapeHtml(remedy.plan.commitMessage)}</code></div>` : ""}
</div>`
      : `<div class="apply-col apply-col-empty"><span class="r-block-label">Apply plan</span><p class="r-muted">No structured plan provided.</p></div>`;

    const instrCol =
      remedy.applyInstructions && remedy.applyInstructions.length > 0
        ? `<div class="apply-col">
  <div class="apply-col-label">Apply instructions</div>
  <ol class="r-apply-instr">
    ${remedy.applyInstructions.map((step) => `<li>${escapeHtml(step)}</li>`).join("\n    ")}
  </ol>
</div>`
        : `<div class="apply-col apply-col-empty"><span class="r-block-label">Apply instructions</span><p class="r-muted">No step-by-step instructions provided.</p></div>`;

    applyGrid = `<div class="r-apply-grid">${planCol}${instrCol}</div>`;
  }

  // ── W9-F L3: fix-feedback history (feedbackOnFix[]) ──
  const fixFeedbackHtml = renderFeedbackOnFixBlock(remedy);

  // ── Remedy notes textarea (D7) ──
  const notesArea = `<textarea class="remedy-notes" placeholder="Feedback on this remedy — overrides, conditions, why-not, modifications. Merged verbatim into the master Copy decisions bundle."></textarea>`;

  // ── Hidden payload script (CC-08) ──
  const payloadScript = finding
    ? `<script type="text/plain" id="payload-${escapeHtml(rid)}">${escapeHtml(buildRemedyMarkdownBundle(remedy, finding))}</script>`
    : "";

  // W12-04: `.remedy` is a flex ROW of [checkbox][.remedy-body]; `.remedy-body`
  // is a flex COLUMN that stacks the ~9 content blocks full-width. Without the
  // wrapper the blocks laid out as a horizontal row crushed into narrow columns.
  // The hidden text/plain payload stays outside `.remedy-body` (not visible).
  return `<div class="remedy${isRecommended ? " recommended" : ""}">
  ${payloadScript}
  ${checkbox}
  <div class="remedy-body">
  ${header}
  ${metaStrip}
  ${rationaleBlock}
  ${whyWorksBlock}
  ${targetRow}
  ${diffGrid}
  ${applyGrid}
  ${fixFeedbackHtml}
  ${notesArea}
  </div>
</div>`;
}

// ── renderFeedbackBlock (PRD-CC-04, D5/D9) ────────────────────────────────────

/**
 * PRD-CC-04 (D5): Render the feedback-grounding block for a finding.
 * Displayed between Problem and Evidence. Returns "" when no sources.
 * Legacy: when feedbackSources is absent, auto-promotes userFeedback to
 * a single chat source entry (PRD-CC-02 backward-compat).
 * NO emojis on the header or source-type labels (D9).
 */
export function renderFeedbackBlock(finding: Finding): string {
  // Resolve sources: prefer feedbackSources, fall back to userFeedback promotion.
  let sources: FeedbackSource[] = finding.feedbackSources ?? [];
  if (sources.length === 0 && finding.userFeedback) {
    sources = [
      {
        sourceType: "chat",
        provenance: "legacy userFeedback field",
        body: finding.userFeedback,
      },
    ];
  }
  if (sources.length === 0) return "";

  const prettyLabel = (s: FeedbackSource): string => {
    if (s.sourceType === "chat") return "Operator chat";
    if (s.sourceType === "trace-score") return "Langfuse trace score";
    return s.externalPlatform ? `External: ${s.externalPlatform}` : "External feedback platform";
  };

  const items = sources
    .map((s) => {
      const scoreNote =
        s.score !== undefined
          ? ` <span class="fb-score-note">${escapeHtml(s.score.name)}: ${escapeHtml(String(s.score.value))}${s.score.scorerType ? ` (${escapeHtml(s.score.scorerType)})` : ""}</span>`
          : "";
      const traceNote = s.traceId
        ? ` · trace <code>${escapeHtml(s.traceId)}</code>`
        : "";
      const timeNote = s.capturedAt ? ` · ${escapeHtml(s.capturedAt)}` : "";
      return `<div class="fb-item fb-${s.sourceType}">
  <div class="fb-head"><span class="fb-source-type">${escapeHtml(prettyLabel(s))}</span> · ${escapeHtml(s.provenance)}${scoreNote}${traceNote}${timeNote}</div>
  <blockquote>${escapeHtml(s.body)}</blockquote>
</div>`;
    })
    .join("\n");

  return `<div class="feedback-list">
<h3>Feedback grounding this finding <span class="r-count">(${sources.length} source${sources.length !== 1 ? "s" : ""})</span></h3>
${items}
</div>`;
}

// ── renderFindingPanel (gold-standard finding panel) ─────────────────────────

/**
 * Wave-5 R1.2: Render a single finding as a gold-standard panel.
 * Anatomy: severity-badged h2 + sub + worst-case callout + taxonomy chips +
 * Problem (.f-desc) + Evidence + Why-chain (.whychain w/ origin marker) +
 * Assumptions block + Remedies (ranked, rank-1 recommended).
 *
 * Panel id scheme: client findings get t2..tN+1 (Overview is t1).
 */
/**
 * Wave-6 R2.5: Render the per-finding sampling-representativeness proof. Shown
 * BELOW the why-chain. WARN-only — a "low" coverageConfidence surfaces a caveat
 * banner but never blocks. Returns "" when the finding carries no coverageProof.
 *
 * Renders: a confidence headline (value + level pill), the 4-dimension coverage
 * table (latency · score · temporal · tool-trajectory), and a population-vs-sample
 * bias row (mean-badness proof). The colour cue derives from `level` only.
 *
 * W12-13 (OP-4): when the per-finding proof was NOT computed (sampler did not
 * attach `coverageProof`), render an EXPLICIT "representativeness not computed"
 * marker rather than a blank slot — so the absence is legible, not silent.
 */
export function renderCoverageProof(f: Finding): string {
  const cp = f.coverageProof;
  if (!cp) {
    return `<div class="coverage-proof coverage-proof-absent">
  <h3>Sampling coverage — representativeness proof <span class="badge b-info">NOT COMPUTED</span></h3>
  <p class="sub">Per-finding representativeness was not computed for this finding (no per-finding sample proof attached). The run-level sampling methodology still applies; see the Methodology tab.</p>
</div>`;
  }

  const levelPill =
    cp.level === "high"
      ? `<span class="badge b-info" style="background:var(--g,#43c39a);">HIGH</span>`
      : cp.level === "medium"
      ? `<span class="badge b-med">MEDIUM</span>`
      : `<span class="badge b-crit">LOW</span>`;

  const lowBanner =
    cp.level === "low"
      ? `<div class="warn">⚠ <strong>Low sampling coverage (${escapeHtml(cp.coverageConfidence.toFixed(1))}%).</strong> This finding's evidence may under-represent the population. Non-blocking — re-run with a wider sample or pass <code>--accept-low-confidence</code> to acknowledge. (R2.5)</div>`
      : "";

  const dimRows = cp.dimensions
    .map(
      (d) =>
        `<tr><td>${escapeHtml(d.dimension)}</td><td>${d.coveredBuckets} / ${d.populationBuckets}</td><td>${escapeHtml(d.coveragePct.toFixed(1))}%</td></tr>`
    )
    .join("\n      ");

  const p = cp.population;
  const biasRow = `<p class="sub">Population bias proof — sampled <strong>${p.sampleSize}</strong> of <strong>${p.populationSize}</strong> traces (${escapeHtml((p.sampleFraction * 100).toFixed(1))}%). Mean-badness population <code>${escapeHtml(p.populationMeanBadness.toFixed(4))}</code> vs sample <code>${escapeHtml(p.sampleMeanBadness.toFixed(4))}</code>.</p>`;

  return `<div class="coverage-proof">
  <h3>Sampling coverage — representativeness proof ${levelPill} <code>${escapeHtml(cp.coverageConfidence.toFixed(1))}%</code></h3>
  ${lowBanner}
  <table>
    <thead><tr><th>Dimension</th><th>Buckets covered</th><th>Coverage</th></tr></thead>
    <tbody>
      ${dimRows}
    </tbody>
  </table>
  ${biasRow}
</div>`;
}

/**
 * EV-1 (Wave-15): render a cited trace as a narration line rather than a bare
 * pointer. Shape:  trace `<id>` — <whatHappened>  with the optional `example`
 * appended as a quoted excerpt («…»). Block-0 (trace.ts) guarantees
 * `whatHappened` on every FailureOrigin / WhyChainEntry, but we degrade
 * gracefully if it is absent (e.g. legacy findings): fall back to the `evidence`
 * pointer alone so the panel never renders an empty narration.
 *
 * `traceId` is the cited trace for this slice (failureOrigin → referenceIds /
 * sourceTraceIds[0]; whyChain[] → the evidence pointer already carries it). When
 * no trace id is known the "trace `<id>` —" prefix is omitted, not faked.
 *
 * escapeHtml discipline (no raw interpolation) — every dynamic field is escaped.
 */
function renderTraceNarration(
  whatHappened: string | undefined,
  evidence: string,
  example: string | undefined,
  traceId?: string,
): string {
  const narration =
    whatHappened && whatHappened.trim().length > 0
      ? escapeHtml(whatHappened)
      : escapeHtml(evidence);
  const prefix =
    traceId && traceId.trim().length > 0
      ? `trace <code>${escapeHtml(traceId)}</code> — `
      : "";
  const excerpt =
    example && example.trim().length > 0
      ? ` <q class="ev-example">«${escapeHtml(example)}»</q>`
      : "";
  return `${prefix}${narration}${excerpt}`;
}

export function renderFindingPanel(f: Finding, panelIdx: number): string {
  const panelId = `t${panelIdx + 2}`;
  const sev = severityBadgeClass(f.severity, f.failureOrigin.confidence);
  const sevLabel = sev === "crit" ? "CRITICAL" : sev === "high" ? "HIGH" : sev === "med" ? "MEDIUM" : "RULE-OUT";

  const title = escapeHtml(f.title ?? f.actionable.slice(0, 90));
  const sub = f.subDesc ? `<p class="sub">${escapeHtml(f.subDesc)}</p>` : "";
  const worstCase = f.worstCaseCallout ? `<div class="crit"><strong>Worst:</strong> ${f.worstCaseCallout}</div>` : "";

  // Taxonomy chips (WHAT/WHY/WHERE + apply + confidence).
  const applyLabel = f.applyLabel ?? "";
  const taxonomy = `<div class="taxonomy">
    <span class="tax-chip"><strong>WHAT</strong>: ${escapeHtml(f.failureOrigin.what)}</span>
    <span class="tax-chip"><strong>WHY</strong>: ${escapeHtml(f.failureOrigin.why)}</span>
    <span class="tax-chip"><strong>WHERE</strong>: ${escapeHtml(f.failureOrigin.where)}</span>
    ${applyLabel ? `<span class="tax-chip"><strong>APPLY</strong>: ${escapeHtml(applyLabel)}</span>` : ""}
    <span class="tax-chip"><strong>Confidence</strong>: ${escapeHtml(f.failureOrigin.confidence)}</span>
  </div>`;

  // Problem prose — PRIMARY block (W18-problem): ALWAYS rendered, at the TOP of the
  // panel (before Evidence / why-chain / remedies), from the descriptive `f.problem`
  // statement. The fallback to the action-biased `f.actionable` is KILLED: if `problem`
  // is somehow absent we emit a LOUD placeholder rather than silently showing a todo.
  const problemBody =
    f.problem && f.problem.trim().length > 0
      ? f.problem
      : `<strong class="problem-missing">PROBLEM STATEMENT MISSING</strong>`;
  const problem = `<h3>Problem</h3>
  <div class="f-desc">${problemBody}</div>`;

  // PRD-CC-04: Feedback block between Problem and Evidence (D5).
  // L1: raw feedbackSources (or legacy userFeedback promotion)
  const feedbackBlock = renderFeedbackBlock(f);
  // W9-F L2: translated feedback (raw symptom → component-level RCA target)
  const translatedFeedbackBlock = renderTranslatedFeedbackBlock(f);

  // Evidence. EV-1: when no pre-rendered evidenceHtml is supplied, narrate the
  // cited trace ("trace <id> — <whatHappened> «example»") instead of a bare pointer.
  const citedTraceId = f.referenceIds?.traceId ?? f.sourceTraceIds[0];
  const evidence = `<h3>Evidence</h3>
  ${
    f.evidenceHtml
      ? f.evidenceHtml
      : `<p class="ev-narration">${renderTraceNarration(
          f.failureOrigin.whatHappened,
          f.failureOrigin.evidence,
          f.failureOrigin.example,
          citedTraceId,
        )}</p>`
  }`;

  // Why-chain. EV-1: each step narrates what happened in the cited trace via
  // whatHappened (+ optional «example»); the evidence pointer is the trace id.
  const whyChainItems = f.whyChain
    .map(
      (w) =>
        `<li class="${w.isOrigin ? "origin" : ""}">${escapeHtml(w.why)}<em>${renderTraceNarration(
          w.whatHappened,
          w.evidence,
          w.example,
          w.evidence,
        )}</em></li>`
    )
    .join("\n    ");
  const whyChain = f.whyChain.length > 0
    ? `<h3>Why-chain</h3>
  <ol class="whychain">
    ${whyChainItems}
  </ol>`
    : "";

  // R2.5: sampling-representativeness proof — rendered directly below the why-chain.
  const coverageProof = renderCoverageProof(f);

  // Assumptions block.
  const assumptions = renderAssumptionsBlock(f);

  // Remedies — pass finding ref to renderRemedyCard for hidden payload scripts (CC-08).
  const remedies = f.remedies.length > 0
    ? `<h3>Remedies</h3>
  ${f.remedies.map((r) => renderRemedyCard(r, f.findingId, f)).join("\n  ")}`
    : "";

  // W18-problem: Problem is the PRIMARY content block of the finding — rendered at the
  // TOP of the finding body, BEFORE feedback / Evidence / why-chain / remedies. It sits
  // immediately after the taxonomy chip-strip (head matter: title + sub + worstCase
  // callout + WHAT/WHY/WHERE chips). Keeping Problem adjacent-after the taxonomy anchor
  // also satisfies the finalize-gate `finding-panel` row, which scans forward from
  // `<div class="taxonomy">` for the required "Problem" marker.
  return `
<section class="panel" id="${panelId}">
  <h2><span class="badge b-${sev}">${sevLabel}</span> ${escapeHtml(f.findingId)} — ${title}</h2>
  ${sub}
  ${worstCase}
  ${taxonomy}
  ${problem}
  ${feedbackBlock}
  ${translatedFeedbackBlock}
  ${evidence}
  ${whyChain}
  ${coverageProof}
  ${assumptions}
  ${remedies}
</section>`;
}

// ── renderMetaReportPanels (SD cluster-grouped panels) ───────────────────────

/**
 * SD self-diag: render cluster panels — one panel per failureOrigin.what cluster.
 * Dedup findings within a cluster by (traceId, what+why+where). Each finding inside
 * the cluster renders the same gold-standard depth (taxonomy + evidence + assumptions
 * + remedies) as the per-finding client panels.
 */
function renderMetaReportPanels(findings: Finding[]): string {
  const clusters = clusterFindings(findings);
  let html = "";
  let clusterIdx = 0;
  for (const [what, group] of clusters) {
    const panelId = `tcluster-${clusterIdx}`;
    const deduped = dedupFindings(group);
    const subPanels = deduped
      .map((f) => {
        const sev = severityBadgeClass(f.severity, f.failureOrigin.confidence);
        // SD-6: parity with renderFindingPanel — the meta sub-panel must carry the
        // WHAT chip (it previously had only WHY/WHERE/Confidence) so the
        // finding-panel checklist row (require: taxonomy + WHAT + Problem) passes
        // on a meta-report WITHOUT a checklist exemption.
        const taxonomy = `<div class="taxonomy">
        <span class="tax-chip"><strong>WHAT</strong>: ${escapeHtml(f.failureOrigin.what)}</span>
        <span class="tax-chip"><strong>WHY</strong>: ${escapeHtml(f.failureOrigin.why)}</span>
        <span class="tax-chip"><strong>WHERE</strong>: ${escapeHtml(f.failureOrigin.where)}</span>
        <span class="tax-chip"><strong>Confidence</strong>: ${escapeHtml(f.failureOrigin.confidence)}</span>
      </div>`;
        // SD-6 + W18-problem: Problem block parity. renderFindingPanel emits an
        // <h3>Problem</h3> PRIMARY block from the descriptive `f.problem` statement with
        // NO actionable fallback. Mirror it here: render ALWAYS from `f.problem`; if
        // absent, emit the same LOUD placeholder rather than silently showing a todo.
        const metaProblemBody =
          f.problem && f.problem.trim().length > 0
            ? f.problem
            : `<strong class="problem-missing">PROBLEM STATEMENT MISSING</strong>`;
        const problem = `<h3 style="font-size:13px;margin:8px 0 4px;">Problem</h3>
      <div class="f-desc">${metaProblemBody}</div>`;
        // EV-1: narrate the cited trace ("trace <id> — <whatHappened> «example»")
        // in the SD cluster panel too, instead of a bare evidence pointer.
        const sdTraceId = f.referenceIds?.traceId ?? f.sourceTraceIds[0];
        // W18-problem: Problem is the PRIMARY content block of the meta sub-panel —
        // rendered at the TOP of the finding body, BEFORE the evidence narration /
        // remedies. It sits immediately after the taxonomy chip-strip (after the
        // entity-head + title line), keeping it adjacent-after the `<div class="taxonomy">`
        // anchor so the finalize-gate `finding-panel` row finds the "Problem" marker.
        return `<div class="entity" style="margin-bottom:14px;">
      <div class="entity-head"><div class="entity-name" style="font-size:14px;">${escapeHtml(f.findingId)}</div><span class="badge b-${sev}">${escapeHtml(f.failureOrigin.confidence)}</span></div>
      <div class="f-desc">${escapeHtml(f.title ?? f.actionable)}</div>
      ${taxonomy}
      ${problem}
      <p class="ev-narration" style="font-size:12px;color:var(--muted);">${renderTraceNarration(
        f.failureOrigin.whatHappened,
        f.failureOrigin.evidence,
        f.failureOrigin.example,
        sdTraceId,
      )}</p>
      ${renderAssumptionsBlock(f)}
      ${f.remedies.map((r) => renderRemedyCard(r, f.findingId, f)).join("\n      ")}
    </div>`;
      })
      .join("\n");

    html += `
<section class="panel" id="${panelId}">
  <h2>${escapeHtml(what)} <span style="font-size:13px;color:var(--dim);">(${deduped.length} finding${deduped.length !== 1 ? "s" : ""})</span></h2>
  ${subPanels}
</section>`;
    clusterIdx++;
  }
  return html;
}

/** Group findings by failureOrigin.what for the SD cluster layout. */
function clusterFindings(findings: Finding[]): Map<string, Finding[]> {
  const clusters = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.failureOrigin.what;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(f);
  }
  return clusters;
}

/** Dedup findings within a cluster by (traceId, what+why+where). */
function dedupFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const traceId = f.referenceIds?.traceId ?? f.sourceTraceIds[0] ?? "";
    const key = `${traceId}|${f.failureOrigin.what}+${f.failureOrigin.why}+${f.failureOrigin.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ── renderOverviewTab (gold-standard Overview) ───────────────────────────────

/**
 * Wave-5 R1.2: Render the Overview panel (t1).
 * Entity card + big-stat row + headline callout + signal census + scan funnel +
 * 24h heatmap + findings summary table + leverage callout.
 */
export function renderOverviewTab(input: RenderInput): string {
  // R2.6: when the operator gave a focus, this panel leads as 🎯 Guided (replacing
  // the neutral Overview survey). The focus drives the heading + a sub-line tooltip.
  const focus = input.runMeta?.parsedInvocation?.focus;
  const guided = typeof focus === "string" && focus.trim().length > 0;
  const defaultTitle = guided ? `🎯 Guided — ${escapeHtml(focus)}` : "① Overview";
  const title = input.overviewTitle ? escapeHtml(input.overviewTitle) : defaultTitle;
  const guidedSub = guided
    ? `<p class="sub" title="Guided by operator focus: ${escapeHtml(focus)}">Operator focus: <code>${escapeHtml(focus)}</code> — this report leads with the focused view (R2.6).</p>`
    : "";
  const sub = (input.overviewSub ? `<p class="sub">${escapeHtml(input.overviewSub)}</p>` : "") + guidedSub;

  const entityCard = input.diagnosedEntity ? renderEntityCard(input.diagnosedEntity) : "";
  const bigStat = input.bigStat ? renderBigStat(input.bigStat) : "";
  // W9-07: deep-read coverage tile sourced from RunMeta.deepRead (B1 telemetry)
  const deepReadTile = renderDeepReadTile(input.runMeta);
  const headline = input.overviewHeadline ? `<div class="crit"><strong>Headline:</strong> ${input.overviewHeadline}</div>` : "";

  // W17-E (R7): residual surfacing — when the top discovered signal was capped at
  // SECONDARY for lack of mechanical evidence and primary fell back to a cheap signal,
  // render the caveat BEFORE the census so the reader sees it ahead of the ★ PRIMARY
  // badge (never silently present the cheap fallback as the confident primary).
  const suspectedNote = renderSuspectedPrimaryNote(input.runMeta);

  // W11-01: annotate the census heading with primarySignal.why when available.
  const primaryWhy = input.runMeta?.primarySignal?.why;
  const censusSub = primaryWhy
    ? `<p style="font-size:12px;color:var(--muted);margin:2px 0 6px;">${escapeHtml(primaryWhy)}</p>`
    : "";
  const census = input.signalCensus
    ? `<h3>Signal census → primary selected by failure-validity gate + impact×prevalence + deep-read corroboration</h3>
  ${censusSub}
  ${renderSignalCensus(input.signalCensus)}`
    : "";

  const funnel = input.scanFunnel ? renderScanFunnel(input.scanFunnel) : "";
  // W11-02: pass runMeta so heatmap can annotate primary-signal cells.
  // F3 (UR-2): caption follows the active metric (default = avg latency).
  const heatMetricLabel = input.hourlyHeatmap?.metric?.label ?? "avg latency";
  const heatmap = input.hourlyHeatmap
    ? `<h3>24h timeline heatmap (colour = ${escapeHtml(heatMetricLabel)}, number = trace count)</h3>
  ${render24hHeatmap(input.hourlyHeatmap, input.runMeta)}`
    : "";

  const findingsTable = renderFindingsSummaryTable(input.findings);
  const leverage = input.overviewLeverage ? `<div class="alert"><strong>Highest-leverage:</strong> ${input.overviewLeverage}</div>` : "";

  // Overview is the active tab only when there is no internal Methodology tab.
  // D-8: a methodologyAudit is a meta report, so treat it as such here.
  const effectiveMeta = (input.isMetaReport ?? false) || (input.methodologyAudit ?? false);
  const isActive = (input.audience ?? "client") === "internal" && !effectiveMeta ? "" : " active";

  return `<section class="panel${isActive}" id="t1">
  <h2>${title}</h2>
  ${sub}
  ${entityCard}
  ${bigStat}
  ${deepReadTile}
  ${headline}
  ${suspectedNote}
  ${census}
  ${funnel}
  ${heatmap}
  ${findingsTable}
  ${leverage}
</section>`;
}

/**
 * W11-03: Render the scan-coverage funnel.
 * Supports 4 segments (total → tier0 → sample → deep-read) when `funnel.sample`
 * is present; falls back to 3-segment display for backward-compat.
 */
function renderScanFunnel(funnel: ScanFunnel): string {
  const seg = (cls: string, s: { value: string; label: string; detail: string }) =>
    `<div class="seg ${cls}"><div class="fv">${escapeHtml(s.value)}</div><div class="fl">${escapeHtml(s.label)}</div><div class="fp">${escapeHtml(s.detail)}</div></div>`;
  const sampleSeg = funnel.sample ? `\n    ${seg("s-sample", funnel.sample)}` : "";
  return `<h3>Scan coverage</h3>
  <div class="funnel">
    ${seg("s-total", funnel.total)}
    ${seg("s-code", funnel.code)}${sampleSeg}
    ${seg("s-llm", funnel.llm)}
  </div>`;
}

/** Render the findings summary table on the Overview tab. */
function renderFindingsSummaryTable(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const rows = findings
    .map((f) => {
      const sev = severityBadgeClass(f.severity, f.failureOrigin.confidence);
      const sevLabel = sev === "crit" ? "CRIT" : sev === "high" ? "HIGH" : sev === "med" ? "MED" : "RULE-OUT";
      const applyLabel = f.applyLabel ?? "";
      const applyPill = applyLabel
        ? `<span class="apply-pill ${applyPillClass(applyLabel)}">${escapeHtml(applyLabel)}</span>`
        : "";
      const oneLiner = f.subDesc ?? f.title ?? f.actionable.slice(0, 80);
      return `<tr><td>${escapeHtml(f.findingId)}</td><td><span class="badge b-${sev}">${sevLabel}</span></td><td>${escapeHtml(f.failureOrigin.what)} / ${escapeHtml(f.failureOrigin.why)} / ${escapeHtml(f.failureOrigin.where)}</td><td>${applyPill}</td><td>${escapeHtml(oneLiner)}</td></tr>`;
    })
    .join("\n      ");
  return `<table>
    <thead><tr><th>ID</th><th>Severity</th><th>WHAT/WHY/WHERE</th><th>Apply</th><th>One-liner</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

// ── renderDecisionsTab (gold-standard Decisions) ─────────────────────────────

/**
 * PRD-CC-06: Render the Decisions panel — recommended bundle + general feedback +
 * live-preview textarea (D11). The live preview updates in real-time as remedies
 * are checked/unchecked and feedback is typed. The sticky global Copy button
 * (#copy-decisions) reads #lp-body.value and writes to clipboard.
 */
export function renderDecisionsTab(input: RenderInput): string {
  const bundle = input.decisionsBundle
    ? `<div class="alert"><strong>Recommended bundle:</strong> ${input.decisionsBundle}</div>`
    : "";

  // SD-06: self-diag subject header row in Decisions
  // D-8: a methodologyAudit is also a self-diag report.
  const subjectRow = input.isMetaReport || input.methodologyAudit
    ? `<div class="decisions-subject-row"><span class="r-block-label">Subject</span> skill source (skill maintainer mode — PR-022)</div>`
    : "";

  return `<section class="panel" id="tdecisions">
  <div class="decisions-cta-bar"><button id="copy-decisions" title="Copy the approved-remedies bundle as markdown for handoff">Copy decisions as markdown</button></div>
  <h2>⑦ Decisions — copy approvals</h2>
  <p class="sub">★ green = recommended (pre-checked). Apply-target tags show change-type per remedy.</p>
  ${subjectRow}
  ${bundle}
  <div class="gfeedback">
    <h4>General feedback (speech-to-text friendly)</h4>
    <textarea id="general-feedback" id="general-feedback-dr" placeholder="Voice-dump anything here — approve a remedy AND add conditions, reject with rationale, request a remedy not listed, scope overrides, questions, priorities… Folded into the Copy-decisions export verbatim."></textarea>
  </div>
  <div class="live-preview" id="live-preview">
    <div class="lp-head"><span class="lp-label">Live Preview — Master Plan markdown</span><span class="lp-meta" id="lp-meta">0 remedies · 0 chars</span></div>
    <textarea class="lp-body" id="lp-body" readonly placeholder="Check remedies above and type feedback — bundle assembles here live. Click the sticky Copy to Clipboard button at the bottom of the page to copy."></textarea>
  </div>
  <p>Each remedy also has its own notes box. The live preview above updates as you select remedies and type feedback.</p>
</section>`;
}

// ── renderLivePreviewScript (PRD-CC-07 — live preview + global Copy button) ───

/**
 * PRD-CC-07: Render the inline JS for the live preview + event wiring.
 * renderLivePreview() walks .remedy-cb:checked, prefers hidden payload-{id}
 * scripts over DOM extraction, appends .remedy-notes content (lines prefixed "> "),
 * appends general feedback, writes result to #lp-body and updates #lp-meta.
 * Wired to: .remedy-cb change, .remedy-notes input, #general-feedback input,
 * #general-feedback-dr input, DOMContentLoaded.
 * The #copy-decisions button reads #lp-body.value and writes to clipboard.
 */
export function renderLivePreviewScript(): string {
  return `<script>
(function(){
  function renderLivePreview(){
    var checked = Array.from(document.querySelectorAll('.remedy-cb:checked'));
    var lines = [];
    if (checked.length === 0) {
      document.getElementById('lp-body').value = '';
      document.getElementById('lp-meta').textContent = '0 remedies · 0 chars';
      return;
    }
    lines.push('# Approved Remedies (handoff)');
    lines.push('');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('');
    lines.push('---');
    lines.push('');
    checked.forEach(function(cb){
      var rid = (cb.dataset.id || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g,'-');
      var payloadEl = document.getElementById('payload-' + rid);
      if (payloadEl) {
        lines.push(payloadEl.textContent || '');
      } else {
        // DOM fallback
        var card = cb.closest('.remedy');
        if (!card) return;
        var fid = cb.dataset.finding || '?';
        var remedyId = cb.dataset.id || '?';
        var what = (card.querySelector('.remedy-what') || {textContent:''}).textContent.trim();
        lines.push('## ' + remedyId + ' (' + fid + ')');
        lines.push('**Remedy:** ' + what);
        lines.push('');
      }
      var note = card ? card.querySelector('.remedy-notes') : null;
      if (note && note.value.trim()) {
        note.value.trim().split(/\\r?\\n/).forEach(function(ln){ lines.push('> ' + ln); });
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    });
    var gf1 = document.getElementById('general-feedback');
    var gf2 = document.getElementById('general-feedback-dr');
    var gfVal = (gf1 && gf1.value.trim()) || (gf2 && gf2.value.trim()) || '';
    if (gfVal) {
      lines.push('## General feedback');
      lines.push('');
      lines.push(gfVal);
      lines.push('');
    }
    var text = lines.join('\\n');
    var lp = document.getElementById('lp-body');
    lp.value = text;
    document.getElementById('lp-meta').textContent = checked.length + ' remedies · ' + text.length + ' chars';
  }

  // Wire events
  function wireEvents(){
    document.querySelectorAll('.remedy-cb').forEach(function(cb){
      cb.addEventListener('change', renderLivePreview);
    });
    document.querySelectorAll('.remedy-notes').forEach(function(ta){
      ta.addEventListener('input', renderLivePreview);
    });
    var gf1 = document.getElementById('general-feedback');
    var gf2 = document.getElementById('general-feedback-dr');
    if (gf1) gf1.addEventListener('input', renderLivePreview);
    if (gf2) gf2.addEventListener('input', renderLivePreview);
    renderLivePreview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireEvents);
  } else {
    wireEvents();
  }

  // Override #copy-decisions to read from #lp-body (D11)
  function overrideCopyBtn(){
    var btn = document.getElementById('copy-decisions');
    if (!btn) return;
    // Remove old listeners by cloning
    var newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', function(){
      var lp = document.getElementById('lp-body');
      var text = lp ? lp.value : '';
      if (!text) { text = '# No remedies selected'; }
      var originalText = newBtn.textContent;
      navigator.clipboard.writeText(text).then(function(){
        newBtn.textContent = '✓ Copied';
        // Log to changelog if present
        var cl = document.getElementById('changelog-log');
        if (cl) {
          var row = document.createElement('tr');
          row.innerHTML = '<td>' + new Date().toLocaleTimeString() + '</td><td>Copied ' + text.length + ' chars to clipboard</td>';
          cl.prepend(row);
        }
        setTimeout(function(){ newBtn.textContent = originalText; }, 2200);
      }).catch(function(){
        window.prompt('Copy:', text);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', overrideCopyBtn);
  } else {
    overrideCopyBtn();
  }
})();
</script>`;
}

// ── renderFunnelHeatmap (legacy I-027 slot — backward compat) ────────────────

/**
 * I-027 backward-compat: the {{FUNNEL_HEATMAP_HTML}} slot. In the gold-standard
 * layout the funnel + heatmap live INSIDE the Overview tab, so this slot is
 * emitted empty unless a legacy template relies on it AND no Overview was built.
 * Returns "" for the gold-standard path (avoids double-render).
 */
export function renderFunnelHeatmap(): string {
  return "";
}

// ── sanitizeMermaid (F-SELF-011 — mermaid v10 compatibility) ─────────────────

/**
 * Sanitize orchestrator-authored mermaid before it lands in <div class="mermaid">.
 * Mermaid v10 lexer is strict: parens in participant aliases and raw HTML in Note
 * blocks cause silent render failure. This rewrites both into compatible forms.
 * Pure + deterministic. Emits a single console.warn listing what changed so the
 * author learns the constraints.
 */
export function sanitizeMermaid(src: string): { sanitized: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = src;

  // 1) Strip parens from participant alias lines: `participant X as Foo (bar)` → `participant X as Foo bar`
  out = out.replace(/^(\s*participant\s+\S+\s+as\s+)([^\n]+)$/gm, (_, prefix, alias) => {
    if (alias.includes("(") || alias.includes(")")) {
      const clean = alias.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
      rewrites.push(`participant alias "${alias.trim()}" → "${clean}"`);
      return prefix + clean;
    }
    return prefix + alias;
  });

  // 2) Split `<br/?>` inside Note over X,Y: lines into consecutive Note over lines.
  out = out.replace(/^(\s*Note\s+over\s+[^:]+:\s*)([^\n]+)$/gm, (_, prefix, body) => {
    if (!/<br\s*\/?>/i.test(body)) return prefix + body;
    const parts = body.split(/<br\s*\/?>/i).map((s: string) => s.trim()).filter(Boolean);
    rewrites.push(`<br/> in Note → ${parts.length} consecutive Note lines`);
    return parts.map((p: string) => `${prefix}${p}`).join("\n");
  });

  if (rewrites.length > 0) {
    console.warn(`[render] sanitizeMermaid rewrote ${rewrites.length} construct(s): ${rewrites.join("; ")}`);
  }
  return { sanitized: out, rewrites };
}

// ── renderMethodologyTab (gold-standard Methodology [INTERNAL]) ──────────────

/**
 * Wave-5 R1.2: Render the Methodology [INTERNAL] panel (t0).
 * Mermaid sequence diagram + graded decision log + signal census table.
 * NODE-STRIPPED for client audience (FU-INT-1).
 */
export function renderMethodologyTab(input: RenderInput): string {
  const mermaidRaw = input.mermaidSequence ?? input.runMeta?.mermaidTopology;
  // F-SELF-011: sanitize orchestrator-authored mermaid (parens in participant
  // aliases + raw <br/> in Notes) before embedding — mermaid v10 silently fails otherwise.
  const mermaid = mermaidRaw !== undefined ? sanitizeMermaid(mermaidRaw).sanitized : undefined;
  const sequenceHtml = mermaid
    ? `<h3>Sequence — orchestrator → scripts → analyzers</h3>
  <div class="mermaid">
${mermaid}
  </div>`
    : "";

  const decisionLogHtml = input.decisionLog && input.decisionLog.length > 0
    ? `<h3>Decision log (graded)</h3>
  <table>
    <thead><tr><th>Decision</th><th>What the skill did</th><th>Grade</th></tr></thead>
    <tbody>
      ${input.decisionLog
        .map((d) => `<tr><td>${escapeHtml(d.decision)}</td><td>${escapeHtml(d.what)}</td><td>${d.grade}</td></tr>`)
        .join("\n      ")}
    </tbody>
  </table>`
    : "";

  // W11-01/PR-049: annotate Methodology census heading with primarySignal rationale.
  const primarySig = input.runMeta?.primarySignal;
  const primarySigNote = primarySig
    ? `<p style="font-size:12px;color:var(--muted);margin:2px 0 6px;">
      Selected: <strong>${escapeHtml(primarySig.name)}</strong> — ${escapeHtml(primarySig.why)}
      · confidence: <em>${escapeHtml(primarySig.confidence)}</em>
      ${primarySig.ruledOut.length > 0 ? `· ruled out: ${primarySig.ruledOut.map((r) => escapeHtml(r)).join(", ")}` : ""}
    </p>`
    : "";
  // W17-E (R7): residual surfacing inside Methodology too — the floor cap is part of
  // the selection story, so the caveat sits with Step 1's census + selection cards.
  const suspectedNoteHtml = renderSuspectedPrimaryNote(input.runMeta);
  const censusHtml = input.signalCensus
    ? `<h3>Step 1 — Primary-signal selection (PR-049: failure-validity gate → impact×prevalence → deep-read)</h3>
  ${primarySigNote}
  ${suspectedNoteHtml}
  ${renderSignalCensus(input.signalCensus)}`
    : "";

  // R2.6/D2: Methodology Step 0 — verbatim operator invocation (rendered first).
  const step0Html = renderOperatorInvocationStep(input.runMeta);

  // F5 (defense-in-depth): on INTERNAL / META-audience reports, a widget whose data
  // was NOT threaded into runMeta renders a LOUD marker instead of vanishing silently
  // — so the next threading regression is visible, not invisible. CLIENT / PRODUCT
  // reports stay clean (these are internal-only nodes, node-stripped at publish).
  const isInternalAudience = (input.audience ?? "client") !== "client";
  const loudOrEmpty = (html: string, widget: string, threaded: boolean): string => {
    if (html.length > 0) return html;
    if (isInternalAudience && !threaded) {
      return `<div class="warn loud-missing-widget" data-widget="${escapeHtml(widget)}">⚠ ${escapeHtml(widget)} not threaded into runMeta — see orchestrator-protocol Step 8.5 (F4 widget-threading table).</div>`;
    }
    return html;
  };

  // R2.2: Methodology Step 1.5 — awareness-layer mini-sample + blind-spots.
  const awarenessThreaded =
    input.runMeta?.awarenessSample !== undefined ||
    (input.runMeta?.blindSpots !== undefined && input.runMeta.blindSpots.length > 0);
  // REQ-050: the empty-state must be HONEST. An absent awareness witness has TWO
  // distinct causes the generic "not threaded" marker conflates:
  //   (a) awareness genuinely NOT RUN / NOT APPLICABLE — the orchestrator recorded a
  //       skip/exemption decision (e.g. library priors exist, or the run shape makes
  //       the 5-trace mini-sample inapplicable). This is correct behaviour, not a bug.
  //   (b) awareness RAN but its witness was never threaded into runMeta — a real
  //       threading regression that the loud F5 marker rightly surfaces.
  // We distinguish them via runMeta.decisions: an awareness skip/not-applicable
  // decision is the (a) signal. INTERNAL audience only (the whole tab is stripped for
  // clients — we never force-render anything here for client reports).
  const awarenessSkip = findAwarenessSkipDecision(input.runMeta);
  let step15Html: string;
  if (awarenessThreaded) {
    // Case: awareness ran AND was threaded → render the real Step 1.5 content.
    step15Html = renderAwarenessStep(input.runMeta);
  } else if (awarenessSkip && isInternalAudience) {
    // Case (a): awareness genuinely not run / not applicable — HONEST placeholder
    // that surfaces the recorded reason, not a misleading "not threaded" marker.
    step15Html = renderAwarenessNotRun(awarenessSkip);
  } else {
    // Case (b): awareness absent with no skip decision → the loud F5 not-threaded
    // marker (INTERNAL only; "" for client — the tab is stripped anyway).
    step15Html = loudOrEmpty(
      renderAwarenessStep(input.runMeta),
      "awareness sample + blind-spots",
      awarenessThreaded
    );
  }

  // R2.4: three methodology widgets — tier pie, selection-rule cards, mermaid trace.
  const tierPieHtml = loudOrEmpty(
    renderTierPie(input.runMeta?.tierBreakdown),
    "tier-coverage pie (tierBreakdown)",
    input.runMeta?.tierBreakdown !== undefined
  );
  const selectionCardsHtml = renderSelectionRuleCards(input.runMeta?.selectionRules);
  const selectionTraceHtml = loudOrEmpty(
    renderSignalSelectionTrace(input.runMeta?.signalSelectionTrace),
    "signal-selection trace (signalSelectionTrace)",
    input.runMeta?.signalSelectionTrace !== undefined
  );

  // R2.1 (+D1): cap-exceeded banner + deep-read gate banner (rendered FIRST).
  const capBannerHtml = input.runMeta?.capBanner
    ? `<div class="crit"><strong>${escapeHtml(input.runMeta.capBanner)}</strong></div>`
    : "";
  const gate = input.runMeta?.deepReadGate;
  const gateBannerHtml = gate
    ? gate.verdict === "refuse"
      ? `<div class="crit"><strong>${escapeHtml(gate.reason)}</strong></div>`
      : gate.verdict === "proceed-with-priors"
      ? `<div class="warn">${escapeHtml(gate.reason)}</div>`
      : ""
    : "";

  return `<section class="panel active" id="t0">
  <div class="internal-banner">⚙ INTERNAL-ONLY — hidden in public/client release. Traces the topology of skill operations + sub-agent dispatch for this run.</div>
  <h2>⚙ Methodology — operation topology</h2>
  <p class="sub">How this diagnosis was produced: which orchestrator steps, scripts, and sub-agents ran, pulled from the run trajectory.</p>
  ${capBannerHtml}
  ${gateBannerHtml}
  ${step0Html}
  ${sequenceHtml}
  ${decisionLogHtml}
  ${censusHtml}
  ${step15Html}
  ${selectionCardsHtml}
  ${tierPieHtml}
  ${selectionTraceHtml}
</section>`;
}

/**
 * Wave-6 R2.6/D2: Render Methodology Step 0 — the VERBATIM operator invocation
 * brief that initiated the run, plus the parsed shape (agent / timeWindow / focus /
 * residual) when present. The verbatim is shown EXACTLY as the operator typed it
 * (D2 — never reworded/dropped). Returns "" when no invocation was recorded.
 */
export function renderOperatorInvocationStep(runMeta?: RunMeta): string {
  const verbatim = runMeta?.operatorInvocation;
  const parsed = runMeta?.parsedInvocation;
  if (!verbatim && !parsed) return "";

  const verbatimHtml = verbatim
    ? `<p class="sub">Operator invocation (verbatim):</p>
  <pre>${escapeHtml(verbatim)}</pre>`
    : "";

  const parsedHtml = parsed
    ? `<table>
    <thead><tr><th>Parsed field</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>agent</td><td>${parsed.agent ? `<code>${escapeHtml(parsed.agent)}</code>` : "<em>—</em>"}</td></tr>
      <tr><td>timeWindow</td><td>${parsed.timeWindow ? `<code>${escapeHtml(parsed.timeWindow)}</code>` : "<em>—</em>"}</td></tr>
      <tr><td>focus</td><td>${parsed.focus ? `<code>${escapeHtml(parsed.focus)}</code>` : "<em>neutral survey</em>"}</td></tr>
      <tr><td>residual</td><td>${parsed.residual ? escapeHtml(parsed.residual) : "<em>—</em>"}</td></tr>
    </tbody>
  </table>`
    : "";

  return `<h3>Step 0 — Operator invocation</h3>
  ${verbatimHtml}
  ${parsedHtml}`;
}

// ── Wave-6 R2.4 — Methodology widgets (SVG pie · selection cards · mermaid trace) ──

/** Deterministic polar→cartesian for SVG arc math. cx/cy/r in px, angle in deg. */
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: round3(cx + r * Math.cos(a)), y: round3(cy + r * Math.sin(a)) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Default tier colours (cycled deterministically when a tier omits `color`). */
const TIER_PIE_COLORS = ["#45b8cc", "#7E47D7", "#e8a64d", "#43c39a", "#b794f4", "#8a8698"];

/**
 * Wave-6 R2.4: SVG arc-path tier-coverage pie. Reads runMeta.tierBreakdown.
 * Handles the 0-finding case (renders an empty ring + "no findings" note) and the
 * single-tier case (full circle). Deterministic: arc math is pure, colours cycle
 * by index. Returns "" when tierBreakdown is absent.
 */
export function renderTierPie(tierBreakdown?: RunMeta["tierBreakdown"]): string {
  if (!tierBreakdown) return "";

  const total = tierBreakdown.reduce((sum, t) => sum + Math.max(0, t.count), 0);
  const cx = 80;
  const cy = 80;
  const r = 70;

  // 0-finding case: render an empty ring with a note (handle 0-tiers, plan §4 R2.4).
  if (total === 0) {
    return `<h3>Tier coverage</h3>
  <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="Tier coverage — no findings">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border,#444)" stroke-width="2"/>
  </svg>
  <p class="sub">No findings across any tier — empty coverage ring.</p>`;
  }

  // Build pie slices. A single tier with all the findings → full circle.
  const slices: string[] = [];
  const legend: string[] = [];
  let cursor = 0;
  tierBreakdown.forEach((t, i) => {
    const count = Math.max(0, t.count);
    const color = t.color ?? TIER_PIE_COLORS[i % TIER_PIE_COLORS.length];
    const frac = count / total;
    legend.push(
      `<span class="pie-leg"><span class="pie-sw" style="background:${escapeHtml(color)}"></span>${escapeHtml(t.tier)} (${count})</span>`
    );
    if (count === 0) return; // 0-finding tier contributes legend only, no slice.

    const startAngle = cursor * 360;
    const endAngle = (cursor + frac) * 360;
    cursor += frac;

    if (frac >= 1) {
      // Full circle — a path arc cannot draw 360°, use a circle element.
      slices.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${escapeHtml(color)}"/>`);
      return;
    }
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
    slices.push(
      `<path d="M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z" fill="${escapeHtml(color)}"/>`
    );
  });

  return `<h3>Tier coverage</h3>
  <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="Tier coverage pie">
    ${slices.join("\n    ")}
  </svg>
  <div class="pie-legend">${legend.join(" ")}</div>`;
}

/**
 * W11-09 (Wave-6 R2.4 + PR-049): per-signal selection-rule cards.
 * Each card shows the signal's score + verdict. Signals discovered by the R2.2
 * awareness layer get a "discovered" badge.
 *
 * PR-049 5-step detect+select process (rendered as a sub-header when no cards present):
 *   1. Enumerate all signals from Tier-0 static scan (PR-001).
 *   2. Failure-validity gate — drop benign observability artifacts.
 *   3. Impact×prevalence scoring (impact = $/latency/correctness harm × trace rate).
 *   4. Deep-read corroboration — findings[0].failureOrigin.what confirms or overrides.
 *   5. Emit ONE RunMeta.primarySignal driving census·heatmap·funnel.
 *
 * Reads runMeta.selectionRules. Returns the 5-step methodology note when absent/empty.
 */
/**
 * W17-E (R1 evidence-floor visibility): derive an explicit floor-outcome badge from a
 * selection-rule verdict string. The enricher (buildSelectionMeta) encodes the floor
 * outcome in the verdict prose; this lifts it into a visible badge so a reader can see
 * — without parsing prose — which discovered signals were CORROBORATED (admitted to
 * PRIMARY by the evidence floor) vs CAPPED at SECONDARY for lack of mechanical evidence.
 *
 *   - "★ PRIMARY (… mechanically corroborated)"     → corroborated-PRIMARY badge
 *   - "secondary (discovered, corroborated)"          → corroborated badge
 *   - "… unconfirmed (no mechanical evidence …)"      → capped-at-SECONDARY badge
 *   - anything else (cheap-signal cards / ruled-out)  → no floor badge ("")
 *
 * Deterministic, case-insensitive substring classification. Pure string.
 */
export function floorVerdictBadge(verdict: string): string {
  const v = verdict.toLowerCase();
  // Unevidenced discovered signal: the floor capped it at SECONDARY. Most specific —
  // check first so a "corroborated" substring elsewhere can't mask it.
  if (v.includes("unconfirmed") || v.includes("no mechanical evidence")) {
    return `<span class="badge b-med floor-capped">⚠ capped at SECONDARY — unevidenced (R1 floor)</span>`;
  }
  // Discovered signal that passed the floor (corroborated).
  if (v.includes("corroborated")) {
    return `<span class="badge b-crit floor-corroborated">✓ evidence-floor: corroborated</span>`;
  }
  return "";
}

export function renderSelectionRuleCards(rules?: RunMeta["selectionRules"]): string {
  const methodologyNote = `<div style="font-size:12px;color:var(--muted);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px 12px;margin:4px 0;">
  <strong>PR-049 signal detect+select process (5 steps):</strong><br>
  1. Enumerate all Tier-0 signals (PR-001 static scan).<br>
  2. Failure-validity gate — admit only mechanical signals that map to a user-visible failure WHAT; rule out benign observability artifacts (e.g. missing-metadata).<br>
  3. Impact×prevalence scoring: impact = $/latency/correctness harm × trace prevalence rate.<br>
  4. Deep-read corroboration — LLM findings[0].failureOrigin.what confirms or overrides rank.<br>
  5. Emit ONE <code>runMeta.primarySignal</code> driving census badge · heatmap · funnel.
</div>`;

  if (!rules || rules.length === 0) return methodologyNote;
  const cards = rules
    .map((rule) => {
      const badge = rule.discoveredByAwareness
        ? `<span class="badge b-info">★ discovered (awareness)</span>`
        : "";
      // W17-E (R1 floor visibility): make the evidence-floor outcome an explicit badge,
      // not text buried in the verdict prose. Derived deterministically from the verdict
      // the enricher emitted (build-render-input.ts buildSelectionMeta): a corroborated
      // discovered winner reads "★ PRIMARY (… corroborated)"; an unevidenced discovered
      // signal reads "… unconfirmed (no mechanical evidence …)" and is capped-at-SECONDARY.
      const floorBadge = floorVerdictBadge(rule.verdict);
      // D3: dataset-candidate detail rows — each is rendered ONLY when the enricher
      // derived it from the linked finding (omitted gracefully otherwise — never faked).
      const detail = (label: string, value: string | undefined, cls = ""): string =>
        value
          ? `<div class="sel-detail${cls ? " " + cls : ""}"><span class="sel-k">${escapeHtml(label)}</span>${escapeHtml(value)}</div>`
          : "";
      const findingLink = rule.linkedFindingId
        ? `<div class="sel-detail"><span class="sel-k">finding</span><code>${escapeHtml(rule.linkedFindingId)}</code></div>`
        : "";
      const candidateDetails = [
        detail("scenario", rule.scenario),
        detail("use-case / edge-case", rule.useCase),
        detail("why it failed", rule.whyFailed),
        detail("why high-value candidate", rule.whyHighValue, "sel-value"),
        detail("would prevent regression", rule.prevents, "sel-prevents"),
        findingLink,
      ].join("");
      return `<div class="sel-card">
    <div class="sel-card-head"><strong>${escapeHtml(rule.signal)}</strong> ${badge}${floorBadge}</div>
    <div class="sel-card-body">
      <span class="sel-k">score</span> <code>${escapeHtml(rule.score)}</code>
      <span class="sel-k">verdict</span> ${escapeHtml(rule.verdict)}
    </div>
    ${candidateDetails}
  </div>`;
    })
    .join("\n  ");
  return `<h3>Selection rules — per-signal score + verdict (PR-049)</h3>
  ${methodologyNote}
  <div class="sel-cards">
  ${cards}
  </div>`;
}

/**
 * W17-E (R7 — residual surfacing): render the "suspected primary — unconfirmed"
 * note from runMeta.suspectedPrimaryUnconfirmed.
 *
 * WHY: when the top DISCOVERED signal is capped at SECONDARY for lack of mechanical
 * evidence (R1 evidence floor) and primary falls back to a CHEAP signal, the report
 * must NOT silently present the cheap fallback as the confident primary. This note
 * makes the residual visible: it names the suspected signal, shows its HONEST sampled
 * prevalence ("seen in k/n sampled" — never a fabricated corpus rate), and states WHY
 * it could not be confirmed (the floor reason). Rendered as a `.warn` callout so it
 * reads as a caveat, not a finding.
 *
 * Returns "" when the field is absent — i.e. the discovered signal PASSED the floor
 * (nothing unconfirmed) or none was discovered. Deterministic; pure string.
 */
export function renderSuspectedPrimaryNote(runMeta?: RunMeta): string {
  const sp = runMeta?.suspectedPrimaryUnconfirmed;
  if (!sp) return "";
  return `<div class="warn suspected-primary-unconfirmed" data-suspected="${escapeHtml(sp.signal)}">
    <strong>⚠ Suspected primary — unconfirmed:</strong>
    <code>${escapeHtml(sp.signal)}</code> was the highest-impact <em>discovered</em> signal
    (seen in ${sp.seenCount}/${sp.sampledCount} sampled) but is <strong>capped at SECONDARY</strong>
    — ${escapeHtml(sp.reason)}. The primary shown below is a cheaper fallback signal, NOT a
    confident root cause. Treat the suspected signal as a lead requiring mechanical corroboration.
  </div>`;
}

/**
 * Wave-6 R2.4: signal-selection trace — a mermaid decision tree reading
 * runMeta.signalSelectionTrace. Renders with PARTIAL data (tolerates a short or
 * empty trace by falling back to a stub diagram). Returns "" when absent.
 */
export function renderSignalSelectionTrace(trace?: string): string {
  if (trace === undefined) return "";
  const body = trace.trim().length > 0
    ? trace
    : "graph TD\n  A[insufficient trace data] --> B[partial render]";
  return `<h3>Signal-selection trace</h3>
  <div class="mermaid">
${body}
  </div>`;
}

/**
 * REQ-050: Detect an awareness "not run / not applicable" decision in the run's
 * decision log. The orchestrator records a skip/exemption decision (e.g. library
 * priors exist, or the run shape makes the 5-trace mini-sample inapplicable) in
 * runMeta.decisions. Its presence is the signal that an ABSENT awareness witness is
 * deliberate (case a) rather than a threading regression (case b).
 *
 * Match heuristic: a decision whose step marks an exemption/skip (or whose choice
 * text names a skip) AND whose text mentions the awareness layer. Returns the
 * matched decision (for its rationale) or undefined.
 */
export function findAwarenessSkipDecision(
  runMeta?: RunMeta
): { step: string; choice: string; rationale: string } | undefined {
  const decisions = runMeta?.decisions;
  if (!decisions || decisions.length === 0) return undefined;
  return decisions.find((d) => {
    const haystack = `${d.step} ${d.choice} ${d.rationale}`.toLowerCase();
    const mentionsAwareness = haystack.includes("awareness");
    const isSkip =
      haystack.includes("skip") ||
      haystack.includes("exempt") ||
      haystack.includes("not applicable") ||
      haystack.includes("not run") ||
      haystack.includes("n/a");
    return mentionsAwareness && isSkip;
  });
}

/**
 * REQ-050: Render the HONEST "awareness not run / not applicable" empty-state for the
 * Methodology Step 1.5 slot. Surfaces the recorded rationale so the reader can tell
 * this from the (b) "ran-but-not-threaded" regression marker. INTERNAL-audience only
 * (the caller guards on audience; the whole Methodology tab is stripped for clients).
 */
export function renderAwarenessNotRun(decision: {
  step: string;
  choice: string;
  rationale: string;
}): string {
  return `<h3>Step 1.5 — Awareness layer (measurement-gap check)</h3>
  <div class="warn awareness-not-run" data-awareness="not-run">⊘ Awareness layer not run / not applicable for this run — this is a recorded decision, not a missing widget. Reason: ${escapeHtml(decision.rationale || decision.choice)}.</div>`;
}

/**
 * Wave-6 R2.2: Render Methodology Step 1.5 — the awareness-layer mini-sample +
 * blind-spots table. When the awareness layer SKIPPED (library priors exist), a
 * placeholder is rendered instead. Returns "" when no awareness data is present
 * at all (older runs / backward-compat).
 */
export function renderAwarenessStep(runMeta?: RunMeta): string {
  const sample = runMeta?.awarenessSample;
  const blindSpots = runMeta?.blindSpots;

  // No awareness data at all → omit the step (backward-compat).
  if (!sample && (!blindSpots || blindSpots.length === 0)) return "";

  // SKIP placeholder: a blindSpots table with the "(all)" skipped marker and no sample.
  if (!sample && blindSpots && blindSpots.length > 0 && blindSpots.every((b) => b.checkedBy === "—")) {
    return `<h3>Step 1.5 — Awareness layer (measurement-gap check)</h3>
  <p class="sub">Library priors exist; awareness layer skipped. The discovered-signal priors from prior runs are reused instead of a fresh 5-trace mini-sample. (R2.2)</p>`;
  }

  // SD-7: guard the .map at the call site. The documented shape is
  // `{ traces: string[]; findings; firedAt }`, but a malformed runtime witness
  // (e.g. traces threaded as undefined/null by a producer regression) would crash
  // the whole render with `sample.traces.map is not a function`. Render a SKIP
  // marker for the trace list instead of throwing — the rest of Step 1.5 (firedAt,
  // blind-spots) still renders.
  const sampleHtml = sample
    ? `<p class="sub">A 5-trace LLM mini-sample fired BEFORE primary-signal selection to surface signals Tier-0 cannot MEASURE (the measurement-layer fix). Traces: ${
        Array.isArray(sample.traces)
          ? sample.traces.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ")
          : `<em>— trace list unavailable (malformed awareness witness)</em>`
      }. Fired at ${escapeHtml(sample.firedAt)}.</p>`
    : "";

  const blindSpotsTable = blindSpots && blindSpots.length > 0
    ? `<table>
    <thead><tr><th>Signal</th><th>Measurable?</th><th>Checked by</th><th>Result</th></tr></thead>
    <tbody>
      ${blindSpots
        .map(
          (b) =>
            `<tr><td>${escapeHtml(b.signal)}</td><td>${escapeHtml(b.measurable)}</td><td>${escapeHtml(b.checkedBy)}</td><td>${escapeHtml(b.result)}</td></tr>`
        )
        .join("\n      ")}
    </tbody>
  </table>`
    : "";

  return `<h3>Step 1.5 — Awareness layer (measurement-gap check)</h3>
  ${sampleHtml}
  ${blindSpotsTable}`;
}

// ── renderTrajectoryTab (legacy I-041 — retained, no longer in default nav) ──

/**
 * I-041 (retained): Session-trajectory tab. The gold-standard nav does not
 * surface a separate Trajectory tab (its sequence lives in Methodology), but the
 * function is retained for callers/tests that render it directly.
 */
export function renderTrajectoryTab(input: RenderInput): string {
  const traj = input.sessionTrajectory;
  const dagHtml = traj?.mermaidDag
    ? `<h3>Session Flow (DAG)</h3>
    <div class="mermaid">${escapeHtml(traj.mermaidDag)}</div>`
    : `<h3>Session Flow (DAG)</h3><p class="sub">No trajectory DAG available.</p>`;
  const timelineHtml =
    traj?.steps && traj.steps.length > 0
      ? `<h3 style="margin-top:18px;">Timeline</h3>
      <div style="font-size:12px;">
        ${traj.steps
          .map(
            (s) =>
              `<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="min-width:28px;font-family:var(--fm);color:var(--dim);font-size:11px;">${s.step}</span>
            <span style="min-width:80px;color:var(--p);font-family:var(--fm);font-size:11px;font-weight:600;">${escapeHtml(s.type)}</span>
            <span style="flex:1;color:var(--muted);">${escapeHtml(s.content.slice(0, 140))}${s.content.length > 140 ? "…" : ""}</span>
            ${s.timestamp ? `<span style="color:var(--dim);font-size:11px;font-family:var(--fm);white-space:nowrap;">${escapeHtml(s.timestamp)}</span>` : ""}
          </div>`
          )
          .join("\n")}
      </div>`
      : `<p class="sub" style="margin-top:12px;">No step-by-step timeline available.</p>`;
  return `
<section class="panel" id="ttraj">
  <h2>Session Trajectory <span class="badge b-info">INTERNAL</span></h2>
  ${dagHtml}
  ${timelineHtml}
</section>`;
}

// ── renderDiscoveredChecks ────────────────────────────────────────────────────

function renderDiscoveredChecks(checks: DiscoveredCheck[]): string {
  return `
<div class="discovered-checks">
  ${checks
    .map(
      (c) => `
  <div class="check" id="${escapeHtml(c.checkId)}">
    <strong>${escapeHtml(c.name)}</strong>
    <p>${escapeHtml(c.description)}</p>
    <small>Affects: ${c.affectedTraceIds.map((id) => escapeHtml(id)).join(", ")}</small>
  </div>`
    )
    .join("\n")}
</div>`;
}

// ── Wave-4: Contract-aware rendering (opt-in structured-report mode) ──────────

/**
 * Detects whether a target declares a self-diagnosis contract.
 * Looks for <target-root>/self-diagnosis-contract.yaml.
 * Returns parsed + validated contract OR null if absent.
 *
 * Capability: opt-in structured-report mode. Targets that don't declare
 * a contract get open-ended reports unchanged (regression invariant).
 */
export async function loadTargetContract(
  targetRoot: string
): Promise<SelfDiagnosisContract | null> {
  const contractPath = join(targetRoot, "self-diagnosis-contract.yaml");
  if (!existsSync(contractPath)) return null;
  const raw = readFileSync(contractPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  if (!Value.Check(SelfDiagnosisContractSchema, parsed)) {
    const errors = [...Value.Errors(SelfDiagnosisContractSchema, parsed)];
    const detail = errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`Invalid self-diagnosis-contract.yaml at ${contractPath}: ${detail}`);
  }
  return parsed as SelfDiagnosisContract;
}

/**
 * Open-ended report path (existing behaviour — unchanged).
 * Targets without a self-diagnosis-contract.yaml always use this path.
 * Regression invariant: output must be identical to renderReport for same inputs.
 */
export function renderOpenEndedReport(template: string, input: RenderInput): string {
  return renderReport(template, input);
}

// ── Structured render input ──────────────────────────────────────────────────

export interface StructuredRenderInput extends RenderInput {
  /** Parsed contract from the target's self-diagnosis-contract.yaml */
  contract: SelfDiagnosisContract;
}

/**
 * Structured report path (Wave-4 new).
 * When a target declares a self-diagnosis-contract.yaml, diagnostics emits a
 * 10-category structured report against the declared success criteria.
 * Findings with `criterion` populated are matched to their category section.
 * Criteria with no matching finding default to "pending".
 */
export function renderStructuredReport(input: StructuredRenderInput): string {
  const { contract, findings } = input;

  // Build a lookup: criterion id → finding (for criterion-aware findings only)
  const criterionFindingMap = new Map<string, Finding>();
  for (const f of findings) {
    if (f.criterion) {
      criterionFindingMap.set(f.criterion.id, f);
    }
  }

  // Status pill rendering
  const statusPill = (status: string): string => {
    const colorMap: Record<string, string> = {
      pass: "var(--g)",
      fail: "var(--r)",
      "not-applicable": "var(--dim)",
      pending: "var(--y)",
    };
    const color = colorMap[status] ?? "var(--muted)";
    return `<span style="font-family:var(--fm);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:2px 8px;border-radius:4px;background:${color};color:var(--bg);">${escapeHtml(status)}</span>`;
  };

  // Build 10-category sections
  const categorySections = contract.success_criteria
    .map((entry) => {
      const criteriaRows = entry.criteria
        .map((criterion) => {
          const matchedFinding = criterionFindingMap.get(criterion.id);
          const status = matchedFinding?.criterion?.status ?? "pending";
          const evidenceRef = matchedFinding?.criterion?.evidenceRef;
          const evidenceHtml = evidenceRef
            ? `<span style="font-size:11px;color:var(--dim);font-family:var(--fm);">[${escapeHtml(evidenceRef.kind)}] ${escapeHtml(evidenceRef.value)}</span>`
            : "";
          return `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 12px;font-family:var(--fm);font-size:11px;color:var(--muted);white-space:nowrap;">${escapeHtml(criterion.id)}</td>
            <td style="padding:8px 12px;font-size:13px;color:var(--text);">${escapeHtml(criterion.statement)}</td>
            <td style="padding:8px 12px;">${statusPill(status)}</td>
            <td style="padding:8px 12px;">${evidenceHtml}</td>
          </tr>`;
        })
        .join("\n");

      const notesHtml = entry.notes
        ? `<div style="font-size:11px;color:var(--dim);font-family:var(--fm);padding:6px 0 10px;">${escapeHtml(entry.notes)}</div>`
        : "";

      return `<section style="margin-bottom:24px;">
  <h3 style="font-family:var(--fm);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--p);border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:6px;">${escapeHtml(entry.category)}</h3>
  ${notesHtml}
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="border-bottom:2px solid var(--bstr);">
      <th style="padding:6px 12px;text-align:left;font-family:var(--fm);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">ID</th>
      <th style="padding:6px 12px;text-align:left;font-family:var(--fm);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Criterion</th>
      <th style="padding:6px 12px;text-align:left;font-family:var(--fm);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Status</th>
      <th style="padding:6px 12px;text-align:left;font-family:var(--fm);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Evidence</th>
    </tr></thead>
    <tbody>${criteriaRows}</tbody>
  </table>
</section>`;
    })
    .join("\n");

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const skillName = escapeHtml(contract.skill.name);
  const skillVersion = escapeHtml(contract.skill.version);
  const skillClass = escapeHtml(contract.skill.class);
  const categoryCount = contract.success_criteria.length;
  const totalCriteria = contract.success_criteria.reduce(
    (sum, e) => sum + e.criteria.length,
    0
  );

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<title>MUTAGENT — Structured Diagnostic Report · ${skillName}</title>
<style>
:root{--bg:#0a0a12;--bg2:#14141d;--surf:#1a1a25;--surf-e:#22222f;--text:#eef1f6;--muted:#a6a2b4;--dim:#6a6678;--border:rgba(255,255,255,0.09);--bstr:rgba(255,255,255,0.16);--p:#b794f4;--p-strong:#7E47D7;--c:#45b8cc;--g:#43c39a;--y:#e8a64d;--r:#e06666;--fm:'IBM Plex Mono',ui-monospace,monospace;}
*,*::before,*::after{box-sizing:border-box;border-radius:0!important;} body{margin:0;font-family:'Space Grotesk',system-ui,sans-serif;color:var(--text);background:var(--bg);font-size:14px;line-height:1.55;}
header{background:var(--bg2);border-bottom:1px solid var(--bstr);padding:20px 32px;}
.logo{font-weight:700;font-size:20px;letter-spacing:0.18em;background:linear-gradient(135deg,var(--p) 0%,var(--c) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
main{padding:24px 32px;}
h2{font-size:16px;color:var(--p);margin-bottom:16px;}
</style>
</head>
<body>
<header>
  <div class="logo">MUTAGENT</div>
  <div style="font-size:12px;color:var(--muted);margin-top:4px;">Structured Diagnostic Report · ${skillName} v${skillVersion} · <span style="color:var(--dim);">${skillClass}</span></div>
  <div style="font-size:11px;color:var(--dim);font-family:var(--fm);margin-top:4px;">session=${escapeHtml(safeSessionId(input.sessionId))} · diagnosed=${escapeHtml(input.diagnosedAt)} · generated=${escapeHtml(generatedAt)}</div>
  <div style="font-size:11px;color:var(--dim);font-family:var(--fm);">${categoryCount} categories · ${totalCriteria} criteria · ${findings.length} finding(s)</div>
</header>
<main>
  <h2>Success Criteria — 10-Category Structured Report</h2>
  ${categorySections}
</main>
</body>
</html>`;
}

// ── escapeHtml ───────────────────────────────────────────────────────────────

function escapeHtml(str: string | null | undefined): string {
  // W12-03: coerce defensively — optional parsed fields (e.g. parsedInvocation.residual)
  // reach here as undefined on neutral-survey runs; an unguarded .replace would throw
  // TypeError and crash the whole report (the product surface must never crash on an
  // absent optional field).
  const safe = String(str ?? "");
  return safe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── defaultTemplatePath ──────────────────────────────────────────────────────

/**
 * Resolve the default template path: assets/templates/report.html.tpl
 * relative to this script's own directory (report/), so it works regardless
 * of CWD. The canonical path is <skill-root>/assets/templates/report.html.tpl.
 * R-SELF-02-a / R-003-A: when --template flag is omitted, default to this file.
 * Falls back to default.html if report.html.tpl does not exist (pre-P4 compatibility).
 */
function defaultTemplatePath(): string {
  const scriptDir = import.meta.dirname ?? pathDirname(import.meta.url.replace("file://", ""));
  const tplPath = join(scriptDir, "..", "..", "assets", "templates", "report.html.tpl");
  if (existsSync(tplPath)) return tplPath;
  return join(scriptDir, "..", "..", "assets", "templates", "default.html");
}

// ── parseCliArgs ─────────────────────────────────────────────────────────────

/**
 * R-003-A: Parse flag-based CLI arguments.
 * Supports: --findings <path> --output <path> [--template <path>] [--audience client|internal]
 * Returns null if required flags are missing.
 */
function parseCliArgs(argv: string[]): {
  findingsPath: string;
  outputPath: string;
  templatePath: string | null;
  audience: Audience;
} | null {
  let findingsPath: string | null = null;
  let outputPath: string | null = null;
  let templatePath: string | null = null;
  let audience: Audience = "client"; // W13: default to CLIENT (leak-safe for published runs); internal is opt-in (--audience internal); self-diag forces internal (PR-022)

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--findings" && argv[i + 1]) {
      findingsPath = argv[i + 1];
      i++;
    } else if (argv[i] === "--output" && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    } else if (argv[i] === "--template" && argv[i + 1]) {
      templatePath = argv[i + 1];
      i++;
    } else if (argv[i] === "--audience" && argv[i + 1]) {
      const raw = argv[i + 1];
      audience = raw === "client" ? "client" : "internal";
      i++;
    }
  }

  if (!findingsPath || !outputPath) return null;
  return { findingsPath, outputPath, templatePath, audience };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const parsed = parseCliArgs(args);

  if (!parsed) {
    process.stderr.write(
      "Usage: bun scripts/report/render.ts --findings <findings.json> --output <report.html> [options]\n" +
      "Options:\n" +
      "  --template <path>           Template file (default: assets/templates/report.html.tpl)\n" +
      "  --audience client|internal  Audience mode (default: internal)\n" +
      "    client:   NODE-STRIP removes class=\"internal\" nodes (Methodology, Trajectory tabs)\n" +
      "    internal: Full report with all internal tabs and banners\n"
    );
    process.exit(1);
  }

  const { findingsPath, outputPath, templatePath: templatePathArg, audience } = parsed;
  const templatePath = templatePathArg ?? defaultTemplatePath();

  try {
    const rawInput: RenderInput = JSON.parse(readFileSync(resolve(findingsPath), "utf8"));
    // FU-INT-1: CLI --audience flag overrides any audience in the JSON
    const input: RenderInput = { ...rawInput, audience };
    const template = readFileSync(resolve(templatePath), "utf8");
    const html = renderReport(template, input);
    writeFileSync(resolve(outputPath), html, "utf8");
    process.stdout.write(`Report written to: ${outputPath}\n`);
    process.exit(0);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`Error rendering ${findingsPath}:\n${e.stack ?? e.message}\n`);
    process.exit(1);
  }
}
