/**
 * scripts/render-report.ts
 * ---------------------------------------------------------------------------
 * The color-coded renderer — composes the 4-tab master-audit HTML from the
 * assembled scorecard + the tab fragments (data-leak Tab-2, variance Tab-3,
 * methodology Tab-4). Renders from the evaluator's OWN bundled Mutagent brand
 * asset (assets/brand/theme.css + wordmark.html) so the report is visually
 * consistent with the diagnostics gold-standard report (dark theme, MUTAGENT
 * wordmark, same tokens) WITHOUT referencing the diagnostics package at runtime.
 *
 * Deterministic + null-guarded: every dereference is guarded so a contract-
 * incomplete input fails-loud at the assembler, never crashes the renderer. The
 * only non-deterministic input is the injected generatedAt (passed in), so two
 * renders of the same scorecard are byte-identical after the generatedAt mask.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GateComponent,
  type Scorecard,
  type ScorecardCriterion,
} from "./contracts/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(HERE, "..", "assets", "brand");

/** HTML-escape (null-guarded — no throw on undefined). */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sevBadge(sev: string): string {
  const cls =
    sev === "CRIT"
      ? "b-crit"
      : sev === "HIGH"
        ? "b-high"
        : sev === "MED"
          ? "b-med"
          : "b-low";
  return `<span class="badge ${cls}">${esc(sev)}</span>`;
}

function resultBadge(result: string): string {
  const cls =
    result === "pass" ? "b-pass" : result === "fail" ? "b-fail" : "b-skip";
  return `<span class="badge ${cls}">${esc(result)}</span>`;
}

function criterionRow(c: ScorecardCriterion): string {
  return (
    `<tr><td>${esc(c.dimension)}</td>` +
    `<td>${sevBadge(c.severity)}</td>` +
    `<td><code>${esc(c.checkMethod)}</code></td>` +
    `<td>${esc(c.track)}</td>` +
    `<td>${resultBadge(c.result)}</td>` +
    `<td>${esc(c.detail)}</td></tr>`
  );
}

function componentSection(g: GateComponent): string {
  const passBadge = g.pass
    ? `<span class="badge b-pass">PASS</span>`
    : `<span class="badge b-fail">FAIL</span>`;
  const rows = g.criteria.map(criterionRow).join("");
  return (
    `<h3>${esc(g.componentId)} ${passBadge}</h3>` +
    `<table><thead><tr><th>Dimension</th><th>Sev</th><th>Check</th><th>Track</th><th>Result</th><th>Detail</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

export interface RenderTabs {
  /** Tab-2 data-leak HTML fragment (body of the panel). */
  dataLeakHtml?: string;
  /** Tab-4 methodology-review HTML fragment. */
  methodologyHtml?: string;
}

function evalMatrixTab(scorecard: Scorecard): string {
  const t = scorecard.gate.totals;
  // GA — ternary fail ▸ incomplete ▸ pass (back-compat: derive from runPass when
  // runVerdict is absent, e.g. legacy v1 scorecards never carry incomplete rows).
  const runVerdict = scorecard.gate.runVerdict ?? (scorecard.gate.runPass ? "pass" : "fail");
  const incompleteN = t.incomplete ?? 0;
  const verdictClass = runVerdict === "pass" ? "pass" : runVerdict === "incomplete" ? "skip" : "fail";
  const verdictText =
    runVerdict === "pass"
      ? "Run PASS — every component cleared the severity gate (0 CRIT/HIGH fail or indeterminate)."
      : runVerdict === "incomplete"
        ? `Run INCOMPLETE — ${incompleteN} CRIT/HIGH criteria indeterminate (no CRIT/HIGH fail). The run cannot be certified — NOT a pass.`
        : `Run FAIL — ${t.critFail} CRIT + ${t.highFail} HIGH criteria failed the gate.`;
  const tiles = [
    ["Components", String(scorecard.gate.components.length)],
    ["Pass", String(t.pass)],
    ["Fail", String(t.fail)],
    ["Skip (seam)", String(t.skip)],
    ["CRIT fail", String(t.critFail)],
    ["HIGH fail", String(t.highFail)],
  ]
    .map(
      ([l, v]) =>
        `<div class="s"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`,
    )
    .join("");
  const components = scorecard.gate.components.map(componentSection).join("");
  return (
    `<h2>Eval Matrix — Track-1 GATE</h2>` +
    `<div class="sub">Binary, severity-gated. Component PASS iff 0 CRIT/HIGH fail. Run PASS iff all components pass. Advisory.</div>` +
    `<div class="verdict ${verdictClass}"><strong>${esc(verdictText)}</strong></div>` +
    `<div class="big-stat">${tiles}</div>` +
    components
  );
}

function varianceTab(scorecard: Scorecard): string {
  const dims = scorecard.trend.dimensions ?? [];
  const rows = dims
    .map(
      (d) =>
        `<tr><td>${esc(d.name)}</td><td>${esc(d.measure)}</td><td>${esc(d.target)}</td><td>${esc(d.divergence)}</td></tr>`,
    )
    .join("");
  const pairNote = scorecard.trend.runPair
    ? `run-pair: <code>${esc(scorecard.trend.runPair.a)}</code> vs <code>${esc(scorecard.trend.runPair.b)}</code>`
    : "single-run audit — no run-pair compared (variance dimensions not-evaluated)";
  return (
    `<h2>Variance Trend — Track-2 TREND</h2>` +
    `<div class="sub">The 15-dim determinism score, SEPARATE from GATE, never merged. ${pairNote}.</div>` +
    `<div class="big-stat"><div class="s"><div class="v">${esc(scorecard.trend.varianceScore)}</div><div class="l">Variance score (diverged dims)</div></div></div>` +
    `<table><thead><tr><th>Dimension</th><th>Measure</th><th>Target</th><th>Divergence</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

/**
 * Render the full 4-tab report HTML. Pure string assembly; no I/O except reading
 * the bundled brand assets.
 */
export function renderReport(
  scorecard: Scorecard,
  tabs: RenderTabs = {},
): string {
  const theme = readFileSync(join(BRAND_DIR, "theme.css"), "utf8");
  const wordmark = readFileSync(join(BRAND_DIR, "wordmark.html"), "utf8");

  const headerTitle = "Evaluator — Master Audit";
  const headerMeta =
    `<span class="mk">subject</span> <span class="mv">${esc(scorecard.subject)}</span>` +
    `<span class="sep">·</span><span class="mk">runId</span> <span class="mv">${esc(scorecard.runId)}</span>` +
    `<span class="sep">·</span><span class="mk">generated</span> <span class="mv">${esc(scorecard.generatedAt)}</span>`;
  const header = wordmark
    .replaceAll("{{HEADER_TITLE}}", esc(headerTitle))
    .replaceAll("{{HEADER_META}}", headerMeta);

  const dataLeak =
    tabs.dataLeakHtml ??
    `<h2>Data-Leak Graph</h2><div class="sub">Tab-2 — pipeline-with-leak-edges (C2C/UI x class x formal-structure).</div><div class="warn"><strong>Not composed:</strong> run workflows/data-leak.workflow.js to populate this tab (judge-execution seam).</div>`;
  const methodology =
    tabs.methodologyHtml ??
    `<h2>Methodology Review</h2><div class="sub">Tab-4 — fitness, not conformance. Decision-tree fitness · data-flow efficiency · process self-feedback.</div><div class="warn"><strong>Not composed:</strong> run the methodology-critic lens to populate this tab (judge-execution seam).</div>`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<title>${esc(headerTitle)} — ${esc(scorecard.subject)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${theme}
</style>
</head>
<body>
${header}
<nav class="tabs">
  <button class="tab-btn active" data-tab="t1">Eval Matrix</button>
  <button class="tab-btn" data-tab="t2">Data-Leak</button>
  <button class="tab-btn" data-tab="t3">Variance Trend</button>
  <button class="tab-btn internal" data-tab="t4">Methodology Review</button>
</nav>
<main>
  <section class="panel active" id="t1">${evalMatrixTab(scorecard)}</section>
  <section class="panel" id="t2">${dataLeak}</section>
  <section class="panel" id="t3">${varianceTab(scorecard)}</section>
  <section class="panel" id="t4">${methodology}</section>
</main>
<script>
(function(){
  var btns = document.querySelectorAll('nav.tabs button');
  var panels = document.querySelectorAll('main .panel');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(){
      var tab = this.getAttribute('data-tab');
      for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
      for (var k = 0; k < panels.length; k++) panels[k].classList.remove('active');
      this.classList.add('active');
      var panel = document.getElementById(tab);
      if (panel) panel.classList.add('active');
    });
  }
})();
</script>
</body>
</html>
`;
}
