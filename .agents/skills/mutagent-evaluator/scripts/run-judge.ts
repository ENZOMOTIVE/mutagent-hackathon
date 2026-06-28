/**
 * scripts/run-judge.ts
 * ---------------------------------------------------------------------------
 * The pinned-judge applicator seam (EV-REQ-024 / GAP-JUDGE-SEAM).
 *
 * This is the INNER, deterministic, testable HALF of the judge track. The OTHER
 * half — the live LLM call that PRODUCES verdicts by reading a transcript vs the
 * behavior-tree — is a documented integration seam at the WORKFLOW layer, never
 * in this script. Keeping the engine PURE is what makes the judge track
 * reproducible and unit-testable.
 *
 * `applyJudgeVerdicts(rows, verdictMap, judgePin?)` consumes the scorecard rows
 * (incl. the `judgePlaceholder()` skip rows emitted by run-deterministic.ts —
 * we CONSUME that placeholder, we do NOT redefine it) plus a CALLER-SUPPLIED
 * verdict map keyed by a stable per-row id, and resolves each judge placeholder:
 *
 *   - no verdict in the map            -> STAYS skip (the judge never fabricates)
 *   - a non-pinned verdict (temp != 0
 *     OR missing modelId)              -> REJECTED -> stays skip + records a
 *                                         determinism-defect detail. A non-pinned
 *                                         judge can NEVER produce a pass (C-PIN).
 *   - a pinned pass/fail verdict       -> applies (sets result + records modelId)
 *   - deterministic-track rows         -> passed through UNTOUCHED
 *
 * ── Row-keying convention (needed so the verdictMap key is unambiguous) ───────
 * ScorecardCriterion carries no stable per-row id. The applicator receives the
 * flat row list in MATRIX ORDER (the order run-deterministic emits), so the
 * stable key is `componentId#<indexWithinComponent>` — i.e. the Nth row of a
 * given component. `rowKey(componentId, indexInComponent)` builds it; callers
 * that produce verdicts MUST key the map with this same convention.
 *
 * Pure + deterministic: a fresh array is returned; inputs are never mutated; no
 * clock/random/network. Same (rows, verdictMap) -> deep-equal output, always.
 */
import { type DeterministicRowResult } from "./run-deterministic.ts";
import {
  type RowResultValue,
  type ScorecardCriterion,
  RowResult,
  Track,
} from "./contracts/types.ts";

/**
 * A caller-supplied judge verdict for one row. The live judge layer fills these
 * in; this engine only APPLIES them under the C-PIN invariant. A verdict is
 * "pinned" iff it carries a modelId AND temperature === 0.
 */
export interface JudgeVerdict {
  /** The pinned model id the judge ran under. Absent => not pinned => rejected. */
  modelId?: string;
  /** Sampling temperature. Anything other than 0 => not pinned => rejected. */
  temperature?: number;
  /** The judge's claimed result. Only `pass`/`fail` are meaningful; a pinned
   *  verdict applies it. (A `skip` verdict is treated as no decision.) */
  result: RowResultValue;
  /** Optional free-text rationale from the judge (masked downstream). */
  detail?: string;
}

/** verdictMap: stable rowKey -> verdict. Keyed by `rowKey(componentId, idx)`. */
export type JudgeVerdictMap = Record<string, JudgeVerdict>;

/**
 * Stable per-row key: the Nth criterion of a given component. This is the
 * documented row-keying convention the verdictMap is keyed by.
 */
export function rowKey(componentId: string, indexInComponent: number): string {
  return `${componentId}#${indexInComponent}`;
}

/** A verdict is pinned iff it declares a modelId AND temperature === 0. */
function isPinned(verdict: JudgeVerdict): boolean {
  return (
    typeof verdict.modelId === "string" &&
    verdict.modelId.length > 0 &&
    verdict.temperature === 0
  );
}

/** Build the resolved criterion for a pinned, applicable verdict. */
function resolvePinned(
  placeholder: ScorecardCriterion,
  verdict: JudgeVerdict,
): ScorecardCriterion {
  const judged =
    verdict.result === RowResult.Pass || verdict.result === RowResult.Fail
      ? verdict.result
      : RowResult.Skip;
  const base = `pinned judge '${verdict.modelId}' (temp=0) -> ${judged}`;
  return {
    ...placeholder,
    result: judged,
    detail: verdict.detail ? `${base}; ${verdict.detail}` : base,
  };
}

/** Build the skip+defect criterion for a rejected (non-pinned) verdict. */
function rejectNonPinned(
  placeholder: ScorecardCriterion,
  verdict: JudgeVerdict,
): ScorecardCriterion {
  const reason =
    verdict.modelId == null || verdict.modelId.length === 0
      ? "missing modelId"
      : `temperature=${String(verdict.temperature)} (!= 0)`;
  return {
    ...placeholder,
    // C-PIN: a non-pinned judge can NEVER produce a pass — force skip.
    result: RowResult.Skip,
    detail:
      `DETERMINISM DEFECT: verdict is not pinned (${reason}); ` +
      "a non-pinned judge can never produce a pass — staying skip",
  };
}

/**
 * Apply caller-supplied judge verdicts to the scorecard rows.
 *
 * @param rows       scorecard rows in matrix order (deterministic + judge).
 * @param verdictMap rowKey -> verdict, keyed via `rowKey(componentId, idx)`.
 * @param _judgePin  reserved: a future global pin assertion hook. Per-verdict
 *                   pinning (modelId + temp=0) is the enforced contract today.
 */
export function applyJudgeVerdicts(
  rows: DeterministicRowResult[],
  verdictMap: JudgeVerdictMap,
  _judgePin?: { modelId: string; temperature: number },
): DeterministicRowResult[] {
  // Per-component running index -> the stable rowKey for each judge row.
  const perComponentIndex = new Map<string, number>();

  return rows.map((r) => {
    const idx = perComponentIndex.get(r.componentId) ?? 0;
    perComponentIndex.set(r.componentId, idx + 1);

    // Deterministic-track rows pass through UNTOUCHED.
    if (r.criterion.track !== Track.Judge) {
      return { componentId: r.componentId, criterion: { ...r.criterion } };
    }

    const key = rowKey(r.componentId, idx);
    const verdict = verdictMap[key];

    // No verdict -> the judge never fabricates -> stay skip (untouched).
    if (verdict == null) {
      return { componentId: r.componentId, criterion: { ...r.criterion } };
    }

    const criterion = isPinned(verdict)
      ? resolvePinned(r.criterion, verdict)
      : rejectNonPinned(r.criterion, verdict);

    return { componentId: r.componentId, criterion };
  });
}
