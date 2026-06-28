/**
 * scripts/validate/completeness-check.ts
 * W9-08 (R-CP-1..4): Simple deterministic report-completeness gate.
 *
 * Asserts:
 *   1. RunMeta required fields present (totalTraces, tier0ScannedCount, llmReadCount,
 *      scopeFilter, samplingStrategy, decisions, deepRead).
 *   2. Every expected report section non-empty:
 *        entity card (diagnosedEntity)
 *        bigStat (≥1 tile)
 *        heatmap (≥1 cell with count > 0)
 *        signal census (≥1 row)
 *        ≥1 finding panel (findings.length ≥ 1)
 *        Methodology section (runMeta present)
 *        Decisions section (always present — no content gating needed)
 *   3. W13-C (D-6): the renderer's EXACT dereference contract — the fields render.ts
 *      interpolates without a guard, so a gate-pass GUARANTEES a render-success:
 *        - top-level `sessionId` (render does `sessionId.toUpperCase()`)
 *        - per-finding `actionable` is a string (render does `actionable.slice()`)
 *        - per-finding `failureOrigin.evidence` + `failureOrigin.confidence`
 *        - per-remedy `rank` / `cost` / `correctness` (the D-1 header-badge triad)
 *      This closes the "gate passes but render crashes/garbles" gap.
 *
 * Export: `checkCompleteness(input): CompletenessResult` (pure function — no I/O)
 * CLI: `if (import.meta.main)` entrypoint — exit 0 on pass, exit 1 with missing list on fail.
 *
 * Type A — Pure Script (deterministic + no I/O except CLI file read)
 */

import { parse as parseYaml } from "yaml";
import type { RenderInput, RunMeta } from "../report/render.ts";

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CompletenessResult {
  /** True when all required fields and sections are present. */
  pass: boolean;
  /** List of missing / empty fields / sections (empty when pass). */
  missing: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// S4-orch (Wave-15 Block B): PRE-ENRICHER runMeta gate
// ════════════════════════════════════════════════════════════════════════════
//
// WHY: the orchestrator's Step-8.5 runMeta assembly is hand-threaded with no gate.
// The F4 methodology widgets (orchestrator-COMPUTED — the enricher cannot recompute
// them) can silently fail to thread. A real regression was observed in run 210635:
// NOTHING threaded → generic-fallback Methodology, 0 <svg>. The pre-render
// completeness-check (above) runs AFTER the enricher; by then a never-threaded
// widget is indistinguishable from one the enricher legitimately omits.
//
// FIX (operator option B): a PRE-ENRICHER gate that HARD-FAILS (naming the missing
// field) if any runMeta field required by the report-checklist's F4 table is absent
// BEFORE the enricher runs. The report-checklist (scripts/validate/report-checklist.yaml)
// is the SOURCE OF TRUTH for the required-field list — the F4 methodology rows.
//
// SCOPE — only the ORCHESTRATOR-THREADED F4 widgets are pre-enricher-required.
// `selectionRules` + `signalSelectionTrace` are ENRICHER-DERIVED (F1, deterministic);
// they are legitimately ABSENT before the enricher runs, so they are NOT gated here
// (gating them would hard-fail every correct run). See orchestrator-protocol.md §F4
// "Who computes" column.

/**
 * The orchestrator-threaded F4 methodology widgets, each cross-referenced to the
 * report-checklist section that requires it. This map is asserted against the
 * checklist at gate time (checklist drift → loud failure), keeping the checklist
 * the single source of truth for WHICH sections require these widgets.
 *
 *   tierBreakdown   → methodology-tier-pie   (orchestrator assigns from the wave6 stamp)
 *   blindSpots      → methodology-blind-spots (orchestrator assigns; present in BOTH the
 *                     fresh-run and the prior-skip path — protocol §F2)
 *   awarenessSample → methodology-awareness   (orchestrator assigns on a FRESH run; legitimately
 *                     ABSENT under a documented awareness-skip exemption — see okEmpty)
 */
const PRE_ENRICHER_F4_WIDGETS: ReadonlyArray<{
  field: keyof RunMeta;
  checklistSection: string;
  /** True when this field may be legitimately absent under a documented exemption. */
  exemptable: boolean;
}> = [
  { field: "tierBreakdown", checklistSection: "methodology-tier-pie", exemptable: false },
  { field: "blindSpots", checklistSection: "methodology-blind-spots", exemptable: false },
  { field: "awarenessSample", checklistSection: "methodology-awareness", exemptable: true },
] as const;

/** Minimal shape of the report-checklist rows this gate reads (section id only). */
interface ChecklistSectionRow {
  section: string;
}

export interface PreEnricherRunMetaResult {
  /** True when every required orchestrator-threaded F4 widget is threaded. */
  pass: boolean;
  /** Missing widget fields (with the checklist section that requires each). */
  missing: string[];
}

/**
 * True when a documented awareness-skip exemption is recorded in runMeta. The
 * orchestrator records exemptions per protocol §Step-8.9 as
 * `runMeta.exemptions: [{ stepId, reason, declaredBy }]`. A prior-based awareness
 * SKIP (Step 4.5 library match) leaves `awarenessSample` undefined on purpose; the
 * exemption entry is what makes that absence LEGITIMATE (mirrors the checklist
 * `methodology-awareness` okEmpty: "awareness SKIPPED under documented exemption").
 */
function hasAwarenessSkipExemption(runMeta: RunMeta): boolean {
  const exemptions = (runMeta as Record<string, unknown>).exemptions;
  if (!Array.isArray(exemptions)) return false;
  return exemptions.some((e) => {
    const stepId = (e as Record<string, unknown>)?.stepId;
    return stepId === "awareness-sample" || stepId === "awareness";
  });
}

/**
 * Assert the F4 widget→section map against the loaded checklist. The checklist is
 * the source of truth: if a section this gate relies on has been renamed/removed
 * in report-checklist.yaml, FAIL LOUD rather than silently under-gate.
 */
function assertChecklistCoversWidgets(checklist: ChecklistSectionRow[]): void {
  const sections = new Set(checklist.map((r) => r.section));
  const orphaned = PRE_ENRICHER_F4_WIDGETS.filter(
    (w) => !sections.has(w.checklistSection)
  );
  if (orphaned.length > 0) {
    throw new Error(
      `pre-enricher-runMeta gate: report-checklist.yaml drift — the F4 section(s) ` +
        `[${orphaned.map((w) => w.checklistSection).join(", ")}] referenced by this gate ` +
        `are absent from the checklist. The checklist is the source of truth; reconcile ` +
        `PRE_ENRICHER_F4_WIDGETS with report-checklist.yaml. Fail-loud (S4-orch).`
    );
  }
}

/**
 * S4-orch: PRE-ENRICHER runMeta completeness gate. Runs over `findings.runMeta`
 * BEFORE the Step-8.5 enricher. HARD-FAILS naming any orchestrator-threaded F4
 * widget that was not threaded (the run-210635 regression class).
 *
 * @param runMeta   - findings.runMeta as assembled by the orchestrator (pre-enrich)
 * @param checklist - parsed report-checklist rows (source of truth for required sections)
 *
 * Pure function — same input, same output. No I/O (the CLI entrypoint reads files).
 */
export function checkPreEnricherRunMeta(
  runMeta: RunMeta | undefined,
  checklist: ChecklistSectionRow[]
): PreEnricherRunMetaResult {
  assertChecklistCoversWidgets(checklist);

  const missing: string[] = [];

  // A wholly-absent runMeta means NOTHING threaded — the exact run-210635 failure.
  if (!runMeta) {
    for (const w of PRE_ENRICHER_F4_WIDGETS) {
      // No runMeta ⇒ no exemption record either ⇒ even the exemptable field is missing.
      missing.push(`runMeta.${String(w.field)} (required by checklist '${w.checklistSection}')`);
    }
    return { pass: false, missing };
  }

  const exemptAwareness = hasAwarenessSkipExemption(runMeta);

  for (const w of PRE_ENRICHER_F4_WIDGETS) {
    const value = (runMeta as Record<string, unknown>)[w.field as string];
    const present = value !== undefined && value !== null;
    if (present) continue;
    if (w.exemptable && exemptAwareness) continue; // documented awareness-skip exemption
    missing.push(
      `runMeta.${String(w.field)} (required by checklist '${w.checklistSection}'` +
        (w.exemptable ? " — no documented awareness-skip exemption found" : "") +
        ")"
    );
  }

  return { pass: missing.length === 0, missing };
}

/** Parse the report-checklist YAML into the minimal section rows this gate needs. */
export function parseChecklistSections(yamlText: string): ChecklistSectionRow[] {
  const parsed = parseYaml(yamlText) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("report-checklist.yaml: expected a top-level list of section rows.");
  }
  return parsed.map((raw, i): ChecklistSectionRow => {
    const section = (raw as Record<string, unknown>)?.section;
    if (typeof section !== "string" || section.trim() === "") {
      throw new Error(`report-checklist.yaml[${i}]: missing/empty 'section' id.`);
    }
    return { section };
  });
}

// ── Required RunMeta fields ───────────────────────────────────────────────────

/**
 * The RunMeta fields required by W9-08. All are optional on the TypeScript type
 * for backward-compat; the completeness check asserts them as required at runtime.
 */
const REQUIRED_RUN_META_FIELDS: ReadonlyArray<keyof RunMeta> = [
  "totalTraces",
  "tier0ScannedCount",
  "llmReadCount",
  "scopeFilter",
  "samplingStrategy",
  "decisions",
  "deepRead",
] as const;

// ── W13-C (D-6): render-contract helpers ────────────────────────────────────────

/** The low|medium|high categorical scale shared by remedy cost/correctness. */
const COST_CORRECTNESS_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high"]);

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * W13-C (D-6): assert the renderer's exact per-finding + per-remedy dereference
 * contract. Pushes one entry per gap so the gate fails-loud with ALL gaps at once.
 */
function checkRenderContract(input: RenderInput, missing: string[]): void {
  // Top-level: render does `input.sessionId.toUpperCase()` — must be a non-empty string.
  if (!isNonEmptyString(input.sessionId)) {
    missing.push("sessionId (render does sessionId.toUpperCase() — must be a non-empty string)");
  }

  input.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    // render does `f.actionable.slice(...)` in several panels — must be a string.
    if (typeof f.actionable !== "string") {
      missing.push(`${at}.actionable (render does actionable.slice() — must be a string)`);
    }
    // render dereferences both failureOrigin fields (severity badge + entity card).
    const fo = (f.failureOrigin ?? {}) as unknown as Record<string, unknown>;
    if (!isNonEmptyString(fo.evidence)) missing.push(`${at}.failureOrigin.evidence`);
    if (!isNonEmptyString(fo.confidence)) missing.push(`${at}.failureOrigin.confidence`);

    // Per-remedy D-1 header-badge triad: render interpolates rank/cost/correctness raw.
    const remedies = Array.isArray(f.remedies) ? f.remedies : [];
    remedies.forEach((r, j) => {
      const rat = `${at}.remedies[${j}]`;
      const rr = (r ?? {}) as unknown as Record<string, unknown>;
      if (typeof rr.rank !== "number") {
        missing.push(`${rat}.rank (render does RANK \${rank} — must be a number; enricher-derived)`);
      }
      if (!COST_CORRECTNESS_VALUES.has(rr.cost as string)) {
        missing.push(`${rat}.cost (render does cost:\${cost} — must be low|medium|high)`);
      }
      if (!COST_CORRECTNESS_VALUES.has(rr.correctness as string)) {
        missing.push(`${rat}.correctness (render does correct:\${correctness} — must be low|medium|high)`);
      }
    });
  });
}

// ── checkCompleteness ─────────────────────────────────────────────────────────

/**
 * W9-08 (R-CP-1..4): Deterministic completeness gate.
 * Pure function — same input, same output every time.
 *
 * Empty-findings runs (findings.length === 0) are exempt from the finding-panel
 * and section checks — a legitimate zero-finding run is always complete.
 */
export function checkCompleteness(input: RenderInput): CompletenessResult {
  const missing: string[] = [];

  // ── RunMeta field presence ────────────────────────────────────────────────
  // When runMeta is absent entirely: record all required fields as missing.
  const runMeta = input.runMeta;
  if (!runMeta) {
    // Only flag as missing when there ARE findings — pre-W9 empty runs are exempt.
    if (input.findings.length > 0) {
      missing.push("runMeta (absent — required for runs with findings)");
      REQUIRED_RUN_META_FIELDS.forEach((f) => missing.push(`runMeta.${f}`));
    }
  } else {
    for (const field of REQUIRED_RUN_META_FIELDS) {
      if ((runMeta as Record<string, unknown>)[field] === undefined) {
        missing.push(`runMeta.${field}`);
      }
    }
  }

  // ── Section presence — only checked when there are findings ───────────────
  if (input.findings.length > 0) {
    // Entity card
    if (!input.diagnosedEntity) {
      missing.push("diagnosedEntity (entity card absent)");
    }

    // BigStat row (≥1 tile)
    if (!input.bigStat || input.bigStat.length === 0) {
      missing.push("bigStat (no tiles — Overview big-stat row empty)");
    }

    // Heatmap (at least 1 cell with count > 0 — an all-zero heatmap is a starved signal)
    if (!input.hourlyHeatmap || input.hourlyHeatmap.cells.length === 0) {
      missing.push("hourlyHeatmap.cells (heatmap absent)");
    } else if (input.hourlyHeatmap.cells.every((c) => c.count === 0)) {
      missing.push("hourlyHeatmap (all cells are zero — starved heatmap input)");
    }

    // Signal census (≥1 row)
    if (!input.signalCensus || input.signalCensus.length === 0) {
      missing.push("signalCensus (signal census absent)");
    }

    // ≥1 finding panel
    if (input.findings.length < 1) {
      // Redundant guard — kept explicit for clarity.
      missing.push("findings (no findings present — expected ≥1 finding panel)");
    }

    // Methodology section (runMeta required for Methodology tab content)
    if (!input.runMeta) {
      missing.push("runMeta (Methodology tab requires runMeta)");
    }

    // Decisions section is always emitted by renderDecisionsTab — no content guard needed.

    // W13-C (D-6): the renderer's exact dereference contract (sessionId + per-finding
    // + per-remedy fields). Runs on findings-bearing runs — the render path that
    // previously passed the gate yet crashed/garbled (the D-1 undefined badges).
    checkRenderContract(input, missing);
  }

  return {
    pass: missing.length === 0,
    missing,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync } = await import("fs");
  const { resolve, dirname, join } = await import("path");
  const { fileURLToPath } = await import("url");

  const argv = process.argv.slice(2);

  // ── S4-orch: --pre-enricher mode (runs over findings.runMeta BEFORE the enricher) ──
  if (argv[0] === "--pre-enricher") {
    const flagIdx = (name: string): number => argv.indexOf(name);
    const flagVal = (name: string): string | undefined => {
      const i = flagIdx(name);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const findingsPath = flagVal("--findings");
    if (!findingsPath) {
      process.stderr.write(
        "Usage: bun scripts/validate/completeness-check.ts --pre-enricher --findings <findings.json> [--checklist <report-checklist.yaml>]\n" +
          "\n" +
          "S4-orch: PRE-ENRICHER runMeta gate. HARD-FAILS if any orchestrator-threaded\n" +
          "F4 methodology widget (tierBreakdown / blindSpots / awarenessSample) is absent\n" +
          "from findings.runMeta before the Step-8.5 enricher runs. Exit 0 = threaded,\n" +
          "Exit 1 = missing widget(s) listed.\n"
      );
      process.exit(1);
    }
    const checklistPath =
      flagVal("--checklist") ??
      join(dirname(fileURLToPath(import.meta.url)), "report-checklist.yaml");

    let runMeta: RunMeta | undefined;
    let checklist: ChecklistSectionRow[];
    try {
      const findingsDoc = JSON.parse(readFileSync(resolve(findingsPath), "utf8")) as {
        runMeta?: RunMeta;
      };
      runMeta = findingsDoc.runMeta;
      checklist = parseChecklistSections(readFileSync(resolve(checklistPath), "utf8"));
    } catch (err) {
      process.stderr.write(`Error reading inputs: ${err}\n`);
      process.exit(1);
    }

    const preResult = checkPreEnricherRunMeta(runMeta, checklist);
    if (preResult.pass) {
      process.stdout.write(
        `[pre-enricher-runMeta] PASS — all orchestrator-threaded F4 widgets present.\n`
      );
      process.exit(0);
    }
    process.stderr.write(
      `[pre-enricher-runMeta] FAIL — ${preResult.missing.length} unthreaded widget(s) ` +
        `(orchestrator Step-8.5 threading regression — see protocol §F4):\n`
    );
    preResult.missing.forEach((m, i) => {
      process.stderr.write(`  ${i + 1}. ${m}\n`);
    });
    process.exit(1);
  }

  const inputPath = argv[0];

  if (!inputPath) {
    process.stderr.write(
      "Usage: bun scripts/validate/completeness-check.ts <render-input.json>\n" +
        "       bun scripts/validate/completeness-check.ts --pre-enricher --findings <findings.json>\n" +
        "\n" +
        "Validates that a RenderInput has all required RunMeta fields and report\n" +
        "sections populated. Exit 0 = complete, Exit 1 = missing fields listed.\n"
    );
    process.exit(1);
  }

  let input: RenderInput;
  try {
    input = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as RenderInput;
  } catch (err) {
    process.stderr.write(`Error reading ${inputPath}: ${err}\n`);
    process.exit(1);
  }

  const result = checkCompleteness(input);

  if (result.pass) {
    process.stdout.write(
      `[completeness-check] PASS — all required fields and sections present.\n`
    );
    process.exit(0);
  } else {
    process.stderr.write(
      `[completeness-check] FAIL — ${result.missing.length} missing field(s) / section(s):\n`
    );
    result.missing.forEach((m, i) => {
      process.stderr.write(`  ${i + 1}. ${m}\n`);
    });
    process.exit(1);
  }
}
