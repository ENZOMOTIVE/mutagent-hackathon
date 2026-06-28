/**
 * scripts/emit-completeness.ts — WS-1: the judge EMIT-CONTRACT completeness gate.
 * ---------------------------------------------------------------------------
 * The §9.4 judge walk is OPTIONAL in the schema (`present iff the judge emitted
 * it`), so a judge that drops the structured reasoning still produces a
 * schema-valid verdict file. That silent gap is what starved the report's
 * Trajectory (§2) + Self-Eval (§5) tabs: walk/understanding(M2)/expectedTrajectory(M3)
 * were 0/500 and agentSteps only 200/500, while the verdicts themselves were
 * fully reasoned (rich critiques). This module makes the gap MACHINE-VISIBLE.
 *
 * It assesses, over the COMPLETE-fidelity dispatched verdicts (an INCOMPLETE trace
 * legitimately SKIPS the per-criterion walk via the deterministic node-1 gate, so
 * it is EXEMPT — never counted as a missing emit), how many carry each required
 * judge-walk field. PURE + ADVISORY: it NEVER throws and NEVER alters a verdict —
 * it returns coverage counts + a loud `warning` when a required field is wholly
 * absent. Two consumers read the SAME numbers: the engine's aggregate log (loud
 * assert) and the report's §5 Self-Eval "Emit-Completeness" panel (honest coverage).
 */
import type { MatrixVerdictFile } from "./contracts/eval-matrix.ts";

/** The judge-walk fields the emit-contract REQUIRES on a complete-fidelity verdict. */
export const EMIT_FIELDS = ["agentSteps", "understanding", "expectedTrajectory", "judgeSteps"] as const;
export type EmitField = (typeof EMIT_FIELDS)[number];

/** Per-field coverage over the eligible (complete-fidelity) dispatched verdicts. */
export interface EmitFieldCoverage {
  field: EmitField;
  /** how many eligible verdicts carry a NON-EMPTY value for this field. */
  present: number;
  /** trajectoryIds of the eligible verdicts MISSING this field. */
  missing: string[];
  /** present / eligible, as a 0..100 integer (100 when there are 0 eligible). */
  pct: number;
}

export interface EmitCompleteness {
  /** dispatched verdicts total (complete + incomplete). */
  total: number;
  /** the DENOMINATOR — complete-fidelity verdicts that SHOULD carry the walk. */
  eligible: number;
  /** INCOMPLETE-fidelity verdicts, exempt from the walk contract (node-1 short-circuit). */
  exemptIncomplete: number;
  /** per-field coverage. */
  fields: EmitFieldCoverage[];
  /** eligible verdicts carrying ALL required fields (a fully-complete emit). */
  completeEmits: number;
  /** completeEmits / eligible, 0..100 integer. */
  completePct: number;
  /** SET (loud) when ≥1 required field is wholly absent across all eligible verdicts. */
  warning?: string;
}

/** A verdict file is eligible for the walk contract iff its fidelity is COMPLETE. */
function isCompleteFidelity(f: MatrixVerdictFile): boolean {
  // fidelity is required on the schema; `complete:false` is the node-1 INCOMPLETE gate.
  return f.fidelity?.complete !== false;
}

/** Non-empty test for one emit field on a verdict file. */
function fieldPresent(f: MatrixVerdictFile, field: EmitField): boolean {
  const v = (f as Record<string, unknown>)[field];
  if (Array.isArray(v)) return v.length > 0;
  if (field === "understanding") {
    // M2 is an object — present iff it carries a non-empty rephrase/understanding.
    if (v === undefined || v === null || typeof v !== "object") return false;
    return Object.keys(v as object).length > 0;
  }
  return v !== undefined && v !== null;
}

/**
 * Assess the judge emit-contract completeness over the dispatched verdict files.
 * PURE. NEVER throws. The denominator is the COMPLETE-fidelity verdicts (INCOMPLETE
 * traces are exempt — they short-circuit the walk by design).
 */
export function assessEmitCompleteness(files: MatrixVerdictFile[]): EmitCompleteness {
  const total = files.length;
  const eligibleFiles = files.filter(isCompleteFidelity);
  const exemptIncomplete = total - eligibleFiles.length;
  const eligible = eligibleFiles.length;

  const fields: EmitFieldCoverage[] = EMIT_FIELDS.map((field) => {
    const missing = eligibleFiles.filter((f) => !fieldPresent(f, field)).map((f) => f.trajectoryId);
    const present = eligible - missing.length;
    return { field, present, missing, pct: eligible > 0 ? Math.round((100 * present) / eligible) : 100 };
  });

  const completeEmits = eligibleFiles.filter((f) => EMIT_FIELDS.every((field) => fieldPresent(f, field))).length;
  const completePct = eligible > 0 ? Math.round((100 * completeEmits) / eligible) : 100;

  const result: EmitCompleteness = {
    total,
    eligible,
    exemptIncomplete,
    fields,
    completeEmits,
    completePct,
  };

  const whollyAbsent = fields.filter((f) => eligible > 0 && f.present === 0).map((f) => f.field);
  if (whollyAbsent.length > 0) {
    result.warning =
      `JUDGE EMIT-CONTRACT GAP: ${whollyAbsent.join(", ")} absent on ALL ${eligible} complete-fidelity ` +
      `verdict(s) — the §9.4 judge walk was dropped. The Trajectory (§2) + Self-Eval (§5) tabs read ` +
      `these as starved. The judge (#mode-judge-trajectory) MUST emit M2 understanding, M3 ` +
      `expectedTrajectory, agentSteps and judgeSteps on every complete-fidelity trajectory ` +
      `(assets/agents/evaluator.md §9.4 walk). agentSteps is factual trace data — reconstruct it ` +
      `deterministically when the judge omits it; M2/M3/judgeSteps are judge reasoning — resend on absence.`;
  }
  return result;
}
