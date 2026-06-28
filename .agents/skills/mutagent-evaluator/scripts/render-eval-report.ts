/**
 * scripts/render-eval-report.ts — P4 (D-1/D-2/D-3): the v2 `*evaluate` reporting.
 * ---------------------------------------------------------------------------
 * The `*evaluate` path (P5) produces a Scorecard (GATE + variance + per-criterion
 * verdicts); this module is the v2 HTML reporting. It is a faithful TS PORT of the
 * operator-APPROVED 5-tab component spec (the sample-eval-1 reference renderer —
 * `.mutagent-evaluator/sample-eval-1/scripts/render-report.py`), NOT a flat table:
 *
 *   - D-1  renderEvalCards   : terminal per-criterion cards from the Scorecard.
 *   - D-2/D-3 renderEvalReport: the 5-tab HTML eval-report —
 *       §1 Overview          — KPIs + coverage-contract note + gating-criteria
 *                              table (pass-rate over applicable) + top-findings teaser.
 *       §2 Trajectory·Judge  — per-trace ledger (filter/search) + click-row drill:
 *                              Target-Agent‖Judge SIDE-BY-SIDE (gather-context band,
 *                              two lanes, judge micro-steps anchored to agent steps,
 *                              localize band, judge-health) when judge_steps exist,
 *                              else the per-trajectory scorecard.
 *       §3 Eval Scorecard    — cohort heatmap (criteria × route cohort) + nested
 *                              subcards (grounding / verdict / why-abstained) +
 *                              inline calibration buttons.
 *       §4 Findings          — verbatim evidence bullets + judge reasoning chain +
 *                              agree/revise/refute alignment review.
 *       §5 Self-Eval [INTERNAL] — judge-health + methodology + EV-051 routed
 *                              decisions; carries a `strip-for-client` marker.
 *   - autoOpenCommand        : cross-platform open helper (built; the orchestrator
 *           fires it post-render — never fired here).
 *
 * GRACEFUL DEGRADE: the rich tabs CONSUME the §9.4 judge contract (a dense
 * na-explicit per-criterion map + `judge_steps[]` anchored to agent steps) WHEN
 * the judge emits it — and fall back to the scorecard-derived rendering when it is
 * absent. The judge-AGENT emission of dense-map + judge_steps is a SEPARATE change
 * (see TODO[§9.4-judge-emit] in buildEvalReportInput + the additive optional
 * fields the renderer reads off `MatrixVerdictFile`).
 *
 * Brand: rendered from the evaluator's OWN bundled `assets/brand/theme.css` (the
 * unified design-system tokens, aligned to @mutagent/templates/tokens.css) +
 * report-component CSS referencing those same tokens — no diagnostics-package
 * runtime ref (sealed-sibling). SHARP corners · SUBTLE non-black cards · TONED
 * status · RESTRAINED glow. Tabs are <button> (NOT <s>) — no strikethrough.
 *
 * DETERMINISTIC + null-guarded: the ONLY non-deterministic input is the injected
 * `generatedAt`, so two renders of the same report input are BYTE-IDENTICAL after
 * the generatedAt mask (`mask.ts`). v1 render-report.ts / evaluate.ts / mask.ts are
 * UNTOUCHED — this is a separate v2 renderer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AssumptionKind,
  CriterionFlag,
  Grounding,
  OutcomeVerdict,
  type CriterionVerdict,
  type DiscoveryRationale,
  type EvalTrace,
  type MinedCriterion,
} from "./contracts/eval-types.ts";
import { localizeText, PROFILE_UNKNOWN } from "./contracts/eval-matrix.ts";
import type {
  ExpectedStep,
  MatrixCriterion,
  MatrixVerdictFile,
  SubjectProfile,
  Understanding,
} from "./contracts/eval-matrix.ts";
import { deriveWalkHealth } from "./matrix-judge.ts";
import { assessEmitCompleteness, type EmitCompleteness } from "./emit-completeness.ts";
import type { Scorecard } from "./evaluate.ts";
import type { SourceMap } from "./source-map.ts";
import { routeFailures, type FailureRef, type HandoverBundle } from "./route-failures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(HERE, "..", "assets", "brand");

/** HTML-escape (null-guarded — no throw on undefined). Mirrors render-report.ts. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Render input (rich; every rich field OPTIONAL → graceful degrade) ─────────

/** §9.4.4 R4 — where a criterion CAME FROM (defined-in-suite vs source-mined). */
export interface CriterionProvenance {
  /** `defined` = an authored matrix row · `source` = mined from the trace batch. */
  kind: "defined" | "source";
  /** a human-readable origin label (e.g. "eval-matrix.yaml" / "mined: ✓/✗ split"). */
  label: string;
  /** the source detail (e.g. how many traces it was seen in), when known. */
  detail?: string;
}

/** One criterion as the report needs it (mined OR matrix-derived). */
export interface ReportCriterion {
  id: string;
  statement: string;
  severity: string; // CRIT | HIGH | MED | LOW
  gating?: boolean;
  dimension?: string;
  level?: string; // context | output | cross-stage
  appliesTo?: string[];
  /** §9.4.4 R4 — the concrete binary pass condition (the full definition for the hover). */
  passCondition?: string;
  /** UI-7 — what the judge READS to evaluate this criterion (the "how it's judged"
   *  inputs, eval-matrix `judgeInputs`). Render-layer surfacing of an existing field. */
  judgeInputs?: string[];
  /** §9.4.4 R4 — where the criterion came from (defined vs source). */
  provenance?: CriterionProvenance;
  /** UI-10 — the code-vs-judge ROUTER for this criterion (eval-matrix `checkMethod`
   *  / mined `metadata.check_method`): `deterministic` (CODE — a code-eval, no judge
   *  tokens) · `hybrid` (code pre-filter + judge) · `llm-judge` (an LLM-judge
   *  criterion). Defaults to `llm-judge` when the source row omits it (the legacy
   *  all-judge behaviour). Render-layer surfacing — drives the CODE vs JUDGE chip;
   *  NO judge-protocol change. */
  checkMethod?: string;
  /** the §5c DR-2 discovery-rationale block (present iff mined). */
  discovery?: DiscoveryRationale;
}

/** One ordered judge micro-step (§9.4 `judge_steps[]`), anchored to an agent step. */
export interface JudgeStep {
  /** context | examine | detect | bind | ground | critique | decide | verify */
  kind: string;
  text?: string;
  /** a grounding citation — a string OR a structured {obs,path,value} ref (coerced in the renderer). */
  ref?: string | { obs: string; path: string; value: string };
  /** the agent-step index this judge step anchors to (0 / "context" = gather band).
   *  TOLERANT: real judges may emit a stringified index / label / range (coerced below). */
  anchor?: number | string;
}

/** One target-agent step (the left lane of the §2 side-by-side). */
export interface AgentStep {
  n: number;
  tool?: string;
  /** ok | error | warn | false-success */
  status?: string;
  detail?: string;
  /** The trace OBSERVATION id this step corresponds to. Carried best-effort by
   *  `enrichAgentStepsObs` (verdict files don't emit it natively): recovered from
   *  the per-criterion verdict `refs` (`path:"name"` → `{obs, value:<tool>}`) and
   *  the `tool@<obs>` tokens the judge embeds in its critiques. Lets the §2 judge
   *  lane map a step to the criterion verdicts that EXAMINED it via `ref.obs ===
   *  step.obs` (the precise key) on top of the tool-name fallback. Undefined when
   *  no obs id could be recovered for the step (then tool-name match still applies). */
  obs?: string;
}

/** WS-1 — one per-criterion JUDGE verdict for a SINGLE trajectory, read verbatim
 *  from the verdict file's `verdicts[]` (critique-before-verdict + grounding refs).
 *  Distinct from the FOLDED `CriterionVerdict` (one-per-criterion across the batch):
 *  this is the per-trace judgement bound to the §2 drill so EVERY evaluated trace
 *  surfaces its judge reasoning (result · critique · refs), whether or not a
 *  `judge_steps[]` walk was emitted for it. */
export interface CriterionTrajectoryVerdict {
  criterionId: string;
  /** pass | fail | uncertain | na */
  result: string;
  confidence?: number;
  confidenceBand?: string;
  critique?: string;
  /** grounding citations — a string OR a structured {obs,path,value} (coerced in the UI). */
  refs?: Array<string | { obs?: string; path?: string; value?: string }>;
}

/** Per-trajectory judge-health micro-summary (the §2 footer). */
export interface JudgeHealthRow {
  contextGathered?: boolean;
  grounded?: number;
  assumed?: number;
  stoppedAtSymptom?: boolean;
}

/** WS-5 — the resolution class for an INDETERMINATE (uncertain) per-criterion verdict.
 *  `na` = the criterion's TRIGGER/precondition was ABSENT in this trace (not applicable —
 *  DROPPED from the applicable denominator). `needs-evidence` = the precondition WAS
 *  present but the judge could not decide (stays in the denominator, carries a concrete
 *  next-action). NEVER a bare "indeterminate". */
export type IndeterminateResolutionClass = "na" | "needs-evidence";
/** WS-5 — the chain next-action for a `needs-evidence` item (the deterministic decision
 *  chain: re-check the code, get a 2nd judge, revise the criterion, or HITL-spot-check). */
export type IndeterminateNextAction = "code-recheck" | "2nd-judge" | "revise-criterion" | "hitl-spot-check";
/** WS-5 — one resolved indeterminate per-criterion verdict (§3 resolution chain). */
export interface IndeterminateResolution {
  criterionId: string;
  resolutionClass: IndeterminateResolutionClass;
  /** present iff `needs-evidence` — the concrete chain next-action. */
  nextAction?: IndeterminateNextAction;
  /** one-line WHY: the missing precondition (na) or the missing signal (needs-evidence). */
  reason: string;
}

/** One per-trace ledger row (§2). The side-by-side fields are present iff the
 *  judge emitted `judge_steps[]` for this trajectory. */
export interface LedgerRow {
  trajectoryId: string;
  route?: string;
  /** PASS | FAIL | INDETERMINATE | INCOMPLETE */
  verdict: string;
  /** dense, na-explicit per-criterion map: cid -> pass|fail|uncertain|na. */
  perCriterion: Record<string, string>;
  failingCriteria: string[];
  root?: string;
  grounding?: string;
  /** WS-1 — the per-criterion JUDGE verdicts for THIS trajectory (result · critique-
   *  before-verdict · grounding refs), read verbatim from the verdict file's
   *  `verdicts[]`. Bound to the §2 drill ("How the Judge Reasoned") so EVERY trace —
   *  PASS or FAIL, walk or no walk — surfaces its judge reasoning. Present whenever
   *  the verdict file carried ≥1 per-criterion verdict (i.e. all judged trajectories). */
  criterionVerdicts?: CriterionTrajectoryVerdict[];
  // ── §2 side-by-side (present iff judge_steps[] emitted) ──
  context?: { harness?: string; scenario?: string; exitStates?: string };
  /** Gap A — the RAW triggering INPUT for this trajectory (the thing that fired
   *  the subject agent). Sourced from the TRACE (`EvalTrace.input.prompt`, fallback
   *  packet `transcript[0]`) keyed by traceId in `buildEvalReportInput` — NOT a
   *  judge-emitted field (the input is ground-truth in the trace, no judge echo
   *  needed). ABSENT when the trace carried no readable input ⇒ the §2 drill cell
   *  renders "—" (never faked). The judge's `context.scenario` LABEL still shows
   *  beneath it — the input is the WHAT, the scenario is the route summary. */
  input?: string;
  agentSteps?: AgentStep[];
  judgeSteps?: JudgeStep[];
  localize?: string;
  health?: JudgeHealthRow;
  // ── §9.4.4 v2.2 (present iff the judge emitted them) ──
  /** M2 node-0 train-of-thought (rephrase + given-vs-inferred). */
  understanding?: Understanding;
  /** M3 node-0.5 expected-trajectory (how the target SHOULD have acted). */
  expectedTrajectory?: ExpectedStep[];
  /** M1 the subject profile the judge reasoned under (echoed / reconstructed). */
  subjectProfile?: SubjectProfile;
  /** §9.4.5 E3 — the trace's wall-clock timestamp (ISO), when the source carried it.
   *  Powers the eval-HEALTH temporal heatmap (correctness over time). ABSENT ⇒ that
   *  trajectory falls into the data-pending bucket (structure renders, never faked). */
  timestamp?: string;
  /** WS-5 — per-criterion INDETERMINATE resolution for THIS trace (keyed by criterionId):
   *  the deterministic precondition gate's verdict (`na` precondition-absent vs
   *  `needs-evidence` + next-action). Present only for criteria whose raw verdict was
   *  uncertain on this trace. */
  indeterminateResolution?: Record<string, IndeterminateResolution>;
  /** WS-2 — how this trajectory's judgement RESOLVED, made honest + visible (a trace
   *  with no §2 walk is NOT "unjudged"). One of:
   *   • `judge-walk`            — the judge emitted the §9.4 walk (agentSteps/judgeSteps)
   *   • `judged-walk-not-captured` — the trace WAS judged (per-criterion verdicts present)
   *                                  but the emit-contract dropped the structured walk
   *   • `truncated`             — INCOMPLETE fidelity (node-1 gate); never walked by design
   *  Drives the §2 ledger resolution badge + the per-trace drill routing line. */
  resolution?: TrajectoryResolution;
}

/** WS-2 — the resolution class of one ledger row (see `LedgerRow.resolution`). */
export type TrajectoryResolution = "judge-walk" | "judged-walk-not-captured" | "truncated";

/** WS-2 — derive the resolution class for one verdict file. PURE.
 *  truncated > judge-walk (walk emitted) > judged-walk-not-captured (judged, walk dropped). */
export function deriveTrajectoryResolution(f: {
  fidelity?: { complete?: boolean };
  agentSteps?: unknown[];
  judgeSteps?: unknown[];
  verdicts?: unknown[];
}): TrajectoryResolution {
  if (f.fidelity?.complete === false) return "truncated";
  const hasWalk = (f.judgeSteps?.length ?? 0) > 0 || (f.agentSteps?.length ?? 0) > 0;
  if (hasWalk) return "judge-walk";
  return "judged-walk-not-captured";
}

/** WS-2 — the human badge label + one-line routing explanation per resolution class. */
export function resolutionMeta(r: TrajectoryResolution): { badge: string; cls: string; routing: string } {
  switch (r) {
    case "judge-walk":
      return {
        badge: "JUDGE·WALK",
        cls: "res-walk",
        routing:
          "Routed through the full §9.4 judge walk — the target step lane + the anchored judge reasoning were captured, so the side-by-side below is complete.",
      };
    case "judged-walk-not-captured":
      return {
        badge: "judged · walk not captured",
        cls: "res-nowalk",
        routing:
          "This trace WAS judged (per-criterion verdicts + critiques are present below) — the judge simply did not persist the structured §9.4 walk (agentSteps/judgeSteps/M2/M3). The verdict stands; only the step-by-step lane is missing. The emit-completeness gate (§5) tracks this gap; a fresh run with the hardened emit-contract captures the walk natively.",
      };
    case "truncated":
      return {
        badge: "TRUNCATED",
        cls: "res-trunc",
        routing:
          "The node-1 fidelity gate fired — the trace was truncated/unreadable, so it was NEVER walked per-criterion (no fabricated verdicts from a partial trace). Resolved INCOMPLETE by design, not a judge omission.",
      };
  }
}

/** §9.4.4 R3/M5 — one DETECTED-but-unmatched flag (a node-2.5 candidate). NOT a
 *  verdict: a real behaviour the judge flagged with NO matching criterion. Surfaced
 *  in §4 CLEARLY SEPARATED from fails-on-existing-criteria, and routed to discover. */
export interface DetectedFlag {
  /** `eval` = a candidate criterion to mine · `dataset` = a candidate test case. */
  kind: string;
  detection: string;
  trajectoryId: string;
  anchor?: number | string;
  ref?: string | { obs: string; path: string; value: string };
}

/** One §4 finding (one failing/at-risk criterion, aggregated over the ledger). */
export interface TopFinding {
  criterion: string;
  severity?: string;
  applicable: number;
  failCount: number;
  /** % over the APPLICABLE denominator (GA-D2b — na never counted). */
  prevalencePctOverApplicable: number;
  root?: string;
  /** the trace whose judge-walk powers the verbatim evidence. */
  exampleTraceId?: string;
}

/** One gating-criterion roll (§1 table + §3 subcards). */
export interface GatingRoll {
  criterion: string;
  severity?: string;
  applicable: number;
  fail: number;
  /** WS-5 — GENUINE under-evidence (precondition present, undecided). NOT N/A. */
  indeterminate?: number;
  /** WS-5 — N/A (precondition/trigger absent) — DROPPED from the applicable denominator. */
  na?: number;
  passRateOverApplicable: number;
  denominatorNote?: string;
  root?: string;
}

/** WS-5 — one per-criterion INDETERMINATE resolution roll (§3 resolution chain). Covers
 *  ALL criteria (not just gating). The applicable denominator EXCLUDES `na`. */
export interface CriterionResolution {
  criterion: string;
  severity?: string;
  /** applicable = pass + fail + needsEvidence (N/A excluded — denominator-honest). */
  applicable: number;
  pass: number;
  fail: number;
  /** N/A (precondition absent) — shown SEPARATELY, never in the applicable denominator. */
  na: number;
  /** genuine under-evidence (precondition present, undecided) — carries next-actions. */
  needsEvidence: number;
  passRateOverApplicable: number;
  /** the dominant N/A reason (the missing precondition), when na > 0. */
  naReason?: string;
  /** aggregated next-actions for the needsEvidence items (action → count + a reason). */
  nextActions: Array<{ action: IndeterminateNextAction; count: number; reason: string }>;
}

export interface EvalReportInput {
  subject: { name: string; org?: string; source?: string; models?: string[] };
  /** the v2 *evaluate Scorecard (GATE + variance). */
  scorecard: Scorecard;
  /** the folded per-criterion verdicts. */
  verdicts: CriterionVerdict[];
  /** the criteria (mined → DR-2 cards; matrix → statement/severity only). */
  criteria: ReportCriterion[];
  // ── rich (all OPTIONAL — derived by `buildEvalReportInput` from real pipeline
  //     data; the renderer degrades gracefully when absent) ──
  /** per-trace ledger (§2). */
  ledger?: LedgerRow[];
  /** coverage contract (§1). */
  coverage?: { judged?: number; triaged?: number; byVerdict?: Record<string, number>; gapNote?: string };
  /** route cohorts (§3 heatmap): counts per cohort + cid×cohort cells. */
  cohorts?: {
    counts: Record<string, number>;
    matrix: Record<string, Record<string, { pass: number; fail: number; indeterminate: number }>>;
  };
  /** the gating-criteria rolls (§1 table + §3 subcards). */
  gatingCriteria?: GatingRoll[];
  /** WS-5 — per-criterion INDETERMINATE resolution chain (ALL criteria): the
   *  applicable·pass·fail·N/A·needs-evidence split that resolves the single
   *  indeterminate bucket into precondition-absent (N/A, denominator-excluded) vs
   *  genuine under-evidence (carries a next-action). §3 Scorecard. */
  criterionResolutions?: CriterionResolution[];
  /** the §4 top findings (verbatim-evidence cards). */
  topFindings?: TopFinding[];
  /** §9.4.4 R3/M5 — the DETECTED-but-unmatched flags (node-2.5 candidates), shown
   *  in §4 SEPARATED from criterion fails. A detection routed to discover, never minted. */
  detectedFlags?: DetectedFlag[];
  /** §9.4.4 M1/R2 — the subject profile (identity·purpose·tools·skill·scope) for the
   *  INTERNAL calibration tab + the §2 "who is the agent" band. */
  subjectProfile?: SubjectProfile;
  /** §9.4.5 E2 — per-tool OBSERVED call-count (from the trace observations / trajectory
   *  steps). Drives the entity-hero tool CHIPS' "obs N" badge — honest in the trace-only
   *  (no-code-access) case where the only tool evidence is what the traces show. */
  toolObservations?: Record<string, number>;
  /** judge-health (§5 self-eval). */
  judgeHealth?: { groundedPct?: number; abstentionRatePct?: number; stoppedAtSymptomPct?: number };
  /** P2 source-map topology (coverage note). */
  sourceMap?: SourceMap;
  /** the EV-051 diagnostics handover (§5 decisions); null when nothing failed. */
  handover?: HandoverBundle | null;
  /** WS-3 — the §5 Self-Eval AGGREGATE judge-calibration derivation (behavior map +
   *  the 9 components). Deterministic over the verdict files; ABSENT ⇒ §5 degrades to
   *  the legacy calibration view. */
  selfEval?: SelfEvalAggregate;
  /** Overview provenance meta-strip — the RUN config (run-id · date · source · JUDGE
   *  substrate · pinned judge model · temp-0 · C-PIN). Distinct from the TARGET model
   *  (`subject.models`). All OPTIONAL: a genuinely-unavailable field is MARKED, never
   *  faked; substrate/temp/C-PIN carry sensible engine defaults. */
  runConfig?: RunConfig;
  /** the ONLY non-deterministic input (masked for byte-identity). */
  generatedAt: string;
}

/** §Overview-redesign — the run-configuration the provenance meta-strip renders. The
 *  JUDGE substrate + pinned judge model are DISTINCT from the TARGET model under eval. */
export interface RunConfig {
  /** the *evaluate run id (the artifact dot-root key). */
  runId?: string;
  /** the run date/timestamp (defaults to `generatedAt` when absent). */
  date?: string;
  /** the trace SOURCE platform (langfuse · otel · local-ndjson · …). */
  source?: string;
  /** the JUDGE substrate: agent-dispatch (host runtime) · ai-sdk · code. */
  judgeSubstrate?: string;
  /** the PINNED judge model (C-PIN) — NOT the target model. */
  judgeModel?: string;
  /** the pinned judge temperature (C-PIN ⇒ 0). */
  temperature?: number;
  /** C-PIN engaged (pinned model + temp ⇒ byte-identical reruns). */
  cPin?: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sevCls(sev: string | undefined): string {
  const s = String(sev ?? "med").toLowerCase();
  if (s === "crit") return "crit";
  if (s === "high") return "high";
  if (s === "med" || s === "medium") return "med";
  return "low";
}
/** Heatmap / pass-rate colour by % (fail<80 · warn<95 · pass). Deterministic. */
function rateCol(r: number): string {
  return r < 80 ? "var(--fail)" : r < 95 ? "var(--warn)" : "var(--pass)";
}
/** Map a per-criterion result string to its display token (uncertain→indeterminate). */
function resultToken(r: string): string {
  return r === OutcomeVerdict.Uncertain ? "indeterminate" : r;
}
function verdictCls(v: string): string {
  const u = v.toUpperCase();
  return u === "PASS" ? "pass" : u === "FAIL" ? "fail" : "inc";
}
function criterionById(input: EvalReportInput, id: string): ReportCriterion | undefined {
  return input.criteria.find((c) => c.id === id);
}
/** Render structured grounding refs `{obs,path,value}` as compact citations. */
function refsText(refs: { obs: string; path: string; value: string }[]): string {
  return refs.map((r) => `${r.obs}${r.path ? "/" + r.path : ""}: "${r.value}"`).join(" · ");
}

/** UI-6 — pass-RATE → an accent class (driven by SUCCESS rate, NOT severity): green-ish
 *  high · amber mid · red-ish low. Mirrors the heatmap thresholds (≥95 ok · ≥80 mid ·
 *  <80 low) so a criterion card's colour reflects how it actually scored. Deterministic. */
export function rateClass(r: number): "rate-ok" | "rate-mid" | "rate-low" {
  return r >= 95 ? "rate-ok" : r >= 80 ? "rate-mid" : "rate-low";
}

// ── UI-2 — verdict-state legend (Overview + Scorecard) ───────────────────────
/**
 * UI-2 — the verdict-state LEGEND: plain-words for every run/trajectory verdict state
 * so a reader never has to guess what INCOMPLETE means. Rendered in the Overview AND the
 * Scorecard. INCOMPLETE is called out as DISTINCT from FAIL (a CRIT/HIGH criterion is
 * uncertain → the run can't be certified, but it is not a fail). PURE.
 */
function verdictLegend(): string {
  const items: [string, string, string][] = [
    ["pass", "PASS", "every applicable criterion was met — the run is certified as pass."],
    ["fail", "FAIL", "at least one gating (CRIT/HIGH) criterion failed."],
    [
      "inc",
      "INCOMPLETE",
      "a CRIT/HIGH criterion is UNCERTAIN (or the trace was too truncated to judge) — the run can't be certified as pass, but it is NOT a fail.",
    ],
    ["indet", "INDETERMINATE", "judged, but no confident pass/fail on this criterion (not certain either way)."],
    ["na", "na", "not applicable — out of scope for this trajectory; never counted as a fail."],
  ];
  const cells = items
    .map(
      ([cls, k, v]) =>
        `<div class="vl-item"><span class="vl-k ${cls}">${esc(k)}</span><span class="vl-v">${esc(v)}</span></div>`,
    )
    .join("");
  return `<div class="vlegend"><div class="vl-h">▾ what the verdicts mean</div>${cells}</div>`;
}

// ── UI-7 — the criterion DEFINITION block (explainability) ────────────────────
/**
 * UI-7 — the criterion DEFINITION (what it is + HOW it's judged), shown BESIDE the
 * verdict so a card reads as explainable, not robotic. Sourced purely from the
 * criterion's EXISTING fields (statement · passCondition · dimension/severity/level ·
 * judgeInputs · provenance · mined discovery). Every field OPTIONAL → graceful. PURE.
 */
function criterionDefn(c: ReportCriterion | undefined, fallbackId: string): string {
  if (c === undefined) return `<div class="row">${esc(fallbackId)}</div>`;
  const meta = [
    c.dimension ? `dimension · ${c.dimension}` : "",
    c.severity ? `severity · ${String(c.severity).toUpperCase()}` : "",
    c.level ? `level · ${c.level}` : "",
    c.gating ? "gating" : "",
  ]
    .filter(Boolean)
    .join("    ·    ");
  const judged =
    c.judgeInputs && c.judgeInputs.length > 0
      ? `<div class="row"><span class="ref">judged from:</span> ${esc(c.judgeInputs.join(", "))}</div>`
      : "";
  const disc =
    c.discovery !== undefined
      ? `<div class="row"><span class="ref">mined:</span> ${esc(c.discovery.targets)} — ${esc(c.discovery.why_problem)}</div>`
      : "";
  return (
    `<div class="row">${esc(c.statement)}</div>` +
    (c.passCondition && c.passCondition !== c.statement
      ? `<div class="row"><span class="ref">pass when:</span> ${esc(c.passCondition)}</div>`
      : "") +
    (meta ? `<div class="row defn-meta">${esc(meta)}</div>` : "") +
    judged +
    `<div class="row"><span class="ref">provenance:</span> ${esc(c.provenance?.label ?? "—")}${c.provenance?.detail ? " · " + esc(c.provenance.detail) : ""}</div>` +
    disc
  );
}

/**
 * WS-3 — a ONE-LINE plain-language gloss for a criterion: de-jargons WHAT it measures
 * and WHY it matters, so a non-author can read the scorecard/findings without parsing
 * the "Pass = …; Fail = …" statement scaffolding or the dimension/refs.
 *
 * SOURCED honestly, in priority order — NEVER fabricates beyond what the criterion
 * already states:
 *   1) the mined discovery rationale — `discovery.targets` (the behaviour it guards)
 *      + `discovery.why_problem` (the user/correctness consequence). These are the
 *      purpose-built readable fields, used verbatim.
 *   2) DERIVED deterministically from the `statement` by stripping the
 *      `Pass = …` / `Fail = …` scaffolding into "Measures: <pass clause>. Why it
 *      matters: failing means <fail clause>." (a pure restructure — no new content).
 *   3) the bare statement, when it carries no Pass/Fail scaffolding.
 * Always returns a non-empty string for any criterion with a statement. PURE.
 */
export function plainExplainer(c: ReportCriterion | undefined): string {
  if (c === undefined) return "";
  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
  // (1) mined criteria carry the most readable, purpose-built fields.
  if (c.discovery !== undefined) {
    const what = clean(c.discovery.targets);
    const why = clean(c.discovery.why_problem);
    if (what !== "") return `Measures: ${what}${why !== "" ? `. Why it matters: ${why}` : ""}.`;
  }
  // (2) derive from the statement — strip the Pass/Fail scaffolding (tolerant of
  // `=`/`:` and casing; the pass clause runs up to a `;` or the `Fail` marker).
  const stmt = clean(c.statement);
  if (stmt === "") return "";
  const passM = stmt.match(/pass\s*[:=]\s*([^;]+?)(?:;\s*|\s+fail\s*[:=]|$)/i);
  const failM = stmt.match(/fail\s*[:=]\s*(.+)$/i);
  if (passM) {
    const what = clean(passM[1]);
    const why = failM ? clean(failM[1]).replace(/\.$/, "") : "";
    return `Measures: ${what}${why !== "" ? `. Why it matters: failing means ${why}` : ""}.`;
  }
  // (3) no scaffolding — present the statement as the measure.
  return `Measures: ${stmt}`;
}

/** WS-3 — the muted plain-language banner element (above the technical block). Empty
 *  source ⇒ empty string (no stray banner). Shared by the §3 subcards + §4 findings. */
function plainBanner(c: ReportCriterion | undefined): string {
  const txt = plainExplainer(c);
  return txt === "" ? "" : `<div class="plain">${esc(txt)}</div>`;
}

/**
 * WS-5 — the deterministic INDETERMINATE-resolution gate. Resolves ONE uncertain
 * per-criterion verdict into the decision chain, NEVER leaving a bare "indeterminate":
 *
 *  ① PRECONDITION GATE (deterministic) — is the criterion's TRIGGER/precondition even
 *     present in this trace? Signals, in priority:
 *       (a) the judge's DENSE na-map marks this criterion `na` on this trace — its
 *           explicit, per-trace applicability call (the strongest deterministic signal);
 *       (b) the abstain is `blockedBy.kind === "scope"` — the criterion's referent is
 *           out of scope for this route;
 *       (c) a derivable precondition TRIGGER (tool/event) did NOT fire in the observed
 *           agent steps (used when the criterion carries one + the trace has steps).
 *     Any ⇒ `na` (precondition absent) — DROPPED from the applicable denominator.
 *  ② Otherwise the precondition WAS present but the judge could not decide ⇒
 *     `needs-evidence`, with a concrete NEXT-ACTION: code-recheck (a deterministic/hybrid
 *     criterion) · 2nd-judge (re-ground a `factual-intent` abstain) · revise-criterion
 *     (a `normative` value-call — operator-owned) · hitl-spot-check (default).
 * PURE. `reason` is the judge's own `blockedBy.text` when present (the unbound term),
 * never invented.
 */
export function classifyIndeterminate(
  criterion: ReportCriterion | undefined,
  verdict: { result?: string; blockedBy?: { kind?: string; text?: string } } | undefined,
  denseValue: string | undefined,
  agentSteps?: AgentStep[],
): IndeterminateResolution {
  const cid = criterion?.id ?? "";
  const bb = verdict?.blockedBy;
  const trigger = preconditionTrigger(criterion);
  const norm = (s: string): string => s.trim().toLowerCase();
  const triggerAbsent =
    trigger !== undefined && agentSteps !== undefined && agentSteps.length > 0
      ? !agentSteps.some((s) => norm(s.tool ?? "") === norm(trigger))
      : false;
  // ① precondition-absent ⇒ N/A (excluded from the applicable denominator)
  if (denseValue === "na" || bb?.kind === AssumptionKind.Scope || triggerAbsent) {
    const reason =
      bb?.text && bb.text.trim().length > 0
        ? bb.text.trim()
        : trigger
          ? `trigger '${trigger}' not invoked in this trace`
          : "criterion not applicable to this trace — precondition/trigger absent";
    return { criterionId: cid, resolutionClass: "na", reason };
  }
  // ② precondition present but undecided ⇒ needs-evidence + a chain next-action
  const cm = criterion?.checkMethod;
  const nextAction: IndeterminateNextAction =
    cm === "deterministic" || cm === "hybrid"
      ? "code-recheck"
      : bb?.kind === AssumptionKind.FactualIntent
        ? "2nd-judge"
        : bb?.kind === AssumptionKind.Normative
          ? "revise-criterion"
          : "hitl-spot-check";
  const reason =
    bb?.text && bb.text.trim().length > 0
      ? bb.text.trim()
      : "judge abstained — evidence present but inconclusive; needs a confirming pass";
  return { criterionId: cid, resolutionClass: "needs-evidence", nextAction, reason };
}

/** WS-5 — the precondition TRIGGER (tool/event) a criterion requires before it applies,
 *  when derivable. RESERVED hook: `ReportCriterion` carries no codeEval today, so this
 *  returns undefined and the deterministic gate runs off the judge's dense na-map + the
 *  typed `blockedBy`. A codeEval-bearing criterion (discover-side) can override later. */
function preconditionTrigger(_criterion: ReportCriterion | undefined): string | undefined {
  return undefined;
}

// ── §9.4.4 R3 — per-tab "what this tab shows" description ─────────────────────
/** A standardized tab-description banner (R3): every tab states what it shows. */
function tabDesc(text: string): string {
  return `<div class="tabdesc"><span class="td-i">ⓘ</span> ${esc(text)}</div>`;
}

// ── §9.4.4 R4 — criterion provenance + human-readable statement + hover ───────
/**
 * The provenance chip for a criterion (R4): `defined` (authored matrix row) vs
 * `source` (mined from the trace ✓/✗ split), with a hover title carrying the origin.
 */
function provChip(c: ReportCriterion | undefined): string {
  const p = c?.provenance;
  if (p === undefined) return "";
  const cls = p.kind === "defined" ? "defined" : "source";
  const title = `${p.label}${p.detail ? " — " + p.detail : ""}`;
  return `<span class="prov ${cls}" title="${esc(title)}">${esc(p.kind)}</span>`;
}

/**
 * UI-10 — the CODE vs JUDGE chip for a criterion, from its `checkMethod` router:
 * `deterministic` → CODE (a deterministic code-eval — zero judge tokens) · `hybrid`
 * → CODE+JUDGE (code pre-filter, then judge on the residual) · else JUDGE (scored by
 * the critique-before-verdict LLM judge). Lets a reader tell at a glance HOW each
 * criterion is evaluated — code-checked vs judged. Absent checkMethod ⇒ no chip.
 */
function methodKind(c: ReportCriterion | undefined): "code" | "hybrid" | "judge" | undefined {
  const m = c?.checkMethod;
  if (m === undefined) return undefined;
  return m === "deterministic" ? "code" : m === "hybrid" ? "hybrid" : "judge";
}
function methodChip(c: ReportCriterion | undefined): string {
  const kind = methodKind(c);
  if (kind === undefined) return "";
  const label = kind === "code" ? "CODE" : kind === "hybrid" ? "CODE+JUDGE" : "JUDGE";
  const title =
    kind === "code"
      ? "code-eval — deterministic check, no LLM judge (zero judge tokens)"
      : kind === "hybrid"
        ? "hybrid — deterministic code pre-filter, then LLM judge on the residual"
        : "llm-judge — scored by the critique-before-verdict LLM judge";
  return `<span class="method ${kind}" title="${esc(title)}">${label}</span>`;
}

/**
 * An info-hover badge carrying the criterion's FULL definition (R4): the human-
 * readable statement + pass condition + provenance. Rendered as a `title=`-tooltip
 * on a small ⓘ glyph so every criterion id is self-describing on hover.
 */
function critHover(c: ReportCriterion | undefined): string {
  if (c === undefined) return "";
  const kind = methodKind(c);
  const parts = [
    `STATEMENT: ${c.statement}`,
    c.passCondition ? `PASS WHEN: ${c.passCondition}` : "",
    // UI-10 — the code-vs-judge method, spelled out in the hover.
    kind !== undefined ? `EVALUATED BY: ${kind === "code" ? "CODE (deterministic check)" : kind === "hybrid" ? "HYBRID (code pre-filter + judge)" : "LLM JUDGE"}` : "",
    c.provenance ? `PROVENANCE: ${c.provenance.label}${c.provenance.detail ? " (" + c.provenance.detail + ")" : ""}` : "",
  ].filter(Boolean);
  return `<span class="ihover" title="${esc(parts.join("\n"))}">ⓘ</span>`;
}

/**
 * Gap A — the RAW triggering INPUT for a trace: the thing that fired the subject
 * agent. PRIMARY source is `EvalTrace.input.prompt` (the canonical contract field,
 * contracts/eval-types.ts). FALLBACK is the packet-style `transcript[0]` raw user
 * turn carried on some exports (`input.transcript[0].content|text|message`). An
 * absent / non-string / empty value ⇒ `undefined` (the row gets no input; the
 * drill cell renders "—" — never a fabricated input). PURE, read-only.
 */
function traceInputText(t: EvalTrace): string | undefined {
  const input = t.input;
  if (input === undefined || input === null) return undefined;
  // PRIMARY: the canonical `input.prompt`.
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt === "string" && prompt.trim().length > 0) return prompt;
  // FALLBACK: a packet/transcript-style first user turn (`transcript[0]`).
  const transcript = (input as { transcript?: unknown }).transcript;
  if (Array.isArray(transcript) && transcript.length > 0) {
    const first = transcript[0] as Record<string, unknown> | string | undefined;
    if (typeof first === "string" && first.trim().length > 0) return first;
    if (first !== null && typeof first === "object") {
      for (const key of ["content", "text", "message", "prompt"] as const) {
        const v = first[key];
        if (typeof v === "string" && v.trim().length > 0) return v;
      }
    }
  }
  return undefined;
}

/**
 * WS-6 — reconstruct the subject's SYSTEM PROMPT from a raw trace. The eval
 * `subjectProfile` carries no `systemPrompt` (0/N verdicts), but the agent's static
 * system message rides on every LLM-call observation as the first `role:"system"`
 * message — so it is RECOVERABLE from the trace batch, not confabulated.
 *
 * Scans, in priority order: (1) each observation's `input` — a bare messages ARRAY
 * (e.g. Langfuse `ai.generateText.doGenerate.input = [{role:"system",content:…}, …]`)
 * OR a `{messages:[…]}` wrapper (the `ai.generateText` SPAN shape); (2) the trace-level
 * `input` in those same two shapes. Returns the FIRST `role:"system"` message's text
 * (string content, or the joined `text` parts of an array content). Returns `undefined`
 * when no system message exists — the caller then leaves the prompt UNAVAILABLE
 * (NEVER fabricated). PURE, read-only over the trace. REUSABLE: the discover-side
 * entity hero can import this to mirror the same reconstruction.
 */
export function reconstructSystemPrompt(t: EvalTrace): string | undefined {
  // content → text: a message content is a string OR an array of {type,text} parts.
  const contentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part !== null && typeof part === "object"
            ? String((part as { text?: unknown }).text ?? "")
            : typeof part === "string"
              ? part
              : "",
        )
        .join("");
    }
    return "";
  };
  // scan a message ARRAY for the first role:"system" → its (non-empty) content text.
  const fromMessages = (msgs: unknown): string | undefined => {
    if (!Array.isArray(msgs)) return undefined;
    for (const m of msgs) {
      if (m !== null && typeof m === "object" && (m as { role?: unknown }).role === "system") {
        const txt = contentText((m as { content?: unknown }).content).trim();
        if (txt.length > 0) return txt;
      }
    }
    return undefined;
  };
  // a container is either a bare messages array OR a {messages:[…]} wrapper.
  const fromContainer = (c: unknown): string | undefined => {
    const direct = fromMessages(c);
    if (direct !== undefined) return direct;
    if (c !== null && typeof c === "object" && !Array.isArray(c)) {
      return fromMessages((c as { messages?: unknown }).messages);
    }
    return undefined;
  };
  for (const o of t.observations ?? []) {
    const hit = fromContainer(o.input);
    if (hit !== undefined) return hit;
  }
  return fromContainer(t.input);
}

/**
 * UI-9 (§9.4.5 E3) — the trace WALL-CLOCK timestamp, sourced from the RAW input
 * prompt's `<current_time>…ISO…</current_time>` tag. Real agent harnesses stamp the
 * wall-clock into the prompt they fire the subject with (e.g. a sample subject:
 * `<current_time>2026-05-05T18:39:19.934Z</current_time>`), so the time the run
 * happened is GROUND-TRUTH in the trace — NOT a judge-emit field. The eval-health
 * heatmap buckets pass-rate by this timestamp. TOLERANT: returns the inner ISO when
 * it parses as a real date (never a fabricated stamp); absent/garbage ⇒ undefined
 * (the row lands in the heatmap data-pending bucket). PURE, read-only over traces.
 */
export function traceTimestamp(t: EvalTrace): string | undefined {
  const raw = traceInputText(t);
  if (raw === undefined) return undefined;
  const m = raw.match(/<current_time>\s*([^<]+?)\s*<\/current_time>/i);
  if (m === null) return undefined;
  const iso = m[1].trim();
  // validate: a real, date-parseable stamp of ISO-ish length — never fake.
  if (iso.length < 10 || Number.isNaN(Date.parse(iso))) return undefined;
  return iso;
}

/** A criterion's human-readable one-line statement (R4), truncated for table rows. */
function critStatement(c: ReportCriterion | undefined, max = 88): string {
  const s = c?.statement ?? "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Coerce a tolerant context band (string | string[]) to readable strings — real
 *  judges emit exit-states / scenarios as a LIST; join them for the §2 band. */
function coerceContext(
  ctx: { harness?: unknown; scenario?: unknown; exitStates?: unknown },
): { harness?: string; scenario?: string; exitStates?: string } {
  // TOLERANT — real judges emit exitStates/scenario as a string, a string[], OR a
  // structured object (e.g. `{steps: 7}`). Coerce all three to a readable string so
  // the §2 drill never renders a raw "[object Object]" (WS-1: the rich verdict files
  // that carry an object exitStates are exactly the ones with the judge_steps walk).
  const one = (v: unknown): string | undefined =>
    v === undefined || v === null
      ? undefined
      : Array.isArray(v)
        ? v.join(" · ")
        : typeof v === "object"
          ? Object.entries(v as Record<string, unknown>)
              .map(([k, val]) => `${k}: ${val}`)
              .join(", ")
          : String(v);
  return {
    ...(ctx.harness !== undefined ? { harness: one(ctx.harness) } : {}),
    ...(ctx.scenario !== undefined ? { scenario: one(ctx.scenario) } : {}),
    ...(ctx.exitStates !== undefined ? { exitStates: one(ctx.exitStates) } : {}),
  };
}

// ── criterion adapters (mined ⇄ matrix → ReportCriterion) ────────────────────

const GATING_SEVERITIES = new Set(["CRIT", "HIGH"]);

/** A mined criterion carries the full §5b metadata + §5c DR-2 rationale. Its
 *  provenance is `source` (R4): mined from the ✓/✗ trace split. */
export function fromMinedCriteria(criteria: MinedCriterion[]): ReportCriterion[] {
  return criteria.map((c) => ({
    id: c.id,
    statement: c.statement,
    severity: c.metadata.severity,
    gating: GATING_SEVERITIES.has(c.metadata.severity),
    dimension: c.metadata.dimension,
    level: c.metadata.level,
    appliesTo: c.metadata.applies_to,
    // UI-10 — carry the code-vs-judge router (default llm-judge when the metadata omits it).
    checkMethod: c.metadata.check_method ?? "llm-judge",
    ...(c.metadata.judge_inputs !== undefined ? { judgeInputs: c.metadata.judge_inputs } : {}),
    provenance: {
      kind: "source" as const,
      label: "mined from trace ✓/✗ split",
      ...(c.discovery !== undefined
        ? { detail: `grounding ${c.discovery.evidence.grounding} · seen in ${c.discovery.evidence.seen_in_traces} trace(s)` }
        : {}),
    },
    discovery: c.discovery,
  }));
}

/** A matrix criterion carries statement + pass condition + severity. Its provenance
 *  is `defined` (R4): an authored eval-matrix row. */
export function fromMatrixCriteria(criteria: MatrixCriterion[]): ReportCriterion[] {
  return criteria.map((c) => ({
    id: c.criterionId,
    statement: c.statement,
    severity: c.severity,
    gating: GATING_SEVERITIES.has(c.severity),
    passCondition: c.passCondition,
    // UI-10 — carry the code-vs-judge router (default llm-judge when the matrix row omits it).
    checkMethod: c.checkMethod ?? "llm-judge",
    provenance: { kind: "defined" as const, label: "defined eval-matrix criterion" },
    ...(c.dimension !== undefined ? { dimension: c.dimension } : {}),
    ...(c.judgeInputs !== undefined ? { judgeInputs: c.judgeInputs } : {}),
  }));
}

// ── D-1 terminal eval-cards ─────────────────────────────────────────────────

/**
 * Render per-criterion terminal cards from the Scorecard: criterion · verdict ·
 * severity · critique snippet · the §5c DR-2 grounding tag (when mined). Plain
 * text, deterministic (criteria in `verdicts` order). The D-1 dogfood fix.
 */
export function renderEvalCards(input: EvalReportInput): string {
  const lines: string[] = [];
  const g = input.scorecard.gate;
  lines.push(`╔═ EVAL CARDS — ${input.subject.name} ═══`);
  lines.push(`║ GATE: ${g.passed ? "PASS" : (g.runVerdict ?? "fail").toUpperCase()}  (${g.passCount}/${g.total} pass, ${g.gatedBy.length} gating)`);
  lines.push("╠══════════════════════════════════════");
  for (const v of input.verdicts) {
    const crit = criterionById(input, v.criterionId);
    const sev = crit?.severity ?? "MED";
    // UI-10 — the code-vs-judge tag, so the terminal cards distinguish code-checked
    // criteria from judged ones (CODE · HYBRID · JUDGE). Default JUDGE when absent.
    const mkind = methodKind(crit);
    const method = mkind === "code" ? "CODE" : mkind === "hybrid" ? "HYBRID" : "JUDGE";
    const grounding = crit?.discovery?.evidence.grounding ?? Grounding.Inferred;
    const prevalence = crit?.discovery?.evidence.prevalence ?? "n/a";
    const snippet = v.critique.length > 80 ? v.critique.slice(0, 77) + "…" : v.critique;
    lines.push(`║ ▸ ${v.criterionId}  [${sev}·${method}]  ${resultToken(v.result).toUpperCase()}  (conf ${v.confidence})`);
    lines.push(`║     grounding: ${grounding} (${prevalence})`);
    lines.push(`║     ${snippet}`);
  }
  lines.push("╚══════════════════════════════════════");
  return lines.join("\n");
}

// ── wiring: build the rich report input from real pipeline data ──────────────

function ledgerVerdict(perCriterion: Record<string, string>): string {
  const vals = Object.values(perCriterion).filter((v) => v !== "na");
  if (vals.includes(OutcomeVerdict.Fail)) return "FAIL";
  if (vals.includes(OutcomeVerdict.Uncertain)) return "INDETERMINATE";
  if (vals.length === 0) return "INCOMPLETE";
  return "PASS";
}

/** Optional §9.4 trajectory-level fields the judge MAY emit (additive). */
interface MatrixVerdictFileRich extends MatrixVerdictFile {
  route?: string;
  context?: { harness?: string | string[]; scenario?: string | string[]; exitStates?: string | string[] };
  agentSteps?: AgentStep[];
  judgeSteps?: JudgeStep[];
  localize?: string;
  health?: JudgeHealthRow;
  // §9.4.4 v2.2
  understanding?: Understanding;
  expectedTrajectory?: ExpectedStep[];
  subjectProfile?: SubjectProfile;
  /** §9.4.5 E3 — the trace wall-clock timestamp (ISO), when the source carried it.
   *  Common spellings tolerated below (`timestamp` · `traceTimestamp` · `startTime`). */
  timestamp?: string;
  traceTimestamp?: string;
  startTime?: string;
}

/**
 * Best-effort carry of an observation id onto each `AgentStep` so the §2 judge
 * lane can map a step to the criterion verdicts that EXAMINED it by the precise
 * `ref.obs === step.obs` key (on top of the tool-name fallback). The verdict
 * files DON'T emit a per-step obs id — but the per-criterion verdict `refs` and
 * critiques DO carry obs ids bound to a tool:
 *   (a) `refs[]` with `path:"name"` → `{obs:<id>, value:<toolName>}`.
 *   (b) `tool@<obsid>` tokens the judge embeds in `critique` text
 *       (e.g. "sendMessage@04ff44e20dbacb37") — the ONLY source for tools that
 *       were cited only by an `output.*` ref (which carries no tool name).
 * We gather tool → ordered-unique obs ids from both, then assign positionally per
 * step (nth call of a tool → nth obs id). A tool with no recovered obs id leaves
 * the step's obs UNDEFINED (honest — the tool-name match still covers it). PURE.
 */
export function enrichAgentStepsObs(f: {
  agentSteps?: AgentStep[];
  verdicts?: Array<{ critique?: string; refs?: Array<{ obs?: string; path?: string; value?: string }> }>;
}): AgentStep[] | undefined {
  const steps = f.agentSteps;
  if (steps === undefined) return undefined;
  const toolObs = new Map<string, string[]>();
  const push = (tool: string, obs: string): void => {
    if (!tool || !obs) return;
    const list = toolObs.get(tool) ?? [];
    if (!list.includes(obs)) {
      list.push(obs);
      toolObs.set(tool, list);
    }
  };
  for (const v of f.verdicts ?? []) {
    for (const rf of v.refs ?? []) {
      if (rf && typeof rf === "object" && rf.path === "name" && rf.value && rf.obs) {
        push(String(rf.value), String(rf.obs));
      }
    }
    // `tool@<obs>` tokens in the critique (obs ids are 6+ hex chars).
    const crit = typeof v.critique === "string" ? v.critique : "";
    const re = /([A-Za-z_]\w*)@([0-9a-f]{6,})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(crit)) !== null) push(m[1], m[2]);
  }
  if (toolObs.size === 0) return steps;
  const counter: Record<string, number> = {};
  return steps.map((s) => {
    const tool = s.tool ?? "";
    const list = toolObs.get(tool);
    if (list === undefined || list.length === 0) return s;
    const i = counter[tool] ?? 0;
    counter[tool] = i + 1;
    const obs = list[i];
    return obs !== undefined ? { ...s, obs } : s;
  });
}

/**
 * Derive the rich `EvalReportInput` fields (ledger · coverage · cohorts · gating
 * rolls · top findings · judge-health) from the REAL pipeline outputs — the
 * per-trajectory Judge-Agent verdict files + the folded scorecard + the criteria.
 * Invents NO data: every cell is read from a verdict file or the scorecard.
 *
 * §9.4-judge-emit CLOSED (T2): the JUDGE AGENT now EMITS the side-by-side fields
 * (`judgeSteps`, `agentSteps`, `context`, `localize`, `health`, `route`), a dense
 * na-explicit `denseMap`, a `fidelity` gate, and per-verdict `confidenceBand` —
 * mandated in `evaluator.md #mode-judge-trajectory`. The renderer uses an emitted
 * `denseMap` verbatim when present and otherwise synthesizes one from `verdicts[]`
 * (na for any unjudged row), so a judge that omits the walk still renders. PURE.
 */
export function buildEvalReportInput(params: {
  subject: EvalReportInput["subject"];
  scorecard: Scorecard;
  verdicts: CriterionVerdict[];
  criteria: ReportCriterion[];
  matrixVerdictFiles?: MatrixVerdictFile[];
  sourceMap?: SourceMap;
  handover?: HandoverBundle | null;
  generatedAt: string;
  triaged?: number;
  /** §9.4.4 M1/R2 — the subject profile (given or reconstructed) for the report. */
  subjectProfile?: SubjectProfile;
  /** Overview provenance meta-strip — the run config (judge substrate · pinned model · …). */
  runConfig?: RunConfig;
  /**
   * Gap A — the INGESTED trace batch (the EvalTraces under evaluation). Used ONLY
   * to source each ledger row's RAW triggering INPUT (`EvalTrace.input.prompt`,
   * keyed by trace id == `MatrixVerdictFile.trajectoryId`). The input is
   * ground-truth in the trace — NOT a judge-emit field, so this stays non-protocol
   * (the judge schema is untouched). ABSENT ⇒ rows carry no `input` and the §2
   * drill cell renders "—" (graceful, never faked). PURE — read-only over traces.
   */
  traces?: EvalTrace[];
}): EvalReportInput {
  const files = (params.matrixVerdictFiles ?? []) as MatrixVerdictFileRich[];
  const critIds = params.criteria.map((c) => c.id);
  // Gap A — index the raw triggering INPUT by trace id (== trajectoryId). Read
  // `EvalTrace.input.prompt`; an absent/empty input leaves the row without `input`
  // (the drill renders "—"). NO judge echo — the input is read straight from the
  // trace the verdict was produced over.
  const inputByTrace = new Map<string, string>();
  // UI-9 (§9.4.5 E3) — index the wall-clock timestamp by trace id (== trajectoryId),
  // extracted from the trace's `<current_time>` prompt stamp. This is the REAL data
  // path the eval-health heatmap needs; verdict files carry no timestamp, but the
  // ingested traces do. Mirror inputByTrace; NO contract change.
  const timestampByTrace = new Map<string, string>();
  for (const t of params.traces ?? []) {
    const raw = traceInputText(t);
    if (raw !== undefined) inputByTrace.set(t.id, raw);
    const ts = traceTimestamp(t);
    if (ts !== undefined) timestampByTrace.set(t.id, ts);
  }
  const sevById = new Map(params.criteria.map((c) => [c.id, c.severity]));
  const critById = new Map(params.criteria.map((c) => [c.id, c]));
  const gatingIds = new Set(params.criteria.filter((c) => c.gating).map((c) => c.id));

  // ── ledger: one dense row per trajectory ──
  const ledger: LedgerRow[] = files.map((f) => {
    const perCriterion: Record<string, string> = {};
    for (const cid of critIds) perCriterion[cid] = "na"; // dense, na-explicit
    // §9.4.2 node 9: prefer the judge's EMITTED dense map (na-explicit) verbatim;
    // else synthesize from verdicts[] (any unjudged row stays na).
    const emittedDense = (f as { denseMap?: Record<string, string> }).denseMap;
    if (emittedDense !== undefined) {
      for (const cid of critIds) if (emittedDense[cid] !== undefined) perCriterion[cid] = emittedDense[cid];
    }
    for (const v of f.verdicts) perCriterion[v.criterionId] = v.result;
    // WS-5 — the INDETERMINATE resolution chain: deterministically resolve every
    // uncertain per-criterion verdict into `na` (precondition absent — DROPPED from the
    // applicable denominator) or `needs-evidence` (+ a next-action). A precondition-
    // absent uncertain is RECLASSIFIED to `na` in `perCriterion` so EVERY downstream
    // count (rolls · cohorts · heatmap · trace verdict) becomes denominator-honest —
    // no bare "indeterminate" that conflates not-applicable with under-evidenced.
    const verdictByCid = new Map(
      f.verdicts.map((v) => [v.criterionId, v as { result?: string; blockedBy?: { kind?: string; text?: string } }]),
    );
    const indeterminateResolution: Record<string, IndeterminateResolution> = {};
    for (const cid of critIds) {
      if (perCriterion[cid] === OutcomeVerdict.Uncertain) {
        const res = classifyIndeterminate(critById.get(cid), verdictByCid.get(cid), emittedDense?.[cid], f.agentSteps);
        indeterminateResolution[cid] = res;
        if (res.resolutionClass === "na") perCriterion[cid] = "na";
      }
    }
    const failingCriteria = f.verdicts.filter((v) => v.result === OutcomeVerdict.Fail).map((v) => v.criterionId);
    const grounding = f.verdicts
      .flatMap((v) => v.refs ?? [])
      .map((r) => `${r.obs}/${r.path}`)
      .slice(0, 3)
      .join(" · ");
    // #3 EXAMINE fidelity gate: a trajectory whose deterministic fidelity gate
    // fired (truncated / unterminated) is INCOMPLETE regardless of its dense map —
    // it was never walked per-criterion.
    const isIncomplete = (f as { fidelity?: { complete?: boolean } }).fidelity?.complete === false;
    const row: LedgerRow = {
      trajectoryId: f.trajectoryId,
      verdict: isIncomplete ? "INCOMPLETE" : ledgerVerdict(perCriterion),
      perCriterion,
      failingCriteria,
      ...(f.route !== undefined ? { route: f.route } : {}),
      ...(grounding ? { grounding } : {}),
      // WS-1 — bind the per-criterion JUDGE verdicts (result · critique · refs) for
      // THIS trajectory, read verbatim off the verdict file's `verdicts[]`. This is
      // the rich "How the Judge Reasoned" payload that EVERY judged trace carries
      // (PASS or FAIL), independent of whether a judge_steps[] walk was emitted —
      // so the §2 drill never renders an empty reasoning panel when the verdict file
      // has data. NO invention: a row with no verdicts simply omits the field.
      ...(f.verdicts.length > 0
        ? { criterionVerdicts: f.verdicts as unknown as CriterionTrajectoryVerdict[] }
        : {}),
      // Gap A — the raw triggering INPUT for this trajectory, sourced from the
      // trace by id (== trajectoryId). ABSENT ⇒ the drill cell renders "—".
      ...(inputByTrace.has(f.trajectoryId) ? { input: inputByTrace.get(f.trajectoryId) } : {}),
      ...(f.context !== undefined ? { context: coerceContext(f.context) } : {}),
      // Carry recovered obs ids onto each agent step so the §2 judge lane can map
      // a step → the criterion verdicts that examined it by `ref.obs === step.obs`.
      ...(f.agentSteps !== undefined ? { agentSteps: enrichAgentStepsObs(f) } : {}),
      ...(f.judgeSteps !== undefined ? { judgeSteps: f.judgeSteps } : {}),
      ...(f.localize !== undefined ? { localize: localizeText(f.localize) } : {}),
      // §9.4.4 v2.2 — node-0 understanding · node-0.5 expected-trajectory · M1 profile.
      ...(f.understanding !== undefined ? { understanding: f.understanding } : {}),
      ...(f.expectedTrajectory !== undefined ? { expectedTrajectory: f.expectedTrajectory } : {}),
      ...(f.subjectProfile !== undefined ? { subjectProfile: f.subjectProfile } : {}),
      // T4: DERIVE health from the walk when judge_steps were emitted (don't trust
      // the self-reported `health`); fall back to the self-reported field otherwise.
      ...((f.judgeSteps?.length ?? 0) > 0
        ? { health: deriveWalkHealth(f) }
        : f.health !== undefined
          ? { health: f.health }
          : {}),
      // §9.4.5 E3 / UI-9 — carry the trace timestamp for the eval-HEALTH temporal
      // heatmap. PRIMARY = the trace's `<current_time>` wall-clock (real ground-truth,
      // sourced from params.traces); FALLBACK = a verdict-file timestamp (tolerant
      // spellings) if a judge ever emits one. ABSENT ⇒ this row lands in the
      // data-pending bucket (never faked).
      ...(((timestampByTrace.get(f.trajectoryId) ?? f.timestamp ?? f.traceTimestamp ?? f.startTime) !== undefined)
        ? { timestamp: timestampByTrace.get(f.trajectoryId) ?? f.timestamp ?? f.traceTimestamp ?? f.startTime }
        : {}),
      // WS-5 — the per-criterion indeterminate resolution for this trace (na vs needs-evidence).
      ...(Object.keys(indeterminateResolution).length > 0 ? { indeterminateResolution } : {}),
      // WS-2 — how this trajectory resolved (judge-walk · judged-walk-not-captured ·
      // truncated). Makes the "no walk" traces HONEST: judged, not unjudged.
      resolution: deriveTrajectoryResolution(f),
    };
    return row;
  });

  // ── §9.4.5 E2 — per-tool OBSERVED call-count (from the trajectory agent-steps). In
  //    the trace-only (no-code-access) case this is the ONLY honest tool evidence: how
  //    often each tool was actually seen called across the judged trajectories. PURE. ──
  const toolObservations: Record<string, number> = {};
  for (const f of files) {
    for (const step of f.agentSteps ?? []) {
      const name = step.tool;
      if (typeof name === "string" && name.length > 0) {
        toolObservations[name] = (toolObservations[name] ?? 0) + 1;
      }
    }
  }

  // ── §9.4.4 R3/M5 — collect the DETECTED-but-unmatched flags (node-2.5 candidates),
  //    surfaced in §4 SEPARATED from criterion fails (a detection, never a verdict). ──
  const detectedFlags: DetectedFlag[] = [];
  for (const f of files) {
    for (const cand of f.candidates ?? []) {
      detectedFlags.push({
        kind: cand.kind,
        detection: cand.detection,
        trajectoryId: f.trajectoryId,
        ...(cand.anchor !== undefined ? { anchor: cand.anchor } : {}),
        ...(cand.ref !== undefined ? { ref: cand.ref } : {}),
      });
    }
  }
  // §9.4.4 M1/R2 — the subject profile: prefer the run-supplied one, else the first
  // one a judge echoed/reconstructed on its verdict file.
  const subjectProfileBase = params.subjectProfile ?? files.find((f) => f.subjectProfile !== undefined)?.subjectProfile;
  // WS-6 — reconstruct the SYSTEM PROMPT from the trace batch when the profile lacks
  // one. The eval subjectProfile never carries `systemPrompt`, but the agent's static
  // system message rides on each LLM-call observation (role:"system"). Extract it ONCE
  // from the first trace that yields one, attach it, and TAG it reconstructed (added to
  // `inferredFields` ⇒ the entity hero shows the "system prompt · reconstructed"
  // collapsible). NEVER confabulate: if no trace carries a system message, leave it
  // UNAVAILABLE. If no profile exists at all but a system prompt is recoverable, mint a
  // MINIMAL reconstructed profile so the recovered prompt still surfaces.
  let reconstructedSystemPrompt: string | undefined;
  if (subjectProfileBase?.systemPrompt === undefined || subjectProfileBase.systemPrompt.trim() === "") {
    for (const t of params.traces ?? []) {
      const sys = reconstructSystemPrompt(t);
      if (sys !== undefined) {
        reconstructedSystemPrompt = sys;
        break;
      }
    }
  }
  const subjectProfile: SubjectProfile | undefined =
    reconstructedSystemPrompt !== undefined
      ? ({
          ...(subjectProfileBase ?? { provenance: "reconstructed" }),
          systemPrompt: reconstructedSystemPrompt,
          inferredFields: Array.from(
            new Set([...(subjectProfileBase?.inferredFields ?? []), "systemPrompt"]),
          ),
        } as SubjectProfile)
      : subjectProfileBase;

  // ── coverage: byVerdict tally over the ledger ──
  const byVerdict: Record<string, number> = { PASS: 0, FAIL: 0, INDETERMINATE: 0, INCOMPLETE: 0 };
  for (const r of ledger) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const coverage = {
    judged: ledger.length,
    triaged: params.triaged ?? ledger.length,
    byVerdict,
    gapNote:
      ledger.length > 0
        ? `${ledger.length} trajectory verdict(s) folded; every in-scope trajectory carries a per-criterion judgement (0 silently dropped).`
        : "no per-trajectory verdict files supplied for this render — scorecard-only.",
  };

  // ── cohorts: criteria × route cohort (route defaults to "all") ──
  const counts: Record<string, number> = {};
  const matrix: Record<string, Record<string, { pass: number; fail: number; indeterminate: number }>> = {};
  for (const r of ledger) {
    const cohort = r.route ?? "all";
    counts[cohort] = (counts[cohort] ?? 0) + 1;
    for (const [cid, res] of Object.entries(r.perCriterion)) {
      if (res === "na") continue;
      matrix[cid] ??= {};
      matrix[cid][cohort] ??= { pass: 0, fail: 0, indeterminate: 0 };
      if (res === OutcomeVerdict.Pass) matrix[cid][cohort].pass += 1;
      else if (res === OutcomeVerdict.Fail) matrix[cid][cohort].fail += 1;
      else matrix[cid][cohort].indeterminate += 1;
    }
  }

  // ── per-criterion roll (over the ledger). WS-5 — the applicable denominator EXCLUDES
  //    `na` (precondition absent); the remaining `uncertain` are GENUINE needs-evidence
  //    (the precondition-absent uncertains were already reclassified to `na` above). ──
  function rollOf(cid: string): {
    applicable: number;
    pass: number;
    fail: number;
    needsEvidence: number;
    na: number;
    example?: string;
  } {
    let applicable = 0,
      pass = 0,
      fail = 0,
      needsEvidence = 0,
      na = 0;
    let example: string | undefined;
    for (const r of ledger) {
      const res = r.perCriterion[cid];
      if (res === undefined) continue;
      if (res === "na") {
        na += 1;
        continue;
      }
      applicable += 1;
      if (res === OutcomeVerdict.Fail) {
        fail += 1;
        example ??= r.trajectoryId;
      } else if (res === OutcomeVerdict.Uncertain) {
        needsEvidence += 1;
        example ??= r.trajectoryId;
      } else pass += 1;
    }
    return { applicable, pass, fail, needsEvidence, na, ...(example !== undefined ? { example } : {}) };
  }

  // #6 — the AUDITABLE second-judge note: surfaces that an INDEPENDENT verifier ran
  // over a gating fail and what it concluded (upheld vs refuted→downgraded), so the
  // report shows the refutation result (not just "eligible for"). PURE.
  function ivNote(folded?: CriterionVerdict): string {
    const iv = folded?.independentVerify;
    if (iv === undefined) return "";
    const who = iv.reviewerId !== undefined ? ` (${iv.reviewerId})` : "";
    return ` · [INDEPENDENT VERIFY — 2nd judge${who}: ${iv.upheld ? "UPHELD" : "REFUTED → downgraded"}; ${iv.reason}]`;
  }

  // ── gating-criteria rolls (the gating subset; GA-D2b applicable denominator) ──
  const gatingCriteria: GatingRoll[] = [...gatingIds]
    .map((cid) => {
      const roll = rollOf(cid);
      const passRate = roll.applicable > 0 ? Math.round((100 * roll.pass) / roll.applicable) : 100;
      const folded = params.verdicts.find((v) => v.criterionId === cid);
      return {
        criterion: cid,
        severity: sevById.get(cid) ?? "MED",
        applicable: roll.applicable,
        fail: roll.fail,
        indeterminate: roll.needsEvidence,
        na: roll.na,
        passRateOverApplicable: passRate,
        denominatorNote: `N/A excluded — denominator = ${roll.applicable} applicable (na ${roll.na} dropped, GA-D2b)`,
        ...(folded?.critique ? { root: folded.critique + ivNote(folded) } : {}),
      };
    })
    .sort((a, b) => a.passRateOverApplicable - b.passRateOverApplicable);

  // ── WS-5 — per-criterion INDETERMINATE resolution chain (ALL criteria, not just
  //    gating). Splits each criterion's indeterminate into N/A (precondition absent,
  //    denominator-excluded) vs needs-evidence (carries aggregated chain next-actions).
  //    The reasons/next-actions are aggregated from each trace's deterministic
  //    `indeterminateResolution`. ──
  const criterionResolutions: CriterionResolution[] = params.criteria.map((c) => {
    const roll = rollOf(c.id);
    const naReasons: Record<string, number> = {};
    const actionAgg: Record<string, { count: number; reason: string }> = {};
    for (const r of ledger) {
      const res = r.indeterminateResolution?.[c.id];
      if (res === undefined) continue;
      if (res.resolutionClass === "na") naReasons[res.reason] = (naReasons[res.reason] ?? 0) + 1;
      else if (res.nextAction !== undefined) {
        const a = (actionAgg[res.nextAction] ??= { count: 0, reason: res.reason });
        a.count += 1;
      }
    }
    const naReason = Object.entries(naReasons).sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      criterion: c.id,
      severity: c.severity,
      applicable: roll.applicable,
      pass: roll.pass,
      fail: roll.fail,
      na: roll.na,
      needsEvidence: roll.needsEvidence,
      passRateOverApplicable: roll.applicable > 0 ? Math.round((100 * roll.pass) / roll.applicable) : 100,
      ...(naReason !== undefined ? { naReason } : {}),
      nextActions: Object.entries(actionAgg)
        .map(([action, v]) => ({ action: action as IndeterminateNextAction, count: v.count, reason: v.reason }))
        .sort((a, b) => b.count - a.count),
    };
  });

  // ── top findings: every criterion with ≥1 applicable fail, worst-first ──
  const topFindings: TopFinding[] = params.criteria
    .map((c) => {
      const roll = rollOf(c.id);
      const prev = roll.applicable > 0 ? Math.round((100 * roll.fail) / roll.applicable) : 0;
      const folded = params.verdicts.find((v) => v.criterionId === c.id);
      return {
        criterion: c.id,
        severity: c.severity,
        applicable: roll.applicable,
        failCount: roll.fail,
        prevalencePctOverApplicable: prev,
        ...(folded?.critique ? { root: folded.critique + ivNote(folded) } : {}),
        ...(roll.example !== undefined ? { exampleTraceId: roll.example } : {}),
      };
    })
    .filter((f) => f.failCount > 0)
    .sort((a, b) => b.prevalencePctOverApplicable - a.prevalencePctOverApplicable || b.failCount - a.failCount);

  // ── judge-health: grounded% (verdicts citing refs) · abstention% · symptom% ──
  const allV = files.flatMap((f) => f.verdicts);
  // UI-12-B — groundedPct is computed over DECIDED verdicts ONLY. An `uncertain`
  // abstain carries empty refs BY DESIGN (it's blockedBy / na for grounding, NOT
  // "ungrounded"), so counting it in the denominator dilutes the honest grounded
  // rate (a clean 100%-of-decided run reads e.g. ~92% just because some rows abstained).
  // Abstains are surfaced separately as the abstention rate. When there are NO decided
  // verdicts to ground (all abstained / none judged), groundedPct is undefined →
  // the cell renders "capture-unavailable" (never a fabricated 100%/0%).
  const decidedV = allV.filter((v) => v.result !== OutcomeVerdict.Uncertain);
  const grounded = decidedV.filter((v) => (v.refs?.length ?? 0) > 0).length;
  const abstained = allV.filter((v) => v.result === OutcomeVerdict.Uncertain).length;
  const symptom = ledger.filter((r) => r.health?.stoppedAtSymptom).length;
  const judgeHealth = {
    ...(decidedV.length > 0 ? { groundedPct: Math.round((100 * grounded) / decidedV.length) } : {}),
    abstentionRatePct: allV.length > 0 ? Math.round((100 * abstained) / allV.length) : 0,
    stoppedAtSymptomPct: ledger.length > 0 ? Math.round((100 * symptom) / ledger.length) : 0,
  };

  // WS-3 — derive the §5 Self-Eval AGGREGATE (behavior map + 9 components) from the
  // SAME parsed files + ledger. Deterministic; the emit-completeness meter (5.7) reads
  // the WS-1 gate. PURE — no extra dispatch (lean ~0 latency).
  const selfEval = deriveSelfEval({ ledger, criteria: params.criteria, emit: assessEmitCompleteness(files) });

  return {
    subject: params.subject,
    scorecard: params.scorecard,
    verdicts: params.verdicts,
    criteria: params.criteria,
    ledger,
    selfEval,
    coverage,
    cohorts: { counts, matrix },
    gatingCriteria,
    criterionResolutions,
    topFindings,
    detectedFlags,
    judgeHealth,
    ...(Object.keys(toolObservations).length > 0 ? { toolObservations } : {}),
    ...(subjectProfile !== undefined ? { subjectProfile } : {}),
    ...(params.sourceMap !== undefined ? { sourceMap: params.sourceMap } : {}),
    ...(params.runConfig !== undefined ? { runConfig: params.runConfig } : {}),
    handover: params.handover ?? null,
    generatedAt: params.generatedAt,
  };
}

// ── WS-3 §5 Self-Eval — the AGGREGATE judge-calibration derivation ────────────

/** WS-3 — one behavior cluster in the §5.0 Judge Behavior Map. */
export interface BehaviorCluster {
  label: string;
  count: number;
  /** good | warn | bad | neutral — drives the chip tint. */
  tone: string;
  note: string;
}

/** WS-3 — the §5 Self-Eval AGGREGATE: a deterministic judge-calibration roll-up over
 *  the WHOLE population of verdicts (NOT per-trace). Each field maps to a wireframe
 *  component; panels that need ground-truth the run does not have are MARKED proxy. */
export interface SelfEvalAggregate {
  /** the headline trust band (0..100 + label + the basis sentence). */
  trust: { score: number; label: string; basis: string };
  /** 5.0 Judge Behavior Map — how the judge handled the population. */
  behaviorMap: {
    total: number;
    verdict: { pass: number; fail: number; indeterminate: number; incomplete: number };
    resolution: { walk: number; noWalk: number; truncated: number };
    clusters: BehaviorCluster[];
    /** where fails CONCENTRATE (top criteria by fail count). */
    concentration: { id: string; statement: string; fails: number; pct: number }[];
  };
  /** 5.1 Reference Integrity — grounded-ref presence over decided verdicts. */
  refIntegrity: { decided: number; grounded: number; ungrounded: number; groundedPct: number; note: string };
  /** 5.2 Confidence Calibration — verdicts bucketed by confidence band. */
  confidence: { band: string; count: number; pct: number }[];
  /** 5.3 Per-Criterion Reliability. */
  perCriterion: {
    id: string;
    statement: string;
    severity: string;
    pass: number;
    fail: number;
    unc: number;
    na: number;
    groundedPct: number;
    flag: string;
  }[];
  /** 5.4 Criterion Value / Applicability Audit. */
  criterionValue: { id: string; statement: string; severity: string; applicablePct: number; fails: number; verdict: string }[];
  /** 5.5 Diligence / Trace Coverage. */
  diligence: { examined: number; total: number; avgGroundingRefs: number; note: string };
  /** 5.6 Reasoning Transparency (blocked-aware). */
  transparency: { m2Pct: number; m3Pct: number; walkPct: number; blocked: boolean; note: string };
  /** 5.7 Emit-Completeness — the WS-1 self-honesty meter. */
  emit: EmitCompleteness;
  /** 5.8 Spot-Check / Disagreement queue — the brittle verdicts worth an operator look. */
  spotCheck: { trace: string; criterion: string; verdict: string; conf: string; reason: string }[];
}

/** WS-3 — derive the §5 Self-Eval aggregate. PURE + deterministic (sorted outputs). */
export function deriveSelfEval(args: {
  ledger: LedgerRow[];
  criteria: ReportCriterion[];
  emit: EmitCompleteness;
}): SelfEvalAggregate {
  const { ledger, criteria, emit } = args;
  const total = ledger.length;
  const critById = new Map(criteria.map((c) => [c.id, c]));

  // ── verdict + resolution tallies ──
  const verdict = { pass: 0, fail: 0, indeterminate: 0, incomplete: 0 };
  const resolution = { walk: 0, noWalk: 0, truncated: 0 };
  for (const r of ledger) {
    const v = (r.verdict || "").toUpperCase();
    if (v === "PASS") verdict.pass++;
    else if (v === "FAIL") verdict.fail++;
    else if (v === "INCOMPLETE") verdict.incomplete++;
    else verdict.indeterminate++;
    if (r.resolution === "judge-walk") resolution.walk++;
    else if (r.resolution === "truncated") resolution.truncated++;
    else resolution.noWalk++;
  }

  // ── per-criterion roll-up (pass/fail/unc/na + grounding) ──
  type Agg = { pass: number; fail: number; unc: number; na: number; refd: number; decided: number };
  const agg = new Map<string, Agg>();
  for (const c of criteria) agg.set(c.id, { pass: 0, fail: 0, unc: 0, na: 0, refd: 0, decided: 0 });
  for (const r of ledger) {
    for (const [cid, res] of Object.entries(r.perCriterion)) {
      const a = agg.get(cid);
      if (!a) continue;
      if (res === "pass") a.pass++;
      else if (res === "fail") a.fail++;
      else if (res === "uncertain" || res === "indeterminate") a.unc++;
      else a.na++;
    }
    for (const cv of r.criterionVerdicts ?? []) {
      const a = agg.get(cv.criterionId);
      if (!a) continue;
      const decided = cv.result === "pass" || cv.result === "fail";
      if (decided) {
        a.decided++;
        if ((cv.refs?.length ?? 0) > 0) a.refd++;
      }
    }
  }

  const perCriterion = criteria.map((c) => {
    const a = agg.get(c.id)!;
    const groundedPct = a.decided > 0 ? Math.round((100 * a.refd) / a.decided) : 100;
    const flag = a.fail > 0 ? "fails-present" : a.pass + a.fail + a.unc === 0 ? "never-applies" : "solid";
    return { id: c.id, statement: c.statement, severity: c.severity, pass: a.pass, fail: a.fail, unc: a.unc, na: a.na, groundedPct, flag };
  });

  // 5.4 criterion value: applicable% + ever-fails → keep/low-value verdict.
  const criterionValue = criteria.map((c) => {
    const a = agg.get(c.id)!;
    const applicable = a.pass + a.fail + a.unc;
    const denom = applicable + a.na;
    const applicablePct = denom > 0 ? Math.round((100 * applicable) / denom) : 0;
    const everFails = a.fail > 0;
    const verdictTag = applicable === 0 ? "never-applies → review" : everFails ? "keep — discriminates" : "keep — guards";
    return { id: c.id, statement: c.statement, severity: c.severity, applicablePct, fails: a.fail, verdict: verdictTag };
  });

  // 5.0 concentration — where fails concentrate (top criteria by fail count).
  const concentration = perCriterion
    .filter((p) => p.fail > 0)
    .sort((a, b) => b.fail - a.fail)
    .slice(0, 6)
    .map((p) => ({ id: p.id, statement: p.statement, fails: p.fail, pct: total > 0 ? Math.round((100 * p.fail) / total) : 0 }));

  // 5.1 ref integrity — grounded-ref presence over decided verdicts (population).
  let decided = 0;
  let groundedRefs = 0;
  let totalRefs = 0;
  for (const r of ledger) {
    for (const cv of r.criterionVerdicts ?? []) {
      if (cv.result === "pass" || cv.result === "fail") {
        decided++;
        const n = cv.refs?.length ?? 0;
        totalRefs += n;
        if (n > 0) groundedRefs++;
      }
    }
  }
  const refIntegrity = {
    decided,
    grounded: groundedRefs,
    ungrounded: decided - groundedRefs,
    groundedPct: decided > 0 ? Math.round((100 * groundedRefs) / decided) : 100,
    note:
      `${totalRefs} structured {obs,path,value} refs cited across ${decided} decided verdicts. ` +
      "Presence is checked here; full resolveRef-against-trace (GA-1) is the engine readiness gate.",
  };

  // 5.2 confidence calibration — bucket decided verdicts by confidence band.
  const bands: { band: string; lo: number; hi: number }[] = [
    { band: "0.9–1.0", lo: 0.9, hi: 1.01 },
    { band: "0.7–0.9", lo: 0.7, hi: 0.9 },
    { band: "0.5–0.7", lo: 0.5, hi: 0.7 },
    { band: "<0.5", lo: -1, hi: 0.5 },
  ];
  const bandCount = bands.map(() => 0);
  let confTotal = 0;
  for (const r of ledger) {
    for (const cv of r.criterionVerdicts ?? []) {
      const conf = typeof cv.confidence === "number" ? cv.confidence : undefined;
      if (conf === undefined) continue;
      confTotal++;
      const i = bands.findIndex((b) => conf >= b.lo && conf < b.hi);
      if (i >= 0) bandCount[i]++;
    }
  }
  const confidence = bands.map((b, i) => ({
    band: b.band,
    count: bandCount[i],
    pct: confTotal > 0 ? Math.round((100 * bandCount[i]) / confTotal) : 0,
  }));

  // 5.5 diligence — traces examined + avg grounding refs per trace.
  const examined = ledger.filter((r) => (r.criterionVerdicts?.length ?? 0) > 0).length;
  const avgGroundingRefs = examined > 0 ? Math.round((10 * totalRefs) / examined) / 10 : 0;
  const diligence = {
    examined,
    total,
    avgGroundingRefs,
    note: `${examined}/${total} trajectories carry ≥1 per-criterion judge verdict; avg ${avgGroundingRefs} grounding refs cited per examined trace.`,
  };

  // 5.6 transparency — read off the emit-completeness (blocked when M2 is 0%).
  const fieldPct = (f: string): number => emit.fields.find((x) => x.field === f)?.pct ?? 0;
  const transparency = {
    m2Pct: fieldPct("understanding"),
    m3Pct: fieldPct("expectedTrajectory"),
    walkPct: fieldPct("judgeSteps"),
    blocked: fieldPct("understanding") === 0,
    note:
      fieldPct("understanding") === 0
        ? "BLOCKED — the judge did not persist M2 understanding / M3 expected-trajectory (emit-contract gap, §5.7). A fresh run with the hardened contract captures them."
        : "the judge's train-of-thought (M2 understanding · M3 expected-trajectory) is captured and auditable.",
  };

  // 5.8 spot-check queue — the brittle verdicts (fails + low-confidence) worth a look.
  const spotCheck: SelfEvalAggregate["spotCheck"] = [];
  for (const r of ledger) {
    for (const cv of r.criterionVerdicts ?? []) {
      const conf = typeof cv.confidence === "number" ? cv.confidence : undefined;
      const lowConf = conf !== undefined && conf < 0.6;
      const isFail = cv.result === "fail";
      if (!lowConf && !isFail) continue;
      spotCheck.push({
        trace: r.trajectoryId,
        criterion: critById.get(cv.criterionId)?.statement ?? cv.criterionId,
        verdict: String(cv.result || "").toUpperCase(),
        conf: conf !== undefined ? conf.toFixed(2) : "—",
        reason: isFail ? (lowConf ? "FAIL · low-confidence" : "FAIL") : "low-confidence call",
      });
    }
  }
  spotCheck.sort((a, b) => (a.conf === "—" ? 1 : b.conf === "—" ? -1 : Number(a.conf) - Number(b.conf)));
  const spotCheckTop = spotCheck.slice(0, 20);

  // headline trust band — a conservative composite (grounding · emit-completeness · fail-concentration).
  const emitPct = emit.completePct;
  const trustScore = Math.round(0.5 * refIntegrity.groundedPct + 0.5 * emitPct);
  const trustLabel =
    transparency.blocked || emitPct < 50
      ? "PARTIAL — reasoning transparency blocked by the emit-contract gap"
      : trustScore >= 85
        ? "STRONG — grounded + transparent"
        : "MODERATE — grounded, transparency improving";
  const trust = {
    score: trustScore,
    label: trustLabel,
    basis: `grounding ${refIntegrity.groundedPct}% of decided verdicts · emit-completeness ${emitPct}% · ${verdict.fail} failing trajectories across ${total}.`,
  };

  return {
    trust,
    behaviorMap: { total, verdict, resolution, clusters: behaviorClusters(verdict, resolution, total), concentration },
    refIntegrity,
    confidence,
    perCriterion,
    criterionValue,
    diligence,
    transparency,
    emit,
    spotCheck: spotCheckTop,
  };
}

/** WS-3 — derive the §5.0 behavior clusters from the population tallies. PURE. */
function behaviorClusters(
  verdict: { pass: number; fail: number; indeterminate: number; incomplete: number },
  resolution: { walk: number; noWalk: number; truncated: number },
  total: number,
): BehaviorCluster[] {
  const pct = (n: number): number => (total > 0 ? Math.round((100 * n) / total) : 0);
  const out: BehaviorCluster[] = [
    { label: "Passed (criteria satisfied)", count: verdict.pass, tone: "good", note: `${pct(verdict.pass)}% of the population judged PASS on all applicable criteria.` },
    { label: "Failed (≥1 criterion)", count: verdict.fail, tone: "bad", note: `${pct(verdict.fail)}% carry ≥1 failing criterion — the discriminating cases.` },
    { label: "Abstained (indeterminate)", count: verdict.indeterminate, tone: "warn", note: `${pct(verdict.indeterminate)}% abstained — inputs could not decide (blockedBy), routed to calibration not gate.` },
    { label: "Truncated (INCOMPLETE)", count: verdict.incomplete, tone: "neutral", note: `${pct(verdict.incomplete)}% gated INCOMPLETE by the node-1 fidelity short-circuit (never walked).` },
    { label: "Walk captured", count: resolution.walk, tone: "good", note: `${pct(resolution.walk)}% persisted the full §9.4 judge walk (target lane + anchored reasoning).` },
    { label: "Walk dropped (judged)", count: resolution.noWalk, tone: "warn", note: `${pct(resolution.noWalk)}% were judged but did NOT persist the structured walk — the emit-contract gap (§5.7).` },
  ];
  return out.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
}

// ── §1 Overview ──────────────────────────────────────────────────────────────

/**
 * Overview-redesign — the full-width ENTITY HERO card: rich subject identity from the
 * §9.4.4 M1 subject profile (name · entityType · purpose · tools · skill · scope ·
 * version · code-access · system-prompt). HONEST: a field the profile cannot establish
 * renders the `unknown` sentinel (never confabulated); an INFERRED (reconstructed)
 * field carries an `inferred` honesty chip; the system prompt is COLLAPSED. PURE.
 */
function entityHero(input: EvalReportInput): string {
  const p = input.subjectProfile;
  const inferred = new Set(p?.inferredFields ?? []);
  const name = p?.identity ?? input.subject.name;
  const codeAccess = p?.provenance ?? "reconstructed";
  // §9.4.5 E1 — TRACE-ONLY when there is no code access (reconstructed profile, or no
  // profile at all). Drives the honest "CODE-ACCESS: NONE · trace-only" header + the
  // UNAVAILABLE (never-confabulated) marking of harness + system-prompt.
  const isTraceOnly = codeAccess !== "given";
  const nTraces =
    input.sourceMap?.traceCount ?? input.coverage?.judged ?? input.ledger?.length ?? 0;

  // a value cell: shows the value, or the `unknown` sentinel when absent; an `inferred`
  // chip flags a reconstructed (not-given) field so given-vs-inferred is honest.
  const cell = (value: string | undefined, key?: string): string => {
    const has = typeof value === "string" && value.trim().length > 0 && value !== PROFILE_UNKNOWN;
    const body = has ? esc(value as string) : `<span class="unk">${esc(PROFILE_UNKNOWN)}</span>`;
    const inf = key !== undefined && inferred.has(key) ? ` <span class="inf">inferred</span>` : "";
    return `${body}${inf}`;
  };

  // §9.4.5 E2 — tools as diagnostics-style CHIPS with a per-tool OBSERVED call-count
  // ("obs N", from the trajectory agent-steps) instead of a flat comma list. In the
  // trace-only case this is the only honest tool evidence (what was actually called).
  const obs = input.toolObservations ?? {};
  const tools = p?.tools ?? [];
  const toolsInferred = inferred.has("tools");
  const toolChips =
    tools.length > 0
      ? tools
          .map((t) => {
            const n = obs[t] ?? 0;
            const count =
              n > 0
                ? ` <b class="obs" title="observed ${n} call(s) across the judged trajectories">obs ${n}</b>`
                : ` <b class="obs none" title="present in the inventory; 0 calls observed in the judged trajectories">obs 0</b>`;
            return `<span class="tchip">${esc(t)}${count}</span>`;
          })
          .join("")
      : `<span class="unk">${esc(PROFILE_UNKNOWN)}</span>`;
  const toolsCell =
    `<div class="tchips">${toolChips}${toolsInferred ? ` <span class="inf">inferred</span>` : ""}</div>`;

  const targetModels = (input.subject.models ?? []).join(", ");

  // §9.4.5 E1 — harness is UNAVAILABLE (never confabulated) in the trace-only case.
  const harnessHas = typeof p?.harness === "string" && p.harness.trim().length > 0 && p.harness !== PROFILE_UNKNOWN;
  const harnessCell = harnessHas
    ? cell(p?.harness, "harness")
    : `<span class="unk">${esc(PROFILE_UNKNOWN)}</span> <span class="recon-note">UNAVAILABLE — ${isTraceOnly ? "reconstructed, never confabulated" : "not supplied"}</span>`;

  const rows: [string, string][] = [
    ["purpose", cell(p?.purpose, "purpose")],
    ["tools", toolsCell],
    ["skill", cell(p?.skill, "skill")],
    ["scope", cell(p?.scope, "scope")],
    ["harness", harnessCell],
    ["source", cell(input.subject.source)],
    ["org", cell(input.subject.org)],
    ["target model(s)", cell(targetModels)],
  ];
  const grid = rows.map(([k, v]) => `<div class="hk">${esc(k)}</div><div class="hv">${v}</div>`).join("");

  // version + entityType + code-access provenance ride in the hero header.
  const verChip = p?.version ? `<span class="hchip">v ${esc(p.version)}</span>` : "";
  const typeChip = `<span class="hchip type">${cell(p?.entityType, "entityType")}</span>`;
  // §9.4.5 E1 — code-access chip: GIVEN reads green; trace-only reads the explicit
  // "NONE · trace-only" so a reader never mistakes a reconstructed profile for a known one.
  const accessChip = isTraceOnly
    ? `<span class="hchip access recon">code-access: NONE · trace-only</span>`
    : `<span class="hchip access given">code-access: given</span>`;

  // system prompt — present when GIVEN (code access) OR RECONSTRUCTED from the traces
  // (UI-14). `inferred.has("systemPrompt")` distinguishes the two for the provenance tag.
  const sysHas = typeof p?.systemPrompt === "string" && p.systemPrompt.trim().length > 0;
  const sysReconstructed = inferred.has("systemPrompt");

  // §9.4.5 E1 — the trace-reconstructed banner: only when trace-only. States the N traces
  // the identity/tools were inferred from. The system prompt is now RECONSTRUCTED from the
  // batch when an LLM call carried it (UI-14); only harness stays UNAVAILABLE in that case.
  const reconLine = isTraceOnly
    ? `<div class="hrecon">⟲ TRACE-RECONSTRUCTED · inferred from ${esc(nTraces)} trace(s) — identity + tools${sysHas ? " + system-prompt" : ""} observed from the batch; harness${sysHas ? "" : " + system-prompt"} UNAVAILABLE (never confabulated).</div>`
    : "";

  // system prompt — COLLAPSED (it can be tens of KB); carries a provenance tag —
  // "RECONSTRUCTED · from traces" when derived from a GENERATION message list, or
  // "given" under code access. Marked UNAVAILABLE only when genuinely not found
  // (never confabulated).
  const sysProvTag = sysReconstructed
    ? `<span class="hsys-prov recon">RECONSTRUCTED · from traces</span>`
    : `<span class="hsys-prov given">given · code access</span>`;
  const sysPrompt = sysHas
    ? `<details class="hsys"><summary>system prompt ${sysProvTag}</summary><pre>${esc(p?.systemPrompt)}</pre></details>`
    : `<div class="hsys-na">system prompt — <span class="unk">${esc(PROFILE_UNKNOWN)}</span> · UNAVAILABLE (${isTraceOnly ? "reconstructed, no code access — never confabulated" : "not supplied"})</div>`;

  // honesty footer: which fields are inferred (reconstructed), not given.
  const infList = [...inferred];
  const honesty =
    infList.length > 0
      ? `<div class="hhonesty"><span class="inf">inferred</span> ${esc(infList.join(" · "))} — reconstructed from the trace batch, not given. The rest is GIVEN (code/metadata access).</div>`
      : `<div class="hhonesty"><span class="inf given">all given</span> every field supplied with code/metadata access — nothing reconstructed.</div>`;

  return (
    `<div class="hero">` +
    `<div class="hero-top"><div class="hname">${esc(name)}</div>${typeChip}${verChip}${accessChip}</div>` +
    reconLine +
    `<div class="hero-grid">${grid}</div>` +
    sysPrompt +
    honesty +
    `</div>`
  );
}

/**
 * Overview-redesign — the thin PROVENANCE meta-strip under the header: the RUN config
 * (run-id · date · source · JUDGE substrate · pinned judge model · temp-0 · C-PIN).
 * The JUDGE substrate + model are DISTINCT from the TARGET model under eval. Defaults
 * that are ALWAYS true for this engine (agent-dispatch host runtime · temp 0 · C-PIN)
 * fill in when no run-config is threaded; a genuinely-unavailable field is MARKED. PURE.
 */
function provenanceStrip(input: EvalReportInput): string {
  const rc = input.runConfig ?? {};
  const substrate = rc.judgeSubstrate ?? "agent-dispatch";
  const temp = rc.temperature ?? 0;
  const cPin = rc.cPin !== false; // C-PIN is the engine default
  const date = rc.date ?? input.generatedAt;
  const source = rc.source ?? input.subject.source;
  const unk = `<span class="unk">${esc(PROFILE_UNKNOWN)}</span>`;
  const v = (val: string | undefined): string =>
    typeof val === "string" && val.trim().length > 0 ? esc(val) : unk;
  const item = (label: string, body: string): string =>
    `<span class="ps-item"><span class="ps-k">${esc(label)}</span><span class="ps-v">${body}</span></span>`;
  return (
    `<div class="provstrip">` +
    item("run-id", v(rc.runId)) +
    item("date", v(date)) +
    item("source", v(source)) +
    item("judge substrate", esc(substrate)) +
    item("judge model", v(rc.judgeModel)) +
    item("temp", esc(`temp ${temp}`)) +
    `<span class="ps-item"><span class="ps-badge ${cPin ? "on" : "off"}">${cPin ? "C-PIN" : "no C-PIN"}</span></span>` +
    `</div>`
  );
}

/**
 * Overview-redesign — the segmented COVERAGE FUNNEL: ingested → triaged → judged →
 * outcomes. INCOMPLETE is a FIRST-CLASS outcome (a distinct segment from indeterminate:
 * one is "trace too truncated to judge", the other is "judged but not certain"). Counts
 * read from `coverage.{triaged,judged,byVerdict}` + the source-map trace count. PURE.
 */
function coverageFunnel(input: EvalReportInput): string {
  const cov = input.coverage ?? {};
  const bv = cov.byVerdict ?? {};
  const judged = cov.judged ?? input.ledger?.length ?? 0;
  const triaged = cov.triaged ?? judged;
  const ingested = input.sourceMap?.traceCount ?? triaged;
  const stage = (label: string, n: number, note: string): string =>
    `<div class="fstage"><div class="fn">${esc(n)}</div><div class="fl">${esc(label)}</div><div class="fnote">${esc(note)}</div></div>`;
  const arrow = `<div class="farrow">›</div>`;
  // the OUTCOME segment — four FIRST-CLASS buckets, INCOMPLETE separate from indeterminate.
  const outcomes: [string, number, string][] = [
    ["pass", bv.PASS ?? 0, "pass"],
    ["fail", bv.FAIL ?? 0, "fail"],
    ["indeterminate", bv.INDETERMINATE ?? 0, "indet"],
    ["incomplete", bv.INCOMPLETE ?? 0, "inc"],
  ];
  const outcomePills = outcomes
    .map(([l, n, cls]) => `<div class="fpill ${cls}"><b>${esc(n)}</b> ${esc(l)}</div>`)
    .join("");
  return (
    `<div class="funnel">` +
    stage("Ingested", ingested, "traces pulled from source") +
    arrow +
    stage("Triaged", triaged, "tier-0 + fidelity gate") +
    arrow +
    stage("Judged", judged, "per-criterion verdicts") +
    arrow +
    `<div class="fstage outc"><div class="fl">Outcomes</div><div class="foutc">${outcomePills}</div></div>` +
    `</div>`
  );
}

/**
 * §9.4.5 E3 — the eval-HEALTH temporal heatmap: CORRECTNESS over time (NOT latency —
 * latency belongs to diagnostics). Each bucket is an hour window; its COLOUR is the
 * pass-rate over the trajectories judged in that window (fail-clustering pops as a red
 * window → a deploy/incident regression signal), and its NUMBER is the count of
 * trajectories judged in the bucket. Computed from the ledger verdicts + the per-trace
 * timestamps (E3 data path). When NO trajectory carries a timestamp, the heatmap renders
 * its STRUCTURE with a single data-pending cell + an explicit note (never faked). PURE.
 */
function evalHealthHeatmap(input: EvalReportInput): string {
  const ledger = input.ledger ?? [];
  const timed = ledger.filter((r) => typeof r.timestamp === "string" && (r.timestamp as string).length >= 13);
  const head = `<h3>eval-health over time — correctness, not latency</h3>`;

  if (timed.length === 0) {
    // structure + data-pending: the wiring is live, the batch just lacks timestamps.
    return (
      head +
      `<div class="ehm" data-pending="1">` +
      `<div class="ehm-cell skip" title="awaiting timestamped traces">·</div>` +
      `</div>` +
      `<div class="ehm-pending">⏲ data-pending — no per-trace timestamps in this batch. Correctness-over-time wiring is active; it renders real pass-rate windows as soon as the source carries trace timestamps.</div>`
    );
  }

  // bucket by hour window (ISO "YYYY-MM-DDTHH"), deterministic chronological order.
  const buckets = new Map<string, { judged: number; pass: number; fail: number }>();
  for (const r of timed) {
    const key = (r.timestamp as string).slice(0, 13); // YYYY-MM-DDTHH
    const b = buckets.get(key) ?? { judged: 0, pass: 0, fail: 0 };
    b.judged += 1;
    const v = r.verdict.toUpperCase();
    if (v === "PASS") b.pass += 1;
    else if (v === "FAIL") b.fail += 1; // INCOMPLETE/INDETERMINATE count as judged, not in the rate
    buckets.set(key, b);
  }
  const keys = [...buckets.keys()].sort();
  const cells = keys
    .map((k) => {
      const b = buckets.get(k)!;
      const denom = b.pass + b.fail;
      const rate = denom > 0 ? Math.round((100 * b.pass) / denom) : -1;
      const cls = rate < 0 ? "skip" : rate < 80 ? "fail" : rate < 95 ? "indet" : "pass";
      const hour = k.slice(11, 13);
      const day = k.slice(5, 10);
      const title = `${esc(k)}:00 — ${b.judged} judged · ${b.pass} pass / ${b.fail} fail${rate >= 0 ? ` · ${rate}% pass-rate` : " · rate n/a"}`;
      return (
        `<div class="ehm-col">` +
        `<div class="ehm-cell ${cls}" title="${title}">${esc(b.judged)}</div>` +
        `<div class="ehm-lab">${esc(day)}<br>${esc(hour)}h</div>` +
        `</div>`
      );
    })
    .join("");
  return (
    head +
    `<div class="ehm-legend">colour = pass-rate per window (<span class="sw fail"></span>&lt;80% &nbsp;<span class="sw indet"></span>&lt;95% &nbsp;<span class="sw pass"></span>≥95%) · number = trajectories judged</div>` +
    `<div class="ehm">${cells}</div>`
  );
}

function overviewTab(input: EvalReportInput): string {
  const g = input.scorecard.gate;
  const sm = input.sourceMap;
  const cov = input.coverage ?? {};
  const runVerdict = g.runVerdict ?? (g.passed ? "pass" : "fail");
  const indetCount = g.indeterminateBy?.length ?? 0;
  const verdictClass = runVerdict === "pass" ? "pass" : runVerdict === "incomplete" ? "skip" : "fail";
  const verdictText =
    runVerdict === "pass"
      ? "GATE PASS — no CRIT/HIGH criterion failed or was indeterminate."
      : runVerdict === "incomplete"
        ? `GATE INCOMPLETE — ${indetCount} CRIT/HIGH criterion/criteria indeterminate (${(g.indeterminateBy ?? []).map((x) => esc(x.criterionId)).join(", ")}). No CRIT/HIGH fail, but the run cannot be certified — NOT a pass.`
        : `GATE FAIL — ${g.gatedBy.length} gating criterion/criteria failed (${g.gatedBy.map((x) => esc(x.criterionId)).join(", ")}).`;

  // 6-tile big-stat row (theme.css .big-stat .s/.v/.l) — status-acuity: the OUTCOME
  // tiles (pass/fail/indeterminate) carry a status tint + left-accent so the eye
  // separates outcomes from the neutral COUNT tiles (criteria/trajectories/traces).
  const tileRows: [string, string, string][] = [
    ["Criteria", String(g.total), "count"],
    ["Pass", String(g.passCount), "pass"],
    ["Fail", String(g.gatedBy.length), "fail"],
    ["Indeterminate", String(indetCount), "indet"],
    ["Trajectories", String(input.ledger?.length ?? 0), "count"],
    ["Traces (coverage)", String(sm?.traceCount ?? cov.judged ?? 0), "count"],
  ];
  const tiles = tileRows
    .map(([l, v, kind]) => `<div class="s ${kind}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`)
    .join("");

  const coverageNote = cov.gapNote
    ? `<div class="note"><span class="tag">★ COVERAGE CONTRACT</span>&nbsp;${esc(cov.gapNote)}</div>`
    : sm
      ? `<div class="note"><span class="tag">★ COVERAGE CONTRACT</span>&nbsp;${esc(sm.traceCount)} trace(s) · ${esc(sm.nullOutputTraces)} with null trace-output (read from GENERATION, SV-1) · platform <code>${esc(sm.platform)}</code>.</div>`
      : "";

  // gating-criteria table — pass-rate over applicable (R4: statement + provenance + hover)
  const gating = input.gatingCriteria ?? [];
  const gatingRows =
    gating.length > 0
      ? gating
          .map((d) => {
            const c = criterionById(input, d.criterion);
            return (
              `<tr><td class="cn"><b class="mono">${esc(d.criterion)}</b> ${critHover(c)} ${provChip(c)} ${methodChip(c)}` +
              `<div class="cstmt">${esc(critStatement(c))}</div></td>` +
              `<td>${esc(d.applicable)}</td><td>${esc(d.fail)}</td>` +
              `<td style="color:${rateCol(d.passRateOverApplicable)};font-weight:600">${esc(d.passRateOverApplicable)}%</td></tr>`
            );
          })
          .join("")
      : `<tr><td colspan="4" style="color:var(--dim)">no gating criteria</td></tr>`;
  const gatingTable =
    `<h3>gating criteria — pass-rate over applicable</h3>` +
    `<table><thead><tr><th>criterion (statement · provenance)</th><th>applicable</th><th>fail</th><th>pass-rate</th></tr></thead><tbody>${gatingRows}</tbody></table>`;

  // top-findings teaser
  const teaser = (input.topFindings ?? [])
    .slice(0, 5)
    .map(
      (fd) =>
        `<div class="teaser-row"><span class="sev ${sevCls(fd.severity)}">${esc((fd.severity ?? "med").toUpperCase())}</span>` +
        `<b class="mono">${esc(fd.criterion)}</b>` +
        `<span class="teaser-num">${esc(fd.failCount)}/${esc(fd.applicable)} fail · ${esc(fd.prevalencePctOverApplicable)}%</span></div>`,
    )
    .join("");
  const teaserBlock = (input.topFindings ?? []).length > 0 ? `<h3>top findings</h3>${teaser}` : "";

  return (
    `<h2>① Overview</h2><div class="sub">subject identity · provenance · coverage · gate · top findings</div>` +
    tabDesc("What this tab shows: WHO the subject is (entity hero), HOW the run was judged (provenance strip — judge substrate + pinned model, distinct from the target), the coverage funnel (ingested → triaged → judged → outcomes, INCOMPLETE first-class), the GATE verdict, the gating criteria with their pass-rate over the applicable denominator, and a teaser of the top findings.") +
    entityHero(input) +
    provenanceStrip(input) +
    coverageFunnel(input) +
    `<div class="verdict ${verdictClass}"><strong>${esc(verdictText)}</strong></div>` +
    verdictLegend() +
    `<div class="big-stat">${tiles}</div>` +
    coverageNote +
    evalHealthHeatmap(input) +
    gatingTable +
    teaserBlock
  );
}

// ── §2 Trajectory · Judge Behaviour (ledger + drill) ─────────────────────────

function trajectoryTab(input: EvalReportInput): string {
  const ledger = input.ledger ?? [];
  if (ledger.length === 0) {
    return (
      `<h2>② Trajectory · Judge Behaviour</h2>` +
      `<div class="sub">per-trace judge ledger — no per-trajectory verdict files supplied for this render.</div>`
    );
  }
  const walks = ledger.filter((r) => r.judgeSteps && r.judgeSteps.length > 0).length;
  return (
    `<h2>② Trajectory · Judge Behaviour</h2>` +
    tabDesc("What this tab shows: the Target-Agent trajectory ‖ Judge trajectory SIDE-BY-SIDE. Click a row to drill in — the agent's steps render on the LEFT lane, the judge's reasoning walk (anchored to each step) on the RIGHT, with the judge's gather-context, expected-trajectory and root localization.") +
    `<div class="sub">all ${esc(ledger.length)} — click a row; ✦ = full agent‖judge walk (${esc(walks)} with judge_steps)</div>` +
    `<div class="lfilter">` +
    `<b class="on" data-flt="all">all</b><b data-flt="FAIL">fail</b><b data-flt="INDETERMINATE">indeterminate</b><b data-flt="PASS">pass</b>` +
    `<input id="q" placeholder="search route / trace id…"><span class="sp" id="cnt"></span></div>` +
    `<table class="ledger"><thead><tr><th>trace</th><th>route</th><th>verdict</th><th>resolution</th><th>pass</th><th>fail</th><th>indet</th><th>failing criteria</th></tr></thead><tbody id="lrows"></tbody></table>` +
    `<div id="virt" class="mono virt"></div>` +
    `<div id="drill"></div>`
  );
}

// ── §3 Eval Scorecard (heatmap + subcards + calibration) ─────────────────────

function heatmapHtml(input: EvalReportInput): string {
  const cohorts = input.cohorts;
  if (!cohorts || Object.keys(cohorts.counts).length === 0) {
    return `<div class="sub">criteria × route cohort — no per-trajectory cohort data for this render.</div>`;
  }
  const cohortKeys = Object.entries(cohorts.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([c]) => c);
  const head =
    `<span class="lab"></span>` +
    cohortKeys.map((c) => `<span class="colh">${esc(c)}<br>${esc(cohorts.counts[c] ?? 0)}</span>`).join("");
  const cids = Object.keys(cohorts.matrix).slice(0, 14);
  const rows = cids.map((cid) => {
    let cells = `<span class="lab" title="${esc(cid)}">${esc(cid.slice(0, 26))}</span>`;
    for (const co of cohortKeys) {
      const cell = cohorts.matrix[cid]?.[co];
      if (!cell) {
        cells += `<span class="cell skip"></span>`;
        continue;
      }
      const tot = cell.pass + cell.fail + cell.indeterminate;
      if (tot === 0) {
        cells += `<span class="cell skip"></span>`;
        continue;
      }
      const r = Math.round((100 * cell.pass) / tot);
      const cls = r >= 95 ? "pass" : r >= 80 ? "indet" : "fail";
      cells += `<span class="cell ${cls}" title="${esc(cid)} × ${esc(co)}: ${cell.pass}/${tot} pass">${r}</span>`;
    }
    return cells;
  });
  // UI-3 — wrap in a horizontal-scroll container so long cohort names / many cohorts
  // never overflow the page; the grid columns use minmax(0,…) so a long unbreakable
  // header word can't force the track wider than its share (it ellipsis-clips instead).
  return (
    `<div class="hm-scroll">` +
    `<div class="hm" style="grid-template-columns:150px repeat(${cohortKeys.length},minmax(58px,1fr))">` +
    head +
    rows.join("") +
    `</div>` +
    `</div>`
  );
}

/**
 * UI-5 — the success-rate + key-metrics SUMMARY row under the §3 heatmap. The heatmap
 * alone "dangled" into the subcards with no headline numbers; this anchors it with a
 * compact metrics strip (criteria pass-rate · trajectory pass-rate · indeterminate ·
 * incomplete · grounded%). All numbers derive from the scorecard gate + the folded
 * coverage + judge-health — nothing fabricated; an empty source renders 0/—. PURE.
 */
function scorecardMetrics(input: EvalReportInput): string {
  const g = input.scorecard.gate;
  const bv = input.coverage?.byVerdict ?? {};
  const judged = input.coverage?.judged ?? input.ledger?.length ?? 0;
  const critPassRate = g.total > 0 ? Math.round((100 * g.passCount) / g.total) : 100;
  const trajPass = bv.PASS ?? 0;
  const trajRate = judged > 0 ? Math.round((100 * trajPass) / judged) : 0;
  const grounded = input.judgeHealth?.groundedPct;
  const tile = (label: string, value: string, cls: string, note: string): string =>
    `<div class="scm ${cls}"><div class="scm-v">${esc(value)}</div><div class="scm-l">${esc(label)}</div><div class="scm-n">${esc(note)}</div></div>`;
  return (
    `<div class="sc-metrics">` +
    tile("criteria pass-rate", `${critPassRate}%`, rateClass(critPassRate), `${g.passCount}/${g.total} criteria pass`) +
    tile("trajectory pass-rate", `${trajRate}%`, rateClass(trajRate), `${trajPass}/${judged} trajectories pass`) +
    tile("needs-evidence", String(bv.INDETERMINATE ?? 0), (bv.INDETERMINATE ?? 0) > 0 ? "rate-mid" : "rate-ok", "precondition present, undecided (N/A excluded)") +
    tile("incomplete", String(bv.INCOMPLETE ?? 0), (bv.INCOMPLETE ?? 0) > 0 ? "rate-mid" : "rate-ok", "too truncated to judge") +
    // UI-12-B — grounded is HONEST about capture: 0 / undefined (judge emitted 0
    // structured refs) renders "capture-unavailable" (data-pending), NEVER a silent
    // green 0%; a real >0 value is colour-coded by rate (low = critical).
    (grounded === undefined || grounded === 0
      ? tile("grounded", "capture-unavailable", "rate-na pending", "judge emitted 0 structured refs — capture-unavailable")
      : tile("grounded", `${grounded}%`, rateClass(grounded), "verdicts citing evidence")) +
    `</div>`
  );
}

/**
 * WS-3 follow-up — a compact per-criterion KEY rendered DIRECTLY UNDER the §3
 * heatmap. The heatmap rows are raw technical criterion ids (e.g.
 * `send-delivery-success`); this legend maps EVERY criterion on the scorecard axis —
 * gating AND non-gating — to its one-line plain-language gloss (reusing the same
 * `plainExplainer` the Findings cards use), so no scorecard criterion is left without
 * "what it measures · why it matters". Covers ALL `input.criteria` (not the gating
 * subset). PURE — empty criteria ⇒ empty string.
 */
function criterionLegend(input: EvalReportInput): string {
  const crits = input.criteria ?? [];
  if (crits.length === 0) return "";
  const rows = crits
    .map((c) => {
      const sev = sevCls(c.severity);
      return (
        `<div class="plain plain-leg">` +
        `<span class="pl-id mono">${esc(c.id)}</span>` +
        `<span class="sev ${sev}">${esc(String(c.severity ?? "med").toUpperCase())}</span>` +
        `<span class="pl-tx">${esc(plainExplainer(c))}</span>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<div class="plain-legend">` +
    `<div class="pl-h">what each criterion measures — plain-language key (all ${crits.length})</div>` +
    rows +
    `</div>`
  );
}

function subcardsHtml(input: EvalReportInput): string {
  const gating = input.gatingCriteria ?? [];
  if (gating.length === 0) return `<div class="sub">no gating criteria to calibrate.</div>`;
  return gating
    .map((d) => {
      const sev = sevCls(d.severity);
      const c = criterionById(input, d.criterion);
      // UI-6 — the card colour is driven by SUCCESS RATE (green-ish high · amber mid ·
      // red-ish low), on a purplish base — NOT a uniform severity red. Severity stays
      // legible as its own pill in the header.
      const rate = rateClass(d.passRateOverApplicable);
      // WS-5 — the indeterminate RESOLUTION split: N/A (precondition absent, excluded
      // from the denominator) vs needs-evidence (precondition present, undecided). No
      // bare "indeterminate".
      const whyAb =
        (d.indeterminate ?? 0) > 0 || (d.na ?? 0) > 0
          ? `<div class="nest"><div class="nest-h">▾ indeterminate resolution</div><div class="row">` +
            `<span class="rz na">N/A ${esc(d.na ?? 0)}</span> precondition absent — excluded from denominator · ` +
            `<span class="rz ne">needs-evidence ${esc(d.indeterminate ?? 0)}</span> precondition present, undecided</div></div>`
          : "";
      return (
        `<div class="subc ${rate}"><div class="subc-h"><span class="sev ${sev}">${esc((d.severity ?? "med").toUpperCase())}</span>` +
        `<b>${esc(d.criterion)}</b> ${critHover(c)} ${provChip(c)} ${methodChip(c)}<span class="chip">gate</span>` +
        `<span class="vp" style="margin-left:auto;color:${rateCol(d.passRateOverApplicable)};border-color:${rateCol(d.passRateOverApplicable)}">${esc(d.passRateOverApplicable)}%</span></div>` +
        // OPERATOR-REQUESTED: the one-line plain-language "Measures / Why it matters" gloss
        // INLINE in every gating subcard (not only in the §3 legend) — so reading a gating
        // criterion's detail explains, in plain language, what it measures right there.
        plainBanner(c) +
        // UI-7 — the full criterion DEFINITION in-card (statement · pass condition ·
        // dimension/severity/level · judged-from inputs · provenance · mined details).
        `<div class="nest"><div class="nest-h">▾ criterion definition — what it is &amp; how it's judged</div>` +
        criterionDefn(c, d.criterion) +
        `</div>` +
        `<div class="nest"><div class="nest-h">▾ grounding</div><div class="row"><span class="ref">obs:</span> ${esc(d.fail)}/${esc(d.applicable)} applicable fail · ${esc((d.denominatorNote ?? "").slice(0, 90))}</div></div>` +
        `<div class="nest"><div class="nest-h">▾ verdict reasoning</div><div class="row">${esc((d.root ?? "all applicable pass").slice(0, 160))}</div></div>` +
        whyAb +
        // UI-8 — calibrate tags grouped for MUTUAL EXCLUSION (radio semantics): the
        // keep/revise/retire group and the verify/eliminate group each allow ONE active
        // selection (the client JS clears siblings within a `data-calgroup`).
        `<div class="cal"><span class="l">calibrate</span>` +
        `<span class="calgroup" data-calgroup="keep-revise-retire"><b>keep</b><b>revise</b><b>retire</b></span>` +
        `<span style="color:var(--dim)">·</span>` +
        `<span class="calgroup" data-calgroup="verify-eliminate"><b>verify</b><b>eliminate</b></span>` +
        `</div></div>`
      );
    })
    .join("");
}

/** WS-5 — a readable label for a chain next-action. */
function nextActionLabel(a: string): string {
  return a === "code-recheck"
    ? "code-recheck"
    : a === "2nd-judge"
      ? "2nd-judge"
      : a === "revise-criterion"
        ? "revise-criterion"
        : "HITL-spot-check";
}

/**
 * WS-5 — the per-criterion INDETERMINATE resolution chain (§3). For EVERY criterion
 * (gating + non-gating) it shows the denominator-honest split:
 *   applicable · pass · fail · N/A (precondition absent) · needs-evidence (+ next-action)
 * N/A is shown SEPARATELY and is NEVER in the applicable/fail denominator. A
 * needs-evidence count carries its aggregated chain next-actions + the missing-signal
 * reason — so no criterion ever shows a bare, actionless "indeterminate". PURE.
 */
function criterionResolutionTable(input: EvalReportInput): string {
  const rows = input.criterionResolutions ?? [];
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const sev = sevCls(r.severity);
      const naCell =
        r.na > 0
          ? `<span class="rz na">N/A ${esc(r.na)}</span>` +
            (r.naReason ? `<span class="rz-reason">precondition absent — ${esc(r.naReason.slice(0, 120))}</span>` : "")
          : `<span class="rz na zero">N/A 0</span>`;
      const neCell =
        r.needsEvidence > 0
          ? `<span class="rz ne">needs-evidence ${esc(r.needsEvidence)}</span>` +
            r.nextActions
              .map(
                (a) =>
                  `<span class="rz-act">→ ${esc(nextActionLabel(a.action))} ×${esc(a.count)}` +
                  `<span class="rz-reason">${esc(a.reason.slice(0, 120))}</span></span>`,
              )
              .join("")
          : `<span class="rz ne zero">needs-evidence 0</span>`;
      return (
        `<div class="rzrow ${sev}">` +
        `<div class="rz-h"><span class="sev ${sev}">${esc(String(r.severity ?? "med").toUpperCase())}</span>` +
        `<b class="mono">${esc(r.criterion)}</b>` +
        `<span class="rz-rate" style="color:${rateCol(r.passRateOverApplicable)}">${esc(r.passRateOverApplicable)}% pass / applicable</span></div>` +
        `<div class="rz-stats">` +
        `<span class="rz applicable">applicable ${esc(r.applicable)}</span>` +
        `<span class="rz pass">pass ${esc(r.pass)}</span>` +
        `<span class="rz fail">fail ${esc(r.fail)}</span>` +
        naCell +
        neCell +
        `</div></div>`
      );
    })
    .join("");
  return (
    `<h3>indeterminate resolution chain — applicable · pass · fail · N/A (precondition absent) · needs-evidence</h3>` +
    `<div class="sub">every indeterminate is RESOLVED by a deterministic precondition gate: <b>N/A</b> (the criterion's trigger/precondition was absent in the trace — DROPPED from the applicable denominator) vs <b>needs-evidence</b> (precondition present but undecided — carries a concrete next-action: code-recheck · 2nd-judge · revise-criterion · HITL-spot-check). No bare indeterminate.</div>` +
    `<div class="rztable">${body}</div>`
  );
}

function scorecardTab(input: EvalReportInput): string {
  return (
    `<h2>③ Eval Scorecard</h2>` +
    tabDesc("What this tab shows: the DEFINED criteria × results. Each criterion carries its STATEMENT, its provenance (defined vs source-mined), and a hover with the full definition; the heatmap is criteria × route cohort, with nested subcards + inline calibration on the applicable-denominator-honest pass-rate.") +
    `<div class="sub">cohort heatmap · nested subcards · inline calibration · GA-D2b applicable-denominator honest</div>` +
    verdictLegend() +
    `<h3>criteria × route cohort — cell = % pass over (pass+fail+indet)</h3>` +
    heatmapHtml(input) +
    // WS-3 follow-up — the per-criterion plain-language KEY directly under the heatmap,
    // covering ALL criteria (gating + non-gating) so every technical heatmap id has a
    // "what it measures · why it matters" gloss.
    criterionLegend(input) +
    // UI-5 — anchor the heatmap with a success-rate + key-metrics summary row (no dangle).
    scorecardMetrics(input) +
    `<h3>gating criteria — nested subcards + HITL calibration</h3>` +
    subcardsHtml(input) +
    // WS-5 — the INDETERMINATE resolution chain for ALL criteria (gating + non-gating):
    // splits the single indeterminate bucket into N/A (precondition absent, excluded)
    // vs needs-evidence (carries a next-action). interest-logging-integrity's 283 land here.
    criterionResolutionTable(input)
  );
}

// ── §4 Findings (verbatim evidence + judge chain + agree/revise/refute) ───────

const KIND_ORDER: Record<string, number> = { context: 0, examine: 1, detect: 2, bind: 3, ground: 4, critique: 5, decide: 6, verify: 7 };

/** One §4 finding from the top-findings roll; uses DR-2 / judge-walk for evidence. */
function findingFromTop(input: EvalReportInput, fd: TopFinding): string {
  const crit = criterionById(input, fd.criterion);
  const sev = sevCls(fd.severity ?? crit?.severity);
  const ex = fd.exampleTraceId ?? "";
  const row = input.ledger?.find((r) => r.trajectoryId === ex);
  const grounds = (row?.judgeSteps ?? []).filter((s) => s.ref);
  // a judge-step ref may be a string OR a structured {obs,path,value} — coerce.
  const refToStr = (rf: JudgeStep["ref"]): string =>
    rf === undefined ? "" : typeof rf === "string" ? rf : [rf.obs, rf.path, rf.value].filter(Boolean).join(":");
  const evItems =
    grounds.length > 0
      ? grounds
          .slice(0, 4)
          .map((s) => { const r = refToStr(s.ref); return `<li><span class="ref">${esc(r.split(":")[0])}</span> ${esc(r.split(":").slice(1).join(":").slice(0, 120))}</li>`; })
          .join("")
      : crit?.discovery && crit.discovery.evidence.refs.length > 0
        ? crit.discovery.evidence.refs
            .slice(0, 4)
            .map((r) => `<li><span class="ref">${esc(r.obs)}</span> ${esc(((r.path ? r.path + ": " : "") + r.value).slice(0, 120))}</li>`)
            .join("")
        : `<li><span class="ref">trace</span> <code>${esc(ex || "(suite)")}</code> — search §2 for the judge walk</li>`;
  const chain =
    (row?.judgeSteps ?? []).length > 0
      ? [...(row?.judgeSteps ?? [])]
          .filter((s) => s.kind !== "context")
          .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
          .map((s) => `<span class="step">${esc(s.kind)}</span>`)
          .join(" → ")
      : "detect → ground → critique → decide → verify";
  const link =
    row?.judgeSteps && row.judgeSteps.length > 0 ? ` <span class="lnk" data-drill="${esc(ex)}">[open §2 side-by-side ▸]</span>` : "";
  const gate = sev === "crit" || sev === "high" ? `<span class="gatetag">GATING</span>` : "";
  const prev = fd.prevalencePctOverApplicable;
  const assumptionsLine =
    crit?.discovery && crit.discovery.assumptions.length > 0
      ? crit.discovery.assumptions.map((a) => `${esc(a.text)} <span class="badge b-skip">${esc(a.status)}</span>`).join(" · ")
      : `<span class="none">grounded</span> — judge-health surfaced (see §5)`;
  const whyProblem = crit?.discovery ? `<div class="k">why a<br>problem</div><div class="v">${esc(crit.discovery.why_problem)}</div>` : "";
  return (
    `<div class="find ${sev === "crit" || sev === "high" ? "gate" : ""}">` +
    `<div class="find-h"><span class="sev ${sev}">${esc((fd.severity ?? "med").toUpperCase())}</span><b>${esc(fd.criterion)}</b>${gate}` +
    `<span class="verd fail" style="margin-left:auto">${esc(fd.failCount)}/${esc(fd.applicable)} fail · ${esc(prev)}%</span></div>` +
    // WS-3 — plain-language gloss (what · why) above the technical claim/evidence grid.
    plainBanner(crit) +
    `<div class="fg">` +
    `<div class="k">claim</div><div class="v">Criterion <code>${esc(fd.criterion)}</code> fails on ${esc(fd.failCount)} of ${esc(fd.applicable)} applicable trajectories.</div>` +
    whyProblem +
    `<div class="k">evidence<br>(verbatim)</div><div class="v" data-pii="evidence"><ul>${evItems}</ul></div>` +
    `<div class="k">judge<br>reasoning</div><div class="v reason">${chain}${link}</div>` +
    `<div class="k">root</div><div class="v">${esc(fd.root ?? "")}</div>` +
    `<div class="k">prevalence</div><div class="v"><b>${esc(prev)}%</b> over applicable (${esc(fd.applicable)}) <span class="prev"><i style="width:${Math.min(prev, 100)}%"></i></span> <span class="mono na-note">na excluded (GA-D2b)</span></div>` +
    `<div class="k">assumptions</div><div class="v">${assumptionsLine}</div>` +
    `</div>` +
    `<div class="areview"><span class="l">⊕ alignment review:</span><b class="agree">✓ agree</b><b>~ revise</b><b class="refute">✗ refute</b><input placeholder="reviewer note…"></div>` +
    `</div>`
  );
}

/** Fallback DR-2 finding card (no ledger / no top-findings — mined criteria only). */
function findingFromCriterion(c: ReportCriterion, verdict: CriterionVerdict | undefined): string {
  const sev = sevCls(c.severity);
  const d = c.discovery;
  if (!d) {
    return (
      `<div class="find"><div class="find-h"><span class="sev ${sev}">${esc(c.severity)}</span><b>${esc(c.id)}</b>` +
      `${verdict ? `<span class="verd ${verdictCls(resultToken(verdict.result))}" style="margin-left:auto">${esc(resultToken(verdict.result))}</span>` : ""}</div>` +
      plainBanner(c) +
      `<div class="fg"><div class="k">statement</div><div class="v">${esc(c.statement)}</div>` +
      `${verdict ? `<div class="k">critique</div><div class="v">${esc(verdict.critique)}</div>` : ""}</div></div>`
    );
  }
  const ev = d.evidence;
  const refs = ev.refs.length > 0 ? `<li><span class="ref">refs</span> <code>${esc(refsText(ev.refs))}</code></li>` : "";
  const assumptions = d.assumptions.map((a) => `${esc(a.text)} <span class="badge b-skip">${esc(a.status)}</span>`).join(" · ");
  return (
    `<div class="find ${sev === "crit" || sev === "high" ? "gate" : ""}">` +
    `<div class="find-h"><span class="sev ${sev}">${esc(c.severity)}</span><b>${esc(c.id)}</b>` +
    `${verdict ? `<span class="verd ${verdictCls(resultToken(verdict.result))}" style="margin-left:auto">${esc(resultToken(verdict.result))}</span>` : ""}</div>` +
    plainBanner(c) +
    `<div class="fg">` +
    `<div class="k">targets</div><div class="v">${esc(d.targets)}</div>` +
    `<div class="k">why a<br>problem</div><div class="v">${esc(d.why_problem)}</div>` +
    `<div class="k">evidence<br>(verbatim)</div><div class="v" data-pii="evidence">grounding <strong>${esc(ev.grounding)}</strong> · seen-in-traces ${esc(ev.seen_in_traces)} · prevalence <strong>${esc(ev.prevalence)}</strong><ul>${refs}</ul></div>` +
    `<div class="k">judge<br>reasoning</div><div class="v reason">${esc(d.reasoning)}</div>` +
    `<div class="k">assumptions</div><div class="v">${assumptions}</div>` +
    `</div>` +
    `<div class="areview"><span class="l">⊕ alignment review:</span><b class="agree">✓ agree</b><b>~ revise</b><b class="refute">✗ refute</b><input placeholder="reviewer note…"></div>` +
    `</div>`
  );
}

function findingsTab(input: EvalReportInput): string {
  const top = input.topFindings ?? [];
  let body: string;
  if (top.length > 0) {
    body = top.map((fd) => findingFromTop(input, fd)).join("");
  } else {
    // no ledger-derived findings — fall back to DR-2 cards for failing/at-risk criteria.
    const verdictById = new Map(input.verdicts.map((v) => [v.criterionId, v]));
    const failing = input.criteria.filter((c) => {
      const v = verdictById.get(c.id);
      return v ? v.result !== OutcomeVerdict.Pass : c.discovery !== undefined;
    });
    const pool = failing.length > 0 ? failing : input.criteria;
    body = pool.map((c) => findingFromCriterion(c, verdictById.get(c.id))).join("");
  }
  // §9.4.4 R3/M5 — DETECTED-but-unmatched flags, CLEARLY SEPARATED from the
  // fails-on-existing-criteria above. These are detections the judge flagged with NO
  // matching criterion — routed to *discover, never minted into evals mid-judging.
  const flags = input.detectedFlags ?? [];
  const refToStr = (rf: DetectedFlag["ref"]): string =>
    rf === undefined ? "" : typeof rf === "string" ? rf : [rf.obs, rf.path, rf.value].filter(Boolean).join(":");
  const detectedSection =
    flags.length > 0
      ? `<h3 class="detected-h">⚠ Detected — unmatched (no defined criterion) <span class="badge b-skip">NOT SCORED</span></h3>` +
        `<div class="sub">M5 JUDGE-WHAT-IS: these behaviours were DETECTED + FLAGGED but have no matching criterion — routed to <code>*discover</code> / <code>*build-dataset</code>, never scored or minted into evals mid-judging.</div>` +
        flags
          .map((fl) => {
            const r = refToStr(fl.ref);
            return (
              `<div class="detected"><div class="detected-top"><span class="dkind">${esc(fl.kind)}</span>` +
              `<b>${esc(fl.detection)}</b><span class="dtrace mono">${esc(fl.trajectoryId)}${fl.anchor !== undefined ? " · step " + esc(fl.anchor) : ""}</span></div>` +
              (r ? `<div class="detected-ev mono"><span class="ref">${esc(r.split(":")[0])}</span> ${esc(r.split(":").slice(1).join(":"))}</div>` : "") +
              `</div>`
            );
          })
          .join("")
      : `<h3 class="detected-h">⚠ Detected — unmatched (no defined criterion)</h3><div class="sub">none — every detected behaviour had a matching defined criterion this run.</div>`;

  return (
    `<h2>④ Findings</h2>` +
    tabDesc("What this tab shows: TWO clearly separated groups — (1) FAILURES on the existing DEFINED criteria (with verbatim evidence + judge reasoning chain), and (2) DETECTED-but-unmatched flags the judge raised with no matching criterion (routed to discover, never scored).") +
    `<div class="sub">alignment-auditable — verbatim evidence + judge reasoning chain</div>` +
    `<h3 class="fails-h">✗ Failures on defined criteria</h3>` +
    body +
    detectedSection +
    `<div class="note"><span class="tag">★ AUDITABLE</span>&nbsp;Each finding: verbatim evidence (obs/diff refs from the example trace's judge walk), the judge reasoning chain, prevalence over the applicable denominator, agree/revise/refute to overturn. Open §2 to see the full side-by-side.</div>`
  );
}

// ── §5 Self-Eval · Calibration [INTERNAL — stripped on publish] ───────────────

const PHASE_LENS_ORDER = ["gather", "expect", "context", "examine", "detect", "bind", "ground", "critique", "decide", "verify", "localize"];

/** §9.4.4 R2/M1 — the subject-profile card for the INTERNAL calibration lens. */
function subjectProfileCard(p: SubjectProfile | undefined): string {
  if (p === undefined) {
    return `<div class="sub">no subject profile supplied for this run — the judge reconstructed identity at reason-time.</div>`;
  }
  const inferred = new Set(p.inferredFields ?? []);
  const tag = (field: string): string => (inferred.has(field) ? ` <span class="badge b-skip">inferred</span>` : "");
  const rows: [string, string, string][] = [
    ["identity", p.identity, "identity"],
    ["purpose", p.purpose, "purpose"],
    ["scope", p.scope, "scope"],
    ["skill", p.skill ?? "—", "skill"],
    ["tools", (p.tools ?? []).join(", ") || "—", "tools"],
    ["harness", p.harness, "harness"],
    ["version", p.version ?? "—", "version"],
  ];
  const prov = `<span class="prov ${p.provenance === "given" ? "defined" : "source"}">${esc(p.provenance)}</span>`;
  const body = rows
    .map(([k, v, field]) => `<div class="pk">${esc(k)}${tag(field)}</div><div class="pv">${esc(v)}</div>`)
    .join("");
  return (
    `<div class="sub">M1 — who the judge understood the agent to be (${prov}; <span class="badge b-skip">inferred</span> = reconstructed, not given · harness <code>unknown</code> is MARKED, never confabulated).</div>` +
    `<div class="profile-grid">${body}</div>`
  );
}

/** §9.4.4 R2/M4 — the PHASE-BLOCK lens: the judge's reasoning grouped by DAG node
 *  across the whole run — the calibration surface the builder reads like an AI eng. */
function phaseLens(input: EvalReportInput): string {
  const ledger = input.ledger ?? [];
  const byPhase = new Map<string, { count: number; samples: string[] }>();
  for (const r of ledger) {
    for (const s of r.judgeSteps ?? []) {
      const k = s.kind;
      const entry = byPhase.get(k) ?? { count: 0, samples: [] };
      entry.count += 1;
      if (s.text && entry.samples.length < 3) entry.samples.push(s.text);
      byPhase.set(k, entry);
    }
  }
  if (byPhase.size === 0) {
    return `<div class="sub">no judge_steps emitted this run — phase-block lens unavailable (scorecard-only render).</div>`;
  }
  const orderedKinds = [
    ...PHASE_LENS_ORDER.filter((k) => byPhase.has(k)),
    ...[...byPhase.keys()].filter((k) => !PHASE_LENS_ORDER.includes(k)),
  ];
  return (
    `<div class="phase-lens">` +
    orderedKinds
      .map((k) => {
        const e = byPhase.get(k)!;
        const samples = e.samples.map((t) => `<div class="ps-row">${esc(t.slice(0, 140))}</div>`).join("");
        return (
          `<div class="phase-blk"><div class="phase-h"><span class="k ${esc(k)}">${esc(k)}</span><span class="phase-n">${esc(e.count)} step(s)</span></div>${samples}</div>`
        );
      })
      .join("") +
    `</div>`
  );
}

/** §9.4.4 R2/M2+M3 — an example node-0 understanding (train-of-thought) + node-0.5
 *  expected-trajectory, from the first trajectory that carries them. */
function reasoningExample(input: EvalReportInput): string {
  const ledger = input.ledger ?? [];
  const withU = ledger.find((r) => r.understanding !== undefined);
  const withE = ledger.find((r) => r.expectedTrajectory && r.expectedTrajectory.length > 0);
  if (withU === undefined && withE === undefined) {
    return `<div class="sub">no node-0 understanding / node-0.5 expected-trajectory emitted this run.</div>`;
  }
  let out = "";
  if (withU?.understanding !== undefined) {
    const u = withU.understanding;
    const given = (u.given ?? []).map((g) => `<li>${esc(g)}</li>`).join("");
    const inferred = (u.inferred ?? []).map((g) => `<li>${esc(g)}</li>`).join("");
    out +=
      `<div class="re-blk"><div class="re-h">node-0 GATHER — understanding (M2) · <span class="mono">${esc(withU.trajectoryId)}</span></div>` +
      `<div class="re-rephrase">“${esc(u.rephrase)}”</div>` +
      (given ? `<div class="re-sub">given</div><ul class="re-ul">${given}</ul>` : "") +
      (inferred ? `<div class="re-sub">inferred</div><ul class="re-ul">${inferred}</ul>` : "") +
      `</div>`;
  }
  if (withE?.expectedTrajectory !== undefined) {
    const steps = withE.expectedTrajectory
      .map((s: ExpectedStep, i: number) => `<li><b>${esc(s.step ?? i + 1)}.</b> ${esc(s.expected)}${s.rationale ? ` <span class="re-rat">— ${esc(s.rationale)}</span>` : ""}</li>`)
      .join("");
    out +=
      `<div class="re-blk"><div class="re-h">node-0.5 EXPECTED-TRAJECTORY (M3) · <span class="mono">${esc(withE.trajectoryId)}</span></div>` +
      `<div class="re-sub">how the target SHOULD have acted — built BEFORE examine</div><ol class="re-ul">${steps}</ol></div>`;
  }
  return out;
}

/**
 * UI-12-B — the judge-health GROUNDED cell, HONEST about capture. `groundedPct` is
 * the % of verdicts citing ≥1 structured grounding ref. A value of 0 (or undefined)
 * means the judge emitted ZERO structured refs this batch — the grounding is
 * UNCOMPUTABLE / capture-unavailable, NOT a verified 0% to paint green. Render that
 * as "capture-unavailable" (heatmap-style data-pending honesty), never a silent green
 * 0%. A real >0 value is colour-coded by rate (low = critical, never "good"). PURE.
 */
function groundedHealthCell(groundedPct: number | undefined): string {
  if (groundedPct === undefined || groundedPct === 0) {
    return (
      `<div class="hc"><div class="l">grounded</div>` +
      `<div class="v capture-na" title="judge emitted 0 structured grounding refs in this batch — grounding capture unavailable; NOT a verified 0%">capture-unavailable</div></div>`
    );
  }
  return `<div class="hc"><div class="l">grounded</div><div class="v ${rateClass(groundedPct)}">${esc(groundedPct)}%</div></div>`;
}

/**
 * WS-4 — one parsed routed-failure. The EV-051 handover encodes each routed item as a
 * deterministic acceptance string (`routeFailures`):
 *   `<criterionId> [<severity>/<flag>] FAILED on trace <traceId>: <critique>`
 * so the §5 handover is reconstructed STRUCTURALLY (WHAT · WHY · WHERE · TARGET) from
 * it — no new data, just a parse. A string that doesn't match the format degrades to
 * `{criterionId: <raw>}` (rendered as WHAT, never dropped).
 */
interface RoutedItem {
  criterionId: string;
  severity: string;
  flag: string;
  traceId: string;
  critique: string;
  raw: string;
}
function parseRoutedCriterion(c: string): RoutedItem {
  const m = c.match(/^(.+?)\s+\[(.+?)\/(.+?)\]\s+FAILED on trace\s+(.+?):\s+([\s\S]*)$/);
  if (m) return { criterionId: m[1], severity: m[2], flag: m[3], traceId: m[4], critique: m[5].trim(), raw: c };
  return { criterionId: c, severity: "", flag: "", traceId: "", critique: "", raw: c };
}

/**
 * WS-4 — the refined EV-051 "Routed to diagnostics" handover. Restructures the raw
 * acceptance-criteria dump into a clean, COPY-PASTEABLE handover block: a meta strip
 * (subject · target stage · escalation · produced-by) + one card per routed item with
 * WHAT (the criterion/finding) · WHY (the judge critique) · WHERE (the locus — trace +
 * dimension) · TARGET (diagnostics). Each card carries a per-item "copy" button (this
 * item as markdown) and the block ends with a "copy full handover as markdown" button —
 * the operator hands the bundle straight to diagnostics. PURE; deterministic markdown.
 */
function routedHandover(input: EvalReportInput): string {
  const h = input.handover;
  if (h === null || h === undefined) {
    return `<div class="sub">No failures routed — nothing handed to diagnostics this run (judge-only: the evaluator flags + routes, it never fixes).</div>`;
  }
  const subjName = h.subject?.name ?? input.subject.name;
  const target = h.intent?.command ?? "*diagnose";
  const items = h.acceptance.criteria.map(parseRoutedCriterion);

  // per-item markdown (one routed finding, copy-pasteable into diagnostics).
  const itemMd = (p: RoutedItem, crit: ReportCriterion | undefined): string =>
    [
      `## ${p.criterionId}${p.severity ? ` [${p.severity}/${p.flag}]` : ""}`,
      `- **WHAT:** ${crit?.statement ?? p.criterionId}`,
      `- **WHY:** ${p.critique || "(no critique recorded)"}`,
      `- **WHERE:** ${p.traceId ? `trace ${p.traceId}` : "—"}${crit?.dimension ? ` · ${crit.dimension}` : ""}`,
      `- **TARGET:** diagnostics (${target})`,
    ].join("\n");

  const cards = items
    .map((p, i) => {
      const crit = criterionById(input, p.criterionId);
      const sev = sevCls(p.severity || crit?.severity);
      const sevTxt = String(p.severity || crit?.severity || "MED").toUpperCase();
      const where = p.traceId
        ? `trace <code>${esc(p.traceId)}</code>${crit?.dimension ? ` · <span class="hov-dim">${esc(crit.dimension)}</span>` : ""}`
        : "—";
      return (
        `<div class="hov">` +
        `<div class="hov-h"><span class="hov-n">#${i + 1}</span><span class="sev ${sev}">${esc(sevTxt)}</span>` +
        `<b>${esc(p.criterionId)}</b>${p.flag ? `<span class="chip">${esc(p.flag)}</span>` : ""}` +
        `<button class="copy-md hov-copy" data-md="${esc(itemMd(p, crit))}">copy item ▸</button></div>` +
        `<div class="hov-g">` +
        `<div class="hk">WHAT</div><div class="hv">${esc(crit?.statement ?? p.criterionId)}</div>` +
        `<div class="hk">WHY</div><div class="hv">${esc(p.critique || "—")}</div>` +
        `<div class="hk">WHERE</div><div class="hv">${where}</div>` +
        `<div class="hk">TARGET</div><div class="hv">→ diagnostics (<code>${esc(target)}</code>)</div>` +
        `</div></div>`
      );
    })
    .join("");

  // full-bundle markdown (the whole routed set, ready to hand to diagnostics).
  const fullMd = [
    `# EV-051 — Routed to diagnostics`,
    ``,
    `**Subject:** ${subjName}  ·  **Stage:** ${h.adl_stage}  ·  **Escalation:** ${h.escalation_policy}  ·  **By:** ${h.provenance.produced_by ?? "evaluator"}`,
    ``,
    `**Goal:** ${h.acceptance.goal}`,
    ``,
    ...items.flatMap((p) => [itemMd(p, criterionById(input, p.criterionId)), ``]),
  ].join("\n");

  return (
    `<div class="sub">EV-051 — failing criteria ROUTED to diagnostics (judge-only; the evaluator flags + routes, it never fixes). Hand the block below straight to <code>*diagnose</code>.</div>` +
    `<div class="hov-meta">` +
    `<span class="hm-c"><span class="l">subject</span><span class="v">${esc(subjName)}</span></span>` +
    `<span class="hm-c"><span class="l">target stage</span><span class="v"><code>${esc(target)}</code></span></span>` +
    `<span class="hm-c"><span class="l">routed</span><span class="v">${items.length} finding(s)</span></span>` +
    `<span class="hm-c"><span class="l">escalation</span><span class="v">${esc(h.escalation_policy)}</span></span>` +
    `<span class="hm-c"><span class="l">produced by</span><span class="v">${esc(h.provenance.produced_by)}</span></span>` +
    `</div>` +
    `<div class="hov-list">${cards}</div>` +
    `<button class="copy-md" data-md="${esc(fullMd)}">⧉ Copy full handover as markdown</button>`
  );
}

function selfEvalTab(input: EvalReportInput): string {
  const se = input.selfEval;
  const decisions = routedHandover(input);
  const header =
    `<h2>⑤ Self-Eval · Judge Calibration <span class="badge b-skip">INTERNAL</span></h2>` +
    tabDesc("What this tab shows [INTERNAL — stripped on publish]: the AGGREGATE judge-calibration surface — the human-in-the-loop for the JUDGE. It audits the METHODOLOGY the judge followed across the WHOLE population (not one trace): ① is the judge applying the method · ② do the criteria make sense / add value · ③ did it read enough traces (diligence) · ④ are results grounded · ⑤ are the refs real or fabricated. Accuracy-first ordering.") +
    `<div class="sub" data-strip="strip-for-client">internal — calibrate the judge · stripped on publish</div>`;

  if (se === undefined) {
    // graceful fallback — no aggregate derived (older run): keep the EV-051 decisions.
    return header + `<h3>Routed to diagnostics (EV-051)</h3>` + decisions;
  }

  const checksLegend =
    `<div class="se-checks"><div class="se-checks-h">the 5 operator checks this tab answers</div><div class="se-checks-g">` +
    [
      ["①", "methodology adherence", "is the judge applying the judging method (bind · ground · critique-before-verdict · abstain-on-silence)?"],
      ["②", "criterion value", "do the criteria make sense, apply, and discriminate — or are they dead weight?"],
      ["③", "diligence", "did the judge read enough of each trace, or pick one sample and stop?"],
      ["④", "grounded", "are the results anchored in real trace evidence (refs), not vibes?"],
      ["⑤", "refs real", "do the cited {obs,path,value} refs actually resolve in the trace — real or fabricated?"],
    ]
      .map(([n, k, v]) => `<div class="se-check"><span class="se-cn">${n}</span><span class="se-ck">${esc(k)}</span><span class="se-cv">${esc(v)}</span></div>`)
      .join("") +
    `</div></div>`;

  return (
    header +
    checksLegend +
    selfEvalTrustBand(se) +
    selfEvalBehaviorMap(se) +
    selfEvalRefIntegrity(se) +
    selfEvalConfidence(se) +
    selfEvalPerCriterion(se) +
    selfEvalCriterionValue(se) +
    selfEvalDiligence(se) +
    selfEvalTransparency(se) +
    selfEvalEmit(se) +
    selfEvalSpotCheck(se) +
    selfEvalGroundTruthFuture() +
    // ── judge-reasoning DETAIL (M1 · M2 · M3 · M4) — the per-trace calibration lens
    //    that backs the aggregate above (who the judge thinks the agent is, its
    //    train-of-thought, the expected-trajectory it built). Retained below the
    //    aggregate so a builder can drill from the population view into an example.
    `<h3 class="se-h"><span class="se-num">5.D</span> Judge reasoning detail (M1 · M2 · M3 · M4)</h3>` +
    `<div class="sub">the per-trace calibration lens behind the aggregate — who the judge understood the agent to be (M1), its phase-by-phase reasoning (M4), and an example understanding + expected-trajectory (M2 · M3).</div>` +
    subjectProfileCard(input.subjectProfile) +
    phaseLens(input) +
    reasoningExample(input) +
    `<h3 class="se-h">Routed to diagnostics (EV-051)</h3>` +
    decisions
  );
}

// ── WS-3 §5 Self-Eval — section renderers (PURE string assembly) ──────────────

function seBar(pct: number, tone = "p"): string {
  const w = Math.max(0, Math.min(100, pct));
  return `<span class="sebar"><span class="sebar-f ${tone}" style="width:${w}%"></span></span>`;
}

function selfEvalTrustBand(se: SelfEvalAggregate): string {
  const t = se.trust;
  const tone = t.score >= 85 ? "good" : t.score >= 60 ? "warn" : "bad";
  return (
    `<div class="se-trust ${tone}"><div class="se-trust-l"><div class="se-trust-score">${esc(t.score)}<span class="se-trust-d">/100</span></div><div class="se-trust-cap">judge trust</div></div>` +
    `<div class="se-trust-r"><div class="se-trust-label">${esc(t.label)}</div><div class="se-trust-basis">${esc(t.basis)}</div></div></div>`
  );
}

function selfEvalBehaviorMap(se: SelfEvalAggregate): string {
  const b = se.behaviorMap;
  const clusters = b.clusters
    .map(
      (c) =>
        `<div class="se-cl ${esc(c.tone)}"><div class="se-cl-top"><span class="se-cl-n">${esc(c.count)}</span><span class="se-cl-l">${esc(c.label)}</span></div><div class="se-cl-note">${esc(c.note)}</div></div>`,
    )
    .join("");
  const conc = b.concentration.length
    ? `<div class="se-conc"><div class="se-conc-h">where fails CONCENTRATE</div>` +
      b.concentration
        .map(
          (c) =>
            `<div class="se-conc-r"><span class="se-conc-id" title="${esc(c.statement)}">${esc(c.id)}</span>${seBar(c.pct, "bad")}<span class="se-conc-v">${esc(c.fails)} fails · ${esc(c.pct)}%</span></div>`,
        )
        .join("") +
      `</div>`
    : `<div class="se-empty">no failing criteria — nothing concentrates.</div>`;
  return (
    `<h3 class="se-h"><span class="se-num">5.0</span> Judge Behavior Map — clusters &amp; where it falls short <span class="se-tag agg">AGGREGATE · MULTI-TRAJECTORY</span></h3>` +
    `<div class="sub">how the judge handled the POPULATION of ${esc(b.total)} trajectories — the cluster sizes + the fail concentration tell you where the judge (and the criteria) are working vs thin.</div>` +
    `<div class="se-clusters">${clusters}</div>` +
    conc
  );
}

function selfEvalRefIntegrity(se: SelfEvalAggregate): string {
  const r = se.refIntegrity;
  // honesty (UI-12-B): with ZERO decided verdicts grounding is UNMEASURABLE — render
  // capture-unavailable (muted), NEVER a false-green default.
  if (r.decided === 0) {
    return (
      `<h3 class="se-h"><span class="se-num">5.1</span> Reference Integrity — real or fabricated? <span class="se-tag gt">check ⑤ · GROUND-TRUTH</span></h3>` +
      `<div class="se-row"><div class="se-metric"><div class="se-metric-v capture-na">capture-unavailable</div><div class="se-metric-l">no decided verdicts to ground</div></div></div>` +
      `<div class="se-note">${esc(r.note)}</div>`
    );
  }
  const tone = r.groundedPct >= 90 ? "good" : r.groundedPct >= 70 ? "warn" : "bad";
  return (
    `<h3 class="se-h"><span class="se-num">5.1</span> Reference Integrity — real or fabricated? <span class="se-tag gt">check ⑤ · GROUND-TRUTH</span></h3>` +
    `<div class="se-row"><div class="se-metric ${tone}"><div class="se-metric-v">${esc(r.groundedPct)}%</div><div class="se-metric-l">decided verdicts carry ≥1 structured ref</div></div>` +
    `<div class="se-kv"><div><b>${esc(r.grounded)}</b> grounded</div><div><b>${esc(r.ungrounded)}</b> ungrounded</div><div><b>${esc(r.decided)}</b> decided</div></div></div>` +
    `<div class="se-note">${esc(r.note)}</div>`
  );
}

function selfEvalConfidence(se: SelfEvalAggregate): string {
  const rows = se.confidence
    .map(
      (c) =>
        `<div class="se-conf-r"><span class="se-conf-b">${esc(c.band)}</span>${seBar(c.pct, "p")}<span class="se-conf-v">${esc(c.count)} · ${esc(c.pct)}%</span></div>`,
    )
    .join("");
  return (
    `<h3 class="se-h"><span class="se-num">5.2</span> Confidence Calibration <span class="se-tag proxy">PROXY</span></h3>` +
    `<div class="sub">how the judge's stated confidence is distributed across decided verdicts. Tracking this against actual correctness (vs a 2nd judge / ground-truth) is the §5.X future extension.</div>` +
    `<div class="se-conf">${rows || '<div class="se-empty">no per-verdict confidence emitted.</div>'}</div>`
  );
}

function selfEvalPerCriterion(se: SelfEvalAggregate): string {
  const rows = se.perCriterion
    .map((p) => {
      const flagCls = p.flag === "fails-present" ? "bad" : p.flag === "never-applies" ? "warn" : "good";
      return (
        `<tr><td class="se-cid" title="${esc(p.statement)}">${esc(p.id)}</td><td><span class="sev ${esc(p.severity)}">${esc(p.severity)}</span></td>` +
        `<td class="good">${esc(p.pass)}</td><td class="bad">${esc(p.fail)}</td><td class="warn">${esc(p.unc)}</td><td class="dim">${esc(p.na)}</td>` +
        `<td>${esc(p.groundedPct)}%</td><td><span class="se-flag ${flagCls}">${esc(p.flag)}</span></td></tr>`
      );
    })
    .join("");
  return (
    `<h3 class="se-h"><span class="se-num">5.3</span> Per-Criterion Reliability <span class="se-tag proxy">check ①④ · PROXY</span></h3>` +
    `<table class="se-table"><thead><tr><th>criterion</th><th>sev</th><th>pass</th><th>fail</th><th>indet</th><th>na</th><th>grnd</th><th>flag</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function selfEvalCriterionValue(se: SelfEvalAggregate): string {
  const rows = se.criterionValue
    .map((c, i) => {
      const cls = c.applicablePct === 0 ? "warn" : "good";
      return (
        `<tr><td class="se-cid" title="${esc(c.statement)}">${esc(c.id)}</td><td><span class="sev ${esc(c.severity)}">${esc(c.severity)}</span></td>` +
        `<td class="${cls}">${esc(c.applicablePct)}%</td><td>${esc(c.fails)} fails</td><td class="se-vverdict">${esc(c.verdict)}</td>` +
        `<td class="se-hitl"><span class="se-pick" data-vgroup="cval-${i}" data-v="keep">keep</span><span class="se-pick" data-vgroup="cval-${i}" data-v="revise">revise</span><span class="se-pick" data-vgroup="cval-${i}" data-v="retire">retire</span></td></tr>`
      );
    })
    .join("");
  return (
    `<h3 class="se-h"><span class="se-num">5.4</span> Criterion Value / Applicability Audit <span class="se-tag hitl">check ② · HITL</span></h3>` +
    `<div class="sub">does each criterion apply + discriminate, or is it dead weight? A criterion that NEVER applies or NEVER fails is a candidate to retire/revise. Your pick is captured below (export-ready).</div>` +
    `<table class="se-table"><thead><tr><th>criterion</th><th>sev</th><th>applicable</th><th>fails</th><th>value</th><th>operator</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function selfEvalDiligence(se: SelfEvalAggregate): string {
  const d = se.diligence;
  const pct = d.total > 0 ? Math.round((100 * d.examined) / d.total) : 0;
  const tone = pct >= 95 ? "good" : pct >= 80 ? "warn" : "bad";
  return (
    `<h3 class="se-h"><span class="se-num">5.5</span> Diligence / Trace Coverage <span class="se-tag proxy">check ③ · PROXY</span></h3>` +
    `<div class="se-row"><div class="se-metric ${tone}"><div class="se-metric-v">${esc(d.examined)}/${esc(d.total)}</div><div class="se-metric-l">trajectories examined</div></div>` +
    `<div class="se-metric"><div class="se-metric-v">${esc(d.avgGroundingRefs)}</div><div class="se-metric-l">avg grounding refs / examined trace</div></div></div>` +
    `<div class="se-note">${esc(d.note)}</div>`
  );
}

function selfEvalTransparency(se: SelfEvalAggregate): string {
  const t = se.transparency;
  const block = t.blocked
    ? `<div class="se-blocked"><span class="se-blocked-tag">BLOCKED</span> ${esc(t.note)}</div>`
    : `<div class="se-note">${esc(t.note)}</div>`;
  return (
    `<h3 class="se-h"><span class="se-num">5.6</span> Judge Reasoning Transparency (walk · M2 · M3) <span class="se-tag">TRANSPARENCY · check ①</span></h3>` +
    `<div class="se-row"><div class="se-metric ${t.m2Pct > 0 ? "good" : "bad"}"><div class="se-metric-v">${esc(t.m2Pct)}%</div><div class="se-metric-l">M2 understanding</div></div>` +
    `<div class="se-metric ${t.m3Pct > 0 ? "good" : "bad"}"><div class="se-metric-v">${esc(t.m3Pct)}%</div><div class="se-metric-l">M3 expected-trajectory</div></div>` +
    `<div class="se-metric ${t.walkPct > 0 ? "good" : "bad"}"><div class="se-metric-v">${esc(t.walkPct)}%</div><div class="se-metric-l">judge walk emitted</div></div></div>` +
    block
  );
}

function selfEvalEmit(se: SelfEvalAggregate): string {
  const e = se.emit;
  const meter = (label: string, present: number, total: number): string => {
    const pct = total > 0 ? Math.round((100 * present) / total) : 0;
    const tone = pct >= 90 ? "good" : pct >= 40 ? "warn" : "bad";
    return `<div class="se-emit-r"><span class="se-emit-l">${esc(label)}</span>${seBar(pct, tone === "good" ? "p" : tone)}<span class="se-emit-v">${esc(present)}/${esc(total)}</span></div>`;
  };
  const fieldRow = (f: { field: string; present: number }): string =>
    meter(f.field, f.present, e.eligible);
  return (
    `<h3 class="se-h"><span class="se-num">5.7</span> Emit-Completeness — self-honesty meter <span class="se-tag">HONESTY</span></h3>` +
    `<div class="sub">does the judge persist what it reasoned? A dropped walk does NOT change a verdict — but it STARVES this tab + §2. The engine gate (assessEmitCompleteness) tracks this every run.</div>` +
    `<div class="se-emit">` +
    meter("verdict + critique", e.eligible, e.eligible) +
    e.fields.map(fieldRow).join("") +
    `</div>` +
    `<div class="se-note">complete emits (all of M2+M3+agentSteps+judgeSteps): <b>${esc(e.completeEmits)}/${esc(e.eligible)}</b> (${esc(e.completePct)}%).` +
    (e.exemptIncomplete > 0 ? ` ${esc(e.exemptIncomplete)} INCOMPLETE traces exempt (node-1 short-circuit).` : "") +
    `</div>`
  );
}

function selfEvalSpotCheck(se: SelfEvalAggregate): string {
  if (se.spotCheck.length === 0) {
    return (
      `<h3 class="se-h"><span class="se-num">5.8</span> Spot-Check / Disagreement Queue <span class="se-tag hitl">check ④ · HITL</span></h3>` +
      `<div class="se-empty">no failing or low-confidence verdicts queued — nothing brittle to spot-check.</div>`
    );
  }
  const rows = se.spotCheck
    .map(
      (s, i) =>
        `<div class="se-spot"><span class="se-spot-t mono" title="${esc(s.criterion)}">${esc(s.trace.slice(0, 14))}</span>` +
        `<span class="se-spot-c">${esc(s.criterion.slice(0, 54))}</span>` +
        `<span class="verd ${s.verdict === "FAIL" ? "fail" : "inc"}">${esc(s.verdict)}</span>` +
        `<span class="se-spot-conf">conf ${esc(s.conf)}</span><span class="se-spot-why">${esc(s.reason)}</span>` +
        `<span class="se-spot-act"><span class="se-pick" data-vgroup="spot-${i}" data-v="agree">agree</span><span class="se-pick" data-vgroup="spot-${i}" data-v="disagree">disagree</span></span></div>`,
    )
    .join("");
  return (
    `<h3 class="se-h"><span class="se-num">5.8</span> Spot-Check / Disagreement Queue <span class="se-tag hitl">check ④ · HITL</span></h3>` +
    `<div class="sub">the brittle calls — fails + low-confidence verdicts — sorted weakest-confidence-first. Your agree/disagree is captured (and becomes the ground-truth seed for §5.X).</div>` +
    `<div class="se-spots">${rows}</div>`
  );
}

function selfEvalGroundTruthFuture(): string {
  return (
    `<h3 class="se-h"><span class="se-num">5.X</span> Judge Accuracy vs Ground-Truth <span class="se-tag future">FUTURE — not built</span></h3>` +
    `<div class="se-future"><div class="se-future-h">documented extension</div>` +
    `<div class="se-future-b">The strongest calibration is judge-verdict vs a TRUSTED label. We do not have ground-truth labels in this run, so this is DOCUMENTED, not computed. The seed already exists: §5.8 Spot-Check collects operator agree/disagree per verdict — accumulate those into a labelled set and this panel becomes a real accuracy/precision/recall readout against the judge. Until then, §5.1 (refs real) + §5.2 (confidence) + §5.3 (per-criterion) are the PROXY signals.</div></div>`
  );
}

// ── report-component CSS (references theme.css tokens) ────────────────────────

const REPORT_CSS = `
.mono{font-family:var(--mono)}
/* status-acuity — color-code the OUTCOME big-stat tiles; COUNT tiles stay neutral (faint cyan) */
/* ALIGNMENT FIX (parity w/ discover): theme.css ships .big-stat as content-sized flex
 * (min-width:96px) → ragged tile widths. Override to an EQUAL-column grid so every tile
 * is the same width AND height (grid row-stretch). */
.big-stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;align-items:start}
.big-stat .s{min-width:0;min-height:84px;display:flex;flex-direction:column;justify-content:center}
.big-stat .s .v{line-height:1.15}
.big-stat .s{border-left:4px solid var(--border-strong)}
.big-stat .s.count{border-left-color:var(--cyan);opacity:.95}
.big-stat .s.pass{background:var(--pass-bg);border-color:var(--pass);border-left-color:var(--pass)}
.big-stat .s.pass .v{color:var(--pass)}
.big-stat .s.fail{background:var(--fail-bg);border-color:var(--fail);border-left-color:var(--fail)}
.big-stat .s.fail .v{color:var(--fail)}
.big-stat .s.indet{background:var(--warn-bg);border-color:var(--warn);border-left-color:var(--warn)}
.big-stat .s.indet .v{color:var(--warn)}
/* Overview-redesign — entity HERO (full-width subject identity) */
/* §9.4.5 E4 — entity-AS-HERO: a primary left-accent + tighter rhythm so the subject
 * card reads as the page anchor (diagnostics-grade density, dark/branded preserved). */
.hero{border:1px solid var(--border-strong);border-left:3px solid var(--primary);background:var(--surf);margin:10px 0 14px;padding:0}
.hero-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:11px 14px;border-bottom:1px solid var(--border);background:var(--surf-2)}
.hero .hname{font-size:var(--fs-xl);font-weight:700;color:var(--fg-strong);font-family:var(--mono)}
.hero .hchip{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 8px;border:1px solid var(--border);color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.hero .hchip.type{color:var(--cyan);border-color:var(--cyan);background:rgba(69,184,204,.10)}
.hero .hchip.access{margin-left:auto}
.hero .hchip.access.given{color:var(--pass);border-color:var(--pass);background:var(--pass-bg)}
.hero .hchip.access.recon{color:var(--warn);border-color:var(--warn);background:var(--warn-bg)}
.hero-grid{display:grid;grid-template-columns:max-content 1fr;gap:1px;background:var(--border)}
.hero-grid .hk{background:var(--surf);font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:7px 12px}
.hero-grid .hv{background:var(--surf-2);font-size:var(--fs-sm);color:var(--fg);padding:7px 13px;line-height:1.5}
.hero .unk{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);text-transform:uppercase;border:1px dashed var(--border-strong);padding:0 5px}
.hero .inf{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--warn);background:var(--warn-bg);padding:1px 5px;text-transform:uppercase}
.hero .inf.given{color:var(--pass);background:var(--pass-bg)}
.hero .hsys{margin:9px 12px;border:1px solid var(--border)}
.hero .hsys summary{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--cyan);cursor:pointer;padding:6px 10px;background:var(--surf);display:flex;gap:8px;align-items:center}
.hero .hsys-prov{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 6px;text-transform:uppercase;letter-spacing:.03em}
.hero .hsys-prov.recon{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn)}
.hero .hsys-prov.given{color:var(--pass);background:var(--pass-bg);border:1px solid var(--pass)}
.hero .hsys pre{margin:0;padding:9px 11px;font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg);white-space:pre-wrap;word-break:break-word;line-height:1.5;background:var(--bg);max-height:420px;overflow:auto}
.hero .hsys-na{margin:9px 12px;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim)}
.hero .hhonesty{padding:8px 13px;border-top:1px solid var(--border);font-size:var(--fs-2xs);color:var(--muted);line-height:1.5}
/* §9.4.5 E1 — trace-only honesty: the reconstructed banner + the harness/prompt UNAVAILABLE note */
.hero .hrecon{padding:7px 14px;border-bottom:1px solid var(--border);background:var(--warn-bg);font-family:var(--mono);font-size:var(--fs-2xs);font-weight:600;color:var(--warn);letter-spacing:.03em;line-height:1.5}
.hero .recon-note{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--warn);text-transform:uppercase;letter-spacing:.03em}
/* §9.4.5 E2 — tools as diagnostics-style chips with a per-tool observed call-count */
.hero .tchips{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.hero .tchip{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);background:var(--surf-3);border:1px solid var(--border-strong);padding:2px 7px;display:inline-flex;gap:5px;align-items:center;white-space:nowrap}
.hero .tchip .obs{font-weight:700;color:var(--cyan);font-size:var(--fs-2xs)}
.hero .tchip .obs.none{color:var(--dim)}
/* Overview-redesign — provenance META-STRIP (run-config + judge substrate) */
.provstrip{display:flex;gap:7px 14px;flex-wrap:wrap;align-items:center;border:1px solid var(--border);border-left:3px solid var(--primary);background:var(--surf-2);padding:7px 12px;margin:10px 0}
.provstrip .ps-item{display:inline-flex;gap:5px;align-items:baseline}
.provstrip .ps-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.provstrip .ps-v{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg-strong)}
.provstrip .unk{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);text-transform:uppercase}
.provstrip .ps-badge{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 8px;border:1px solid;text-transform:uppercase}
.provstrip .ps-badge.on{color:var(--primary-soft);border-color:var(--primary);background:rgba(126,71,215,.12)}
.provstrip .ps-badge.off{color:var(--dim);border-color:var(--border)}
/* Overview-redesign — segmented coverage FUNNEL (INCOMPLETE first-class) */
.funnel{display:flex;align-items:stretch;gap:6px;flex-wrap:wrap;margin:14px 0 6px}
.funnel .fstage{flex:1;min-width:118px;border:1px solid var(--border);background:var(--surf);padding:9px 11px}
.funnel .fstage .fn{font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;color:var(--fg-strong);line-height:1.05}
.funnel .fstage .fl{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--cyan);margin-top:3px}
.funnel .fstage .fnote{font-size:var(--fs-2xs);color:var(--dim);margin-top:3px;line-height:1.4}
.funnel .farrow{display:flex;align-items:center;color:var(--dim);font-size:var(--fs-lg);font-family:var(--mono)}
.funnel .fstage.outc{flex:1.6;min-width:200px}
.funnel .foutc{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.funnel .fpill{font-family:var(--mono);font-size:var(--fs-2xs);padding:2px 8px;border:1px solid var(--border);color:var(--muted)}
.funnel .fpill b{color:var(--fg-strong)}
.funnel .fpill.pass{border-color:var(--pass);color:var(--pass)}.funnel .fpill.pass b{color:var(--pass)}
.funnel .fpill.fail{border-color:var(--fail);color:var(--fail)}.funnel .fpill.fail b{color:var(--fail)}
.funnel .fpill.indet{border-color:var(--warn);color:var(--warn)}.funnel .fpill.indet b{color:var(--warn)}
.funnel .fpill.inc{border-color:var(--border-strong);color:var(--muted);border-style:dashed}
/* §9.4.5 E3 — eval-HEALTH temporal heatmap (correctness over time, NOT latency) */
.ehm{display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start;margin:6px 0 4px}
.ehm-col{display:flex;flex-direction:column;align-items:center;gap:3px}
.ehm-cell{min-width:30px;height:30px;padding:0 6px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,.35);font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:#0a0a12}
.ehm-cell.pass{background:var(--hm-pass,rgba(67,195,154,.50))}.ehm-cell.fail{background:var(--hm-fail,rgba(224,102,102,.54))}.ehm-cell.indet{background:var(--hm-indet,rgba(232,166,77,.52))}.ehm-cell.skip{background:var(--surf-3);color:var(--dim)}
.ehm-lab{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-align:center;line-height:1.25}
.ehm-legend{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);margin:4px 0;display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.ehm-legend .sw{display:inline-block;width:11px;height:11px;border:1px solid rgba(0,0,0,.35);vertical-align:middle;margin:0 2px}
.ehm-legend .sw.pass{background:var(--hm-pass,rgba(67,195,154,.50))}.ehm-legend .sw.fail{background:var(--hm-fail,rgba(224,102,102,.54))}.ehm-legend .sw.indet{background:var(--hm-indet,rgba(232,166,77,.52))}
.ehm-pending{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);border:1px dashed var(--border-strong);background:var(--surf);padding:7px 11px;margin:2px 0 6px;line-height:1.5}
/* note callout */
.note{border-left:3px solid var(--recommend);background:var(--recommend-bg);padding:7px 11px;font-size:var(--fs-xs);margin:14px 0}
.note .tag{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--recommend)}
/* severity pills + verd */
.sev{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 7px;margin-right:4px}
.sev.crit{color:var(--fail);background:var(--fail-bg)}.sev.high{color:var(--warn);background:var(--warn-bg)}.sev.med{color:var(--cyan);background:rgba(69,184,204,.10)}.sev.low{color:var(--muted);background:var(--surf-3)}
.verd{font-family:var(--mono);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;border:1px solid}
.verd.fail{color:var(--fail);border-color:var(--fail)}.verd.pass{color:var(--pass);border-color:var(--pass)}.verd.inc{color:var(--warn);border-color:var(--warn)}
.chip{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);border:1px solid var(--border);padding:1px 6px;white-space:nowrap}
/* teaser */
.teaser-row{display:flex;gap:8px;align-items:baseline;margin:4px 0;font-size:var(--fs-sm)}
.teaser-num{color:var(--fail);font-family:var(--mono);font-size:var(--fs-xs)}
/* §2 ledger */
.lfilter{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:9px 0}
.lfilter b{font-family:var(--mono);font-size:var(--fs-2xs);padding:3px 8px;border:1px solid var(--border);color:var(--fg);opacity:.8;cursor:pointer}
.lfilter b.on{border-color:var(--primary);color:var(--primary-soft);background:rgba(126,71,215,.12)}
.lfilter input{background:var(--surf-2);border:1px solid var(--border);color:var(--fg);font-family:var(--mono);font-size:var(--fs-xs);padding:3px 8px;flex:1;max-width:240px}
.lfilter .sp{margin-left:auto;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim)}
.virt{font-size:var(--fs-2xs);color:var(--dim);text-align:center;padding:8px}
table.ledger td{cursor:pointer;font-family:var(--mono);font-size:var(--fs-xs)}
table.ledger tr:hover td{background:var(--surf-2)}table.ledger tr.sel td{background:rgba(126,71,215,.10)}
/* status-acuity — verdict-tinted ledger rows + a status left-accent (eye-catch at a glance) */
table.ledger tr.vrow.FAIL td{background:var(--fail-bg)}table.ledger tr.vrow.FAIL td.tid{box-shadow:inset 3px 0 0 var(--fail)}
table.ledger tr.vrow.INDETERMINATE td{background:var(--warn-bg)}table.ledger tr.vrow.INDETERMINATE td.tid{box-shadow:inset 3px 0 0 var(--warn)}
table.ledger tr.vrow.PASS td.tid{box-shadow:inset 3px 0 0 var(--pass)}
table.ledger tr.vrow.INCOMPLETE td.tid{box-shadow:inset 3px 0 0 var(--dim)}
table.ledger tr.vrow:hover td{background:var(--surf-2)}table.ledger tr.vrow.sel td{background:rgba(126,71,215,.10)}
.tid{color:var(--cyan)}.haswalk{color:var(--primary-soft);font-size:var(--fs-2xs)}
.mini{font-family:var(--mono);font-size:var(--fs-2xs);padding:1px 5px}
.mini.PASS{color:var(--pass);background:var(--pass-bg)}.mini.FAIL{color:var(--fail);background:var(--fail-bg)}.mini.INDETERMINATE{color:var(--warn);background:var(--warn-bg)}.mini.INCOMPLETE{color:var(--muted);background:var(--surf-3)}
/* WS-2 — resolution badge (ledger column) + drill routing line. Makes a no-walk trace
   HONEST: judged, not unjudged. walk=cyan · walk-dropped=amber · truncated=dim. */
.resbadge{font-family:var(--mono);font-size:var(--fs-2xs);padding:1px 6px;border:1px solid;white-space:nowrap;cursor:help}
.resbadge.res-walk{color:var(--cyan);border-color:var(--cyan);background:rgba(69,184,204,.10)}
.resbadge.res-nowalk{color:var(--warn);border-color:var(--warn);background:var(--warn-bg)}
.resbadge.res-trunc{color:var(--muted);border-color:var(--border-strong);background:var(--surf-3)}
.routing{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;margin:0 0 9px;padding:8px 11px;border-left:3px solid var(--border-strong);background:var(--surf-2)}
.routing.res-walk{border-left-color:var(--cyan)}
.routing.res-nowalk{border-left-color:var(--warn)}
.routing.res-trunc{border-left-color:var(--dim)}
.routing-k{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.routing-b{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-2xs);padding:1px 6px;border:1px solid}
.routing-b.res-walk{color:var(--cyan);border-color:var(--cyan)}
.routing-b.res-nowalk{color:var(--warn);border-color:var(--warn)}
.routing-b.res-trunc{color:var(--muted);border-color:var(--border-strong)}
.routing-v{flex:1 1 200px;font-size:var(--fs-sm);color:var(--fg);line-height:1.5}
/* §2 side-by-side */
.ctx{border:1px solid var(--border);background:var(--surf-2);margin:8px 0 4px}
.ctx-h{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan);text-transform:uppercase;letter-spacing:.06em;padding:6px 11px;border-bottom:1px solid var(--border)}
.ctx-g{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border)}.ctx-c{background:var(--surf);padding:8px 11px}
.ctx-c .l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase}.ctx-c .v{font-size:var(--fs-xs);margin-top:2px}
/* Gap A — raw triggering INPUT in the §2 drill (input + scenario cell). font floor 11px. */
.ctx-c .iraw{margin:0;font-family:var(--mono);font-size:var(--fs-2xs);line-height:1.5;color:var(--fg);white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);padding:6px 8px}
.ctx-c .iraw.clamp{max-height:120px;overflow:auto}
.ctx-c .iexp summary{cursor:pointer;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan);text-transform:uppercase;letter-spacing:.04em;padding:2px 0}
.ctx-c .iexp[open] summary{margin-bottom:4px}
.ctx-c .iscn{margin-top:4px;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
.ctx-c .ival{font-size:var(--fs-xs);color:var(--fg)}
.lanehdr{display:grid;grid-template-columns:1fr 42px 1fr}.lanehdr div{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;padding:5px 8px;border-bottom:1px solid var(--border-strong)}
.lanehdr .a{color:var(--fg-strong)}.lanehdr .x{text-align:center;color:var(--dim)}.lanehdr .j{color:var(--primary-soft)}
.grid2{display:grid;grid-template-columns:1fr 42px 1fr;align-items:stretch}
.band{grid-column:1/-1;border:1px solid var(--border);margin:8px 0;padding:7px 11px;background:var(--surf)}.band.loc{border-left:3px solid var(--fail);background:var(--fail-bg)}.band .bh{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--fail)}
.node{display:flex;flex-direction:column;align-items:center}.node .n{width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:var(--fs-xs);font-weight:600;border:1px solid var(--border-strong);background:var(--surf-2);margin-top:12px}.node .ln{flex:1;width:1px;background:var(--border)}
.node.error .n,.node.false-success .n{border-color:var(--fail);color:var(--fail)}.node.warn .n{border-color:var(--warn);color:var(--warn)}.node.ok .n{border-color:var(--pass);color:var(--pass)}
.evb{border:1px solid var(--border);background:var(--surf-2);padding:6px 9px;margin:8px 8px 8px 0}.evb.r{margin:8px 0 8px 8px}
.evb .top{display:flex;align-items:center;gap:6px}.evb .tool{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg-strong)}.evb .st{font-family:var(--mono);font-size:var(--fs-2xs);padding:1px 6px;margin-left:auto}
.evb .st.ok{color:var(--pass);background:var(--pass-bg)}.evb .st.error,.evb .st.false-success{color:var(--fail);background:var(--fail-bg)}.evb .st.warn{color:var(--warn);background:var(--warn-bg)}
.evb .det{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);margin-top:3px;line-height:1.4}
.jstep{display:flex;gap:6px;align-items:baseline;font-family:var(--mono);font-size:var(--fs-2xs);margin-top:4px}
.jstep .k{font-size:var(--fs-2xs);font-weight:600;padding:1px 5px;min-width:54px;text-align:center}
.k.context{color:var(--cyan);background:rgba(69,184,204,.10)}.k.examine,.k.detect{color:var(--warn);background:var(--warn-bg)}.k.bind{color:var(--cyan);background:rgba(69,184,204,.10)}.k.ground{color:var(--pass);background:var(--pass-bg)}.k.critique{color:var(--primary-soft);background:rgba(126,71,215,.12)}.k.decide{color:var(--fail);background:var(--fail-bg)}.k.verify{color:var(--fg-strong);background:var(--surf-3)}
.jstep .t{color:var(--fg);opacity:.92;line-height:1.4}.jstep .t .ref{color:var(--cyan)}
.jstep.noexam .t{color:var(--dim);font-style:italic}
/* §2 judge lane — per-step eval-coverage entry (which criterion examined this step). */
.jcov{border-left:2px solid var(--border-strong);background:var(--surf);padding:5px 8px;margin-top:6px}
.jcov.pass{border-left-color:var(--pass)}.jcov.fail{border-left-color:var(--fail)}
.jcov.uncertain,.jcov.indeterminate{border-left-color:var(--warn)}.jcov.na{border-left-color:var(--border)}
.jcov-h{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px}
.jcov .jm{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em;padding:0 5px;border:1px solid var(--border-strong)}
.jcov .jm.code{color:var(--cyan);border-color:var(--cyan)}.jcov .jm.judge{color:var(--primary-soft);border-color:var(--primary-soft)}
.jcov .jcid{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg-strong);word-break:break-all}
.jcov .jcrit{font-size:var(--fs-xs);color:var(--fg);opacity:.92;line-height:1.45}.jcov .jcrit .dim{color:var(--dim)}
.jcov .cvrefs{margin-top:4px}
.health{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);margin-top:8px}.health .hc{background:var(--surf);padding:8px 10px}.health .hc .l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase}.health .hc .v{font-size:var(--fs-lg);font-weight:600;margin-top:2px}.health .hc .v.good{color:var(--pass)}.health .hc .v.warn{color:var(--warn)}
.drillbox{border:1px solid var(--border-strong);background:var(--surf-2);margin-top:10px;padding:11px}
/* §3 heatmap + subcards + calibration */
.hm{display:grid;gap:3px;font-family:var(--mono);font-size:var(--fs-2xs);margin-top:6px}
.hm .lab{color:var(--fg);opacity:.82;text-align:right;padding-right:5px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hm .colh{color:var(--muted);text-align:center;font-size:var(--fs-2xs);line-height:13px}
.hm .cell{height:18px;border:1px solid rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#0a0a12;font-size:var(--fs-2xs);font-weight:700}
/* status-acuity — heatmap fills nudged up for contrast (still toned, not neon) */
.hm .cell.pass{background:var(--hm-pass,rgba(67,195,154,.50))}.hm .cell.fail{background:var(--hm-fail,rgba(224,102,102,.54))}.hm .cell.indet{background:var(--hm-indet,rgba(232,166,77,.52))}.hm .cell.skip{background:var(--surf-3)}
/* UI-6 — criteria cards: a PURPLISH base (brand primary), accent driven by SUCCESS RATE
 * (green-ish high · amber mid · red-ish low) — NOT a uniform severity red. */
.subc{border:1px solid var(--border);border-left:4px solid var(--primary);background:linear-gradient(180deg,rgba(126,71,215,.12),rgba(126,71,215,.045));margin-top:10px}
.subc.rate-ok{border-left-color:var(--pass)}
.subc.rate-mid{border-left-color:var(--warn)}
.subc.rate-low{border-left-color:var(--fail)}
.subc-h{display:flex;gap:8px;align-items:center;padding:8px 11px;border-bottom:1px solid var(--border)}.subc-h b{font-size:var(--fs-sm);color:var(--fg-strong)}.subc-h .vp{font-family:var(--mono);font-size:var(--fs-xs);font-weight:700;padding:1px 7px;border:1px solid}
.nest{border:1px solid var(--border);background:var(--surf);margin:7px 11px}.nest-h{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;padding:4px 9px;border-bottom:1px solid var(--border)}
.row{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg);opacity:.92;margin:4px 9px;line-height:1.5}.row .ref{color:var(--cyan)}.row .w{color:var(--warn)}
.cal{display:flex;gap:5px;align-items:center;padding:8px 11px;border-top:1px solid var(--border)}.cal .l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);margin-right:3px}.cal b{font-family:var(--mono);font-size:var(--fs-2xs);padding:2px 8px;border:1px solid var(--border);color:var(--fg);opacity:.85;cursor:pointer}.cal b.on{border-color:var(--primary);color:var(--primary-soft);background:rgba(126,71,215,.12)}
/* §4 findings */
.find{border:1px solid var(--border);background:var(--surf-2);margin-top:11px}.find.gate{border-top:2px solid var(--fail);border-left:4px solid var(--fail);background:var(--fail-bg)}
.find-h{display:flex;gap:9px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap}.find-h b{font-size:var(--fs-sm);color:var(--fg-strong)}.find-h .gatetag{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fail);border:1px solid var(--fail);padding:1px 6px}
.fg{display:grid;grid-template-columns:92px 1fr;gap:1px;background:var(--border)}.fg .k{background:var(--surf);font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;padding:8px 10px}
.fg .v{background:var(--surf-2);padding:8px 11px;font-size:var(--fs-sm);color:var(--fg)}.fg .v code{font-family:var(--mono);font-size:var(--fs-xs);background:var(--bg);padding:0 4px}.fg .v .ref{color:var(--cyan);font-family:var(--mono);font-size:var(--fs-xs)}.fg .v .none{color:var(--pass)}.fg .v ul{margin:2px 0;padding-left:15px}.fg .v li{margin:2px 0;font-size:var(--fs-xs);font-family:var(--mono)}
.fg .v.reason .step{color:var(--primary-soft)}.fg .v .lnk{color:var(--primary-soft);font-family:var(--mono);font-size:var(--fs-2xs);cursor:pointer}
.na-note{font-size:var(--fs-2xs);color:var(--dim)}
.prev{display:inline-block;background:var(--surf-3);height:8px;width:110px;vertical-align:middle}.prev i{display:block;height:100%;background:var(--fail)}
.areview{display:flex;gap:6px;align-items:center;padding:9px 12px;border-top:1px solid var(--border-strong);background:var(--surf)}.areview .l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan)}.areview b{font-family:var(--mono);font-size:var(--fs-2xs);padding:2px 9px;border:1px solid var(--border);color:var(--fg);opacity:.85;cursor:pointer}.areview b.agree.on{border-color:var(--pass);color:var(--pass)}.areview b.refute.on{border-color:var(--fail);color:var(--fail)}.areview input{flex:1;background:var(--surf-2);border:1px solid var(--border);color:var(--fg);font-family:var(--mono);font-size:var(--fs-xs);padding:3px 7px}
/* §4/§2 per-trajectory scorecard grid */
.scgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:5px;margin-top:6px}
.scc{border:1px solid var(--border);background:var(--surf);padding:5px 8px;font-family:var(--mono);font-size:var(--fs-2xs);display:flex;gap:6px;align-items:center}.scc.fail{border-left:2px solid var(--fail)}.scc.uncertain,.scc.indeterminate{border-left:2px solid var(--warn)}.scc .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* WS-3 §5 self-eval AGGREGATE — judge-calibration surface */
.se-h{font-size:var(--fs-md);margin:22px 0 4px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.se-num{font-family:var(--mono);font-weight:700;color:var(--primary-soft)}
.se-tag{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 6px;border:1px solid var(--border-strong);color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.se-tag.agg{color:var(--cyan);border-color:var(--cyan)}.se-tag.gt{color:var(--pass);border-color:var(--pass)}.se-tag.proxy{color:var(--warn);border-color:var(--warn)}.se-tag.hitl{color:var(--primary-soft);border-color:var(--primary)}.se-tag.future{color:var(--dim);border-color:var(--border)}
.se-checks{border:1px solid var(--border);border-left:3px solid var(--primary);background:var(--surf-2);margin:10px 0 4px;padding:9px 12px}
.se-checks-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:6px}
.se-checks-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px}
.se-check{display:flex;gap:7px;align-items:baseline}.se-cn{color:var(--primary-soft);font-family:var(--mono);font-weight:700}.se-ck{font-weight:600;color:var(--fg-strong);font-size:var(--fs-sm);white-space:nowrap}.se-cv{color:var(--muted);font-size:var(--fs-xs);line-height:1.4}
.se-trust{display:flex;gap:16px;align-items:center;border:1px solid var(--border-strong);background:var(--surf);margin:12px 0;padding:14px 16px;border-left:3px solid var(--primary)}
.se-trust.good{border-left-color:var(--pass)}.se-trust.warn{border-left-color:var(--warn)}.se-trust.bad{border-left-color:var(--fail)}
.se-trust-score{font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;color:var(--fg-strong);line-height:1}.se-trust-d{font-size:var(--fs-md);color:var(--dim)}
.se-trust-cap{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-top:3px}
.se-trust.good .se-trust-score{color:var(--pass)}.se-trust.warn .se-trust-score{color:var(--warn)}.se-trust.bad .se-trust-score{color:var(--fail)}
.se-trust-label{font-weight:600;color:var(--fg-strong);font-size:var(--fs-md)}.se-trust-basis{color:var(--muted);font-size:var(--fs-sm);margin-top:4px;line-height:1.5}
.se-clusters{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:9px;margin:10px 0}
.se-cl{border:1px solid var(--border);border-top:3px solid var(--border-strong);background:var(--surf);padding:9px 11px}
.se-cl.good{border-top-color:var(--pass)}.se-cl.bad{border-top-color:var(--fail)}.se-cl.warn{border-top-color:var(--warn)}.se-cl.neutral{border-top-color:var(--dim)}
.se-cl-top{display:flex;gap:8px;align-items:baseline}.se-cl-n{font-family:var(--mono);font-size:var(--fs-xl);font-weight:700;color:var(--fg-strong)}.se-cl-l{font-size:var(--fs-sm);font-weight:600;color:var(--fg)}
.se-cl-note{font-size:var(--fs-xs);color:var(--muted);margin-top:4px;line-height:1.45}
.se-conc{border:1px solid var(--border);background:var(--surf-2);padding:9px 12px;margin:6px 0}
.se-conc-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:6px}
.se-conc-r,.se-conf-r,.se-emit-r{display:flex;gap:9px;align-items:center;margin:3px 0;font-size:var(--fs-xs)}
.se-conc-id{font-family:var(--mono);color:var(--cyan);flex:0 0 200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.se-conc-v,.se-conf-v,.se-emit-v{font-family:var(--mono);color:var(--muted);flex:0 0 auto;white-space:nowrap}
.sebar{flex:1 1 auto;height:11px;background:var(--bg);border:1px solid var(--border);position:relative;overflow:hidden}
.sebar-f{position:absolute;left:0;top:0;bottom:0}.sebar-f.p{background:linear-gradient(90deg,#3a2d63,var(--primary))}.sebar-f.good{background:var(--pass)}.sebar-f.warn{background:var(--warn)}.sebar-f.bad{background:var(--fail)}
.se-row{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
.se-metric{border:1px solid var(--border);background:var(--surf);padding:9px 14px;min-width:140px;border-left:3px solid var(--border-strong)}
.se-metric.good{border-left-color:var(--pass)}.se-metric.warn{border-left-color:var(--warn)}.se-metric.bad{border-left-color:var(--fail)}
.se-metric-v{font-family:var(--mono);font-size:var(--fs-xl);font-weight:700;color:var(--fg-strong)}
.se-metric.good .se-metric-v{color:var(--pass)}.se-metric.warn .se-metric-v{color:var(--warn)}.se-metric.bad .se-metric-v{color:var(--fail)}
.se-metric-l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;margin-top:3px}
.se-kv{display:flex;gap:16px;align-items:center;font-size:var(--fs-sm);color:var(--muted)}.se-kv b{color:var(--fg-strong);font-family:var(--mono)}
.se-note{font-size:var(--fs-sm);color:var(--muted);margin:5px 0 2px;line-height:1.5}
.se-empty{font-family:var(--mono);font-size:var(--fs-xs);color:var(--dim);border:1px dashed var(--border-strong);padding:12px;text-align:center;margin:6px 0}
.se-conf-b{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg);flex:0 0 64px}
.se-table{width:100%;border-collapse:collapse;margin:8px 0;font-size:var(--fs-xs)}
.se-table th{text-align:left;font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--border);padding:5px 8px}
.se-table td{padding:5px 8px;border-bottom:1px solid var(--border);font-family:var(--mono)}
.se-table td.good{color:var(--pass)}.se-table td.bad{color:var(--fail)}.se-table td.warn{color:var(--warn)}.se-table td.dim{color:var(--dim)}
.se-cid{color:var(--cyan);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.se-flag{font-size:var(--fs-2xs);padding:1px 6px;border:1px solid}.se-flag.good{color:var(--pass);border-color:var(--pass)}.se-flag.bad{color:var(--fail);border-color:var(--fail)}.se-flag.warn{color:var(--warn);border-color:var(--warn)}
.se-vverdict{color:var(--muted)}
.se-hitl,.se-spot-act{display:flex;gap:4px}
.se-pick{font-family:var(--mono);font-size:var(--fs-2xs);padding:1px 7px;border:1px solid var(--border);color:var(--muted);cursor:pointer;user-select:none}
.se-pick:hover{border-color:var(--primary);color:var(--fg)}
.se-pick.on{border-color:var(--primary);color:var(--primary-soft);background:rgba(126,71,215,.14);font-weight:700}
.se-blocked{border:1px solid var(--fail);background:var(--fail-bg);padding:9px 12px;margin:6px 0;font-size:var(--fs-sm);color:var(--fg);line-height:1.5}
.se-blocked-tag{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--fail);border:1px solid var(--fail);padding:1px 6px;margin-right:6px}
.se-emit{border:1px solid var(--border);background:var(--surf-2);padding:10px 12px;margin:6px 0}
.se-emit-l{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg);flex:0 0 160px}
.se-spots{display:flex;flex-direction:column;gap:5px;margin:6px 0}
.se-spot{display:flex;gap:9px;align-items:center;flex-wrap:wrap;border:1px solid var(--border);border-left:3px solid var(--warn);background:var(--surf);padding:6px 10px;font-size:var(--fs-xs)}
.se-spot-t{color:var(--cyan);flex:0 0 auto}.se-spot-c{color:var(--fg);flex:1 1 200px}.se-spot-conf{font-family:var(--mono);color:var(--muted)}.se-spot-why{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--warn)}.se-spot-act{margin-left:auto}
.se-future{border:1px dashed var(--border-strong);background:var(--surf-2);padding:10px 13px;margin:6px 0;opacity:.92}
.se-future-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:5px}
.se-future-b{font-size:var(--fs-sm);color:var(--muted);line-height:1.55}
/* §5 self-eval health */
.hsc{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);margin-top:10px}.hsc .hc{background:var(--surf);padding:10px 12px}.hsc .hc .l{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase}.hsc .hc .v{font-size:var(--fs-xl);font-weight:700;margin-top:3px;font-family:var(--mono)}.hsc .hc .v.good{color:var(--pass)}.hsc .hc .v.warn{color:var(--warn)}
/* UI-12-B — honest grounded health: rate-coloured (low=critical), capture-na=muted (never green) */
.hsc .hc .v.rate-ok{color:var(--pass)}.hsc .hc .v.rate-mid{color:var(--warn)}.hsc .hc .v.rate-low{color:var(--fail)}
.hsc .hc .v.capture-na{color:var(--dim);font-size:var(--fs-sm);font-weight:600;cursor:help}
.copy-md{font-family:var(--mono);font-size:var(--fs-xs);padding:4px 10px;border:1px solid var(--border);background:var(--surf-2);color:var(--fg);cursor:pointer;margin-top:8px}
.copy-md:hover{border-color:var(--cyan);color:var(--cyan)}
.copy-md.copied{border-color:var(--pass);color:var(--pass)}
.copy-md.copyfail{border-color:var(--warn);color:var(--warn)}
/* WS-4 — refined EV-051 "routed to diagnostics" handover block */
.hov-meta{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0 10px}
.hov-meta .hm-c{display:flex;flex-direction:column;gap:1px;border:1px solid var(--border);border-left:3px solid var(--primary);background:var(--surf);padding:5px 10px;min-width:90px}
.hov-meta .hm-c .l{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--cyan)}
.hov-meta .hm-c .v{font-size:var(--fs-sm);color:var(--fg-strong)}
.hov-list{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.hov{border:1px solid var(--border);border-left:3px solid var(--fail);background:var(--surf)}
.hov-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 11px;border-bottom:1px solid var(--border);background:var(--surf-2)}
.hov-h .hov-n{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
.hov-h b{font-family:var(--mono);font-size:var(--fs-sm);color:var(--fg-strong)}
.hov-copy{margin:0 0 0 auto;padding:2px 9px;font-size:var(--fs-2xs)}
.hov-g{display:grid;grid-template-columns:64px 1fr;gap:5px 11px;padding:9px 11px}
.hov-g .hk{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--cyan);padding-top:2px}
.hov-g .hv{font-size:var(--fs-sm);color:var(--fg);line-height:1.5;min-width:0;word-break:break-word}
.hov-dim{color:var(--muted);font-family:var(--mono);font-size:var(--fs-2xs)}
/* §9.4.4 R3 per-tab description */
.tabdesc{border:1px solid var(--border);border-left:3px solid var(--cyan);background:var(--surf-2);padding:7px 11px;font-size:var(--fs-xs);color:var(--fg);opacity:.92;line-height:1.5;margin:8px 0 12px}
.tabdesc .td-i{color:var(--cyan);font-weight:700;margin-right:5px}
/* §9.4.4 R4 criterion provenance + hover + statement */
.prov{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 6px;border:1px solid;text-transform:uppercase;cursor:help}
.prov.defined{color:var(--cyan);border-color:var(--cyan);background:rgba(69,184,204,.10)}
.prov.source{color:var(--primary-soft);border-color:var(--primary);background:rgba(126,71,215,.12)}
/* UI-10 — CODE vs JUDGE method chip (how a criterion is evaluated) */
.method{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 6px;border:1px solid;text-transform:uppercase;letter-spacing:.03em;cursor:help;white-space:nowrap}
.method.code{color:var(--warn);border-color:var(--warn);background:rgba(214,158,46,.12)}
.method.hybrid{color:var(--cyan);border-color:var(--cyan);background:rgba(69,184,204,.10)}
.method.judge{color:var(--muted);border-color:var(--border-strong);background:var(--surf-2)}
.ihover{color:var(--cyan);font-size:var(--fs-xs);cursor:help;border-bottom:1px dotted var(--cyan)}
.cstmt{font-size:var(--fs-xs);color:var(--muted);margin-top:3px;line-height:1.4;white-space:normal}
td .cstmt{font-family:var(--sans,inherit)}
/* §9.4.4 R3/M5 detected-but-unmatched */
.fails-h,.detected-h{font-size:var(--fs-sm);margin-top:14px}
.detected-h{color:var(--warn)}
.detected{border:1px solid var(--warn);border-left:3px solid var(--warn);background:var(--warn-bg);margin-top:8px;padding:7px 11px}
.detected-top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.detected-top b{font-size:var(--fs-sm);color:var(--fg-strong)}
.dkind{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--warn);border:1px solid var(--warn);padding:1px 6px;text-transform:uppercase}
.dtrace{font-size:var(--fs-2xs);color:var(--muted);margin-left:auto}
.detected-ev{font-size:var(--fs-2xs);color:var(--muted);margin-top:4px}.detected-ev .ref{color:var(--cyan)}
/* §9.4.4 R2/M1 internal subject-profile card */
.profile-grid{display:grid;grid-template-columns:max-content 1fr;gap:1px;background:var(--border);border:1px solid var(--border);margin:8px 0}
.profile-grid .pk{background:var(--surf);font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;padding:6px 10px}
.profile-grid .pv{background:var(--surf-2);font-size:var(--fs-xs);color:var(--fg);padding:6px 11px}
/* §9.4.4 R2/M4 phase-block lens */
.phase-lens{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;margin:8px 0}
.phase-blk{border:1px solid var(--border);background:var(--surf);padding:7px 9px}
.phase-h{display:flex;gap:6px;align-items:center;margin-bottom:4px}.phase-n{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);margin-left:auto}
.ps-row{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);opacity:.88;line-height:1.4;margin-top:3px;border-top:1px solid var(--border);padding-top:3px}
.phase-h .k.gather{color:var(--cyan);background:rgba(69,184,204,.10)}.phase-h .k.expect{color:var(--primary-soft);background:rgba(126,71,215,.12)}
/* §9.4.4 R2/M2+M3 reasoning example */
.re-blk{border:1px solid var(--border);background:var(--surf-2);padding:8px 11px;margin-top:8px}
.re-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--cyan);margin-bottom:5px}
.re-rephrase{font-size:var(--fs-sm);color:var(--fg-strong);font-style:italic;line-height:1.5}
.re-sub{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--muted);margin-top:6px}
.re-ul{margin:3px 0;padding-left:18px}.re-ul li{font-size:var(--fs-xs);margin:2px 0;line-height:1.4}.re-rat{color:var(--muted)}
/* UI-2 — verdict-state legend (Overview + Scorecard) */
.vlegend{border:1px solid var(--border);border-left:3px solid var(--cyan);background:var(--surf-2);padding:8px 11px;margin:10px 0}
.vlegend .vl-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--cyan);margin-bottom:6px}
.vlegend .vl-item{display:flex;gap:9px;align-items:baseline;margin:4px 0;line-height:1.45}
.vlegend .vl-k{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 7px;border:1px solid;min-width:108px;text-align:center;flex:0 0 auto}
.vlegend .vl-v{font-size:var(--fs-xs);color:var(--fg);opacity:.92}
.vlegend .vl-k.pass{color:var(--pass);border-color:var(--pass);background:var(--pass-bg)}
.vlegend .vl-k.fail{color:var(--fail);border-color:var(--fail);background:var(--fail-bg)}
.vlegend .vl-k.inc{color:var(--muted);border-color:var(--border-strong);background:var(--surf-3)}
.vlegend .vl-k.indet{color:var(--warn);border-color:var(--warn);background:var(--warn-bg)}
.vlegend .vl-k.na{color:var(--dim);border-color:var(--border);background:var(--surf)}
/* UI-3 — heatmap horizontal-scroll container (no page overflow) */
.hm-scroll{overflow-x:auto;max-width:100%;padding-bottom:2px}
.hm .colh{word-break:break-word;white-space:normal}
/* UI-5 — success-rate + key-metrics summary row under the heatmap */
.sc-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin:10px 0 6px}
.scm{border:1px solid var(--border);border-top:3px solid var(--border-strong);background:var(--surf);padding:9px 11px}
.scm-v{font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;line-height:1.05;color:var(--fg-strong)}
.scm-l{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--cyan);margin-top:3px}
.scm-n{font-size:var(--fs-2xs);color:var(--dim);margin-top:3px;line-height:1.4}
.scm.rate-ok{border-top-color:var(--pass)}.scm.rate-ok .scm-v{color:var(--pass)}
.scm.rate-mid{border-top-color:var(--warn)}.scm.rate-mid .scm-v{color:var(--warn)}
.scm.rate-low{border-top-color:var(--fail)}.scm.rate-low .scm-v{color:var(--fail)}
.scm.rate-na{border-top-color:var(--border)}
/* UI-12-B — capture-unavailable grounded tile: long honest label, not a big green number */
.scm.pending .scm-v{font-size:var(--fs-sm);color:var(--dim);word-break:break-word}
/* UI-7 — criterion-definition meta line */
.nest .row.defn-meta{color:var(--cyan);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.03em}
/* UI-8 — calibrate groups (mutually-exclusive radio semantics) */
.cal .calgroup{display:inline-flex;gap:5px;align-items:center}
/* UI-4 — judge-reasoning bands in the §2 drill (why this verdict + full why-chain) */
.band.whyverdict{border-left:3px solid var(--primary);background:rgba(126,71,215,.08)}
.band.whyverdict .wv-t{font-size:var(--fs-sm);color:var(--fg);line-height:1.5;margin-top:4px}
.ctx.whychain{margin:8px 0}
.ctx.whychain .wc-body{padding:7px 11px;display:flex;flex-direction:column;gap:2px}
.why-note{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);margin-top:4px;line-height:1.45}.why-note .ref{color:var(--cyan)}
/* WS-5 — indeterminate resolution chain (§3): per-criterion applicable·pass·fail·N/A·needs-evidence */
.rztable{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.rzrow{border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surf);padding:8px 11px}
.rzrow.crit,.rzrow.high{border-left-color:var(--fail)}.rzrow.med{border-left-color:var(--warn)}.rzrow.low{border-left-color:var(--border-strong)}
.rz-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:5px}
.rz-h b{font-size:var(--fs-sm);color:var(--fg-strong)}
.rz-rate{margin-left:auto;font-family:var(--mono);font-size:var(--fs-2xs)}
.rz-stats{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rz{font-family:var(--mono);font-size:var(--fs-2xs);padding:2px 7px;border:1px solid var(--border)}
.rz.applicable{color:var(--fg-strong);border-color:var(--border-strong)}
.rz.pass{color:var(--pass);border-color:var(--pass)}
.rz.fail{color:var(--fail);border-color:var(--fail)}
.rz.na{color:var(--cyan);border-color:var(--cyan);background:rgba(108,196,212,.08)}
.rz.ne{color:var(--warn);border-color:var(--warn);background:rgba(214,158,46,.08)}
.rz.zero{color:var(--dim);border-color:var(--border);background:none}
.rz-reason{display:inline-block;font-size:var(--fs-2xs);color:var(--muted);font-style:italic;margin-left:4px}
.rz-act{display:inline-flex;flex-direction:column;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--warn);border:1px dashed var(--warn);padding:2px 7px}
.rz-act .rz-reason{color:var(--muted);font-family:var(--sans,inherit)}
/* WS-3 — one-line plain-language gloss (what it measures · why it matters), muted,
   sits ABOVE the technical block in BOTH §3 scorecard subcards and §4 finding cards */
.plain{font-size:var(--fs-xs);color:var(--muted);line-height:1.5;margin:6px 0 8px;padding:6px 9px;border-left:2px solid var(--cyan);background:rgba(108,196,212,.06);font-style:italic}
/* WS-3 follow-up — per-criterion plain-language KEY directly under the §3 heatmap (ALL criteria) */
.plain-legend{margin:8px 0 4px}
.plain-legend .pl-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--cyan);margin:0 0 5px}
.plain-leg{display:flex;gap:8px;align-items:baseline;margin:0 0 4px;flex-wrap:wrap}
.plain-leg .pl-id{font-style:normal;color:var(--fg-strong);font-size:var(--fs-2xs);flex:0 0 auto}
.plain-leg .pl-tx{font-style:italic;color:var(--muted);flex:1 1 240px;min-width:0}
/* WS-1 — "how the judge reasoned" per-criterion critique block (side-by-side + scorecard drill) */
.cvblock{margin:8px 0}
.cvblock .cvbody{display:flex;flex-direction:column;gap:6px;padding:7px 9px}
.cvrow{border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surf);padding:7px 9px}
.cvrow.pass{border-left-color:var(--pass)}.cvrow.fail{border-left-color:var(--fail)}
.cvrow.uncertain,.cvrow.indeterminate{border-left-color:var(--warn)}.cvrow.na{border-left-color:var(--border)}
.cvh{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:3px}
.cvb{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border:1px solid var(--border-strong)}
.cvb.pass{color:var(--pass);border-color:var(--pass)}.cvb.fail{color:var(--fail);border-color:var(--fail)}
.cvb.uncertain,.cvb.indeterminate{color:var(--warn);border-color:var(--warn)}.cvb.na{color:var(--dim)}
.cvid{font-family:var(--mono);font-size:var(--fs-xs);color:var(--fg-strong)}
.cvconf{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);margin-left:auto}
.cvcrit{font-size:var(--fs-sm);color:var(--fg);line-height:1.5}.cvcrit.dim{color:var(--dim)}
.cvrefs{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.cvref{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan);border:1px solid var(--border);padding:1px 5px;word-break:break-all}
`;

// ── the embedded client JS (ledger filter/search + drill + tabs + toggles) ───

/**
 * The embedded client JS — ledger filter/search + click-row drill (side-by-side
 * when judge_steps exist, else the per-trajectory scorecard) + tab switching +
 * calibration/alignment toggles + copy-as-markdown. The data (ledger `L`,
 * criteria `C`, judge-walks `J`) is injected as deterministic JSON.
 */
function clientScript(ledgerJson: string, critJson: string, walksJson: string, resMetaJson: string): string {
  return `
const L=${ledgerJson},C=${critJson},J=${walksJson},RES=${resMetaJson};let F='all';
function resBadge(res){var m=RES[res];if(!m)return '';return '<span class="resbadge '+m.cls+'" title="'+esc(m.routing)+'">'+esc(m.badge)+'</span>';}
function resRouting(res){var m=RES[res];if(!m)return '';return '<div class="routing '+m.cls+'"><span class="routing-k">resolution</span><span class="routing-b '+m.cls+'">'+esc(m.badge)+'</span><span class="routing-v">'+esc(m.routing)+'</span></div>';}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function wireTabs(){var btns=document.querySelectorAll('nav.tabs button'),panels=document.querySelectorAll('main .panel');
  btns.forEach(function(b){b.addEventListener('click',function(){var key=b.getAttribute('data-tab');
    btns.forEach(function(x){x.classList.remove('active');});panels.forEach(function(p){p.classList.remove('active');});
    b.classList.add('active');var p=document.getElementById(key);if(p)p.classList.add('active');});});}
function cnt(c){var p=0,f=0,n=0;for(var k in c){if(c[k]=='pass')p++;else if(c[k]=='fail')f++;else if(c[k]=='uncertain'||c[k]=='indeterminate')n++;}return[p,f,n];}
function render(){var qi=document.getElementById('q');if(!qi)return;var q=(qi.value||'').toLowerCase();
  var rows=L.filter(function(r){return (F=='all'||r.v==F)&&(!q||r.t.toLowerCase().indexOf(q)>=0||(r.r||'').toLowerCase().indexOf(q)>=0);});
  var cntEl=document.getElementById('cnt');if(cntEl)cntEl.textContent=rows.length+' / '+L.length+' trajectories';
  var cap=rows.slice(0,150);
  document.getElementById('lrows').innerHTML=cap.map(function(r){var c=cnt(r.c),p=c[0],f=c[1],n=c[2];
    return '<tr data-id="'+esc(r.t)+'" class="vrow '+esc(r.v)+'"><td class="tid">'+esc(r.t.slice(0,14))+(r.js?' <span class=haswalk>✦</span>':'')+'</td><td>'+esc(r.r||'all')+'</td><td><span class="mini '+esc(r.v)+'">'+esc(r.v)+'</span></td><td>'+resBadge(r.res)+'</td><td>'+p+'</td><td>'+f+'</td><td>'+n+'</td><td style="color:var(--fail)">'+esc((r.f||[]).join(', '))+'</td></tr>';}).join('');
  var virt=document.getElementById('virt');if(virt)virt.textContent=rows.length>150?('▾ showing 150 of '+rows.length+' — filter/search to narrow'):'';
  document.querySelectorAll('table.ledger tbody tr').forEach(function(tr){tr.addEventListener('click',function(){drill(tr.getAttribute('data-id'),tr);});});
  /* Surface the Agent‖Judge side-by-side BY DEFAULT: on the first render, auto-open the
     first JUDGED trace (one that has a judge walk) so the two-lane trajectory shows without
     a click. Once only — never hijacks the drill after the user starts navigating. */
  if(!window._autoDrilled){var jr=null;for(var i=0;i<cap.length;i++){if(cap[i].js){jr=cap[i];break;}}jr=jr||cap[0];if(jr){var atr=document.querySelector('table.ledger tbody tr[data-id="'+jr.t+'"]');if(atr){window._autoDrilled=true;drill(jr.t,atr);}}}}
// WS-1 — the "How the Judge Reasoned" per-criterion block: result badge +
// critique-before-verdict + grounding refs, read off the verdict file's verdicts[].
// Shared by BOTH the side-by-side drill (walk traces) and the per-trajectory
// scorecard drill (no-walk traces) so NO judged trace renders an empty panel.
function cvRefs(refs){if(!refs||!refs.length)return '';
  return '<div class="cvrefs">'+refs.map(function(rf){var s=(typeof rf==='string')?rf:[rf.obs,rf.path,rf.value].filter(Boolean).join(' · ');return s?'<span class="cvref">'+esc(s)+'</span>':'';}).join('')+'</div>';}
function critiqueBlock(cvs){if(!cvs||!cvs.length)return '';
  var order={fail:0,uncertain:1,indeterminate:1,pass:2,na:3};
  var rows=cvs.slice().sort(function(a,b){return (order[a.result]==null?9:order[a.result])-(order[b.result]==null?9:order[b.result]);}).map(function(v){
    var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
    var conf=(v.confidence!=null)?'<span class="cvconf">conf '+esc(v.confidence)+(v.confidenceBand?' · '+esc(v.confidenceBand):'')+'</span>':'';
    var crit=v.critique?'<div class="cvcrit">'+esc(v.critique)+'</div>':'<div class="cvcrit dim">— no critique recorded for this criterion</div>';
    return '<div class="cvrow '+esc(res)+'"><div class="cvh"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span><span class="cvid">'+esc(v.criterionId||'')+'</span>'+conf+'</div>'+crit+cvRefs(v.refs)+'</div>';}).join('');
  return '<div class="ctx cvblock"><div class="ctx-h">◇ how the judge reasoned — per-criterion verdict · critique-before-verdict · grounding refs ('+cvs.length+')</div><div class="cvbody">'+rows+'</div></div>';}
function sideBySide(d){var ctx=d.context||{};
  // Gap A — the §2 "input + scenario" cell renders the RAW triggering INPUT (the
  // thing that fired the agent) ABOVE the judge's scenario LABEL. Long inputs
  // collapse into a <details> (lean, no JS) so the cell stays compact; short ones
  // render inline (clamped). ABSENT input ⇒ the cell shows the scenario alone (or
  // "—"). Font stays at the --fs-2xs (11px) floor + brand mono.
  var inputCell=function(raw,scen){
    var sc=scen?'<div class="iscn">scenario · '+esc(scen)+'</div>':'';
    if(!raw)return (scen?'<div class="ival">'+esc(scen)+'</div>':'—');
    var long=String(raw).length>180;
    var body=long
      ? '<details class="iexp"><summary>raw input · '+String(raw).length+' chars</summary><pre class="iraw">'+esc(raw)+'</pre></details>'
      : '<pre class="iraw clamp">'+esc(raw)+'</pre>';
    return body+sc;};
  var refStr=function(rf){if(!rf)return '';if(typeof rf==='string')return rf;return [rf.obs,rf.path,rf.value].filter(Boolean).join(':');};
  // UI-4 — surface the judge's REASONING (why the verdict + why the exit-states were
  // concluded) from the EXISTING judge walk: an ordered why-chain band + the decide/bind
  // text inlined where it explains a conclusion. No emit-contract change — read-only over
  // the judge_steps already on the verdict file.
  var KORD={gather:0,context:1,examine:2,detect:3,bind:4,ground:5,critique:6,decide:7,verify:8};
  var allJs=(d.judgeSteps||[]).slice();
  var stepText=function(kind){return allJs.filter(function(s){return s.kind===kind;}).map(function(s){return s.text||'';}).filter(Boolean).join(' · ');};
  var decideWhy=stepText('decide')||stepText('critique');
  var stateWhy=[stepText('bind'),stepText('gather')].filter(Boolean).join(' · ');
  var chainSteps=allJs.slice().sort(function(a,b){var x=KORD[a.kind];var y=KORD[b.kind];return (x==null?9:x)-(y==null?9:y);});
  var whyChain=chainSteps.length?('<div class="ctx whychain"><div class="ctx-h">◇ judge reasoning — full why-chain (gather → bind → ground → decide)</div><div class="wc-body">'+chainSteps.map(function(s){var rs=refStr(s.ref);return '<div class="jstep"><span class="k '+esc(s.kind)+'">'+esc(s.kind)+'</span><span class="t">'+esc(s.text||'')+(rs?' <span class=ref>'+esc(rs)+'</span>':'')+'</span></div>';}).join('')+'</div></div>'):'';
  var verdictWhy=decideWhy?('<div class="band whyverdict"><div class="bh" style="color:var(--primary-soft)">◇ why this verdict</div><div class="wv-t">'+esc(decideWhy)+'</div></div>'):'';
  // -- §2 judge lane = per-step EVAL COVERAGE --
  // The judge lane (.step-r) used to filter judgeSteps by anchor === a.n -- but
  // judges never emit an anchor, so EVERY step rendered a bare dash. Instead we
  // map each agent step -> the per-criterion verdicts (d.criterionVerdicts) whose
  // grounding refs EXAMINED that step: a precise ref.obs === step.obs match plus
  // the tool-name fallback (ref.path === 'name' && ref.value === step.tool).
  // Each examining criterion renders one compact entry -- result + CODE/JUDGE tag
  // + criterionId + the judge reasoning (critique). A step no criterion references
  // says 'not examined by any eval' (honest), never a bare dash. Any judge step
  // that DOES carry a real anchor is still honored (future-proof).
  var cvAll=(d.criterionVerdicts||[]);
  var refExaminesStep=function(rf,a){
    if(!rf||typeof rf==='string')return false;
    if(a.obs&&rf.obs&&String(rf.obs)===String(a.obs))return true;
    if(rf.path==='name'&&rf.value!=null&&a.tool&&String(rf.value)===String(a.tool))return true;
    return false;};
  var covEntry=function(v,a){
    var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
    // the router carries TWO vocabularies: matrix-derived ('deterministic') and
    // mined ('code-based'); 'hybrid' is shared. A '[code-eval ...]'-prefixed critique
    // is the deterministic-logic fallback when the method is unset.
    var method=((typeof C!=='undefined'&&C[v.criterionId])||{}).m||'';
    var isCode=method==='deterministic'||method==='code-based'||method==='hybrid'||String(v.critique||'').trim().indexOf('[code-eval')===0;
    var tag=method==='hybrid'?'HYBRID':(isCode?'CODE':'JUDGE');
    var matched=(v.refs||[]).filter(function(rf){return typeof rf!=='string'&&refExaminesStep(rf,a);});
    var crit=v.critique?esc(v.critique):'<span class="dim">— no critique recorded</span>';
    return '<div class="jcov '+esc(res)+'"><div class="jcov-h"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span><span class="jm '+(isCode?'code':'judge')+'" title="'+(isCode?'deterministically checked by a code-eval (not LLM-judged)':'reasoned by the LLM judge')+'">'+esc(tag)+'</span><span class="jcid">'+esc(v.criterionId||'')+'</span></div><div class="jcrit">'+crit+'</div>'+cvRefs(matched)+'</div>';};
  var rowsHtml='';(d.agentSteps||[]).forEach(function(a){
    // future-proof: a judge step that carries a REAL anchor still renders.
    var js=(d.judgeSteps||[]).filter(function(s){return s.anchor!=null&&String(s.anchor)===String(a.n)&&s.kind!=='context';});
    var anchoredHtml=js.map(function(s){var rs=refStr(s.ref);return '<div class="jstep"><span class="k '+esc(s.kind)+'">'+esc(s.kind)+'</span><span class="t">'+esc(s.text||'')+' '+(rs?'<span class=ref>'+esc(rs)+'</span>':'')+'</span></div>';}).join('');
    var examiners=cvAll.filter(function(v){return (v.refs||[]).some(function(rf){return refExaminesStep(rf,a);});});
    var covHtml=examiners.map(function(v){return covEntry(v,a);}).join('');
    var jhtml=anchoredHtml+covHtml;
    if(!jhtml)jhtml='<div class="jstep noexam"><span class="t">— not examined by any eval</span></div>';
    rowsHtml+='<div class="step-l"><div class="evb"><div class="top"><span class="tool">'+esc(a.tool||'')+'</span><span class="st '+esc(a.status||'')+'">'+esc(a.status||'')+'</span></div><div class="det">'+esc(a.detail||'')+'</div></div></div><div class="node '+esc(a.status||'')+'"><div class="ln"></div><div class="n">'+esc(a.n)+'</div><div class="ln"></div></div><div class="step-r"><div class="evb r">'+jhtml+'</div></div>';});
  var h=d.health||{};
  var sp=d.subjectProfile;
  var spHtml=sp?'<div class="ctx"><div class="ctx-h">◇ judge · subject profile (M1) · '+esc(sp.provenance||'')+'</div><div class="ctx-g"><div class="ctx-c"><div class="l">identity</div><div class="v">'+esc(sp.identity||'—')+'</div></div><div class="ctx-c"><div class="l">purpose</div><div class="v">'+esc(sp.purpose||'—')+'</div></div><div class="ctx-c"><div class="l">scope · harness</div><div class="v">'+esc((sp.scope||'—'))+' · harness: '+esc(sp.harness||'—')+'</div></div></div></div>':'';
  var u=d.understanding;
  var uHtml=u?'<div class="band"><div class="bh" style="color:var(--cyan)">◇ node-0 GATHER — understanding (M2)</div><div class="re-rephrase" style="margin-top:4px">“'+esc(u.rephrase||'')+'”</div></div>':'';
  var et=d.expectedTrajectory||[];
  var etHtml=et.length?'<div class="band"><div class="bh" style="color:var(--primary-soft)">◇ node-0.5 EXPECTED-TRAJECTORY (M3) — how it SHOULD have acted</div><ol class="re-ul" style="margin-top:4px">'+et.map(function(s,i){return '<li><b>'+esc(s.step||i+1)+'.</b> '+esc(s.expected||'')+(s.rationale?' <span class=re-rat>— '+esc(s.rationale)+'</span>':'')+'</li>';}).join('')+'</ol></div>':'';
  return '<div class="drillbox"><div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b class="mono">'+esc(d.traceId)+'</b><span class="chip">'+esc(d.route||'all')+'</span><span class="verd '+(d.verdict=='FAIL'?'fail':d.verdict=='PASS'?'pass':'inc')+'">'+esc(d.verdict)+'</span></div>'+
    resRouting(d.res||'judge-walk')+
    spHtml+
    verdictWhy+
    critiqueBlock(d.criterionVerdicts)+
    '<div class="ctx"><div class="ctx-h">◇ judge · gather context</div><div class="ctx-g"><div class="ctx-c"><div class="l">harness</div><div class="v">'+esc(ctx.harness||'—')+'</div></div><div class="ctx-c"><div class="l">input + scenario</div><div class="v">'+inputCell(d.input,ctx.scenario)+'</div></div><div class="ctx-c"><div class="l">exit states</div><div class="v">'+esc(ctx.exitStates||'—')+(stateWhy?'<div class="why-note"><span class="ref">why concluded:</span> '+esc(stateWhy)+'</div>':'')+'</div></div></div></div>'+
    whyChain+
    uHtml+etHtml+
    '<div class="lanehdr"><div class="a">target agent — what it did</div><div class="x">step</div><div class="j">judge — eval coverage (which criteria examined this step)</div></div>'+
    '<div class="grid2">'+rowsHtml+'<div class="band loc"><div class="bh">↯ localize (root, not symptom)</div><div style="font-size:var(--fs-sm);margin-top:4px">'+esc(d.localize||'—')+'</div></div></div>'+
    '<div class="health"><div class="hc"><div class="l">context</div><div class="v good">'+(h.contextGathered?'✓':'—')+'</div></div><div class="hc"><div class="l">grounded</div><div class="v good">'+esc(h.grounded||0)+'</div></div><div class="hc"><div class="l">assumed</div><div class="v '+((h.assumed||0)>0?'warn':'good')+'">'+esc(h.assumed||0)+'</div></div><div class="hc"><div class="l">root vs symptom</div><div class="v good">'+(h.stoppedAtSymptom?'symptom':'✓ root')+'</div></div></div></div>';}
function scorecard(r){var order={fail:0,uncertain:1,indeterminate:1,pass:2,na:3};
  var cells=Object.keys(r.c).sort(function(a,b){return (order[r.c[a]]||9)-(order[r.c[b]]||9);}).map(function(k){var v=r.c[k];var disp=v=='uncertain'?'indeterminate':v;
    return '<div class="scc '+esc(v)+'"><span class="nm" title="'+esc((C[k]||{}).n||k)+'">'+esc(k)+'</span><span style="margin-left:auto;color:var(--muted)">'+esc(disp)+'</span></div>';}).join('');
  return '<div class="drillbox"><div style="display:flex;gap:9px;align-items:center;margin-bottom:6px"><b class="mono">'+esc(r.t)+'</b><span class="chip">'+esc(r.r||'all')+'</span><span class="verd '+(r.v=='PASS'?'pass':r.v=='FAIL'?'fail':'inc')+'">'+esc(r.v)+'</span></div>'+
    resRouting(r.res||'judged-walk-not-captured')+
    (r.root?'<div class="note" style="margin:0 0 8px"><span class="tag">★ ROOT</span>&nbsp;'+esc(r.root)+'</div>':'')+
    (r.g?'<div class="mono" style="font-size:var(--fs-xs);color:var(--muted);margin-bottom:4px">grounding: '+esc(r.g)+'</div>':'')+
    '<div style="font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);text-transform:uppercase;margin:6px 0">per-trajectory scorecard — '+Object.keys(r.c).length+' criteria</div>'+
    '<div class="scgrid">'+cells+'</div>'+
    // WS-1 — no-walk traces still surface their judge reasoning (per-criterion
    // critique + refs) here, so a trace WITHOUT a judge_steps walk is never an
    // empty "How the Judge Reasoned" panel when its verdict file carries verdicts.
    critiqueBlock(r.cv)+'</div>';}
function drill(id,el){document.querySelectorAll('table.ledger tr').forEach(function(t){t.classList.remove('sel');});if(el)el.classList.add('sel');
  var box=document.getElementById('drill');if(!box)return;
  var lrow=L.filter(function(x){return x.t==id;})[0];
  if(J[id]){var d=J[id];
    // WS-1 — graft the per-criterion verdicts (carried on the ledger row for EVERY
    // trace) onto the walk object so the side-by-side drill also shows the per-
    // criterion critique + refs, not just the step-anchored judge walk.
    if(lrow&&(!d.criterionVerdicts||!d.criterionVerdicts.length))d.criterionVerdicts=lrow.cv||[];
    if(lrow&&!d.res)d.res=lrow.res;
    box.innerHTML=sideBySide(d);}
  else if(lrow){box.innerHTML=scorecard(lrow);}
  box.scrollIntoView({behavior:'smooth',block:'nearest'});}
function wireFilters(){document.querySelectorAll('.lfilter b').forEach(function(b){b.addEventListener('click',function(){F=b.getAttribute('data-flt');document.querySelectorAll('.lfilter b').forEach(function(x){x.classList.remove('on');});b.classList.add('on');render();});});
  var q=document.getElementById('q');if(q)q.addEventListener('input',render);}
function wireToggles(){
  // UI-8 — calibrate tags are MUTUALLY EXCLUSIVE within a group (radio semantics):
  // selecting one clears the others in the same [data-calgroup]; clicking the active
  // one again clears it. The agree/revise/refute alignment row stays free-toggle.
  document.querySelectorAll('.calgroup').forEach(function(g){var btns=[].slice.call(g.querySelectorAll('b'));
    btns.forEach(function(b){b.addEventListener('click',function(){var wasOn=b.classList.contains('on');
      btns.forEach(function(x){x.classList.remove('on');});if(!wasOn)b.classList.add('on');});});});
  document.querySelectorAll('.areview b').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('on');});});
  // WS-3 — §5 self-eval HITL picks (5.4 keep/revise/retire · 5.8 agree/disagree):
  // mutually-exclusive within a [data-vgroup]; click the active one again to clear.
  var seGroups={};document.querySelectorAll('.se-pick').forEach(function(p){var g=p.getAttribute('data-vgroup');(seGroups[g]=seGroups[g]||[]).push(p);});
  Object.keys(seGroups).forEach(function(g){var picks=seGroups[g];picks.forEach(function(p){p.addEventListener('click',function(){var wasOn=p.classList.contains('on');picks.forEach(function(x){x.classList.remove('on');});if(!wasOn)p.classList.add('on');});});});
  document.querySelectorAll('.lnk[data-drill]').forEach(function(l){l.addEventListener('click',function(){var t2=document.querySelector('nav.tabs button[data-tab="t2"]');if(t2)t2.click();setTimeout(function(){drill(l.getAttribute('data-drill'));},60);});});
  // WS-4 — wire EVERY copy-as-markdown button (the §5 full-handover button, each
  // per-routed-item button, and any other): each copies its OWN data-md payload and
  // flashes a "copied ✓" confirmation. Was querySelector (first-only) → querySelectorAll.
  // Restricted clipboard contexts (headless / some file://) REJECT writeText — the
  // rejection AND any synchronous throw are CAUGHT so a denied clipboard NEVER raises an
  // uncaught page error; it just shows a "copy failed" hint and restores. ZERO errors.
  document.querySelectorAll('.copy-md').forEach(function(cp){cp.addEventListener('click',function(){
    var md=cp.getAttribute('data-md')||'';
    var prev=cp.textContent;
    var done=function(ok){cp.textContent=ok?'copied ✓':'copy failed';cp.classList.add(ok?'copied':'copyfail');
      setTimeout(function(){cp.textContent=prev;cp.classList.remove('copied');cp.classList.remove('copyfail');},1200);};
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(md).then(function(){done(true);},function(){done(false);});
      }else{done(false);}
    }catch(e){done(false);}
  });});}
wireTabs();wireFilters();wireToggles();render();
`;
}

// ── the full 5-tab report ────────────────────────────────────────────────────

/**
 * Render the 5-tab HTML eval-report (the operator-APPROVED component spec). Pure
 * string assembly; the only I/O is reading the bundled brand assets. The injected
 * `generatedAt` is the only non-deterministic input → masked-byte-identical.
 */
export function renderEvalReport(input: EvalReportInput): string {
  const theme = readFileSync(join(BRAND_DIR, "theme.css"), "utf8");
  const wordmark = readFileSync(join(BRAND_DIR, "wordmark.html"), "utf8");

  const headerTitle = "evaluator · Eval Report";
  const headerMeta =
    `<span class="mk">subject</span> <span class="mv">${esc(input.subject.name)}</span>` +
    `<span class="sep">·</span><span class="mk">generated</span> <span class="mv">${esc(input.generatedAt)}</span>`;
  const header = wordmark.replaceAll("{{HEADER_TITLE}}", esc(headerTitle)).replaceAll("{{HEADER_META}}", headerMeta);

  // deterministic embedded data for the §2 ledger + drill
  const ledger = input.ledger ?? [];
  const rootByTrace = new Map((input.topFindings ?? []).filter((tf) => tf.exampleTraceId).map((tf) => [tf.exampleTraceId as string, tf.root ?? ""]));
  const compactLedger = ledger.map((r) => ({
    t: r.trajectoryId,
    r: r.route ?? "all",
    v: r.verdict,
    c: r.perCriterion,
    f: r.failingCriteria,
    root: rootByTrace.get(r.trajectoryId) ?? "",
    g: r.grounding ?? "",
    js: r.judgeSteps && r.judgeSteps.length > 0 ? 1 : 0,
    // WS-2 — how this trajectory resolved (judge-walk · judged-walk-not-captured ·
    // truncated) → the ledger resolution badge + the drill routing line.
    res: r.resolution ?? "",
    // WS-1 — the per-criterion JUDGE verdicts (result · critique · refs) for THIS
    // trace. Carried on EVERY ledger row so the §2 drill renders "How the Judge
    // Reasoned" for every judged trace — the walk traces graft it onto the side-by-
    // side; the no-walk traces render it under the per-trajectory scorecard. Empty []
    // only when the verdict file genuinely carried no per-criterion verdict.
    cv: r.criterionVerdicts ?? [],
  }));
  // `m` = the code-vs-judge router (`checkMethod`) so the §2 judge lane can tag a
  // step's eval-coverage entry CODE (deterministic) / HYBRID / JUDGE (llm).
  const critMap: Record<string, { n: string; s: string; m: string }> = {};
  for (const c of input.criteria) critMap[c.id] = { n: c.statement, s: c.severity, m: c.checkMethod ?? "" };
  const walks: Record<string, unknown> = {};
  for (const r of ledger) {
    if (r.judgeSteps && r.judgeSteps.length > 0) {
      walks[r.trajectoryId] = {
        traceId: r.trajectoryId,
        route: r.route ?? "all",
        verdict: r.verdict,
        // Gap A — the raw triggering INPUT (ground-truth from the trace), rendered
        // ABOVE the judge's scenario LABEL in the §2 drill. "" ⇒ drill shows "—".
        input: r.input ?? "",
        context: r.context ?? {},
        agentSteps: r.agentSteps ?? [],
        judgeSteps: r.judgeSteps ?? [],
        localize: r.localize ?? "",
        health: r.health ?? {},
        // §9.4.4 v2.2 — node-0 understanding · node-0.5 expected-trajectory · M1 profile.
        understanding: r.understanding ?? null,
        expectedTrajectory: r.expectedTrajectory ?? [],
        subjectProfile: r.subjectProfile ?? input.subjectProfile ?? null,
      };
    }
  }
  const ledgerJson = JSON.stringify(compactLedger);
  const critJson = JSON.stringify(critMap);
  const walksJson = JSON.stringify(walks);
  // WS-2 — the resolution badge label + routing explanation per class (server-derived,
  // injected so the client row badge + drill routing line read ONE source of truth).
  const resMetaJson = JSON.stringify({
    "judge-walk": resolutionMeta("judge-walk"),
    "judged-walk-not-captured": resolutionMeta("judged-walk-not-captured"),
    truncated: resolutionMeta("truncated"),
  });

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(headerTitle)} — ${esc(input.subject.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${theme}
${REPORT_CSS}
</style>
</head>
<body>
${header}
<nav class="tabs">
  <button class="tab-btn active" data-tab="t1">① Overview</button>
  <button class="tab-btn" data-tab="t2">② Trajectory · Judge Behaviour</button>
  <button class="tab-btn" data-tab="t3">③ Eval Scorecard</button>
  <button class="tab-btn" data-tab="t4">④ Findings</button>
  <button class="tab-btn internal" data-tab="t5">⑤ Self-Eval [INTERNAL]</button>
</nav>
<main>
  <section class="panel active" id="t1">${overviewTab(input)}</section>
  <section class="panel" id="t2">${trajectoryTab(input)}</section>
  <section class="panel" id="t3">${scorecardTab(input)}</section>
  <section class="panel" id="t4">${findingsTab(input)}</section>
  <section class="panel" id="t5">${selfEvalTab(input)}</section>
</main>
<script data-pii="ledger">
${clientScript(ledgerJson, critJson, walksJson, resMetaJson)}
</script>
</body>
</html>
`;
}

// ── WS-1 file-based re-render entry (models discover's writeDiscoverReportFromFiles) ──

/** Injected I/O for the file-based eval-report entry (keeps the function pure of fs). */
export interface EvalReportFilesIO {
  readFile: (p: string) => string;
  writeFile: (p: string, s: string) => void;
  readDir: (p: string) => string[];
}

/** The data-completeness probe the harness reports after a re-render. */
export interface EvalReportCompleteness {
  tracesInVerdicts: number;
  tracesRenderedWithJudgeSteps: number;
  /** WS-1 — the honest completeness metric: traces whose drill surfaces ≥1 per-
   *  criterion judge verdict (critique-before-verdict). Should == every JUDGED trace. */
  tracesRenderedWithCritique: number;
  /** traces whose verdict file carried renderable judge data (verdicts[] or a walk)
   *  but the drill would render an EMPTY "How the Judge Reasoned" panel. Goal: 0. */
  emptyUIrows: number;
  /** WS-6 — char length of the reconstructed subject system prompt (0 ⇒ UNAVAILABLE). */
  systemPromptChars: number;
  /** WS-6 — true when the entity hero renders a reconstructed system prompt. */
  systemPromptReconstructed: boolean;
  /** WS-4 — number of true-FAIL criteria routed into the §5 EV-051 diagnostics handover. */
  routedFailures: number;
}

/**
 * WS-1 — re-render the §2 trajectory report DIRECTLY from on-disk artifacts (the
 * RICH per-trajectory `verdicts/*.json` + the folded `AGG-RESULT.json` + the
 * criteria/suite), binding the per-criterion judge reasoning (critique + refs) and
 * the judge_steps walk (where present) to EVERY evaluated trace. This is the eval
 * analogue of `writeDiscoverReportFromFiles`: a pure shipped-function call over the
 * file set, with NO strict-schema gate that would drop the rich verdict files (the
 * verdict files that carry an object `exitStates` / omit `subjectProfile.tools` —
 * exactly the ones with the walk — survive here, where production's strict
 * `parseMatrixVerdictFile` would have rejected them).
 *
 * Returns the report path + the data-completeness probe. PURE except the injected I/O.
 */
export function writeEvalReportFromFiles(
  params: {
    verdictsDir: string;
    aggPath: string;
    criteriaPath: string;
    outPath: string;
    subjectName: string;
    subjectSource?: string;
    generatedAt: string;
    /** WS-6 — OPTIONAL trace batch (or a single representative trace) used ONLY to
     *  reconstruct the subject SYSTEM PROMPT for the entity hero. The harness streams
     *  one trace off the raw ndjson and passes it here; the system prompt is identical
     *  across the batch so one trace suffices. ABSENT ⇒ system prompt stays UNAVAILABLE. */
    traces?: EvalTrace[];
  },
  io: EvalReportFilesIO,
): { report: string; completeness: EvalReportCompleteness } {
  // 1) read the RICH verdict files TOLERANTLY (raw JSON.parse — never the strict
  //    schema gate, which rejects exactly the walk-bearing files). NO trace dropped.
  const verdictFiles = io
    .readDir(params.verdictsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(io.readFile(join(params.verdictsDir, f))) as MatrixVerdictFile;
      } catch {
        return null;
      }
    })
    .filter((v): v is MatrixVerdictFile => v !== null && typeof (v as { trajectoryId?: unknown }).trajectoryId === "string");

  // 2) the folded scorecard (AGG-RESULT.maskedScorecard = gate + variance) + the
  //    per-criterion folded verdicts (summary.perCriterion), with a representative
  //    critique grafted from a matching per-trajectory verdict (for the gating rolls).
  const agg = JSON.parse(io.readFile(params.aggPath)) as {
    summary?: { perCriterion?: Array<{ criterionId: string; folded: string; confidence?: number }> };
    maskedScorecard?: Scorecard;
  };
  const scorecard = (agg.maskedScorecard ?? { gate: { total: 0, passCount: 0, failedCriteria: [], gatedBy: [], indeterminateBy: [], passed: true, runVerdict: "pass" } }) as Scorecard;
  const repCritique = new Map<string, { critique: string; refs?: unknown[]; traceId: string }>();
  for (const f of verdictFiles) {
    for (const v of (f as { verdicts?: Array<{ criterionId: string; result: string; critique?: string; refs?: unknown[] }> }).verdicts ?? []) {
      if (v.critique && !repCritique.has(`${v.criterionId}:${v.result}`)) {
        repCritique.set(`${v.criterionId}:${v.result}`, { critique: v.critique, refs: v.refs, traceId: (f as { trajectoryId: string }).trajectoryId });
      }
    }
  }
  const verdicts: CriterionVerdict[] = (agg.summary?.perCriterion ?? []).map((pc) => {
    const rep = repCritique.get(`${pc.criterionId}:${pc.folded}`);
    return {
      criterionId: pc.criterionId,
      traceId: rep?.traceId ?? "(suite)",
      result: pc.folded as CriterionVerdict["result"],
      confidence: pc.confidence ?? 0,
      critique: rep?.critique ?? "",
      ...(rep?.refs ? { refs: rep.refs as CriterionVerdict["refs"] } : {}),
    };
  });

  // 3) the criteria (discover/suite shape) → ReportCriterion[].
  const rawCrit = JSON.parse(io.readFile(params.criteriaPath)) as unknown;
  const critArr: Array<Record<string, unknown>> = Array.isArray(rawCrit)
    ? (rawCrit as Array<Record<string, unknown>>)
    : ((rawCrit as { entries?: Array<Record<string, unknown>> }).entries ?? []);
  const criteria: ReportCriterion[] = critArr.map((c) => {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const severity = String((c.severity as string) ?? (meta.severity as string) ?? "MED");
    return {
      id: String(c.id ?? c.criterionId ?? ""),
      statement: String(c.statement ?? ""),
      severity,
      gating: GATING_SEVERITIES.has(severity),
      ...(meta.dimension !== undefined ? { dimension: String(meta.dimension) } : {}),
      ...(Array.isArray(c.judgeInputs) ? { judgeInputs: c.judgeInputs as string[] } : {}),
      checkMethod: String((c.judgeKind as string) ?? (meta.check_method as string) ?? "llm-judge"),
      provenance: { kind: "defined" as const, label: "defined eval-matrix criterion" },
    };
  });

  // 3b) WS-4 — reconstruct the EV-051 diagnostics HANDOVER from the folded gate, using
  //     the SHIPPED `routeFailures` (no hand-rolled routing). Each failed criterion →
  //     a FailureRef enriched with its folded result + a representative critique/trace
  //     (from the verdict files). `routeFailures` then partitions: only TRUE FAILs
  //     (result === "fail") route to diagnostics — uncertain/indeterminate go to the
  //     calibration loop and are excluded — so the §5 handover shows exactly the routed
  //     count, matching the run's `summary.routedFailures`. NEVER invents a failure.
  const foldedById = new Map((agg.summary?.perCriterion ?? []).map((pc) => [pc.criterionId, pc.folded]));
  const failedCriteria = (scorecard.gate?.failedCriteria ?? []) as Array<{ criterionId: string; severity: string }>;
  const failures: FailureRef[] = failedCriteria.map((fc) => {
    const folded = foldedById.get(fc.criterionId) ?? "fail";
    const rep = repCritique.get(`${fc.criterionId}:${folded}`) ?? repCritique.get(`${fc.criterionId}:fail`);
    return {
      criterionId: fc.criterionId,
      severity: fc.severity,
      flag: CriterionFlag.EvalWorthy,
      traceId: rep?.traceId ?? "(suite)",
      result: folded as FailureRef["result"],
      critique: rep?.critique ?? "(no critique recorded)",
    };
  });
  // routeFailures internally filters to true FAILs (partitionRouting); pass them all.
  const diagnoseFailures = failures.filter((f) => f.result === OutcomeVerdict.Fail);
  const handover: HandoverBundle | null =
    diagnoseFailures.length > 0
      ? routeFailures({
          subject: { kind: "agent", name: params.subjectName, path: `subjects/${params.subjectName}` },
          failures: diagnoseFailures,
          artifacts: [],
          producedBy: "evaluator",
          producedAt: params.generatedAt,
        })
      : null;

  // 4) build the rich input + render.
  const input = buildEvalReportInput({
    subject: { name: params.subjectName, ...(params.subjectSource ? { source: params.subjectSource } : {}) },
    scorecard,
    verdicts,
    criteria,
    matrixVerdictFiles: verdictFiles,
    handover,
    generatedAt: params.generatedAt,
    // WS-6 — forward the trace(s) so the system prompt is reconstructed for the hero.
    ...(params.traces !== undefined ? { traces: params.traces } : {}),
  });
  io.writeFile(params.outPath, renderEvalReport(input));

  // 5) the data-completeness probe over the BOUND ledger (what the UI will render).
  const ledger = input.ledger ?? [];
  const completeness: EvalReportCompleteness = {
    tracesInVerdicts: verdictFiles.length,
    tracesRenderedWithJudgeSteps: ledger.filter((r) => (r.judgeSteps?.length ?? 0) > 0).length,
    tracesRenderedWithCritique: ledger.filter((r) => (r.criterionVerdicts?.length ?? 0) > 0).length,
    // an empty UI row = the verdict file carried judge data (a walk OR ≥1 per-criterion
    // verdict) yet the drill would bind NOTHING. With per-criterion critique bound to
    // every judged row, this is 0 unless a verdict file is genuinely empty.
    emptyUIrows: ledger.filter(
      (r) => (r.judgeSteps?.length ?? 0) === 0 && (r.criterionVerdicts?.length ?? 0) === 0,
    ).length,
    systemPromptChars: (input.subjectProfile?.systemPrompt ?? "").length,
    systemPromptReconstructed: (input.subjectProfile?.inferredFields ?? []).includes("systemPrompt"),
    routedFailures: input.handover?.acceptance.criteria.length ?? 0,
  };
  return { report: params.outPath, completeness };
}

// ── auto-open helper (built; fired by the orchestrator, NOT here) ────────────

/**
 * The cross-platform command to open a rendered report. PURE — returns the
 * command string; it NEVER spawns a process (the orchestrator fires it
 * post-render; a test must never auto-open). macOS `open` · Linux `xdg-open` ·
 * Windows `start`.
 */
export function autoOpenCommand(platform: string, filePath: string): string {
  if (platform === "darwin") return `open ${filePath}`;
  if (platform === "win32") return `cmd /c start "" ${filePath}`;
  return `xdg-open ${filePath}`;
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
//
// bun scripts/render-eval-report.ts <input.json> [out.html] [runId]
// Reads an EvalReportInput (the rich, already-built shape), prints the D-1
// terminal cards, writes the 5-tab HTML report, and prints the cross-platform
// auto-open command (does NOT fire it — the orchestrator opens post-render).

declare const Bun: { argv: string[] } | undefined;

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const [inputPath, outArg, runIdArg] = argv;
  if (!inputPath) {
    console.error("usage: render-eval-report.ts <input.json> [out.html] [runId]");
    process.exit(2);
    return;
  }
  const { readFileSync: rf, writeFileSync, mkdirSync } = await import("node:fs");
  const { reportDir } = await import("./artifact-paths.ts");
  const { join: pjoin } = await import("node:path");
  const input = JSON.parse(rf(inputPath, "utf8")) as EvalReportInput;
  // P8: a bare run DEFAULTS the report under the localized dot-root
  // `.mutagent-evaluator/reports/<runId>/report.html` (never /tmp or .memory).
  const runId = runIdArg ?? input.subject.name;
  const outPath = outArg ?? pjoin(reportDir(runId), "report.html");
  mkdirSync(pjoin(outPath, ".."), { recursive: true });
  console.info(renderEvalCards(input));
  writeFileSync(outPath, renderEvalReport(input));
  const plat = typeof process !== "undefined" ? process.platform : "linux";
  console.info(`\nreport written: ${outPath}`);
  console.info(`auto-open (orchestrator fires this): ${autoOpenCommand(plat, outPath)}`);
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
