/**
 * scripts/aggregate-discover.ts — P2: the real `*discover` AGGREGATE half.
 * ---------------------------------------------------------------------------
 * Completes the agent-dispatch FSM for `*discover`: PREP (prepDeterminerTasks) →
 * DISPATCH (#mode-discover leaves — PARENT session) → **AGGREGATE (here)**.
 * Sub-agents cannot fan out sub-agents, so the parent runs DISPATCH; this module
 * is the deterministic AGGREGATE the parent calls once the leaves have written
 * their verdict + mining files.
 *
 * It consumes the TWO real leaf artifacts (shapes per evaluator.md
 * `#mode-discover`):
 *   - per-trace determiner verdict files  `<key>.verdict.json`
 *       = { critique, result, confidence }            (the canonical ✓/✗ label)
 *   - one per-batch mining report          `discover/<batch_id>.json`
 *       = { batchId, labels[], categories[] }          (the emergent clustering)
 *         labels[]     : { traceId, verdict, firstThingWrong, evidencePointer }
 *         categories[] : { name, definition, class, fixOrEval, exampleTraceIds, … }
 *
 * AGGREGATE JOINS them into `TraceAnnotation[]` (NO hand-rolled annotations in
 * the path), then `deriveMinedCriteria` (§5b metadata + §5c DR-2) → `growLivingSuite`
 * (append-only, monotonic). FAIL-LOUD: a missing verdict file (mirrors
 * `missingVerdictKeys`) or a category referencing an undispatched trace THROWS —
 * a dispatch gap is never a silently-fabricated annotation.
 *
 * PURE except for fs reads (the verdict files). No clock / random / network — the
 * mined criteria + suite are byte-identical for the same inputs (C-PIN).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { missingVerdictKeys, type JudgeTaskSpec } from "./agent-dispatch.ts";
import { parseCritiqueVerdict } from "./determine-outcome.ts";
import { deriveMinedCriteria, type TraceAnnotation } from "./discover-criteria.ts";
import { growLivingSuite, type LivingSuite } from "./living-suite.ts";
import { deriveRegressionCases } from "./derive-dataset.ts";
import {
  renderDiscoverReport,
  type GroundingCheckSummary,
  type DiscoverReportInput,
} from "./render-discover-report.ts";
import type { LabeledTrace } from "./sample-traces.ts";
import type { DatasetCase } from "./contracts/dataset.ts";
import type { CandidateItem, MatrixVerdictFile } from "./contracts/eval-matrix.ts";
import {
  CodeEvalSpecSchema,
  JudgeKind,
  OutcomeVerdict,
  assertGroundingHonest,
  type DiscoveryRef,
  type EvalTrace,
  type JudgeKindValue,
  type MinedCriterion,
  type OutcomeVerdictValue,
} from "./contracts/eval-types.ts";
import type { CodeEvalSpec } from "./code-eval.ts";
import { applyDiffDiscrimination, type CriterionFireSignals } from "./diff-discriminate.ts";

// ── The leaf's per-batch mining report (real #mode-discover output shape) ────

export const DiscoverLabelSchema = Type.Object(
  {
    traceId: Type.String({ minLength: 1 }),
    verdict: Type.Union([
      Type.Literal(OutcomeVerdict.Pass),
      Type.Literal(OutcomeVerdict.Fail),
      Type.Literal(OutcomeVerdict.Uncertain),
    ]),
    firstThingWrong: Type.String(),
    evidencePointer: Type.String(),
    /** GA-1 — optional STRUCTURED grounding refs `{obs,path,value}` the leaf
     *  cited (additive; when absent a ref is synthesized from evidencePointer). */
    refs: Type.Optional(
      Type.Array(
        Type.Object(
          { obs: Type.String({ minLength: 1 }), path: Type.String(), value: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export const DiscoverCategorySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    /** the binary criterion statement ("Pass = …"). */
    definition: Type.String({ minLength: 1 }),
    /** objective→code · subjective→judge · code-pre-filter+judge→hybrid. */
    class: Type.Union([Type.Literal("code"), Type.Literal("judge"), Type.Literal("hybrid")]),
    fixOrEval: Type.Union([Type.Literal("eval-worthy"), Type.Literal("fixable")]),
    exampleTraceIds: Type.Array(Type.String({ minLength: 1 })),
    // OPTIONAL §5b metadata proposals (additive agent-contract extension).
    dimension: Type.Optional(Type.String({ minLength: 1 })),
    level: Type.Optional(Type.String({ minLength: 1 })),
    generality: Type.Optional(Type.String({ minLength: 1 })),
    severity: Type.Optional(Type.String({ minLength: 1 })),
    judgeInputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** UNIFORM STANDARD — the executable code-check the leaf emits for a
     *  deterministically-checkable category (validated against the canonical
     *  registry; carried onto `MinedCriterion.codeEval`). Absent for judge rows. */
    codeEval: Type.Optional(CodeEvalSpecSchema),
  },
  { additionalProperties: false },
);

export const DiscoverMiningReportSchema = Type.Object(
  {
    batchId: Type.String({ minLength: 1 }),
    labels: Type.Array(DiscoverLabelSchema),
    categories: Type.Array(DiscoverCategorySchema),
  },
  { additionalProperties: false },
);
export type DiscoverMiningReport = Static<typeof DiscoverMiningReportSchema>;
export type DiscoverCategory = Static<typeof DiscoverCategorySchema>;

/** Guarded parse of a leaf mining report. THROWS with the first schema error. */
export function parseDiscoverMiningReport(value: unknown): DiscoverMiningReport {
  if (!Value.Check(DiscoverMiningReportSchema, value)) {
    const first = [...Value.Errors(DiscoverMiningReportSchema, value)][0];
    const where = first?.path ?? "(root)";
    const msg = first?.message ?? "does not match DiscoverMiningReport";
    throw new Error(`parseDiscoverMiningReport: invalid mining report at ${where}: ${msg}`);
  }
  return value;
}

// ── JOIN: verdict files + mining report → TraceAnnotation[] ──────────────────

/** Map a mining-report category `class` → the engine's JudgeKind. */
function judgeKindForClass(klass: DiscoverCategory["class"]): JudgeKindValue {
  if (klass === "code") return JudgeKind.Code;
  if (klass === "hybrid") return JudgeKind.Hybrid;
  return JudgeKind.Llm;
}

export interface AggregateDiscoverInput {
  /** the Stage-A determiner specs (carry `unit.traceId` + the verdict file name). */
  determinerSpecs: JudgeTaskSpec[];
  /** the dir the dispatched leaves wrote their per-trace verdict files into. */
  verdictDir: string;
  /** the parsed (or raw) per-batch mining report. */
  miningReport: DiscoverMiningReport;
}

/**
 * Parse the leaf artifacts into `TraceAnnotation[]` — NO hand-rolled annotations.
 * FAIL-LOUD: every dispatched determiner unit MUST have a collected verdict file
 * (mirrors `missingVerdictKeys`); every `exampleTraceId` MUST belong to a
 * dispatched + verdict-backed trace (else the leaf referenced a trace it was
 * never given). The canonical ✓/✗ label is read from the verdict file; the
 * category clustering + notes come from the mining report. Deterministic:
 * categories in report order, exampleTraceIds in report order.
 */
export function parseDiscoverAnnotations(input: AggregateDiscoverInput): TraceAnnotation[] {
  const report = parseDiscoverMiningReport(input.miningReport);

  // 1. Readiness gate — every dispatched determiner unit has a verdict file.
  const missing = missingVerdictKeys(input.verdictDir, input.determinerSpecs);
  if (missing.length > 0) {
    throw new Error(
      `parseDiscoverAnnotations: ${missing.length} determiner verdict file(s) MISSING ` +
        `(keys: ${missing.join(", ")}). The parent must PREP → dispatch #mode-discover → ` +
        "collect ALL verdict files before AGGREGATE. A missing verdict is a dispatch gap, " +
        "never a fabricated label.",
    );
  }

  // 2. traceId → canonical label (read from the per-trace verdict file).
  const labelByTrace = new Map<string, OutcomeVerdictValue>();
  for (const spec of input.determinerSpecs) {
    const traceId = spec.unit.traceId;
    if (traceId === undefined) continue; // non-discover unit; skip
    const raw = readFileSync(join(input.verdictDir, spec.verdictFile), "utf8");
    const verdict = parseCritiqueVerdict(raw);
    labelByTrace.set(traceId, verdict.result as OutcomeVerdictValue);
  }

  // 3. traceId → mining-report label meta (firstThingWrong + evidencePointer + GA-1 refs).
  const metaByTrace = new Map<
    string,
    { firstThingWrong: string; evidencePointer: string; refs?: DiscoveryRef[] }
  >();
  for (const l of report.labels) {
    metaByTrace.set(l.traceId, {
      firstThingWrong: l.firstThingWrong,
      evidencePointer: l.evidencePointer,
      ...(l.refs !== undefined ? { refs: l.refs } : {}),
    });
  }

  // 4. JOIN per category × exampleTraceId.
  const annotations: TraceAnnotation[] = [];
  for (const cat of report.categories) {
    const judgeKind = judgeKindForClass(cat.class);
    const failureClass = cat.fixOrEval === "fixable" ? "infra" : "behavioral";
    for (const traceId of cat.exampleTraceIds) {
      const label = labelByTrace.get(traceId);
      if (label === undefined) {
        throw new Error(
          `parseDiscoverAnnotations: category '${cat.name}' references trace '${traceId}' ` +
            "which has no dispatched determiner verdict — the leaf may only cluster traces it " +
            "was dispatched for (no verdict ⇒ no annotation).",
        );
      }
      const meta = metaByTrace.get(traceId);
      const ann: TraceAnnotation = {
        traceId,
        label,
        category: cat.name,
        failureClass,
        judgeKind,
        statement: cat.definition,
      };
      if (meta !== undefined && meta.firstThingWrong.length > 0) ann.note = meta.firstThingWrong;
      if (meta !== undefined && meta.evidencePointer.length > 0) ann.evidencePointer = meta.evidencePointer;
      if (meta !== undefined && meta.refs !== undefined && meta.refs.length > 0) ann.refs = meta.refs;
      if (cat.judgeInputs !== undefined) ann.judgeInputs = cat.judgeInputs;
      // UNIFORM STANDARD — carry the leaf's executable code-check through to the
      // annotation so deriveMinedCriteria lands it on MinedCriterion.codeEval.
      if (cat.codeEval !== undefined) ann.codeEval = cat.codeEval as CodeEvalSpec;
      annotations.push(ann);
    }
  }
  return annotations;
}

// ── Full AGGREGATE: annotations → mined criteria → living-suite ──────────────

export interface AggregateDiscoverResult {
  annotations: TraceAnnotation[];
  criteria: MinedCriterion[];
  suite: LivingSuite<MinedCriterion>;
  /** T6 — failure/uncertain DATASET CANDIDATES (present iff `traces` supplied). */
  datasetCandidates: DatasetCase[];
}

/**
 * The full `*discover` AGGREGATE: parse leaf artifacts → mined criteria (§5b+§5c)
 * → grow the append-only living-suite (monotonic; `growLivingSuite` enforces it).
 * A re-run over the same batch never shrinks the suite; new rounds only append
 * novel categories (continuous expansion, EV-053). PURE except for the fs reads.
 *
 * GA wiring (both OPTIONAL — grandfather: absent ⇒ legacy behavior unchanged):
 *   - `traces`        — GA-1 ground-gate: re-resolve each `observed` criterion's
 *                       refs exact-match against the trace batch; an observed
 *                       claim whose refs no longer resolve is REJECTED (THROWS).
 *   - `fireSignals`   — GA-11 diff-discriminate: a criterion is OBSERVED-eligible
 *                       only if it fires on BROKEN ∧ NOT on HEALTHY; else demote
 *                       to `inferred` (or route a garbage-in fixable→diagnostics).
 *                       No healthy companion ⇒ graceful single-trace fallback
 *                       (kept observed, tagged) — never a hard fail.
 */
export function aggregateDiscover(
  input: AggregateDiscoverInput & {
    suite: LivingSuite<MinedCriterion>;
    traces?: EvalTrace[];
    fireSignals?: CriterionFireSignals[];
  },
): AggregateDiscoverResult {
  const annotations = parseDiscoverAnnotations(input);
  let criteria = deriveMinedCriteria(annotations);

  // GA-11 — observed-eligibility via broken∧¬healthy diff (deterministic).
  if (input.fireSignals !== undefined) {
    criteria = applyDiffDiscrimination(criteria, input.fireSignals);
  }

  // GA-1 — hard ground-gate: an `observed` criterion's refs must RE-RESOLVE.
  if (input.traces !== undefined && input.traces.length > 0) {
    for (const c of criteria) assertGroundingHonest(c, input.traces);
  }

  const suite = growLivingSuite(input.suite, criteria, (c) => c.id);

  // T6 — surface failure/uncertain DATASET CANDIDATES (reusing the EV-047 selectors)
  // when the trace batch is supplied; consumable by *build-dataset.
  const datasetCandidates =
    input.traces !== undefined && input.traces.length > 0
      ? collectDatasetCandidates({ determinerSpecs: input.determinerSpecs, verdictDir: input.verdictDir, traces: input.traces })
      : [];

  return { annotations, criteria, suite, datasetCandidates };
}

// ── Report wiring: AGGREGATE result → report.html (mirrors writeRunReport) ───
//
// The way `run-evaluate.ts writeRunReport` composes `buildEvalReportInput` +
// `renderEvalReport` + `writeFileSync`, this composes the discover-card renderer.
// The parent `*discover` AGGREGATE path calls this AFTER `aggregateDiscover`.

export interface WriteDiscoverReportInput {
  /** the mined criteria from `aggregateDiscover().criteria` (FULL MinedCriterion[]). */
  result: Pick<AggregateDiscoverResult, "criteria">;
  /** the dir to write `report.html` into. */
  reportDir: string;
  subjectName?: string;
  batchId?: string;
  /** OPTIONAL GA `grounding-check.json` summary (drives the strip + diff notes). */
  grounding?: GroundingCheckSummary | null;
  subjectSource?: string;
  /**
   * OPTIONAL companion data forwarded to the renderer — the Proof-of-work tab
   * (`verdicts`), the Dataset tab (`dataset`), and the coverage funnel + send
   * distribution (`triage`/`sentDist`) + entity card (`profile`). REGRESSION FIX:
   * without these the renderer degrades those tabs to empty/em-dash — the producer
   * MUST forward them (the from-files entry already does). Absent ⇒ graceful degrade.
   */
  companions?: Pick<DiscoverReportInput, "verdicts" | "dataset" | "triage" | "sentDist" | "profile">;
  /** the ISO timestamp stamped into the header (masked by mask.ts for C-PIN). */
  generatedAt: string;
}

/**
 * Render + write the discover `report.html` for an AGGREGATE result. Returns the
 * out path. The render is DETERMINISTIC (the only varying input is `generatedAt`,
 * masked by mask.ts); the fs side-effects (mkdir + write) live HERE so the
 * renderer stays pure-given-input. PURE except those fs writes + the renderer's
 * brand reads.
 *
 * ⚠️ MINIMAL entry — without `companions` it degrades funnel/Proof-of-work/Dataset to
 * em-dash/empty (the A4 thin-report gap). For a COMPLETE report by default, the *discover
 * flow should call the shipped `writeDiscoverRunReport` composer (render-discover-report.ts),
 * which builds triage-summary.json + wires every companion from the run dir.
 */
export function writeDiscoverReport(input: WriteDiscoverReportInput): string {
  const html = renderDiscoverReport({
    subject: {
      name: input.subjectName ?? "discover-subject",
      ...(input.subjectSource ? { source: input.subjectSource } : {}),
    },
    criteria: input.result.criteria,
    grounding: input.grounding ?? null,
    generatedAt: input.generatedAt,
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    ...(input.companions ?? {}),
  });
  mkdirSync(input.reportDir, { recursive: true });
  const outPath = join(input.reportDir, "report.html");
  writeFileSync(outPath, html);
  return outPath;
}

// ── T6 (B-U5) discover → DATASET CANDIDATES + unmatched-detection handoff ────
//
// `*discover` mined CRITERIA only; T6 ALSO surfaces a failure/uncertain DATASET
// CANDIDATE artifact (reusing the EV-047 `derive-dataset` selectors) + converts the
// judge's node-2.5 UNMATCHED DETECTIONS (`*evaluate` walk `candidates[]`) into the
// same handoff — both consumable by `*build-dataset` (its `mergeCases`). PURE.

/** Read the per-trace determiner labels (✓/✗ + confidence) from the verdict files. */
export function readDeterminerLabels(
  determinerSpecs: JudgeTaskSpec[],
  verdictDir: string,
): Map<string, { label: OutcomeVerdictValue; confidence: number }> {
  const out = new Map<string, { label: OutcomeVerdictValue; confidence: number }>();
  for (const spec of determinerSpecs) {
    const traceId = spec.unit.traceId;
    if (traceId === undefined) continue;
    const raw = readFileSync(join(verdictDir, spec.verdictFile), "utf8");
    const v = parseCritiqueVerdict(raw);
    out.set(traceId, { label: v.result as OutcomeVerdictValue, confidence: v.confidence });
  }
  return out;
}

export interface DatasetCandidateInput {
  determinerSpecs: JudgeTaskSpec[];
  verdictDir: string;
  /** the actual traces (a candidate needs the replayable input prompt). */
  traces: EvalTrace[];
  /** target candidate count (the derive-dataset selectors cap to this). */
  size?: number;
}

/**
 * Distill FAILURE + UNCERTAIN traces into `DatasetCase` candidates (the cases worth
 * adding to a regression/coverage set). Reuses the EV-047 selectors (failure-driven
 * · outlier · uncertainty) via `deriveRegressionCases` with `excludeIndeterminate:
 * false` (a CANDIDATE set keeps the brittle uncertain boundary — unlike the held-out
 * gate set). PASS traces are dropped (a candidate is a not-yet-covered ✗/?). The
 * output is `mergeCases`-ready for `*build-dataset`. DETERMINISTIC. PURE except the
 * verdict-file reads.
 */
export function collectDatasetCandidates(input: DatasetCandidateInput): DatasetCase[] {
  const labels = readDeterminerLabels(input.determinerSpecs, input.verdictDir);
  const traceById = new Map(input.traces.map((t) => [t.id, t]));
  const pool: LabeledTrace[] = [];
  for (const [traceId, meta] of labels) {
    if (meta.label === OutcomeVerdict.Pass) continue; // candidates = ✗ / uncertain
    const trace = traceById.get(traceId);
    if (trace === undefined) continue;
    pool.push({ trace, label: meta.label, confidence: meta.confidence });
  }
  const size = input.size ?? pool.length;
  return deriveRegressionCases(pool, size, { excludeIndeterminate: false });
}

/** One unmatched-detection candidate handed off from the `*evaluate` judge walk. */
export interface UnmatchedDetectionCandidate extends CandidateItem {
  trajectoryId: string;
}

/**
 * Extract the judge's node-2.5 UNMATCHED DETECTIONS (`candidates[]` on the
 * `*evaluate` verdict walks) — real behaviours with NO matching criterion. Each
 * carries the trajectory it was seen on so `*build-dataset` (kind=dataset) /
 * criterion mining (kind=eval) can route it. DETERMINISTIC (file + array order). PURE.
 */
export function unmatchedDetectionCandidates(files: MatrixVerdictFile[]): UnmatchedDetectionCandidate[] {
  const out: UnmatchedDetectionCandidate[] = [];
  for (const f of files) {
    for (const c of (f as { candidates?: CandidateItem[] }).candidates ?? []) {
      out.push({ ...c, trajectoryId: f.trajectoryId });
    }
  }
  return out;
}

// ── CLI entrypoint (the parent drives this after DISPATCH) ───────────────────
//
// Usage: bun scripts/aggregate-discover.ts <determiner-specs.json> <verdictDir>
//          <mining-report.json> [traces.json] [report.html]
// Reads the PREP determiner specs + the collected verdict dir + the leaf mining
// report, runs AGGREGATE, and prints the mined criteria + suite provenance.
//
// `traces.json` (OPTIONAL 4th arg) — the normalized `EvalTrace[]` batch. When
// supplied, it is loaded + PASSED into `aggregateDiscover({ traces })` so the
// GA-1 ground-gate (`assertGroundingHonest`) RE-RESOLVES each `observed`
// criterion's refs in the CLI path — exactly as the lib path does. Wiring only:
// the gate's BEHAVIOR is unchanged (absent ⇒ legacy CLI behavior, gate skipped).
// `report.html` (OPTIONAL 5th arg) — when supplied, the discover-card report is
// written there (the way run-evaluate writeRunReport renders post-aggregate).

declare const Bun: { argv: string[] } | undefined;

export interface AggregateDiscoverCliIo {
  readFile: (p: string) => string;
  writeFile: (p: string, s: string) => void;
  mkdir: (p: string) => void;
}

export interface AggregateDiscoverCliResult {
  batchId: string;
  criteria: number;
  suiteVersion: number;
  suiteTotal: number;
  lastAppended: number;
  criterionIds: string[];
  /** present iff a `report.html` out path was supplied (5th arg). */
  reportPath?: string;
  /** whether the GA-1 ground-gate ran in this CLI invocation (traces supplied). */
  groundGateRan: boolean;
}

/**
 * The CLI body, extracted PURE-given-io (no `process.exit`, no top-level fs) so a
 * test can exercise the traces-wiring + report-wiring deterministically. THROWS
 * on a usage error (the `main` wrapper maps that to exit code 2) or when the
 * GA-1 ground-gate rejects an inferred-as-observed criterion (fail-loud — the
 * gate's behavior is UNCHANGED, just now reached from the CLI path).
 */
export function runAggregateDiscoverCli(
  argv: string[],
  io: AggregateDiscoverCliIo,
): AggregateDiscoverCliResult {
  const [specsPath, verdictDir, reportPath, tracesPath, htmlOutPath] = argv;
  if (!specsPath || !verdictDir || !reportPath) {
    throw new Error(
      "usage: aggregate-discover.ts <determiner-specs.json> <verdictDir> " +
        "<mining-report.json> [traces.json] [report.html]",
    );
  }
  const determinerSpecs = JSON.parse(io.readFile(specsPath)) as JudgeTaskSpec[];
  const miningReport = parseDiscoverMiningReport(
    JSON.parse(io.readFile(reportPath)) as unknown,
  );
  // OPTIONAL traces — load + PASS so the GA-1 ground-gate runs in the CLI path.
  const traces =
    tracesPath !== undefined && tracesPath !== ""
      ? (JSON.parse(io.readFile(tracesPath)) as EvalTrace[])
      : undefined;

  const { criteria, suite } = aggregateDiscover({
    determinerSpecs,
    verdictDir,
    miningReport,
    suite: { entries: [], provenance: { version: 0, total: 0, lastAppended: 0 } },
    ...(traces !== undefined ? { traces } : {}),
  });

  let writtenReport: string | undefined;
  if (htmlOutPath !== undefined && htmlOutPath !== "") {
    const html = renderDiscoverReport({
      subject: { name: "discover-subject" },
      criteria,
      grounding: null,
      generatedAt: new Date().toISOString(),
      batchId: miningReport.batchId,
    });
    io.mkdir(dirname(htmlOutPath));
    io.writeFile(htmlOutPath, html);
    writtenReport = htmlOutPath;
  }

  return {
    batchId: miningReport.batchId,
    criteria: criteria.length,
    suiteVersion: suite.provenance.version,
    suiteTotal: suite.provenance.total,
    lastAppended: suite.provenance.lastAppended,
    criterionIds: criteria.map((c) => c.id),
    ...(writtenReport !== undefined ? { reportPath: writtenReport } : {}),
    groundGateRan: traces !== undefined && traces.length > 0,
  };
}

function main(): void {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  let result: AggregateDiscoverCliResult;
  try {
    result = runAggregateDiscoverCli(argv, {
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, s) => writeFileSync(p, s),
      mkdir: (p) => mkdirSync(p, { recursive: true }),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }
  console.info(JSON.stringify(result, null, 2));
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  main();
}
