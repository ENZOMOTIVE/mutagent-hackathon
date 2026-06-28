/**
 * scripts/matrix-judge.ts — PREP + AGGREGATE for the EVAL-MATRIX × TRAJECTORY judging cell.
 * ---------------------------------------------------------------------------
 * The DEFAULT `*evaluate` judging path. The reasoning lives in the Judge Agent
 * (`assets/agents/eval-matrix-judge.md`); this file is **Type A — deterministic
 * only** (no judge prompt, no LLM call). It:
 *   PREP  — `buildMatrixPacket` / `writeMatrixPacket`: assemble one DATA packet
 *           per trajectory (the WHOLE matrix + that trajectory + transcript) for
 *           the parent to dispatch to a Judge Agent.
 *   AGGREGATE — `aggregateMatrixScorecard`: read the per-trajectory verdict files
 *           the Judge Agents wrote, fold each criterion's verdicts across
 *           trajectories into one GATE-gradable verdict + a per-trajectory
 *           variance view, and roll up via `evaluate.ts` (severity-gated GATE).
 *
 * Per-TRAJECTORY fan-out: one Judge Agent scores the whole matrix for one
 * session → high throughput across many sessions. Folding policy (binary GATE):
 * a criterion is PASS only if it passes on EVERY judged trajectory; any fail →
 * fail; else (no fail, ≥1 uncertain) → uncertain. The per-trajectory scores feed
 * the variance view. PURE — same inputs ⇒ identical scorecard.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertMatrixPacket,
  localizeText,
  parseMatrixVerdictFile,
  type MatrixCriterion,
  type MatrixPacket,
  type MatrixVerdict,
  type MatrixVerdictFile,
  type SubjectProfile,
  type TrajectoryStep,
  type TranscriptTurn,
} from "./contracts/eval-matrix.ts";
import {
  CheckMethod,
  OutcomeVerdict,
  type CriterionVerdict,
  type EvalTrace,
  type GroundingReadiness,
  type IndependentVerifyRecord,
  type OutcomeVerdictValue,
} from "./contracts/eval-types.ts";
import { runCodeEval, type CodeEvalSpec } from "./code-eval.ts";
import { promptHash, writeJudgeTask, type JudgeTaskSpec, type PinnedEnvelope } from "./agent-dispatch.ts";
import { verifyVerdict, type VerifierSignal } from "./result-verify.ts";
import { Severity, type SeverityValue } from "./contracts/types.ts";
import {
  rollupScorecard,
  type CriterionReruns,
  type GradedCriterion,
  type Scorecard,
} from "./evaluate.ts";

/** A stable, filename-safe key for a trajectory id (content hash; no clock/random). */
export function trajectoryKey(trajectoryId: string): string {
  return promptHash(trajectoryId, "trajectory");
}

export function packetFileName(trajectoryId: string): string {
  return `${trajectoryKey(trajectoryId)}.packet.json`;
}
export function matrixVerdictFileName(trajectoryId: string): string {
  return `${trajectoryKey(trajectoryId)}.verdict.json`;
}

/** Extract the ordered tool trajectory (DATA) from a trace. */
function trajectoryOf(trace: EvalTrace): TrajectoryStep[] {
  return trace.observations
    .filter((o) => o.type === "TOOL")
    .map((o) => ({
      name: o.name ?? "?",
      ...(o.input !== undefined ? { input: o.input } : {}),
      ...(o.output !== undefined ? { output: o.output } : {}),
    }));
}

/** Build the minimal transcript (DATA) from a trace's input/output. */
function transcriptOf(trace: EvalTrace): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const prompt = typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
  if (prompt.length > 0) turns.push({ role: "user", content: prompt });
  const resp = typeof trace.output?.response === "string" ? trace.output.response : "";
  if (resp.length > 0) turns.push({ role: "assistant", content: resp });
  return turns;
}

// ── T1 (B-U3) tier-0 deterministic pre-pass ──────────────────────────────────
//
// THE real cost lever (§9.4.1): run the code-method rows FIRST (deterministic,
// zero judge tokens, byte-identical), then dispatch ONLY the residual judge rows.
// A criterion routes by its OPTIONAL `checkMethod` (absent ⇒ `llm-judge`, so an
// all-judge matrix is byte-stable — every row stays in the packet):
//   - `deterministic` → CODE-EXEC in the pre-pass; NOT dispatched.
//   - `hybrid`        → CODE pre-filter in the pre-pass; if code FAILS the judge is
//                       GATED OFF (the code-fail IS the verdict); if code PASSES the
//                       row stays residual for the judge to confirm the subjective half.
//   - `llm-judge`/absent → residual (dispatched to the judge).
// FAIL-LOUD: a code-routed row with no `codeEval` spec THROWS (never silently judged).

/** One trajectory's tier-0 result: the deterministic code verdicts + the residual
 *  judge criteria that still need dispatching for THIS trajectory. PURE. */
export interface Tier0Result {
  codeVerdicts: MatrixVerdict[];
  residualCriteria: MatrixCriterion[];
}

function codeMethodOf(c: MatrixCriterion): "deterministic" | "llm-judge" | "hybrid" {
  return c.checkMethod ?? CheckMethod.LlmJudge;
}

/** Run one matrix row's extracted code-eval into a MatrixVerdict (confidence 1). */
function matrixCodeVerdict(c: MatrixCriterion, trace: EvalTrace): MatrixVerdict {
  if (c.codeEval === undefined) {
    throw new Error(
      `tier0PrePass: criterion '${c.criterionId}' is checkMethod=${codeMethodOf(c)} but carries ` +
        "no `codeEval` spec. Code-routed matrix rows REQUIRE an extracted code-eval; refusing to " +
        "silently LLM-judge a row typed as code (T1 / M1).",
    );
  }
  const code = runCodeEval(c.codeEval as CodeEvalSpec, trace);
  return {
    criterionId: c.criterionId,
    critique: code.detail,
    result: code.result === "pass" ? OutcomeVerdict.Pass : OutcomeVerdict.Fail,
    confidence: 1,
  };
}

/**
 * Tier-0 pre-pass for ONE trajectory: route every criterion by `checkMethod`,
 * run the code rows now, and return the residual judge rows. DETERMINISTIC +
 * PURE (the code-eval is a pure function of (spec, trace)); criteria order is
 * preserved so the residual packet + merged scorecard are byte-stable.
 */
export function tier0PrePass(criteria: MatrixCriterion[], trace: EvalTrace): Tier0Result {
  const codeVerdicts: MatrixVerdict[] = [];
  const residualCriteria: MatrixCriterion[] = [];
  for (const c of criteria) {
    const method = codeMethodOf(c);
    if (method === CheckMethod.LlmJudge) {
      residualCriteria.push(c);
      continue;
    }
    if (method === CheckMethod.Deterministic) {
      codeVerdicts.push(matrixCodeVerdict(c, trace));
      continue;
    }
    // hybrid — code pre-filter; fail short-circuits, pass falls through to the judge.
    const v = matrixCodeVerdict(c, trace);
    if (v.result === OutcomeVerdict.Fail) codeVerdicts.push(v);
    else residualCriteria.push(c);
  }
  return { codeVerdicts, residualCriteria };
}

// ── #3 (§9.4.2 node 1) EXAMINE fidelity gate — the DETERMINISTIC short-circuit ─
//
// The judge's node-1 fidelity gate says "a truncated trace EXITS early as
// INCOMPLETE — never fabricate a pass/fail from a partial trace." That gate must
// ACTUALLY short-circuit: a truncated trajectory is NEVER walked per-criterion.
// Where truncation is detectable BEFORE dispatch (an explicit ingestion marker, or
// a structurally-empty trace), the PIPELINE gates it deterministically — it emits a
// synthesized INCOMPLETE verdict and never dispatches the full criteria walk (no
// judge tokens spent reading a partial trace). PURE — no clock/random/network.

/** The deterministic EXAMINE fidelity verdict for one trace. */
export interface TraceFidelity {
  complete: boolean;
  reason?: string;
}

/**
 * Deterministic pre-judge fidelity gate (§9.4.2 node 1). A trace is INCOMPLETE iff
 * (a) the ingestion layer explicitly marked it `incomplete:true` (a truncated /
 * unterminated session), OR (b) it is STRUCTURALLY EMPTY — no observations AND no
 * `output.response` (literally nothing to judge). Conservative by design: anything
 * with a tool step OR a response is `complete` and judged normally (the judge's own
 * node-1 gate still catches subtler truncation at reason-time). PURE.
 */
export function assessTraceFidelity(trace: EvalTrace): TraceFidelity {
  if (trace.incomplete === true) {
    return {
      complete: false,
      reason:
        trace.incompleteReason ??
        "trace marked incomplete by the ingestion layer (truncated / unterminated session).",
    };
  }
  const hasObservations = trace.observations.length > 0;
  const hasResponse = typeof trace.output?.response === "string" && trace.output.response.length > 0;
  if (!hasObservations && !hasResponse) {
    return {
      complete: false,
      reason:
        "trace is structurally empty: no observations and no output.response — nothing to judge (truncated capture).",
    };
  }
  return { complete: true };
}

/**
 * Synthesize the INCOMPLETE `MatrixVerdictFile` for a truncated trajectory — the
 * deterministic node-1 short-circuit. Emits `fidelity.complete:false`, an EMPTY
 * `verdicts[]` (the per-criterion loop is SKIPPED — never a fabricated verdict from
 * a partial trace), a dense na/uncertain map (every criterion abstains), and a
 * capture-defect `localize`. This file is COLLECTED like a dispatched verdict so the
 * report shows the trajectory as INCOMPLETE — but it contributes NO criterion verdict
 * to the gate fold (empty `verdicts[]`). PURE.
 */
export function synthesizeIncompleteVerdictFile(
  trace: EvalTrace,
  criteria: MatrixCriterion[],
  pin: { model: string; temperature: 0 },
  fidelity?: TraceFidelity,
): MatrixVerdictFile {
  const fid = fidelity ?? assessTraceFidelity(trace);
  const reason = fid.reason ?? "trace truncated / unterminated — emitted INCOMPLETE.";
  const denseMap: Record<string, OutcomeVerdictValue | "na"> = {};
  for (const c of criteria) denseMap[c.criterionId] = OutcomeVerdict.Uncertain;
  return {
    trajectoryId: trace.id,
    judgeModel: pin.model,
    temperature: 0,
    fidelity: { complete: false, reason },
    judgeSteps: [
      {
        kind: "examine",
        text: `EXAMINE — fidelity gate (node 1): ${reason} STOP early: emitted INCOMPLETE, the per-criterion loop is SKIPPED (no fabricated verdict from a partial trace).`,
        anchor: 0,
      },
    ],
    verdicts: [],
    denseMap,
    localize: `Capture/fidelity defect (ROOT): ${reason} Not a subject behavioural defect — verdict is INCOMPLETE.`,
    health: { contextGathered: true, grounded: 0, assumed: 0, stoppedAtSymptom: false },
  };
}

/** PREP — write one synthesized/dispatched verdict file per trajectory into `dir`. */
export function writeMatrixVerdictFile(dir: string, file: MatrixVerdictFile): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, matrixVerdictFileName(file.trajectoryId)), JSON.stringify(file, null, 2));
  return file.trajectoryId;
}

// ── T5 (B-U4) adaptive-K + overload guard ────────────────────────────────────
//
// `prepMatrixPackets` is hardwired 1:1 (one packet per trajectory). T5 adds the
// CONTEXT-BUDGET ESTIMATOR + a K-BATCHER that groups trajectories into 1:K packets
// ONLY when they FIT a token budget AND stay ISOLATED (same cohort). DEFAULT K=1 →
// every trajectory is its own group → byte-identical to today. The OVERLOAD GUARD:
// a trajectory whose own estimate already exceeds the budget is NEVER batched
// (flagged `overBudget`); a batch is closed the moment the next trajectory would
// blow the budget. PURE — a rough chars/4 heuristic, no clock/random/network.

/** Rough context-token estimate of a one-trajectory matrix packet (chars/4). */
export function estimateMatrixPacketTokens(criteria: MatrixCriterion[], trace: EvalTrace): number {
  const criteriaChars = JSON.stringify(criteria).length;
  const trajChars = JSON.stringify(trajectoryOf(trace)).length;
  const transcriptChars = JSON.stringify(transcriptOf(trace)).length;
  return Math.ceil((criteriaChars + trajChars + transcriptChars) / 4);
}

/** One adaptive-K group: the trajectory ids batched into a single judging packet. */
export interface PacketGroup {
  trajectoryIds: string[];
  estTokens: number;
  /** true iff a SINGLE trajectory already exceeded the budget (never batched). */
  overBudget: boolean;
}

export interface AdaptiveKItem {
  trajectoryId: string;
  estTokens: number;
  /** the ISOLATION key — only same-key trajectories may share a group (default: the id → fully isolated). */
  isolationKey?: string;
}

export interface AdaptiveKOptions {
  /** max trajectories per packet. DEFAULT 1 (1:1 — the headline default). */
  maxK?: number;
  /** per-packet context-token budget. DEFAULT Infinity (no budget pressure). */
  tokenBudget?: number;
}

/**
 * Plan adaptive 1:K packet groups. Greedy, ORDER-PRESERVING: items accumulate into
 * a group while `group.length < maxK` AND the running estimate stays ≤ budget AND
 * the isolation key matches; otherwise a new group opens. An item that ALONE exceeds
 * the budget is its own `overBudget` singleton (the overload guard — never batched).
 * Default (maxK=1) ⇒ one singleton per item (byte-identical to the 1:1 path). PURE.
 */
export function planAdaptivePackets(items: AdaptiveKItem[], opts: AdaptiveKOptions = {}): PacketGroup[] {
  const maxK = Math.max(1, opts.maxK ?? 1);
  const budget = opts.tokenBudget ?? Number.POSITIVE_INFINITY;
  const groups: PacketGroup[] = [];
  let cur: { ids: string[]; est: number; key: string } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      groups.push({ trajectoryIds: cur.ids, estTokens: cur.est, overBudget: false });
      cur = null;
    }
  };
  for (const it of items) {
    const key = it.isolationKey ?? it.trajectoryId;
    // overload guard: a single item over budget is an un-batchable singleton.
    if (it.estTokens > budget) {
      flush();
      groups.push({ trajectoryIds: [it.trajectoryId], estTokens: it.estTokens, overBudget: true });
      continue;
    }
    const fits =
      cur !== null && cur.key === key && cur.ids.length < maxK && cur.est + it.estTokens <= budget;
    if (!fits) {
      flush();
      cur = { ids: [], est: 0, key };
    }
    cur!.ids.push(it.trajectoryId);
    cur!.est += it.estTokens;
  }
  flush();
  return groups;
}

/**
 * PREP — assemble one MatrixPacket (DATA) for a trajectory: the WHOLE matrix +
 * that trajectory's tool path + transcript. Validates the packet shape. PURE.
 *
 * T1: when `residualCriteria` is supplied (the tier-0 residual judge rows), the
 * packet carries ONLY those — the judge never re-scores a code-decided row. An
 * empty residual set means the trajectory is fully code-decided (no dispatch);
 * the caller skips PREP for it. ABSENT ⇒ the whole matrix (legacy, byte-stable).
 */
export function buildMatrixPacket(
  subject: string,
  trace: EvalTrace,
  criteria: MatrixCriterion[],
  pin: { model: string; temperature: 0 },
  subjectProfile?: SubjectProfile,
): MatrixPacket {
  const packet: MatrixPacket = {
    subject,
    trajectoryId: trace.id,
    criteria,
    trajectory: trajectoryOf(trace),
    transcript: transcriptOf(trace),
    // §9.4.4 M1 — the judge reads WHO the agent is before it judges. ABSENT ⇒
    // byte-stable legacy packet (the judge reconstructs the profile at reason-time).
    ...(subjectProfile !== undefined ? { subjectProfile } : {}),
    pin,
  };
  assertMatrixPacket(packet);
  return packet;
}

/** PREP — write one packet file per trajectory into `dir`. Returns the trajectory ids. */
export function writeMatrixPacket(dir: string, packet: MatrixPacket): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, packetFileName(packet.trajectoryId)), JSON.stringify(packet, null, 2));
  return packet.trajectoryId;
}

/** verdict → numeric score (pass=1, fail=0, uncertain=0.5) for the variance view. */
function scoreOf(v: OutcomeVerdictValue): number {
  if (v === OutcomeVerdict.Pass) return 1;
  if (v === OutcomeVerdict.Fail) return 0;
  return 0.5;
}

/**
 * Fold one criterion's verdicts across trajectories into a single GATE-gradable
 * verdict (binary policy: PASS iff all pass; any fail → fail; else uncertain).
 * PURE.
 */
export function foldCriterionVerdicts(
  criterionId: string,
  perTrajectory: { trajectoryId: string; verdict: MatrixVerdict }[],
): { verdict: CriterionVerdict; scores: OutcomeVerdictValue[] } {
  const results = perTrajectory.map((p) => p.verdict.result);
  let folded: OutcomeVerdictValue;
  if (results.some((r) => r === OutcomeVerdict.Fail)) folded = OutcomeVerdict.Fail;
  else if (results.some((r) => r === OutcomeVerdict.Uncertain)) folded = OutcomeVerdict.Uncertain;
  else folded = OutcomeVerdict.Pass;

  // representative critique: the first failing (else first uncertain, else first) trajectory.
  const lead =
    perTrajectory.find((p) => p.verdict.result === OutcomeVerdict.Fail) ??
    perTrajectory.find((p) => p.verdict.result === OutcomeVerdict.Uncertain) ??
    perTrajectory[0];
  const minConfidence = perTrajectory.reduce((m, p) => Math.min(m, p.verdict.confidence), 1);

  // GA — NO silent field drop: carry the lead trajectory's refs / assumptions /
  // blockedBy onto the folded verdict. `blockedBy` only meaningful on an
  // indeterminate fold (the lead is the first uncertain when folded=uncertain).
  const verdict: CriterionVerdict = {
    criterionId,
    traceId: lead?.trajectoryId ?? "(suite)",
    result: folded,
    confidence: minConfidence,
    critique: lead?.verdict.critique ?? "(no verdict)",
  };
  if (lead?.verdict.refs !== undefined) verdict.refs = lead.verdict.refs;
  if (lead?.verdict.assumptions !== undefined) verdict.assumptions = lead.verdict.assumptions;
  if (folded === OutcomeVerdict.Uncertain && lead?.verdict.blockedBy !== undefined) {
    verdict.blockedBy = lead.verdict.blockedBy;
  }

  return { verdict, scores: results };
}

// ── T3 independent verifier (§9.4.2 node 7) ──────────────────────────────────
//
// Self-verify (#mode-verify, GA-5) is the FIRST pass. For GATING (CRIT/HIGH) FAILS
// a SECOND, INDEPENDENT judge is dispatched to REFUTE the verdict — reviewer ≠ the
// judge that decided. It is DOWNGRADE-ONLY (`result-verify.ts`): it may weaken a
// fail to `uncertain(blockedBy)` (rolling the run up to INCOMPLETE), never
// strengthen, never flip. A confirmed fail STANDS. Default OFF (no signals → no
// change → byte-stable).

const DEFAULT_GATING: readonly SeverityValue[] = [Severity.Crit, Severity.High];

/** The folded per-criterion verdicts that are GATING FAILS (FAIL ∧ severity ∈ gating). */
export function gatingFailVerdicts(
  verdicts: CriterionVerdict[],
  severityById: Map<string, string>,
  gatingSeverities?: string[],
): CriterionVerdict[] {
  const gating = new Set<string>(gatingSeverities ?? DEFAULT_GATING);
  return verdicts.filter(
    (v) => v.result === OutcomeVerdict.Fail && gating.has(severityById.get(v.criterionId) ?? ""),
  );
}

/**
 * PREP the SECOND-judge REFUTE tasks (T3): one independent-verify task per gating
 * fail, keyed by content hash, with `unit.kind: "verify"`. The dispatched reviewer
 * (a DISTINCT identity) reasons over the SAME situation and tries to REFUTE — it
 * emits a `VerifierSignal {entails, leap?, leapKind?}`. Deterministic file writes.
 */
export function prepIndependentVerifyTasks(
  dir: string,
  gatingFails: CriterionVerdict[],
  criteriaById: Map<string, MatrixCriterion>,
  pin: PinnedEnvelope,
): JudgeTaskSpec[] {
  const specs: JudgeTaskSpec[] = [];
  for (const v of gatingFails) {
    const crit = criteriaById.get(v.criterionId);
    const system = [
      "You are an INDEPENDENT verifier — NOT the judge that produced this verdict.",
      "Your one job: decide whether the JUDGE'S CLAIM actually ENTAILS the FAIL verdict,",
      "or whether there is an inferential leap (a hidden, ungrounded premise). Try to",
      "REFUTE the fail. You are DOWNGRADE-ONLY: you may weaken fail→uncertain, NEVER flip",
      "to pass, NEVER strengthen. Output STRICT JSON:",
      '{ "entails": true|false, "leap": "<residual ungrounded premise if !entails>",',
      '  "leapKind": "factual-intent"|"normative"|"scope" }',
    ].join("\n");
    const user = [
      `Criterion: ${crit?.statement ?? v.criterionId}`,
      `Pass condition: ${crit?.passCondition ?? "(n/a)"}`,
      `Judge verdict: FAIL (confidence ${v.confidence})`,
      `Judge critique:\n${v.critique}`,
      v.refs !== undefined ? `Cited refs: ${JSON.stringify(v.refs)}` : "Cited refs: (none)",
    ].join("\n");
    specs.push(writeJudgeTask(dir, { unit: { kind: "verify", criterionId: v.criterionId, traceId: v.traceId }, system, user, pin }));
  }
  return specs;
}

export interface MatrixAggregateInput {
  criteria: MatrixCriterion[];
  /** the per-trajectory verdict files the Judge Agents wrote (raw JSON text). */
  verdictFilesRaw: string[];
  /** failing criteria at these severities fail the gate (default CRIT+HIGH). */
  gatingSeverities?: string[];
  /**
   * T1 — the tier-0 deterministic code verdicts, per trajectory. Merged into the
   * same per-criterion fold as the judge verdicts so a code-decided row gates
   * exactly like a judged one. ABSENT ⇒ pure-judge aggregate (byte-stable). PURE.
   */
  codeVerdictsByTrajectory?: { trajectoryId: string; verdicts: MatrixVerdict[] }[];
  /**
   * T3 — the independent-verifier signals (criterionId → VerifierSignal) the
   * dispatched 2nd judge produced, + the situation to re-resolve refs over. Applied
   * DOWNGRADE-ONLY to GATING FAILS before the gate rollup (a refuted fail →
   * uncertain → INCOMPLETE). ABSENT ⇒ no second pass (byte-stable). PURE.
   */
  independentVerify?: { situation: EvalTrace[]; signals: Record<string, VerifierSignal> };
}

export interface MatrixAggregateResult {
  scorecard: Scorecard;
  /** the folded per-criterion verdict (for the report's ✓/✗ table). */
  verdicts: CriterionVerdict[];
  /**
   * T3 (§9.4.2 node 7) — the AUDITABLE independent-verify ledger: one record per
   * GATING fail that went through the 2nd-judge refutation pass (upheld or
   * downgraded). EMPTY when no `independentVerify` input was supplied. Mirrors the
   * `independentVerify` field now stamped onto each affected `CriterionVerdict`.
   */
  independentVerify: IndependentVerifyRecord[];
  /**
   * UI-12-A — the GA-1 grounding-capture readiness over the FINAL folded verdicts
   * (computed AFTER any independent-verify downgrade). Threaded so the report's
   * judgeHealth + the run's loud readiness log read the same machine-checkable
   * number. ADVISORY — never gates the run (see `assessGroundingReadiness`).
   */
  groundingReadiness: GroundingReadiness;
}

/**
 * UI-12-A — assess the GA-1 grounding-capture readiness of the folded verdicts.
 *
 * PURE. NEVER throws (judge-only + advisory): a loud `warning` is SET when the
 * silent-capture regression is present (decided verdicts emitted, but ZERO carry a
 * structured `refs[]`). The DENOMINATOR is the DECIDED verdicts (pass|fail) — an
 * `uncertain` abstain legitimately carries `blockedBy` instead of refs and is `na`
 * for grounding, never "ungrounded". Folding abstains/bare-absences into the
 * denominator is exactly what made `groundedPct` read a false 0% (UI-12 audit).
 */
export function assessGroundingReadiness(verdicts: CriterionVerdict[]): GroundingReadiness {
  const isDecided = (v: CriterionVerdict): boolean =>
    v.result === OutcomeVerdict.Pass || v.result === OutcomeVerdict.Fail;
  const hasRef = (v: CriterionVerdict): boolean => (v.refs?.length ?? 0) > 0;

  const decided = verdicts.filter(isDecided);
  const grounded = decided.filter(hasRef);
  const abstained = verdicts.filter((v) => v.result === OutcomeVerdict.Uncertain);
  const ungroundedDecided = decided.filter((v) => !hasRef(v)).map((v) => v.criterionId);

  const readiness: GroundingReadiness = {
    decidedCount: decided.length,
    groundedCount: grounded.length,
    abstainedCount: abstained.length,
    groundedPctOfDecided: decided.length > 0 ? Math.round((100 * grounded.length) / decided.length) : 100,
    ungroundedDecided,
  };
  if (decided.length > 0 && grounded.length === 0) {
    readiness.warning =
      `GA-1 GROUNDING-CAPTURE REGRESSION: ${decided.length} decided verdict(s) emitted, ` +
      "but 0 carry a structured refs[] — groundedPct reads a FALSE 0%. The judge " +
      "(#mode-judge-trajectory) MUST emit refs[]{obs,path,value} grounding EACH decided " +
      "verdict (assets/agents/evaluator.md node 4 GROUND). Abstains (uncertain) are exempt (na).";
  }
  return readiness;
}

/**
 * AGGREGATE — read the per-trajectory Judge Agent verdict files, fold each
 * criterion across trajectories, and roll up the severity-gated GATE + variance
 * view (`evaluate.ts`). Validates every verdict file (critique-before-verdict +
 * closed result set). PURE — same verdict files ⇒ identical scorecard.
 */
export function aggregateMatrixScorecard(input: MatrixAggregateInput): MatrixAggregateResult {
  const files = input.verdictFilesRaw.map(parseMatrixVerdictFile);
  const severityById = new Map(input.criteria.map((c) => [c.criterionId, c.severity]));

  // criterionId → per-trajectory verdicts
  const byCriterion = new Map<string, { trajectoryId: string; verdict: MatrixVerdict }[]>();
  for (const file of files) {
    for (const v of file.verdicts) {
      const list = byCriterion.get(v.criterionId) ?? [];
      list.push({ trajectoryId: file.trajectoryId, verdict: v });
      byCriterion.set(v.criterionId, list);
    }
  }
  // T1 — fold the tier-0 code verdicts into the SAME per-criterion map (a code row
  // gates identically to a judged one). Deterministic order: trajectory order as
  // supplied, code verdicts appended after the judge verdicts for that trajectory.
  for (const entry of input.codeVerdictsByTrajectory ?? []) {
    for (const v of entry.verdicts) {
      const list = byCriterion.get(v.criterionId) ?? [];
      list.push({ trajectoryId: entry.trajectoryId, verdict: v });
      byCriterion.set(v.criterionId, list);
    }
  }

  const graded: GradedCriterion[] = [];
  const reruns: Record<string, CriterionReruns> = {};
  const verdicts: CriterionVerdict[] = [];

  // iterate criteria in matrix order (deterministic), skipping unjudged ones.
  for (const criterion of input.criteria) {
    const perTraj = byCriterion.get(criterion.criterionId);
    if (perTraj === undefined || perTraj.length === 0) continue;
    const folded = foldCriterionVerdicts(criterion.criterionId, perTraj);
    verdicts.push(folded.verdict);
    graded.push({
      criterionId: criterion.criterionId,
      severity: severityById.get(criterion.criterionId) ?? criterion.severity,
      verdict: folded.verdict,
    });
    reruns[criterion.criterionId] = { scores: folded.scores, trajectories: [] };
  }
  // sort verdict scores are already deterministic; void scoreOf keeps it referenced for clarity.
  void scoreOf;

  // T3 — independent-verifier pass over GATING FAILS (downgrade-only). A refuted
  // fail weakens to `uncertain(blockedBy)` → the gate rolls up to INCOMPLETE. The
  // verdicts + graded rows are updated in place so the rollup sees the downgrade.
  // EVERY gating fail that went through the 2nd judge gets an AUDITABLE
  // `independentVerify` record stamped on it (upheld OR downgraded) — persisted
  // proof that a DIFFERENT judge ran, not just "eligible for".
  const independentVerify: IndependentVerifyRecord[] = [];
  if (input.independentVerify !== undefined) {
    const { situation, signals } = input.independentVerify;
    const gatingFails = gatingFailVerdicts(verdicts, severityById, input.gatingSeverities);
    const gatingFailIds = new Set(gatingFails.map((v) => v.criterionId));
    for (const v of verdicts) {
      if (!gatingFailIds.has(v.criterionId)) continue;
      const signal = signals[v.criterionId] ?? { entails: true };
      const res = verifyVerdict(v, situation, signal);
      const record: IndependentVerifyRecord = {
        byDifferentJudge: true,
        upheld: !res.downgraded,
        reason: res.reason,
        ...(signal.reviewerId !== undefined ? { reviewerId: signal.reviewerId } : {}),
        ...(res.downgraded && signal.leapKind !== undefined ? { leapKind: signal.leapKind } : {}),
      };
      independentVerify.push({ criterionId: v.criterionId, ...record });
      if (res.downgraded) {
        // mutate the verdict + its graded row to the downgraded (uncertain) verdict.
        Object.assign(v, res.verdict);
        const g = graded.find((gc) => gc.criterionId === v.criterionId);
        if (g !== undefined) g.verdict = res.verdict;
      }
      // stamp the auditable record onto the (possibly-downgraded) folded verdict.
      v.independentVerify = record;
    }
  }

  const scorecard = rollupScorecard({
    criteria: graded,
    reruns,
    ...(input.gatingSeverities !== undefined ? { gatingSeverities: input.gatingSeverities } : {}),
  });
  // UI-12-A — assess GA-1 grounding readiness over the FINAL folded verdicts (post
  // independent-verify downgrade). The `warning` is the machine-checkable catch for
  // the silent-capture regression; the run logs it loudly (run-evaluate AGGREGATE).
  const groundingReadiness = assessGroundingReadiness(verdicts);
  return { scorecard, verdicts, independentVerify, groundingReadiness };
}

// ── T4 (§9.4.2 nodes 8.5 + 9) consolidate-by-locus + DERIVED health ──────────
//
// CONSOLIDATE-BY-LOCUS: failing criteria that share a ROOT (the `localize` band of
// the trajectory that led each fail) collapse to ONE finding with N symptoms — the
// cascade is reported once, not N times. DERIVED HEALTH: the per-trajectory judge
// health is COMPUTED from the walk (judgeSteps with a ref = grounded; assumptions /
// blockedBy = assumed; a present `localize` = reached-root) — NOT read from the
// judge's self-reported `health` field (which can be wrong). Both PURE.

/** One root-locus cluster: a shared root + the criteria that are its symptoms. */
export interface LocusCluster {
  root: string;
  criterionIds: string[];
  exampleTraceId?: string;
}

/** The health DERIVED from the judge walk (NOT the self-reported `health` field). */
export interface DerivedHealth {
  contextGathered: boolean;
  /** judge steps (or verdicts) that cite a structured ref. */
  grounded: number;
  /** surfaced assumptions + assumption-blocked abstains. */
  assumed: number;
  /** localize present + non-empty ⇒ the judge reached a root (depth ≥ 1). */
  rootDepth: number;
  /** true iff the judge did NOT localize a root (stopped at the symptom). */
  stoppedAtSymptom: boolean;
}

/**
 * Derive the judge health from the WALK — refs-present = grounded, assumptions /
 * blockedBy = assumed, a non-empty `localize` = reached-root. Ignores the judge's
 * self-reported `health` (T4: don't trust self-graded health). PURE.
 */
export function deriveWalkHealth(file: MatrixVerdictFile): DerivedHealth {
  const steps = file.judgeSteps ?? [];
  const verdicts = file.verdicts ?? [];
  // a ref counts as grounded whether emitted as a string OR a structured {obs,…} object.
  const groundedSteps = steps.filter((s) => {
    const r = s.ref as unknown;
    return (typeof r === "string" && r.length > 0) || (typeof r === "object" && r !== null);
  }).length;
  const groundedVerdicts = verdicts.filter((v) => (v.refs?.length ?? 0) > 0).length;
  const grounded = groundedSteps + groundedVerdicts;
  const assumed =
    verdicts.reduce((n, v) => n + (v.assumptions?.length ?? 0), 0) +
    verdicts.filter((v) => v.blockedBy !== undefined).length;
  const hasLocalize = localizeText(file.localize).length > 0;
  const contextGathered = file.context !== undefined || steps.some((s) => s.kind === "context" || s.kind === "gather");
  return {
    contextGathered,
    grounded,
    assumed,
    rootDepth: hasLocalize ? 1 : 0,
    stoppedAtSymptom: !hasLocalize,
  };
}

/**
 * Consolidate failing criteria by their shared ROOT locus. The root for a failing
 * criterion is the `localize` band of the trajectory that led the fold (the
 * verdict's `traceId`); criteria with no localizable root fall under a per-criterion
 * `unlocalized:<id>` bucket (never merged with a real root). Deterministic order:
 * roots in first-seen order, criteria in input order. PURE.
 */
export function consolidateByLocus(
  failingVerdicts: CriterionVerdict[],
  files: MatrixVerdictFile[],
): LocusCluster[] {
  const localizeByTrace = new Map<string, string>();
  for (const f of files) {
    const loc = localizeText(f.localize);
    if (loc.length > 0) localizeByTrace.set(f.trajectoryId, loc);
  }
  const order: string[] = [];
  const byRoot = new Map<string, LocusCluster>();
  for (const v of failingVerdicts) {
    const root = localizeByTrace.get(v.traceId) ?? `unlocalized:${v.criterionId}`;
    let cluster = byRoot.get(root);
    if (cluster === undefined) {
      cluster = { root, criterionIds: [], ...(v.traceId ? { exampleTraceId: v.traceId } : {}) };
      byRoot.set(root, cluster);
      order.push(root);
    }
    cluster.criterionIds.push(v.criterionId);
  }
  return order.map((r) => byRoot.get(r)!);
}

/** AGGREGATE helper — read raw verdict files for the given trajectory ids from a dir. */
export function readMatrixVerdictFiles(verdictDir: string, trajectoryIds: string[]): string[] {
  const raws: string[] = [];
  for (const id of trajectoryIds) {
    const path = join(verdictDir, matrixVerdictFileName(id));
    if (!existsSync(path)) {
      throw new Error(
        `matrix-judge: no verdict file for trajectory '${id}' at '${path}'. The DEFAULT ` +
          "*evaluate path produces verdicts from dispatched eval-matrix-judge subagents on the " +
          "HOST runtime — PREP packets → dispatch one judge per trajectory → collect verdict " +
          "files → AGGREGATE (references/workflows/orchestrator-protocol.md).",
      );
    }
    raws.push(readFileSync(path, "utf8"));
  }
  return raws;
}
