/**
 * scripts/validate/wave6-checklist.ts
 * PRD-SO-06 — Wave-6 methodology checklist validator + stamp emitter.
 * Type A — Pure Script (file-system reads; no LLM; deterministic).
 *
 * The Wave-6 methodology (R2.1–R2.6 + D1/D2) requires each diagnostic run to emit
 * six stamp files under `<report-dir>/wave6/<step>.json` before the render gate
 * (orchestrator-protocol.md Step 8.9). This validator checks those stamps exist and
 * are well-formed, then emits a gate result.
 *
 * Steps validated:
 *   parse-brief          parse-brief.ts produced a ParsedInvocation
 *   awareness-sample     llm-sample.ts produced a 5-trace awareness sample
 *   blind-spots          blind-spots.ts produced the blind-spots taxonomy
 *   library-match        library/match.ts ran the entity library check
 *   caps-result          caps.ts produced a CapsResult
 *   deep-read-gate       deep-read-gate.ts produced a DeepReadGateResult
 *   awareness-witness    W11-05: stamped by the orchestrator at Step 3.5 to record
 *                        whether this was a fresh run AND whether awareness ran.
 *                        HARD-FAIL (regardless of isClientReport) when isFreshRun=true
 *                        AND awarenessRan=false AND no explicit exemption declared.
 *
 * Gate severity (PRD §6 Q7):
 *   Internal reports (isClientReport = false): WARN-only on most missing stamps.
 *   Client reports   (isClientReport = true):  HARD-FAIL (non-zero exit).
 *
 *   W11-05 ADDITIONAL RULE (awareness-witness):
 *   If awareness-witness stamp declares isFreshRun=true AND awarenessRan=false
 *   with no exemption → ALWAYS HARD-FAIL (overrides isClientReport=false leniency).
 *   The operator must never silently skip awareness on a fresh run.
 *
 * Usage (CLI):
 *   bun scripts/cli/run.sh scripts/validate/wave6-checklist.ts \
 *       --report-dir <dir> [--accept-exemptions <id>...] [--client]
 *
 * Exported function:
 *   runWave6Checklist(opts: Wave6ChecklistOpts): Wave6ChecklistResult
 *
 * Step 8.9 integration (orchestrator-protocol.md):
 *   The orchestrator calls this validator after all Wave-6 scripts have run (Step 8.9).
 *   On WARN: log to runMeta.exemptions[]; continue rendering.
 *   On FAIL:  halt; do not render; report the missing stamps to the operator.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type Wave6StepId =
  | "parse-brief"
  | "awareness-sample"
  | "blind-spots"
  | "library-match"
  | "caps-result"
  | "deep-read-gate"
  | "awareness-witness";

export const WAVE6_STEPS: readonly Wave6StepId[] = [
  "parse-brief",
  "awareness-sample",
  "blind-spots",
  "library-match",
  "caps-result",
  "deep-read-gate",
  "awareness-witness",
] as const;

/**
 * W11-05: Payload written to `wave6/awareness-witness.json` by the orchestrator
 * at Step 3.5. Records whether this was a fresh run (no confirmed priors) and
 * whether awareness actually ran.
 *
 * Rules enforced by the checklist:
 *   - isFreshRun=true  + awarenessRan=true  → pass
 *   - isFreshRun=true  + awarenessRan=false → HARD-FAIL (no leniency)
 *   - isFreshRun=false + awarenessRan=false → pass (priors authorized the skip)
 *   - isFreshRun=false + awarenessRan=true  → pass
 */
export interface AwarenessWitnessPayload {
  /**
   * True when no confirmed library prior existed for this entity before the run
   * (i.e. library-match returned no matches). A fresh run MUST run awareness.
   */
  isFreshRun: boolean;
  /** True when llm-sample.ts + blind-spots.ts both ran for this run. */
  awarenessRan: boolean;
  /**
   * When awarenessRan=false on a fresh run, this field MUST be set to a valid
   * exemption reason from the Gate Exemption Taxonomy (references/workflows/rca.md).
   * Absent when awarenessRan=true.
   */
  exemptionReason?: string;
}

export interface Wave6StepResult {
  stepId: Wave6StepId;
  present: boolean;
  /** True when the stamp file was present but could not be parsed as JSON. */
  malformed: boolean;
  /** Path that was checked. */
  stampPath: string;
  /** Parsed content when present and well-formed. */
  content?: unknown;
  /** Exemption reason when this step was accepted despite being missing. */
  exemptionReason?: string;
}

export interface Wave6ChecklistResult {
  ok: boolean;
  /** True when any missing stamps were accepted via exemptions (result is ok despite gaps). */
  exempted: boolean;
  /** Steps with missing or malformed stamps (after exemptions applied). */
  missing: Wave6StepResult[];
  /** All step results (present + absent). */
  steps: Wave6StepResult[];
  /** Formatted banner string for display in reports or logs. */
  banner: string;
  /**
   * W11-05: Set when the awareness-witness gate detected a fresh-run violation.
   * A fresh-run violation is when isFreshRun=true + awarenessRan=false + no exemption.
   * This ALWAYS causes ok=false regardless of isClientReport.
   */
  awarenessViolation?: string;
}

export interface Wave6ChecklistOpts {
  /** Absolute or relative path to the report directory. */
  reportDir: string;
  /** Step IDs that are accepted despite being missing (e.g. library-match when no library priors exist). */
  acceptExemptions?: Wave6StepId[];
  /** When true, missing non-exempted steps cause hard failure. When false, WARN-only. */
  isClientReport?: boolean;
}

// ── Stamp helpers ─────────────────────────────────────────────────────────────

function stampPath(reportDir: string, stepId: Wave6StepId): string {
  return join(reportDir, "wave6", `${stepId}.json`);
}

function readStamp(path: string): { present: boolean; malformed: boolean; content?: unknown } {
  if (!existsSync(path)) return { present: false, malformed: false };
  try {
    const content = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return { present: true, malformed: false, content };
  } catch {
    return { present: true, malformed: true };
  }
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * PRD-SO-06 — Run the Wave-6 methodology checklist.
 * Returns a structured result; the CLI entrypoint handles exit codes.
 *
 * W11-05: Also enforces the awareness-witness gate — hard-fails if the
 * awareness-witness stamp declares isFreshRun=true + awarenessRan=false
 * with no exemption, regardless of isClientReport setting.
 */
export function runWave6Checklist(opts: Wave6ChecklistOpts): Wave6ChecklistResult {
  const { reportDir, acceptExemptions = [], isClientReport = false } = opts;
  const abs = resolve(reportDir);
  const exemptSet = new Set<string>(acceptExemptions);

  const steps: Wave6StepResult[] = WAVE6_STEPS.map((stepId) => {
    const path = stampPath(abs, stepId);
    const { present, malformed, content } = readStamp(path);
    const result: Wave6StepResult = {
      stepId,
      present,
      malformed,
      stampPath: path,
      content,
    };
    if (!present && exemptSet.has(stepId)) {
      result.exemptionReason = `accepted via --accept-exemptions`;
    }
    return result;
  });

  const missing = steps.filter((s) => {
    if (s.present && !s.malformed) return false; // stamp present + valid
    if (s.exemptionReason) return false; // accepted exemption
    return true;
  });

  const exempted = steps.some((s) => !s.present && !!s.exemptionReason);

  // ── W11-05: Awareness witness gate ──────────────────────────────────────────
  // Check the awareness-witness stamp for fresh-run violations.
  // A fresh-run violation (isFreshRun=true + awarenessRan=false + no exemptionReason)
  // is ALWAYS a hard-fail, overriding the isClientReport=false leniency.
  let awarenessViolation: string | undefined;
  const witnessStep = steps.find((s) => s.stepId === "awareness-witness");
  if (witnessStep?.present && !witnessStep.malformed && witnessStep.content) {
    // Stamp files are written as { stepId, timestamp, result: <payload> }
    const stamped = witnessStep.content as { result?: Partial<AwarenessWitnessPayload> };
    const payload = stamped.result ?? (witnessStep.content as Partial<AwarenessWitnessPayload>);
    if (
      payload.isFreshRun === true &&
      payload.awarenessRan === false &&
      !payload.exemptionReason
    ) {
      awarenessViolation =
        "awareness-witness: isFreshRun=true + awarenessRan=false with no exemptionReason. " +
        "Fresh runs MUST run the awareness layer (W11-05). " +
        "Pass an exemptionReason in the witness stamp if skipping is authorized.";
    }
  }

  const ok = missing.length === 0 && !awarenessViolation;

  const lines: string[] = [];
  if (awarenessViolation) {
    lines.push(`Wave-6 checklist HARD-FAIL (W11-05 awareness-witness gate):`);
    lines.push(`  ${awarenessViolation}`);
    lines.push(`\nFix: re-run the awareness layer (scripts/awareness/llm-sample.ts + blind-spots.ts)`);
    lines.push(`     OR write the awareness-witness stamp with a valid exemptionReason.`);
  } else if (ok && !exempted) {
    lines.push(`Wave-6 checklist PASSED — all ${WAVE6_STEPS.length} stamps present.`);
  } else if (ok && exempted) {
    const exemptedIds = steps
      .filter((s) => s.exemptionReason)
      .map((s) => s.stepId)
      .join(", ");
    lines.push(`Wave-6 checklist PASSED (with exemptions: ${exemptedIds}).`);
  } else {
    const severity = isClientReport ? "FAIL" : "WARN";
    lines.push(`Wave-6 checklist ${severity} — ${missing.length} missing stamp(s):`);
    for (const s of missing) {
      const label = s.malformed ? "(malformed JSON)" : "(not found)";
      lines.push(`  - ${s.stepId} ${label}: ${s.stampPath}`);
    }
    if (isClientReport) {
      lines.push(`\nHard-fail: client report requires all Wave-6 stamps (PRD-SO-06 / Q7).`);
      lines.push(`Run the missing Wave-6 scripts and re-invoke the render gate.`);
    } else {
      lines.push(`\nWarn-only: record missing stamps in runMeta.exemptions[] and continue.`);
    }
  }

  return { ok, exempted, missing, steps, banner: lines.join("\n"), awarenessViolation };
}

// ── Stamp writer helpers (for Wave-6 scripts to call) ─────────────────────────

/**
 * Write a Wave-6 stamp file. Called by each Wave-6 script to signal completion.
 * Creates the `wave6/` subdirectory if it does not exist.
 *
 * @param reportDir  Report directory path.
 * @param stepId     The Wave-6 step being stamped.
 * @param payload    Any JSON-serializable result from the step.
 */
export function writeWave6Stamp(reportDir: string, stepId: Wave6StepId, payload: unknown): void {
  const dir = join(resolve(reportDir), "wave6");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stepId}.json`);
  writeFileSync(path, JSON.stringify({ stepId, timestamp: new Date().toISOString(), result: payload }, null, 2), "utf-8");
}

/**
 * W11-05: Write the awareness-witness stamp at Step 3.5.
 * Called by the orchestrator after resolving whether priors exist for the entity:
 *
 *   - isFreshRun: true  when no confirmed library prior exists (no skip authorized)
 *   - isFreshRun: false when a confirmed library prior exists (skip authorized)
 *   - awarenessRan: true when llm-sample.ts + blind-spots.ts both ran
 *   - awarenessRan: false when the awareness layer was intentionally skipped
 *   - exemptionReason: required when awarenessRan=false on a fresh run
 *
 * Example (fresh run, awareness ran):
 *   writeAwarenessWitnessStamp("/tmp/report", { isFreshRun: true, awarenessRan: true })
 *
 * Example (prior-based skip):
 *   writeAwarenessWitnessStamp("/tmp/report", {
 *     isFreshRun: false, awarenessRan: false,
 *     exemptionReason: "library prior exists for this entity (Step 4.5 match)"
 *   })
 */
export function writeAwarenessWitnessStamp(
  reportDir: string,
  payload: AwarenessWitnessPayload
): void {
  writeWave6Stamp(reportDir, "awareness-witness", payload);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  const reportDirIdx = args.indexOf("--report-dir");
  if (reportDirIdx < 0 || !args[reportDirIdx + 1]) {
    console.error("Usage: wave6-checklist.ts --report-dir <dir> [--accept-exemptions <id>...] [--client]");
    process.exit(2);
  }

  const reportDir = args[reportDirIdx + 1];
  const isClientReport = args.includes("--client");

  // Collect exemption IDs: all args after --accept-exemptions until the next flag.
  const exemptions: Wave6StepId[] = [];
  const exemptIdx = args.indexOf("--accept-exemptions");
  if (exemptIdx >= 0) {
    for (let i = exemptIdx + 1; i < args.length; i++) {
      if (args[i].startsWith("--")) break;
      if (WAVE6_STEPS.includes(args[i] as Wave6StepId)) {
        exemptions.push(args[i] as Wave6StepId);
      } else {
        console.warn(`Unknown step ID in --accept-exemptions: ${args[i]}`);
      }
    }
  }

  const result = runWave6Checklist({ reportDir, acceptExemptions: exemptions, isClientReport });

  console.info(`\n${result.banner}\n`);

  if (!result.ok && isClientReport) {
    process.exit(1);
  }
  process.exit(0);
}
