/**
 * scripts/run-evaluate.ts — P5: the real-engine `*evaluate` END-TO-END runner.
 * ---------------------------------------------------------------------------
 * The HEADLINE path, WIRED (not re-implemented). It COMPOSES the existing,
 * C-PIN-certified engine into the full spine the dogfood (M6) bypassed when it
 * hand-rolled judge packets:
 *
 *   PREP       prepMatrixPackets : buildMatrixPacket → writeMatrixPacket  (one
 *              DATA packet per trajectory; NO hand-rolled packets)
 *   DISPATCH   [parent session] : fan out #mode-judge-trajectory leaves — each
 *              scores the WHOLE matrix for ONE trajectory, writes a verdict file.
 *              Sub-agents cannot dispatch sub-agents, so the PARENT runs this;
 *              the runner is split PREP | AGGREGATE around it.
 *   AGGREGATE  aggregateEvaluate : FAIL-LOUD readiness gate (missingMatrixVerdicts
 *              → THROW; never roll up a partial) → readMatrixVerdictFiles →
 *              aggregateMatrixScorecard → GATE + variance → EV-051 route failures.
 *
 * C-PIN: `maskedScorecard` is the byte-identity artifact — two runs on the same
 * verdict files produce a BYTE-IDENTICAL masked scorecard. JUDGE-ONLY (EV-051):
 * failing criteria are ROUTED to a diagnostics HandoverBundle — NEVER fixed here.
 *
 * COMPOSE-ONLY: this module calls matrix-judge.ts / evaluate.ts / route-failures.ts
 * / mask.ts unchanged. It re-implements nothing — the engine is C-PIN-certified.
 * PURE except for the fs the composed fns already do (read/write packet+verdict
 * files); no clock/random/network (handover provenance is INJECTED, not read).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateMatrixScorecard,
  assessTraceFidelity,
  buildMatrixPacket,
  consolidateByLocus,
  estimateMatrixPacketTokens,
  matrixVerdictFileName,
  packetFileName,
  planAdaptivePackets,
  readMatrixVerdictFiles,
  synthesizeIncompleteVerdictFile,
  tier0PrePass,
  writeMatrixPacket,
  writeMatrixVerdictFile,
  type AdaptiveKOptions,
  type LocusCluster,
  type PacketGroup,
  type Tier0Result,
  type TraceFidelity,
} from "./matrix-judge.ts";
import { parseMatrixVerdictFile, type MatrixVerdictFile, type SubjectProfile } from "./contracts/eval-matrix.ts";
import { assessEmitCompleteness, type EmitCompleteness } from "./emit-completeness.ts";
import type { VerifierSignal } from "./result-verify.ts";
import { reportDir } from "./artifact-paths.ts";
import {
  buildEvalReportInput,
  fromMatrixCriteria,
  renderEvalReport,
} from "./render-eval-report.ts";
import { maskedCanonicalJson } from "./mask.ts";
import {
  calibrationItems,
  routeFailures,
  type ArtifactRef,
  type CalibrationItem,
  type FailureRef,
  type HandoverBundle,
  type SubjectKindValue,
} from "./route-failures.ts";
import { packetsDir, verdictsDir } from "./artifact-paths.ts";
import {
  CriterionFlag,
  type CriterionVerdict,
  type GroundingReadiness,
  type IndependentVerifyRecord,
} from "./contracts/eval-types.ts";
import type { MatrixCriterion } from "./contracts/eval-matrix.ts";
import type { Scorecard } from "./evaluate.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";

/** The pinned envelope every packet carries (C-PIN; model-intent-sacred). */
export interface PinnedEnvelope {
  model: string;
  temperature: 0;
}

export interface EvaluateRunInput {
  subject: { kind: SubjectKindValue; name: string; path: string };
  /** the agent sessions under evaluation (one packet each). */
  trajectories: EvalTrace[];
  /** the WHOLE eval matrix every trajectory is scored against. */
  criteria: MatrixCriterion[];
  /**
   * §9.4.4 M1 — the SUBJECT PROFILE (identity·purpose·tools·skill·scope) carried
   * into EVERY judge packet so the judge knows who the agent is before it judges.
   * GIVEN (code access) or RECONSTRUCTED from the trace batch (`buildSubjectProfile`).
   * ABSENT ⇒ byte-stable legacy packets (the judge reconstructs at reason-time).
   */
  subjectProfile?: SubjectProfile;
  pin: PinnedEnvelope;
  /** where PREP writes packet files. */
  packetDir: string;
  /** where the dispatched #mode-judge-trajectory leaves wrote verdict files. */
  verdictDir: string;
  gatingSeverities?: string[];
  /**
   * T3 — the dispatched independent-verifier signals (criterionId → VerifierSignal)
   * + the situation, applied DOWNGRADE-ONLY to gating fails. ABSENT ⇒ self-verify
   * only (byte-stable). The parent PREPs the 2nd-judge tasks (`prepIndependentVerifyTasks`),
   * dispatches the REFUTE leaves, collects their signals, and passes them here.
   */
  independentVerify?: { situation: EvalTrace[]; signals: Record<string, VerifierSignal> };
  /** INJECTED provenance for the EV-051 handover — never a self-read clock. */
  producedBy: string;
  producedAt: string;
  /** the artifacts that cross the diagnose boundary (e.g. the scorecard ref). */
  artifacts?: ArtifactRef[];
}

// ── T1 tier-0 plan ────────────────────────────────────────────────────────────

/** One trajectory's tier-0 plan: the trace, its deterministic code verdicts, the
 *  residual judge rows still needing dispatch, and its EXAMINE fidelity gate. */
export interface Tier0PlanEntry extends Tier0Result {
  trace: EvalTrace;
  /** §9.4.2 node 1 — the deterministic fidelity gate. `complete:false` ⇒ INCOMPLETE
   *  (no residual rows are dispatched; a synthesized INCOMPLETE verdict is emitted). */
  fidelity: TraceFidelity;
}

/**
 * Run the tier-0 deterministic pre-pass over every trajectory (PURE — `tier0PrePass`
 * is a pure function of (criteria, trace)). The plan is the SINGLE source of truth
 * for PREP (which residual rows to dispatch), AGGREGATE (which code verdicts to fold),
 * and the #3 fidelity gate (which trajectories are INCOMPLETE). Default (no
 * `checkMethod`, no truncation): every row is residual, zero code verdicts →
 * byte-identical to the legacy path.
 *
 * #3 EXAMINE fidelity gate (§9.4.2 node 1): a trace flagged INCOMPLETE by
 * `assessTraceFidelity` (truncated / structurally-empty) SHORT-CIRCUITS — it gets
 * ZERO residual criteria (never dispatched the full criteria walk) and ZERO code
 * verdicts; PREP emits a synthesized INCOMPLETE verdict for it instead.
 */
export function tier0Plan(input: EvaluateRunInput): Tier0PlanEntry[] {
  return input.trajectories.map((trace) => {
    const fidelity = assessTraceFidelity(trace);
    if (!fidelity.complete) {
      // node-1 short-circuit: never walk a truncated trace per-criterion.
      return { trace, fidelity, codeVerdicts: [], residualCriteria: [] };
    }
    return { trace, fidelity, ...tier0PrePass(input.criteria, trace) };
  });
}

/** The trajectory ids that still need a dispatched judge verdict (COMPLETE trace ∧
 *  residual rows > 0). Fully code-decided AND truncated (INCOMPLETE) trajectories are
 *  excluded — they get no packet dispatched. */
export function judgeTrajectoryIds(input: EvaluateRunInput): string[] {
  return tier0Plan(input)
    .filter((e) => e.fidelity.complete && e.residualCriteria.length > 0)
    .map((e) => e.trace.id);
}

/** The trajectory ids the #3 fidelity gate flagged INCOMPLETE (truncated / empty).
 *  Each gets a synthesized INCOMPLETE verdict at PREP — never a dispatched judge. */
export function incompleteTrajectoryIds(input: EvaluateRunInput): string[] {
  return tier0Plan(input)
    .filter((e) => !e.fidelity.complete)
    .map((e) => e.trace.id);
}

/**
 * T5 — the adaptive-K dispatch PLAN (the overload guard) over the tier-0 residual
 * judge trajectories. DEFAULT (maxK=1) ⇒ one singleton group per trajectory (the
 * headline 1:1 path). With maxK>1 + a token budget, same-cohort trajectories that
 * FIT are batched (1:K); a trajectory that alone exceeds the budget is an
 * `overBudget` singleton (never batched). The estimate uses the RESIDUAL criteria
 * (post tier-0). PURE — the plan is computed, never mutated. NOTE: the actual
 * dispatch packet stays single-trajectory (the `MatrixPacket` contract); this plan
 * is the budget/isolation guard that decides WHEN batching is even safe.
 */
export function adaptivePacketPlan(input: EvaluateRunInput, opts: AdaptiveKOptions = {}): PacketGroup[] {
  const items = tier0Plan(input)
    .filter((e) => e.residualCriteria.length > 0)
    .map((e) => ({
      trajectoryId: e.trace.id,
      estTokens: estimateMatrixPacketTokens(e.residualCriteria, e.trace),
    }));
  return planAdaptivePackets(items, opts);
}

// ── PREP ────────────────────────────────────────────────────────────────────

/**
 * PREP: build + write one MatrixPacket per trajectory via `buildMatrixPacket`
 * (which asserts the packet shape). NO hand-rolled packets. T1: the packet carries
 * ONLY the tier-0 RESIDUAL judge rows; a fully code-decided trajectory is skipped
 * (no packet, no dispatch). Returns the trajectory ids that were PREPped (the
 * dispatch keys). PURE except the packet-file writes.
 *
 * #3 EXAMINE fidelity gate (§9.4.2 node 1): a trajectory flagged INCOMPLETE is NEVER
 * dispatched the full criteria walk — PREP writes a synthesized INCOMPLETE verdict
 * file for it directly into `verdictDir` (deterministic, no judge tokens) and skips
 * the packet. The returned ids are the DISPATCH keys only (complete + residual > 0).
 */
export function prepMatrixPackets(input: EvaluateRunInput): string[] {
  const ids: string[] = [];
  for (const entry of tier0Plan(input)) {
    if (!entry.fidelity.complete) {
      // #3 short-circuit: emit the synthesized INCOMPLETE verdict (no dispatch).
      writeMatrixVerdictFile(
        input.verdictDir,
        synthesizeIncompleteVerdictFile(entry.trace, input.criteria, input.pin, entry.fidelity),
      );
      continue;
    }
    if (entry.residualCriteria.length === 0) continue; // fully code-decided
    // §9.4.4 M1 — carry the subject profile into every packet (ABSENT ⇒ byte-stable).
    const packet = buildMatrixPacket(
      input.subject.name,
      entry.trace,
      entry.residualCriteria,
      input.pin,
      input.subjectProfile,
    );
    ids.push(writeMatrixPacket(input.packetDir, packet));
  }
  return ids;
}

/** Test/verify helper: do all PREPped packet files exist on disk? PURE fs read. */
export function parseMatrixPacketsExist(packetDir: string, trajectoryIds: string[]): boolean {
  return trajectoryIds.every((id) => existsSync(join(packetDir, packetFileName(id))));
}

// ── Readiness gate (fail-loud) ──────────────────────────────────────────────

/**
 * Which trajectory verdict files are still MISSING from `verdictDir`. An empty
 * array means every dispatched #mode-judge-trajectory leaf has a collected
 * verdict → safe to roll up. The matrix-path analogue of `missingVerdictKeys`.
 * PURE fs read.
 */
export function missingMatrixVerdicts(verdictDir: string, trajectoryIds: string[]): string[] {
  return trajectoryIds.filter((id) => !existsSync(join(verdictDir, matrixVerdictFileName(id))));
}

// ── AGGREGATE ───────────────────────────────────────────────────────────────

export interface EvaluateRunResult {
  scorecard: Scorecard;
  /** the folded per-criterion verdict (for the report's ✓/✗ table). */
  verdicts: CriterionVerdict[];
  /** the EV-051 diagnostics handover for failing criteria; null when none failed. */
  handover: HandoverBundle | null;
  /** GA — indeterminate CRIT/HIGH criteria routed to the CALIBRATION loop (not
   *  diagnostics): re-ground / operator-ratify / re-scope by blockedBy.kind. */
  calibration: CalibrationItem[];
  /** T4 — failing criteria CONSOLIDATED by shared root locus (1 finding, N symptoms). */
  lociClusters: LocusCluster[];
  trajectoryIds: string[];
  /** #3 — trajectory ids the EXAMINE fidelity gate flagged INCOMPLETE (truncated /
   *  empty): never dispatched the full criteria walk; a synthesized INCOMPLETE
   *  verdict was emitted instead. Visible + auditable. */
  incompleteTrajectories: string[];
  /** #6 (T3) — the AUDITABLE independent-verify ledger (one record per gating fail
   *  that went through the 2nd-judge refutation; upheld or downgraded). EMPTY when
   *  no independent-verify pass ran. */
  independentVerify: IndependentVerifyRecord[];
  /** UI-12-A — GA-1 grounding-capture readiness over the final folded verdicts.
   *  `warning` is set (and logged loudly) on the silent-capture regression (decided
   *  verdicts present, zero carry refs). ADVISORY — never gates the run. */
  groundingReadiness: GroundingReadiness;
  /** WS-1 — judge EMIT-CONTRACT completeness over the dispatched verdicts (how many
   *  complete-fidelity verdicts carry M2+M3+agentSteps+judgeSteps). `warning` is set
   *  + logged loudly when a required walk field is wholly dropped. ADVISORY — feeds
   *  the §5 Self-Eval Emit-Completeness panel; never gates the run. */
  emitCompleteness: EmitCompleteness;
}

/**
 * AGGREGATE: the fail-loud readiness gate → read the dispatched verdict files →
 * `aggregateMatrixScorecard` (GATE + variance, C-PIN PURE) → EV-051 route failing
 * criteria to a diagnostics HandoverBundle. THROWS if any trajectory verdict is
 * missing (never rolls up a partial scorecard). JUDGE-ONLY: no remedy is emitted.
 */
export function aggregateEvaluate(input: EvaluateRunInput): EvaluateRunResult {
  // T1 — the tier-0 plan decides which trajectories need a dispatched judge verdict
  // (residual rows > 0) vs are fully code-decided (no verdict file expected).
  const plan = tier0Plan(input);
  const dispatchedIds = plan.filter((e) => e.residualCriteria.length > 0).map((e) => e.trace.id);

  // (2) FAIL-LOUD readiness gate — every DISPATCHED verdict must be collected (a
  // fully code-decided trajectory is excluded; it never produced a packet/verdict).
  const missing = missingMatrixVerdicts(input.verdictDir, dispatchedIds);
  if (missing.length > 0) {
    throw new Error(
      `aggregateEvaluate: ${missing.length} trajectory verdict file(s) MISSING ` +
        `(${missing.join(", ")}). FAIL-LOUD readiness gate — never roll up a partial ` +
        "scorecard. PREP packets → dispatch #mode-judge-trajectory → collect ALL verdict " +
        "files before AGGREGATE.",
    );
  }

  const verdictFilesRaw = readMatrixVerdictFiles(input.verdictDir, dispatchedIds);
  // T1 — the tier-0 code verdicts folded into the SAME per-criterion aggregation.
  const codeVerdictsByTrajectory = plan
    .filter((e) => e.codeVerdicts.length > 0)
    .map((e) => ({ trajectoryId: e.trace.id, verdicts: e.codeVerdicts }));
  const { scorecard, verdicts, independentVerify, groundingReadiness } = aggregateMatrixScorecard({
    criteria: input.criteria,
    verdictFilesRaw,
    ...(codeVerdictsByTrajectory.length > 0 ? { codeVerdictsByTrajectory } : {}),
    ...(input.independentVerify !== undefined ? { independentVerify: input.independentVerify } : {}),
    ...(input.gatingSeverities !== undefined ? { gatingSeverities: input.gatingSeverities } : {}),
  });
  const trajectoryIds = input.trajectories.map((t) => t.id);

  // (4b) UI-12-A — LOUD readiness assert: surface the GA-1 silent-capture regression
  // prominently (a logged assertion) without hard-failing the run. The judge SHOULD
  // emit refs[]{obs,path,value} per decided verdict; a 0-grounded batch is a defect.
  if (groundingReadiness.warning !== undefined) {
    console.warn(`[readiness-assert] ${groundingReadiness.warning}`);
  } else if (groundingReadiness.decidedCount > 0) {
    console.info(
      `[readiness-assert] GA-1 grounding OK: ${groundingReadiness.groundedCount}/` +
        `${groundingReadiness.decidedCount} decided verdicts grounded ` +
        `(${groundingReadiness.groundedPctOfDecided}%).`,
    );
  }

  // (4c) WS-1 — judge EMIT-CONTRACT completeness: loudly surface a dropped §9.4 walk
  // (M2/M3/agentSteps/judgeSteps) so the Trajectory + Self-Eval tabs are HONEST about
  // coverage. Advisory — never gates the run; computed over the COMPLETE-fidelity
  // dispatched verdicts (INCOMPLETE traces legitimately skip the walk).
  const emitCompleteness = assessEmitCompleteness(verdictFilesRaw.map(parseVerdictFileForReport));
  if (emitCompleteness.warning !== undefined) {
    console.warn(`[emit-contract] ${emitCompleteness.warning}`);
  } else if (emitCompleteness.eligible > 0) {
    console.info(
      `[emit-contract] judge-walk completeness: ${emitCompleteness.completeEmits}/` +
        `${emitCompleteness.eligible} complete-fidelity verdicts carry M2+M3+agentSteps+judgeSteps ` +
        `(${emitCompleteness.completePct}%).`,
    );
  }

  // (5) EV-051 — route failing criteria to a diagnostics handover (NEVER fix).
  const verdictById = new Map(verdicts.map((v) => [v.criterionId, v]));
  const failures: FailureRef[] = scorecard.gate.failedCriteria.map((fc) => {
    const v = verdictById.get(fc.criterionId);
    const ref: FailureRef = {
      criterionId: fc.criterionId,
      severity: fc.severity,
      // eval-matrix failures are behavioral eval-worthy judgments (infra fixables
      // are flagged upstream at *discover); routed for root-cause, never fixed here.
      flag: CriterionFlag.EvalWorthy,
      traceId: v?.traceId ?? "(suite)",
      result: v?.result ?? "fail",
      critique: v?.critique ?? "(no critique)",
    };
    // GA — NO silent drop: carry the indeterminate's blockedBy for calibration routing.
    if (v?.blockedBy !== undefined) ref.blockedBy = v.blockedBy;
    return ref;
  });
  // GA — only true FAILs become a diagnostics handover; indeterminates route to
  // the calibration loop (partitioned inside routeFailures / calibrationItems).
  const diagnoseFailures = failures.filter((f) => f.result === "fail");
  const handover =
    diagnoseFailures.length > 0
      ? routeFailures({
          subject: input.subject,
          failures: diagnoseFailures,
          artifacts: input.artifacts ?? [],
          producedBy: input.producedBy,
          producedAt: input.producedAt,
        })
      : null;
  const calibration = calibrationItems(failures);

  // T4 — consolidate the failing criteria by their shared root locus (read off the
  // dispatched judge walks). A fully-code-decided run has no walks ⇒ each fail is
  // its own `unlocalized:<id>` cluster (never falsely merged).
  const failingVerdicts = verdicts.filter((v) => v.result === "fail");
  const lociClusters =
    failingVerdicts.length > 0
      ? consolidateByLocus(failingVerdicts, readRunVerdictFiles(input))
      : [];

  return {
    scorecard,
    verdicts,
    handover,
    calibration,
    lociClusters,
    trajectoryIds,
    incompleteTrajectories: incompleteTrajectoryIds(input),
    independentVerify,
    groundingReadiness,
    emitCompleteness,
  };
}

/** The C-PIN byte-identity artifact: the masked canonical scorecard. */
export function maskedScorecard(scorecard: Scorecard): string {
  return maskedCanonicalJson(scorecard);
}

// ── REPORT (D-2/D-3) — render the 5-tab HTML eval-report from the run ─────────

/**
 * WS-1 — parse a verdict file for the REPORT path WITHOUT dropping the rich §9.4
 * judge-walk additive fields. The strict `parseMatrixVerdictFile` rejects two
 * tolerant real-judge shapes that ride on EXACTLY the walk-bearing files:
 *   • `context.exitStates` emitted as a STRUCTURED object (e.g. `{steps: 7}`) where
 *     the schema allows only `string | string[]`, and
 *   • `subjectProfile` emitted WITHOUT `tools` (the schema marks it required).
 * On a strict-parse failure this coerces those two known shapes and re-validates; if
 * it STILL fails it falls back to the raw parsed object so the report binds the rich
 * judge reasoning rather than crashing/silently dropping the trajectory. The data
 * leak this closes: the rich verdict files (which carry the judge_steps walk + per-
 * criterion critique) were precisely the ones strict-parse threw on, so the §2
 * "How the Judge Reasoned" view rendered with the rich traces MISSING. JUDGE-ONLY,
 * read-only: no verdict content is altered beyond the two structural coercions.
 */
function parseVerdictFileForReport(raw: string): MatrixVerdictFile {
  try {
    return parseMatrixVerdictFile(raw);
  } catch {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const ctx = obj.context as { exitStates?: unknown } | undefined;
    if (ctx && ctx.exitStates !== null && typeof ctx.exitStates === "object" && !Array.isArray(ctx.exitStates)) {
      ctx.exitStates = Object.entries(ctx.exitStates as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    }
    const sp = obj.subjectProfile as { tools?: unknown } | undefined;
    if (sp && sp.tools === undefined) sp.tools = [];
    try {
      return parseMatrixVerdictFile(JSON.stringify(obj));
    } catch {
      // last resort — NEVER drop a rich verdict from the report over residual schema
      // drift; the renderer reads the additive fields defensively.
      return obj as unknown as MatrixVerdictFile;
    }
  }
}

/**
 * Read + parse the per-trajectory Judge-Agent verdict files for the run (the rich
 * §9.4 judge-walk fields, when emitted, ride along — `MatrixVerdictFile` carries
 * them as OPTIONAL additive fields). PURE fs read. THROWS via `readMatrixVerdictFiles`
 * if a verdict file is missing (the same fail-loud contract AGGREGATE uses).
 *
 * WS-1 — uses the TOLERANT `parseVerdictFileForReport` so the walk-bearing verdict
 * files (object `exitStates` / no `subjectProfile.tools`) reach the renderer instead
 * of being rejected by the strict schema (the rich-data-not-bound report leak).
 */
export function readRunVerdictFiles(input: EvaluateRunInput): MatrixVerdictFile[] {
  // T1 — the DISPATCHED trajectories (residual judge rows > 0) have a judge verdict
  // file; a fully code-decided trajectory produced none and is skipped. #3 — the
  // INCOMPLETE (truncated) trajectories carry a synthesized INCOMPLETE verdict file
  // emitted at PREP, included here so the report shows them (they fold nothing).
  const ids = [...judgeTrajectoryIds(input), ...incompleteTrajectoryIds(input)];
  return readMatrixVerdictFiles(input.verdictDir, ids).map(parseVerdictFileForReport);
}

/**
 * REPORT — build the rich `EvalReportInput` from the REAL run outputs (the folded
 * scorecard + per-criterion verdicts + the per-trajectory Judge-Agent verdict
 * files + the matrix criteria + the EV-051 handover) and render the 5-tab HTML
 * eval-report into `<reportDir>/report.html`. This is the wiring D-2/D-3 had been
 * MISSING: `*evaluate` produced a scorecard but emitted no report. The report
 * consumes the §9.4 judge-walk fields when present (side-by-side) and degrades to
 * the per-trajectory scorecard otherwise. Returns the written report path.
 *
 * Deterministic: the only non-deterministic input is `producedAt` (injected,
 * masked for byte-identity). PURE except the report-file write.
 */
export function writeRunReport(
  input: EvaluateRunInput,
  result: EvaluateRunResult,
  runId: string,
  cwd?: string,
): string {
  const matrixVerdictFiles = readRunVerdictFiles(input);
  const reportInput = buildEvalReportInput({
    subject: { name: input.subject.name, source: input.subject.kind },
    scorecard: result.scorecard,
    verdicts: result.verdicts,
    criteria: fromMatrixCriteria(input.criteria),
    matrixVerdictFiles,
    handover: result.handover,
    generatedAt: input.producedAt,
    // Gap A — pass the run's INGESTED traces so the report can source each
    // trajectory's RAW triggering INPUT (`EvalTrace.input.prompt`) by trace id.
    // The input is ground-truth in the trace (NOT a judge-emit field), so this
    // surfaces the initial input that fired the subject agent without any
    // judge-protocol change. ABSENT-tolerant (a row with no input renders "—").
    traces: input.trajectories,
    // §9.4.4 M1/R2 — carry the subject profile into the report (internal calibration).
    ...(input.subjectProfile !== undefined ? { subjectProfile: input.subjectProfile } : {}),
    // Overview provenance meta-strip — the run config (C-PIN: pinned judge model + temp 0).
    // The JUDGE substrate defaults to agent-dispatch (host runtime); the SOURCE is the
    // subject kind. The judge model is DISTINCT from any target model under eval.
    runConfig: {
      runId,
      date: input.producedAt,
      source: input.subject.kind,
      judgeSubstrate: "agent-dispatch",
      judgeModel: input.pin.model,
      temperature: input.pin.temperature,
      cPin: true,
    },
  });
  const dir = reportDir(runId, cwd);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "report.html");
  writeFileSync(outPath, renderEvalReport(reportInput));
  return outPath;
}

/**
 * #6 (T3) — persist the AUDITABLE independent-verify ledger as an on-disk artifact
 * (`<reportDir>/independent-verify.json`) so the second-judge refutation result is
 * inspectable outside the HTML report. Each record carries `{criterionId, upheld,
 * reason, byDifferentJudge:true, reviewerId?, leapKind?}`. Returns the written path
 * (or null when no independent-verify pass ran). PURE except the file write.
 */
export function writeIndependentVerifyLedger(
  result: EvaluateRunResult,
  runId: string,
  cwd?: string,
): string | null {
  if (result.independentVerify.length === 0) return null;
  const dir = reportDir(runId, cwd);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "independent-verify.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        byDifferentJudge: true,
        records: result.independentVerify,
        downgraded: result.independentVerify.filter((r) => !r.upheld).map((r) => r.criterionId),
        upheld: result.independentVerify.filter((r) => r.upheld).map((r) => r.criterionId),
      },
      null,
      2,
    ),
  );
  return outPath;
}

/**
 * P8 (EV-REQ-058) — fill MISSING `packetDir`/`verdictDir` from the localized
 * artifact resolver (`.mutagent-evaluator/runs/<runId>/{packets,verdicts}`). The
 * CLI default-wiring: a bare run lands under the namespaced dot-root (no
 * ad-hoc/scattered output paths). ADDITIVE — an explicitly-provided dir WINS;
 * the PURE core functions still take explicit dirs (this only fills the defaults).
 * PURE (runId + cwd passed in).
 */
export function withResolvedDirs(
  input: Omit<EvaluateRunInput, "packetDir" | "verdictDir"> & { packetDir?: string; verdictDir?: string },
  runId: string,
  cwd?: string,
): EvaluateRunInput {
  return {
    ...input,
    packetDir: input.packetDir ?? packetsDir(runId, cwd),
    verdictDir: input.verdictDir ?? verdictsDir(runId, cwd),
  };
}

// ── CLI entrypoint (the parent drives PREP, dispatches, then AGGREGATE) ──────
//
// prep:      bun scripts/run-evaluate.ts prep      <input.json>
// aggregate: bun scripts/run-evaluate.ts aggregate <input.json>
// `input.json` = an EvaluateRunInput. PREP writes packets; after the parent
// dispatches #mode-judge-trajectory and collects verdict files, AGGREGATE prints
// the GATE + variance summary + whether an EV-051 handover was emitted (secret-free).

declare const Bun: { argv: string[] } | undefined;

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const [mode, inputPath, runIdArg] = argv;
  if ((mode !== "prep" && mode !== "aggregate") || !inputPath) {
    console.error("usage: run-evaluate.ts <prep|aggregate> <input.json> [runId]");
    process.exit(2);
    return;
  }
  const { readFileSync } = await import("node:fs");
  const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as Omit<EvaluateRunInput, "packetDir" | "verdictDir"> & {
    packetDir?: string;
    verdictDir?: string;
  };
  // P8: a bare run (no packetDir/verdictDir in the input) DEFAULTS under the
  // localized dot-root `.mutagent-evaluator/runs/<runId>/{packets,verdicts}`.
  const runId = runIdArg ?? parsed.subject.name;
  const input = withResolvedDirs(parsed, runId);

  if (mode === "prep") {
    const ids = prepMatrixPackets(input);
    console.info(JSON.stringify({ prepped: ids.length, packetDir: input.packetDir, trajectoryIds: ids }, null, 2));
    process.exit(0);
    return;
  }
  const out = aggregateEvaluate(input);
  // REPORT (D-2/D-3): render the 5-tab HTML eval-report from the run. The
  // orchestrator fires the cross-platform auto-open command post-render.
  const reportPath = writeRunReport(input, out, runId);
  // #6 (T3): persist the auditable independent-verify ledger artifact (if any).
  const ivLedgerPath = writeIndependentVerifyLedger(out, runId);
  console.info(
    JSON.stringify(
      {
        trajectories: out.trajectoryIds.length,
        gate: { passed: out.scorecard.gate.passed, total: out.scorecard.gate.total, passCount: out.scorecard.gate.passCount, gatedBy: out.scorecard.gate.gatedBy },
        varianceCriteria: Object.keys(out.scorecard.variance).length,
        handoverEmitted: out.handover !== null,
        routedFailures: out.handover?.acceptance.criteria.length ?? 0,
        incompleteTrajectories: out.incompleteTrajectories,
        independentVerify: { records: out.independentVerify.length, ledger: ivLedgerPath },
        report: reportPath,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
