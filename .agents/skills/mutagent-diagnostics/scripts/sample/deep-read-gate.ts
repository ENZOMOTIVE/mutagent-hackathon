/**
 * scripts/sample/deep-read-gate.ts
 * R2.1 + W9-07/W9-09 — mandatory LLM deep-read REFUSAL predicate + auto-expand +
 * too-thin guard.
 * Type A — Pure Script (deterministic; NO clock/random/LLM/I-O).
 *
 * THE CORE R2.1 INVARIANT: a fresh run that read ZERO traces with the LLM and has
 * NO prior signals to lean on MUST be REFUSED. Tier-0 alone can only MEASURE cheap
 * signals (latency, error counts) — shipping a diagnosis off Tier-0 only is the
 * exact methodology blind-spot Wave-6 fixes. Fail-loud, never graceful-degrade.
 *
 * REFUSE  ⟺  llmReadCount === 0  &&  !priorSignalsRef
 *   - llmReadCount: traces actually deep-read by the LLM this run.
 *   - priorSignalsRef (R2.3): a reference into the class-memory library. When a
 *     prior signal record exists for this entity, the refusal is DOWNGRADED to a
 *     proceed-with-note (library priors substitute for a fresh deep-read).
 *
 * --focus runs (R2.6) BYPASS the auto-pick but NOT the floor/caps and NOT this
 * refusal — a focused run with zero LLM reads and no priors is still refused.
 *
 * AUTO-EXPAND: when the representativeness confidence (R2.5) is below 70%, the
 * sampler should auto-expand the deep-read sample (pull more traces, re-prove)
 * UNLESS a cap already tripped. This module only decides; the caller acts.
 *
 * W9-07/W9-09 TOO-THIN GUARD: when population >= 1000 AND llmReadCount < 100, the
 * verdict carries a `tooThin: true` marker (laziness violation, R-AL-2). The run is
 * NOT refused (the existing zero-refuse spirit is preserved) but the renderer MUST
 * surface a warning banner. A `coverageWarning` string is also populated.
 *
 * W17-D2 SELF-DIAG EXEMPTION: the default self-diag mode reads the single ongoing
 * session (1 session = 1 trace). A population-coverage too-thin banner there is
 * meaningless, so `isSelfDiagSingleSession` SUPPRESSES the banner (records
 * `tooThinExempted: true` for the audit trail). The exemption is for the
 * single-session DEFAULT only — self-diag may target many sessions on request, in
 * which case the caller does NOT set the flag and the banner fires normally.
 *
 * W17-D2 SELECTION-LEVEL DISCOVERY (BLOCK D2): the R2.1 "must deep-read" invariant
 * is also enforced at the SELECTION path (not just report-level). Before PRIMARY
 * selection (PR-049), when an entity has NO prior findings AND NO valid ledger
 * digests, a deep-read discovery pass is MANDATORY — selection off Tier-0 frequency
 * alone is forbidden. See evaluateSelectionDiscoveryGate(). Fail-loud (PR-035).
 */

export interface DeepReadGateInput {
  /** Traces deep-read by the LLM this run (includes awareness-layer traces). */
  llmReadCount: number;
  /** R2.3 — a reference into the class-memory library, when priors exist. */
  priorSignalsRef?: string;
  /** R2.6 — true when the operator scoped the run with --focus. */
  isFocusRun?: boolean;
  /**
   * W9-07/W9-09: Total traces in scope for this run.
   * Required for the too-thin guard (population >= 1000 && llmReadCount < 100).
   * When absent, the guard is skipped (backward-compatible).
   */
  population?: number;
  /**
   * W17-D2 (operator self-diag exemption): true when this run is a single-session
   * self-diagnosis — the default self-diag mode reads the single ongoing session
   * (1 session = 1 trace), where a too-thin "you only read N of a large stack"
   * banner is meaningless (the stack IS one session by design). When true, the
   * too-thin banner is EXEMPTED (suppressed) even on a nominally large population.
   *
   * Self-diag MAY target many sessions on request; this exemption is for the
   * single-session DEFAULT only — callers set it explicitly, it never auto-fires.
   * Refusal (R2.1) and selection-level discovery (BLOCK D2) are NOT exempted —
   * only the population-coverage too-thin warning.
   */
  isSelfDiagSingleSession?: boolean;
}

export type DeepReadVerdict = "refuse" | "proceed" | "proceed-with-priors";

/**
 * W9-07/W9-09: Minimum LLM read count for a large stack (population >= 1000).
 * A run on a large stack that reads fewer traces than this is flagged as too-thin.
 * R-AL-2: a 2K-trace run stopping at < 100 is a laziness violation.
 */
export const TOO_THIN_THRESHOLD = 100;

/**
 * W9-07/W9-09: Minimum population size that activates the too-thin guard.
 * Stacks below this threshold are considered small and exempt from the guard.
 */
export const TOO_THIN_POPULATION_MIN = 1000;

export interface DeepReadGateResult {
  verdict: DeepReadVerdict;
  /** True when the run must be REFUSED (verdict === "refuse"). */
  refused: boolean;
  /** Operator-facing explanation (rendered as a banner when refused). */
  reason: string;
  /**
   * W9-07/W9-09: True when the run has a large stack (population >= 1000) but
   * read fewer than TOO_THIN_THRESHOLD traces. Laziness violation (R-AL-2).
   * Never causes a refusal — this is a warning flag only. The renderer MUST
   * surface a banner when this is true.
   */
  tooThin?: boolean;
  /**
   * W9-07/W9-09: Human-readable coverage warning for the renderer.
   * Populated when tooThin === true. Absent otherwise.
   */
  coverageWarning?: string;
  /**
   * W17-D2: true when the too-thin guard WOULD have fired (large population, thin
   * reads) but was EXEMPTED because this is a single-session self-diag run. Lets the
   * caller log "exemption applied" without re-deriving the condition. Absent when no
   * exemption was needed (guard didn't trip, or population is small/absent).
   */
  tooThinExempted?: boolean;
}

/**
 * R2.1 refusal predicate (W9-07/W9-09 extended with too-thin guard).
 * Pure boolean logic over the gate input.
 *
 *   llmReadCount === 0 && !priorSignalsRef           → REFUSE
 *   llmReadCount === 0 && priorSignalsRef present     → proceed-with-priors
 *   llmReadCount > 0                                   → proceed
 *
 * --focus does NOT exempt a run from refusal (it only bypasses signal auto-pick).
 *
 * W9-07/W9-09 too-thin guard (applied to non-refused verdicts):
 *   population >= TOO_THIN_POPULATION_MIN && llmReadCount < TOO_THIN_THRESHOLD
 *   → verdict carries tooThin:true + coverageWarning (never causes a refusal).
 */
export function evaluateDeepReadGate(input: DeepReadGateInput): DeepReadGateResult {
  const { llmReadCount, priorSignalsRef, population, isSelfDiagSingleSession } = input;

  // W9-07/W9-09: compute the RAW too-thin condition before any early returns.
  const tooThinRaw =
    typeof population === "number" &&
    population >= TOO_THIN_POPULATION_MIN &&
    llmReadCount < TOO_THIN_THRESHOLD;

  // W17-D2 operator exemption: a single-session self-diag run reads the single
  // ongoing session (1 session = 1 trace) by design, so a population-coverage
  // too-thin banner is meaningless there. Suppress the banner but record that the
  // exemption was applied so the decision stays auditable. The exemption ONLY
  // touches the too-thin warning — never the R2.1 refusal or BLOCK D2 discovery.
  const tooThinExempted = tooThinRaw && isSelfDiagSingleSession === true;
  const tooThinFlag = tooThinRaw && !tooThinExempted;

  const tooThinWarning = tooThinFlag
    ? `⚠ TOO-THIN: population=${population} but only ${llmReadCount} trace(s) LLM-read ` +
      `(< ${TOO_THIN_THRESHOLD} required for stacks ≥ ${TOO_THIN_POPULATION_MIN}). ` +
      `Laziness violation (R-AL-2 / PR-048). Surface this banner in the report header.`
    : undefined;

  // Shared too-thin fragment merged into every non-... verdict below.
  const tooThinFields = {
    ...(tooThinFlag ? { tooThin: true, coverageWarning: tooThinWarning } : {}),
    ...(tooThinExempted ? { tooThinExempted: true } : {}),
  };

  if (llmReadCount > 0) {
    return {
      verdict: "proceed",
      refused: false,
      reason: `Deep-read satisfied — ${llmReadCount} trace(s) LLM-read this run.`,
      ...tooThinFields,
    };
  }

  // llmReadCount === 0 from here.
  if (priorSignalsRef && priorSignalsRef.trim().length > 0) {
    return {
      verdict: "proceed-with-priors",
      refused: false,
      reason:
        `No fresh LLM deep-read, but class-memory priors exist (${priorSignalsRef}). ` +
        `Proceeding on library priors (R2.3). Refusal downgraded.`,
      // Zero reads always means no fresh coverage; on large stacks tooThin may still
      // flag (unless self-diag-exempted) so callers can log the full picture.
      ...tooThinFields,
    };
  }

  // REFUSE — too-thin flag is irrelevant on a refused verdict, but still attach it
  // so callers can log the full picture.
  return {
    verdict: "refuse",
    refused: true,
    reason:
      "⛔ REFUSED — a fresh run must LLM-deep-read at least one trace. " +
      "llmReadCount===0 and no class-memory priors (priorSignalsRef) to lean on. " +
      "Tier-0 alone only MEASURES cheap signals — shipping a diagnosis off it is the " +
      "methodology blind-spot R2.1 forbids. Fail-loud (no graceful-degrade).",
    ...tooThinFields,
  };
}

/** R2.5 auto-expand threshold — below this confidence the sample expands. */
export const AUTO_EXPAND_BELOW_PCT = 70;

export interface AutoExpandDecision {
  /** True when the sample should be expanded and re-proven. */
  shouldExpand: boolean;
  reason: string;
}

/**
 * R2.1 auto-expand decision: when coverage confidence < 70% AND no cap has
 * tripped, the caller should widen the deep-read sample and recompute the proof.
 * Pure — returns the decision only.
 */
export function decideAutoExpand(coverageConfidence: number, aCapTripped: boolean): AutoExpandDecision {
  if (aCapTripped) {
    return {
      shouldExpand: false,
      reason: "A cap already tripped — cannot expand the sample (R2.1/D1). Emit with current coverage.",
    };
  }
  if (coverageConfidence < AUTO_EXPAND_BELOW_PCT) {
    return {
      shouldExpand: true,
      reason: `Coverage ${coverageConfidence.toFixed(1)}% < ${AUTO_EXPAND_BELOW_PCT}% — auto-expanding the deep-read sample.`,
    };
  }
  return {
    shouldExpand: false,
    reason: `Coverage ${coverageConfidence.toFixed(1)}% ≥ ${AUTO_EXPAND_BELOW_PCT}% — sample is sufficient.`,
  };
}

// ── BLOCK D2: selection-level mandatory deep-read discovery ───────────────────
//
// The R2.1 invariant (PR-035) historically lived at the REPORT level
// (evaluateDeepReadGate): a whole run with zero LLM reads and no priors is refused.
// But PRIMARY signal selection (PR-049) is a SEPARATE decision point — the skill
// picks WHICH signal/finding to surface BEFORE the report-level gate is even
// evaluated. If that selection runs off Tier-0 frequency alone (matchCount) with no
// deep-read behind it, the methodology blind-spot R2.1 forbids has merely moved
// upstream. BLOCK D2 closes that gap: the "must deep-read" enforcement reaches the
// selection path.
//
// MANDATORY-DISCOVERY predicate (fail-loud, consistent with PR-035):
//   priorFindingsCount === 0  &&  validLedgerDigestCount === 0   → discovery REQUIRED
//
//   - priorFindingsCount:      approved findings already in the class-memory library
//                              for this entity (store.hasPriors equivalent count).
//   - validLedgerDigestCount:  cross-run deep-read digests that PASS the validity
//                              filter (foldValidDigests: analyzerVersion +
//                              entityFingerprint + TTL). A STALE/invalid digest does
//                              NOT count — it cannot substitute for a fresh read.
//
// When BOTH are zero, there is no prior evidence to lean on, so primary selection
// MUST be preceded by a deep-read discovery pass. When EITHER is non-zero the priors
// substitute (R2.3 spirit) and discovery is not forced — selection may proceed.
//
// This module DECIDES only; the orchestrator (Step 4.5 / Step 6) acts on the verdict
// by routing through a discovery deep-read before primary selection.

export interface SelectionDiscoveryGateInput {
  /** Approved findings already recorded for this entity in the class-memory library. */
  priorFindingsCount: number;
  /**
   * Cross-run deep-read ledger digests for this entity that PASS the validity filter
   * (foldValidDigests: matching analyzerVersion + entityFingerprint, within TTL).
   * STALE/invalid digests MUST be excluded by the caller before passing this count.
   */
  validLedgerDigestCount: number;
}

export type SelectionDiscoveryVerdict = "discovery-required" | "priors-cover";

export interface SelectionDiscoveryGateResult {
  verdict: SelectionDiscoveryVerdict;
  /**
   * True when a deep-read discovery pass is MANDATORY before primary selection.
   * (verdict === "discovery-required"). The orchestrator must NOT run primary
   * selection until at least one trace has been deep-read this run.
   */
  mustDeepReadBeforeSelection: boolean;
  /** Operator-facing explanation (rendered as a banner / decision-log entry). */
  reason: string;
}

/**
 * BLOCK D2 — selection-level mandatory deep-read discovery gate (W17-D2).
 *
 * Extends the report-level R2.1 invariant (PR-035) to the PRIMARY-selection path
 * (PR-049). Pure boolean logic over two non-negative counts — no I/O, no clock.
 *
 *   priorFindingsCount === 0 && validLedgerDigestCount === 0  → discovery-required
 *   otherwise                                                  → priors-cover
 *
 * Fail-loud: negative counts are a programming error and throw rather than silently
 * coerce to "covered" (a defensive-zero would let a bad caller skip discovery — the
 * exact failure mode this gate exists to prevent).
 */
export function evaluateSelectionDiscoveryGate(
  input: SelectionDiscoveryGateInput
): SelectionDiscoveryGateResult {
  const { priorFindingsCount, validLedgerDigestCount } = input;

  if (
    !Number.isInteger(priorFindingsCount) ||
    !Number.isInteger(validLedgerDigestCount) ||
    priorFindingsCount < 0 ||
    validLedgerDigestCount < 0
  ) {
    throw new Error(
      "evaluateSelectionDiscoveryGate: counts must be non-negative integers " +
        `(got priorFindingsCount=${priorFindingsCount}, validLedgerDigestCount=${validLedgerDigestCount}). ` +
        "Fail-loud per PR-035 — refusing to guess discovery coverage."
    );
  }

  if (priorFindingsCount === 0 && validLedgerDigestCount === 0) {
    return {
      verdict: "discovery-required",
      mustDeepReadBeforeSelection: true,
      reason:
        "⛔ DISCOVERY REQUIRED — no prior findings and no valid ledger digests for " +
        "this entity. PRIMARY selection (PR-049) must NOT run off Tier-0 frequency " +
        "alone; a deep-read discovery pass is mandatory first (R2.1 / BLOCK D2). " +
        "Fail-loud (no select-then-justify).",
    };
  }

  return {
    verdict: "priors-cover",
    mustDeepReadBeforeSelection: false,
    reason:
      `Priors cover selection — ${priorFindingsCount} prior finding(s) + ` +
      `${validLedgerDigestCount} valid ledger digest(s) for this entity (R2.3). ` +
      "A fresh discovery pass is not forced before primary selection.",
  };
}

// ── CLI entrypoint (PRD-SO-05) ────────────────────────────────────────────────
//
// Usage:
//   bun scripts/cli/run.sh scripts/sample/deep-read-gate.ts \
//       --llmReadCount <n> \
//       [--population <n>] \              # A6: enables the too-thin guard (PR-048)
//       [--priorSignalsRef <ref>] \
//       [--isFocusRun] \
//       [--selfDiagSingleSession] \       # W17-D2: exempt the too-thin banner
//       [--priorFindingsCount <n>] \      # BLOCK D2: selection-discovery gate
//       [--validLedgerDigestCount <n>] \  # BLOCK D2: selection-discovery gate
//       [--output <file>]
//
// Writes a JSON envelope (report-level result + optional selection result) to
// --output (stdout when omitted). The selection block is emitted whenever EITHER
// selection count flag is present.

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const args = process.argv.slice(2);

  function argVal(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  }

  const llmReadCount = Number(argVal("--llmReadCount") ?? "0");
  const priorSignalsRef = argVal("--priorSignalsRef");
  const isFocusRun = args.includes("--isFocusRun");
  // A6 (folded-in): wire --population so the too-thin guard can actually compute.
  // Absent → undefined → guard skipped (backward-compatible).
  const populationArg = argVal("--population");
  const population = populationArg !== undefined ? Number(populationArg) : undefined;
  // W17-D2: operator self-diag exemption for the too-thin banner.
  const isSelfDiagSingleSession = args.includes("--selfDiagSingleSession");
  const outputPath = argVal("--output");

  const result = evaluateDeepReadGate({
    llmReadCount,
    priorSignalsRef,
    isFocusRun,
    population,
    isSelfDiagSingleSession,
  });

  // BLOCK D2: selection-level discovery gate is evaluated only when the caller
  // supplies selection counts (keeps the report-level invocation backward-compatible).
  const hasSelectionInput =
    argVal("--priorFindingsCount") !== undefined ||
    argVal("--validLedgerDigestCount") !== undefined;

  let selection: SelectionDiscoveryGateResult | undefined;
  if (hasSelectionInput) {
    selection = evaluateSelectionDiscoveryGate({
      priorFindingsCount: Number(argVal("--priorFindingsCount") ?? "0"),
      validLedgerDigestCount: Number(argVal("--validLedgerDigestCount") ?? "0"),
    });
  }

  const envelope = {
    ...result,
    ...(selection ? { selection } : {}),
    input: {
      llmReadCount,
      priorSignalsRef,
      isFocusRun,
      population,
      isSelfDiagSingleSession,
      ...(hasSelectionInput
        ? {
            priorFindingsCount: Number(argVal("--priorFindingsCount") ?? "0"),
            validLedgerDigestCount: Number(argVal("--validLedgerDigestCount") ?? "0"),
          }
        : {}),
    },
  };

  const json = JSON.stringify(envelope, null, 2);
  if (outputPath) {
    writeFileSync(resolve(outputPath), json, "utf-8");
    console.info(`deep-read-gate result written to ${outputPath}`);
  } else {
    console.info(json);
  }

  // Exit non-zero when the report-level run is refused OR a selection-discovery
  // deep-read is mandatory but not yet satisfied — orchestrators detect either gate.
  const gateFailed = result.refused || selection?.mustDeepReadBeforeSelection === true;
  process.exit(gateFailed ? 1 : 0);
}
