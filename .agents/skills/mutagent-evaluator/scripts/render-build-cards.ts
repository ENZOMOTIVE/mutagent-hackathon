/**
 * scripts/render-build-cards.ts — F13/F16/F20/F22 wireframe TERMINAL cards (Type A — PURE).
 * ---------------------------------------------------------------------------
 * The ADL EVAL-stage terminal surface. All renderers are PURE deterministic
 * string builders in the house box-drawing style (matching `renderEvalCards` in
 * render-eval-report.ts). No clock / random / network.
 *
 *   - F13 + F16 — stream PROGRESS as wireframe cards for BOTH *build-dataset and
 *     *build-evals (`renderBuildDatasetProgressCard` · `renderBuildEvalsProgressCard`).
 *   - F22 — emit a VERBOSE entity card after *build-dataset and after *build-evals
 *     (`renderDatasetEntityCard` · `renderEvalsEntityCard`).
 *   - F20 — render the eval SCORECARD as a DASHBOARD wireframe (per-criterion
 *     pass/fail, variance, samples) — NOT a flat dump (`renderScorecardDashboard`).
 *
 * Subject-agnostic: every label is DATA passed in.
 */

const W = 60; // card inner width
const TOP = `╔${"═".repeat(W)}╗`;
const MID = `╠${"═".repeat(W)}╣`;
const BOT = `╚${"═".repeat(W)}╝`;

/** A card body line, padded/truncated to the inner width. PURE. */
function row(text: string): string {
  const t = text.length > W - 2 ? text.slice(0, W - 3) + "…" : text;
  return `║ ${t.padEnd(W - 2)} ║`;
}

/** A progress glyph bar `done/total` → filled/empty blocks. PURE. */
function progressBar(done: number, total: number, width = 20): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── F13/F16 — *build-dataset progress card ───────────────────────────────────
export interface BuildDatasetProgress {
  subject: string;
  /** the streamed phase (e.g. "materialize" | "synth-expand" | "dedup-merge"). */
  phase: string;
  categoriesTotal: number;
  categoriesDone: number;
  itemsMaterialized: number;
  edgeItems: number;
}

export function renderBuildDatasetProgressCard(p: BuildDatasetProgress): string {
  const bar = progressBar(p.categoriesDone, p.categoriesTotal);
  return [
    TOP,
    row(`◆ BUILD-DATASET — ${p.subject}`),
    MID,
    row(`phase: ${p.phase}`),
    row(`categories: ${bar} ${p.categoriesDone}/${p.categoriesTotal}`),
    row(`items materialized: ${p.itemsMaterialized}  (edge: ${p.edgeItems})`),
    BOT,
  ].join("\n");
}

// ── F13/F16 — *build-evals progress card ─────────────────────────────────────
export interface BuildEvalsProgress {
  subject: string;
  /** the chosen engine (native-matrix | code-written). */
  engine: string;
  /** the streamed phase (e.g. "ask-engine" | "judge-spec" | "codegen" | "validate"). */
  phase: string;
  criteriaTotal: number;
  criteriaDone: number;
  codeChecks: number;
  judges: number;
}

export function renderBuildEvalsProgressCard(p: BuildEvalsProgress): string {
  const bar = progressBar(p.criteriaDone, p.criteriaTotal);
  return [
    TOP,
    row(`◆ BUILD-EVALS — ${p.subject}  [engine: ${p.engine}]`),
    MID,
    row(`phase: ${p.phase}`),
    row(`criteria: ${bar} ${p.criteriaDone}/${p.criteriaTotal}`),
    row(`code-checks: ${p.codeChecks}   judges: ${p.judges}`),
    BOT,
  ].join("\n");
}

// ── F22 — dataset entity card (verbose, after *build-dataset) ─────────────────
export interface DatasetEntity {
  subject: string;
  version: number;
  categories: { id: string; items: number; edgeItems: number }[];
  totalItems: number;
  sink: string;
}

export function renderDatasetEntityCard(e: DatasetEntity): string {
  const lines = [
    TOP,
    row(`▣ DATASET — ${e.subject}  (v${e.version})`),
    MID,
    row(`categories (${e.categories.length}) · ${e.totalItems} items total`),
  ];
  for (const c of e.categories) {
    lines.push(row(`  • ${c.id}: ${c.items} items  (edge: ${c.edgeItems})`));
  }
  lines.push(row(`sink: ${e.sink}`));
  lines.push(BOT);
  return lines.join("\n");
}

// ── F22 — evals entity card (verbose, after *build-evals) ────────────────────
export interface EvalsEntity {
  subject: string;
  engine: string;
  requiresClaudeCode: boolean;
  requiresLogSink: boolean;
  outputSink: string;
  criteria: { id: string; kind: string; severity: string }[];
}

export function renderEvalsEntityCard(e: EvalsEntity): string {
  const dep =
    (e.requiresClaudeCode ? "needs Claude Code" : "portable (no Claude Code)") +
    (e.requiresLogSink ? " · needs agent log/trace sink" : "");
  const lines = [
    TOP,
    row(`▣ EVAL SUITE — ${e.subject}  [engine: ${e.engine}]`),
    MID,
    row(`dependency: ${dep}`),
    row(`output sink: ${e.outputSink}`),
    row(`criteria (${e.criteria.length}):`),
  ];
  for (const c of e.criteria) {
    lines.push(row(`  • ${c.id}  [${c.severity}·${c.kind}]`));
  }
  lines.push(BOT);
  return lines.join("\n");
}

// ── F20 — scorecard DASHBOARD (per-criterion pass/fail, variance, samples) ───
const GATE_BANNERS: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  incomplete: "INCOMPLETE",
};

export interface ScorecardDashboardCriterion {
  id: string;
  severity: string;
  pass: number;
  fail: number;
  indeterminate: number;
  /** eval-score variance across reruns (EV-054). */
  variance: number;
  /** number of trajectories/samples scored. */
  samples: number;
}

export interface ScorecardDashboardInput {
  subject: string;
  /** the run-level GATE (fail ▸ incomplete ▸ pass). */
  gate: string;
  criteria: ScorecardDashboardCriterion[];
}

/**
 * Render the eval scorecard as a DASHBOARD wireframe — a gate banner + a
 * per-criterion row carrying a pass/fail BAR (visual, not a flat number), the
 * pass/fail/indeterminate split, variance, and sample count (F20). THROWS on an
 * unknown gate value (fail-loud). PURE.
 */
export function renderScorecardDashboard(input: ScorecardDashboardInput): string {
  const banner = GATE_BANNERS[input.gate];
  if (banner === undefined) {
    throw new Error(
      `renderScorecardDashboard: unknown gate '${input.gate}'. ` +
        `Expected one of {${Object.keys(GATE_BANNERS).join(", ")}}.`,
    );
  }
  const lines = [
    TOP,
    row(`▦ SCORECARD — ${input.subject}`),
    row(`GATE: ${banner}`),
    MID,
    row("criterion        bar          pass/fail/?  var   samples"),
  ];
  for (const c of input.criteria) {
    const decided = c.pass + c.fail;
    const bar = progressBar(c.pass, Math.max(1, decided), 12);
    const id = `${c.id}[${c.severity}]`.padEnd(16);
    const split = `${c.pass}/${c.fail}/${c.indeterminate}`.padEnd(11);
    lines.push(row(`${id} ${bar} ${split} var=${c.variance} n=${c.samples}`));
  }
  lines.push(BOT);
  return lines.join("\n");
}
