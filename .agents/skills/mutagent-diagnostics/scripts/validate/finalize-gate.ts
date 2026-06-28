/**
 * scripts/validate/finalize-gate.ts
 * W14 (F2) — OUTPUT-side finalization gate.
 *
 * The completeness-check (W9-08) gates the INPUT (`RenderInput` JSON) — the fields
 * `render.ts` will dereference. THIS gate is the complement: it parses the RENDERED
 * `report.html` and asserts, per section, that the data actually LANDED in the
 * document. It catches the output-only bug class the input gate cannot see:
 *   - a soft render fallback shipped (`RANK n/a`, `cost:n/a`, `correct:n/a`);
 *   - a literal `undefined` / `null` / `NaN` reached the body;
 *   - a raw-JSON entity prompt (`{"prompt":`) instead of humanized prose;
 *   - a `class="internal"` node survived on an `audience=client` render (leak);
 *   - a `loud-missing-widget` marker (a forgotten-data tell) on an internal report.
 *
 * DETERMINISTIC ONLY (operator decision 2): DOM-free string/regex assertions. No LLM,
 * no spend, runs every render. Pure function `runFinalizeGate` + CLI entrypoint.
 *
 * The checklist lives in `report-checklist.yaml` (F1) — one row per section, each
 * carrying the `source` producer + `heal` action used by the orchestrator's bounded
 * self-heal loop (Step 9.9). See references/script-index.md for the backtrace table.
 *
 * Type A — Pure Script (deterministic + no I/O except CLI file read).
 */

import { parse as parseYaml } from "yaml";

// ── Public types ─────────────────────────────────────────────────────────────

/** Audience the report was rendered for. */
export type ReportAudience = "client" | "internal";

/** One section row of the declarative checklist (F1 schema). */
export interface ChecklistRow {
  section: string;
  require: string[];
  forbid: string[];
  tier: "CRIT" | "WARN";
  /** When absence is LEGITIMATE — a human-readable condition string. */
  okEmpty: string;
  /** The producer/step to backtrace to (matches script-index.md). */
  source: string;
  /** The self-heal action to run when this row's data is missing. */
  heal: string;
}

/** One gap found by the gate. */
export interface FinalizeGap {
  section: string;
  tier: "CRIT" | "WARN";
  /** What is wrong (missing-require or forbidden-token, with the offending token). */
  what: string;
  /** The producer/step to backtrace to (from the row's `source`). */
  sourceStep: string;
  /** The self-heal action (from the row's `heal`). */
  healAction: string;
}

/** Structured gate result. */
export interface FinalizeResult {
  /** False when ≥1 CRIT gap. WARN gaps do NOT set pass=false. */
  pass: boolean;
  gaps: FinalizeGap[];
}

// ── Section region anchors ───────────────────────────────────────────────────
//
// Each per-section row is scoped to a region of the HTML, identified by an opening
// marker and (where helpful) a closing marker. Global rows scan the whole stripped
// body. Anchors are stable render.ts markers (verified against the renderers).

interface RegionAnchor {
  /** Opening marker that begins the section's HTML. */
  open: string;
  /**
   * Window length (chars) to scan from the open marker. Sections have nested
   * <div>s, so a naive first-</div> close under-reads; a generous bounded window
   * captures the whole block deterministically without an HTML parser. The window
   * is capped so a require/forbid scan stays scoped to the section, not the whole doc.
   */
  window: number;
}

const SECTION_REGIONS: Readonly<Record<string, RegionAnchor>> = {
  "entity-card": { open: '<div class="entity">', window: 4000 },
  "big-stat": { open: '<div class="big-stat">', window: 2000 },
  "deep-read-tile": { open: '<div class="deep-read-tile">', window: 2500 },
  "signal-census": { open: "Signal / failure-mode", window: 2000 },
  heatmap: { open: "timeline heatmap", window: 4000 },
  funnel: { open: '<div class="funnel">', window: 2000 },
  "finding-panel": { open: '<div class="taxonomy">', window: 1500 },
  "remedy-card": { open: '<div class="remedy', window: 6000 },
  "decisions-copyback": { open: '<section class="panel" id="tdecisions">', window: 4000 },
  // Methodology sub-section rows are whole-tab scans: the loud-missing-widget
  // marker carries its own data-widget attribute, so a body-wide scan is correct.
  "methodology-tier-pie": { open: "<body", window: Number.MAX_SAFE_INTEGER },
  "methodology-selection": { open: "<body", window: Number.MAX_SAFE_INTEGER },
  "methodology-awareness": { open: "<body", window: Number.MAX_SAFE_INTEGER },
  "methodology-blind-spots": { open: "<body", window: Number.MAX_SAFE_INTEGER },
};

/** Section ids that are whole-body global invariants (no region scoping). */
const GLOBAL_SECTIONS: ReadonlySet<string> = new Set([
  "global-no-undefined",
  "global-client-no-internal",
  "global-remedy-triad",
]);

// ── okEmpty evaluation ───────────────────────────────────────────────────────
//
// `okEmpty` is a human-readable condition string. The gate evaluates a small set of
// recognized predicates deterministically. The recognized predicates cover the
// legitimate-absence cases the operator enumerated; an unrecognized okEmpty string
// is treated as "never exempt" (fail-closed — we never silently skip a CRIT row).

interface GateContext {
  /** Stripped body (code/pre/diff removed) — what require/forbid scan by default. */
  strippedBody: string;
  /** Raw HTML — used for structural presence checks (e.g. region existence). */
  rawHtml: string;
  audience: ReportAudience;
  /** True when the report has zero finding panels (clean / zero-finding run). */
  hasNoFindings: boolean;
  /** True when this is a methodologyAudit / meta report (no runtime traces). */
  methodologyAudit: boolean;
}

/**
 * Decide whether a section's absence is legitimate (exempt from its checks).
 * Fail-closed: only the explicitly-recognized conditions exempt; anything else
 * (incl. `okEmpty: never`) means NOT exempt.
 */
function isLegitimatelyEmpty(row: ChecklistRow, ctx: GateContext): boolean {
  const cond = row.okEmpty.toLowerCase();
  if (cond.startsWith("never")) return false;

  // "no findings" / "0 findings" / "clean run" — exempt when there are no findings.
  if ((cond.includes("no findings") || cond.includes("0 findings") || cond.includes("zero-finding") || cond.includes("clean run")) && ctx.hasNoFindings) {
    return true;
  }

  // "audience=client" — the whole internal tab is stripped on a client render.
  if (cond.includes("audience=client") && ctx.audience === "client") {
    return true;
  }

  // "audience=internal" — internal reports legitimately carry internal nodes.
  if (cond.includes("audience=internal") && ctx.audience === "internal") {
    return true;
  }

  // "methodologyAudit" — meta/variance audits have no runtime traces.
  if (cond.includes("methodologyaudit") && ctx.methodologyAudit) {
    return true;
  }

  // "threaded" / "rendered" / "skipped" / "priors" / "absent" — these conditions
  // describe a state that is self-evident from the absence of the loud marker the
  // row forbids. For forbid-only rows (no `require`), the row passes naturally when
  // the forbidden marker is absent; we do NOT pre-exempt them here so the forbid
  // scan still runs (it is the actual check). Return false so the scan proceeds.
  return false;
}

// ── HTML helpers (deterministic, DOM-free) ───────────────────────────────────

/**
 * Strip the spans where a literal `undefined` / `null` / `NaN` / `{"prompt"` is
 * LEGITIMATE content rather than a render bug, BEFORE the forbid scan runs:
 *   - <script>…</script> — ALL inline JS (the live-preview IIFE legitimately uses
 *     `null`, `undefined` checks; its syntax is gated separately by render-js-syntax.ts);
 *   - <pre>…</pre> + <code>…</code> — quoted evidence / diff / command samples;
 *   - the Before/After diff grid (.r-diff-grid).
 * This is the "visible-body data" surface — what the operator reads, not machine slots.
 */
function stripQuotedRegions(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, " ")
    .replace(/<div class="r-diff-grid">[\s\S]*?<\/div>\s*<\/div>/gi, " ");
}

/**
 * Extract a section region from the raw HTML by anchor: a bounded window starting at
 * the open marker. Returns "" when the open marker is absent (= the whole section is
 * missing). Bounded-window slicing is deterministic and needs no HTML parser; the
 * window is sized per section to cover the block without bleeding into the next.
 */
function extractRegion(rawHtml: string, anchor: RegionAnchor): string {
  const start = rawHtml.indexOf(anchor.open);
  if (start === -1) return "";
  const end =
    anchor.window === Number.MAX_SAFE_INTEGER
      ? rawHtml.length
      : Math.min(rawHtml.length, start + anchor.window);
  return rawHtml.slice(start, end);
}

/** Count finding panels (taxonomy strips) — the zero-finding signal. */
function countFindingPanels(rawHtml: string): number {
  const matches = rawHtml.match(/<div class="taxonomy">/g);
  return matches ? matches.length : 0;
}

// ── Core evaluation ──────────────────────────────────────────────────────────

/**
 * Run the finalize gate over a rendered HTML string.
 *
 * @param html      the rendered report.html contents
 * @param audience  the audience the report was rendered for
 * @param checklist the parsed F1 checklist rows
 */
export function runFinalizeGate(
  html: string,
  audience: ReportAudience,
  checklist: ChecklistRow[]
): FinalizeResult {
  const hasNoFindings = countFindingPanels(html) === 0;
  // methodologyAudit reports carry the forced self-diagnosis banner (PR-022).
  const methodologyAudit = html.includes("SELF-DIAGNOSIS — analyzing the diagnostics skill itself");

  const ctx: GateContext = {
    strippedBody: stripQuotedRegions(html),
    rawHtml: html,
    audience,
    hasNoFindings,
    methodologyAudit,
  };

  const gaps: FinalizeGap[] = [];

  for (const row of checklist) {
    if (isLegitimatelyEmpty(row, ctx)) continue;

    // Choose the scan surface for this row.
    const isGlobal = GLOBAL_SECTIONS.has(row.section);
    const region = isGlobal ? "" : SECTION_REGIONS[row.section] ? extractRegion(html, SECTION_REGIONS[row.section]!) : "";

    // require[]: each token must be PRESENT in the section region.
    // (Global rows have no require tokens — their work is the forbid scan.)
    if (!isGlobal && row.require.length > 0) {
      // If the region is entirely absent AND not legitimately empty → the whole
      // section is missing. Report ONE gap for the section (not one per token).
      if (region === "") {
        gaps.push({
          section: row.section,
          tier: row.tier,
          what: `section absent — none of its render markers were emitted (${row.require.join(", ")})`,
          sourceStep: row.source,
          healAction: row.heal,
        });
      } else {
        for (const token of row.require) {
          if (!region.includes(token)) {
            gaps.push({
              section: row.section,
              tier: row.tier,
              what: `required marker missing: ${JSON.stringify(token)}`,
              sourceStep: row.source,
              healAction: row.heal,
            });
          }
        }
      }
    }

    // forbid[]: each token must be ABSENT from the scan surface.
    if (row.forbid.length > 0) {
      // Global rows scan the stripped whole body; per-section rows scan their region.
      // The internal-leak row is structural (class attributes), so it scans the RAW
      // body — stripping would not hide an internal node, and we must catch it intact.
      const surface = isGlobal
        ? row.section === "global-client-no-internal"
          ? html
          : ctx.strippedBody
        : stripQuotedRegions(region === "" ? html : region);

      for (const token of row.forbid) {
        if (surface.includes(token)) {
          gaps.push({
            section: row.section,
            tier: row.tier,
            what: `forbidden token present: ${JSON.stringify(token)}`,
            sourceStep: row.source,
            healAction: row.heal,
          });
        }
      }
    }
  }

  const pass = !gaps.some((g) => g.tier === "CRIT");
  return { pass, gaps };
}

// ── Checklist loading ────────────────────────────────────────────────────────

/** Parse + lightly validate the F1 checklist YAML into typed rows. */
export function parseChecklist(yamlText: string): ChecklistRow[] {
  const parsed = parseYaml(yamlText) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("report-checklist.yaml: expected a top-level list of section rows.");
  }
  return parsed.map((raw, i): ChecklistRow => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const section = r.section;
    if (typeof section !== "string" || section.trim() === "") {
      throw new Error(`report-checklist.yaml[${i}]: missing/empty 'section' id.`);
    }
    const tier = r.tier;
    if (tier !== "CRIT" && tier !== "WARN") {
      throw new Error(`report-checklist.yaml[${i}] (${section}): 'tier' must be CRIT or WARN.`);
    }
    const asStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)) : [];
    return {
      section,
      require: asStringArray(r.require),
      forbid: asStringArray(r.forbid),
      tier,
      okEmpty: typeof r.okEmpty === "string" ? r.okEmpty : "never",
      source: typeof r.source === "string" ? r.source : "(unspecified)",
      heal: typeof r.heal === "string" ? r.heal : "(unspecified)",
    };
  });
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync } = await import("fs");
  const { resolve, dirname, join } = await import("path");
  const { fileURLToPath } = await import("url");

  const argv = process.argv.slice(2);

  function readFlag(name: string): string | undefined {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  }

  const reportPath = readFlag("--report");
  const audienceArg = (readFlag("--audience") ?? "client") as ReportAudience;
  const checklistPath =
    readFlag("--checklist") ??
    join(dirname(fileURLToPath(import.meta.url)), "report-checklist.yaml");

  if (!reportPath) {
    process.stderr.write(
      "Usage: bun scripts/validate/finalize-gate.ts --report <report.html> --audience <client|internal> [--checklist <path>]\n" +
        "\n" +
        "OUTPUT-side finalization gate: parses the rendered report.html and asserts every\n" +
        "section's data landed (no RANK n/a, no undefined, no internal-leak on client).\n" +
        "Exit 0 = CRIT-clean (may carry WARN gaps), Exit 1 = ≥1 CRIT gap.\n"
    );
    process.exit(1);
  }

  if (audienceArg !== "client" && audienceArg !== "internal") {
    process.stderr.write(`[finalize-gate] invalid --audience '${audienceArg}' (expected client|internal)\n`);
    process.exit(1);
  }

  let html: string;
  let checklistText: string;
  try {
    html = readFileSync(resolve(reportPath), "utf8");
  } catch (err) {
    process.stderr.write(`[finalize-gate] cannot read report ${reportPath}: ${err}\n`);
    process.exit(1);
  }
  try {
    checklistText = readFileSync(resolve(checklistPath), "utf8");
  } catch (err) {
    process.stderr.write(`[finalize-gate] cannot read checklist ${checklistPath}: ${err}\n`);
    process.exit(1);
  }

  const checklist = parseChecklist(checklistText);
  const result = runFinalizeGate(html, audienceArg, checklist);

  const crit = result.gaps.filter((g) => g.tier === "CRIT");
  const warn = result.gaps.filter((g) => g.tier === "WARN");

  if (result.pass && warn.length === 0) {
    process.stdout.write(`[finalize-gate] PASS — report is CRIT-clean with no WARN gaps. Audience: ${audienceArg}.\n`);
    process.exit(0);
  }

  // Emit a machine-grep-able structured block so the orchestrator's Step 9.9 loop
  // can backtrace each gap by its sourceStep.
  process.stdout.write(`[finalize-gate] result: pass=${result.pass} crit=${crit.length} warn=${warn.length} audience=${audienceArg}\n`);
  const emit = (g: FinalizeGap): void => {
    process.stdout.write(
      `  [${g.tier}] section=${g.section}\n` +
        `        what:   ${g.what}\n` +
        `        source: ${g.sourceStep}\n` +
        `        heal:   ${g.healAction}\n`
    );
  };
  crit.forEach(emit);
  warn.forEach(emit);

  if (!result.pass) {
    process.stderr.write(
      `[finalize-gate] FAIL — ${crit.length} CRIT gap(s) block "report done". Backtrace each via its source (script-index.md) and self-heal (Step 9.9).\n`
    );
    process.exit(1);
  }

  // CRIT-clean but WARN gaps present: emit with the incomplete banner note, exit 0.
  process.stdout.write(
    `[finalize-gate] PASS-WITH-WARN — CRIT-clean; ${warn.length} WARN gap(s). Stamp "⚠ incomplete: ${warn.map((g) => g.section).join(", ")}" and report as "rendered with ${warn.length} gaps".\n`
  );
  process.exit(0);
}
