/**
 * scripts/run-pipeline.ts — the W1 engine composed end-to-end.
 * ---------------------------------------------------------------------------
 * Wires the eight engine cores into one pass so the dogfood (#7) is a pure
 * RUN with no new logic:
 *
 *   profileSubject (EV-049)
 *     → determineOutcome per trace (EV-042, via the DI judge seam)
 *     → label + balancedSample with a held-out TRAIN/EVAL split (EV-052)
 *     → build ONE judge per EVAL-WORTHY criterion (EV-043; few-shot from TRAIN
 *       only, judged on the EVAL split — held-out discipline)
 *     → severity-gated GATE + variance (EV-048)
 *     → route ALL fixable + any failing criteria to diagnostics (EV-051)
 *
 * Substrate (EV-050) is chosen by the CALLER and handed in as the `judge` seam
 * (in-house = createInHouseJudge; the gate passes a stub). FIXABLE criteria are
 * NEVER judged — they route straight to diagnostics (a judge is only a judge).
 *
 * PURE composition: no clock/random/network here; determinism comes from the
 * cores + the injected judge + injected provenance.
 */
import type { JudgeInvoke } from "./determine-outcome.ts";
import { determineOutcome, runJudge } from "./judge-prompt-template.ts";
import { profileSubject, type SubjectProfile } from "./profile-subject.ts";
import { splitTrainEval, buildJudgeSpec, type JudgePin } from "./build-evals.ts";
import { rollupScorecard, type GradedCriterion, type Scorecard } from "./evaluate.ts";
import {
  routeFailures,
  type ArtifactRef,
  type FailureRef,
  type HandoverBundle,
  type SubjectKindValue,
} from "./route-failures.ts";
import type { LabeledTrace } from "./sample-traces.ts";
import {
  CriterionFlag,
  OutcomeVerdict,
  type CriterionVerdict,
  type DiscoveredCriterion,
  type EvalTrace,
  type JudgeExemplar,
  type OutcomeResult,
  type SubjectVocab,
} from "./contracts/eval-types.ts";
import { Severity } from "./contracts/types.ts";

export interface PipelineOptions {
  criteria: DiscoveredCriterion[];
  pin: JudgePin;
  subject: { kind: SubjectKindValue; name: string; path: string };
  producedBy: string;
  /** INJECTED provenance stamp (no self-read clock). */
  producedAt: string;
  /**
   * AUTHORED subject vocab (EV-002 / EV-049). When supplied it is stamped onto
   * the profile and injected into the determiner; when omitted the profiler
   * auto-infers a best-effort vocab from the traces. Either way the engine reads
   * the vocab off the profile, never a module constant.
   */
  vocab?: SubjectVocab;
  /** sample budget (default = all traces). */
  sampleSize?: number;
  /** per-criterion gating severity (default HIGH). */
  severityById?: Record<string, string>;
  /** artifact refs to enumerate on the handoff (caller-injected locators). */
  artifacts?: ArtifactRef[];
}

export interface PipelineResult {
  profile: SubjectProfile;
  outcomes: OutcomeResult[];
  sample: LabeledTrace[];
  verdicts: CriterionVerdict[];
  scorecard: Scorecard;
  handoff: HandoverBundle;
}

/** Map a determiner outcome → a sampling LabeledTrace. */
function toLabeled(trace: EvalTrace, outcome: OutcomeResult): LabeledTrace {
  return { trace, label: outcome.reached, confidence: outcome.confidence };
}

/** Build few-shot exemplars from the TRAIN split (label from the determiner). */
function exemplarsFromTrain(train: LabeledTrace[], limit = 2): JudgeExemplar[] {
  return train.slice(0, limit).map((l) => ({
    traceId: l.trace.id,
    label: l.label,
    why: `determiner labeled this ${l.label} (confidence ${l.confidence})`,
  }));
}

/**
 * Run the full W1 engine over a trace set. The `judge` seam is the substrate's
 * judge (live in CLI, stub in the gate). Deterministic given its inputs.
 */
export async function runEvalPipeline(
  traces: EvalTrace[],
  judge: JudgeInvoke,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  // EV-049 — subject profile (carries the subject vocab the engine reads).
  const profile = profileSubject(traces, opts.vocab);

  // EV-042 — determine an outcome per trace (sequential → deterministic order).
  // The determiner reads the subject vocab off the profile (EV-002).
  const outcomes: OutcomeResult[] = [];
  for (const t of traces) {
    outcomes.push(await determineOutcome(t, judge, profile.vocab));
  }
  const labeled = traces.map((t, i) => toLabeled(t, outcomes[i]));

  // EV-052 — sample + held-out TRAIN/EVAL split.
  const size = opts.sampleSize ?? labeled.length;
  const sample = labeled.slice(0, size);
  const { train, evalSet } = splitTrainEval(sample, 0.34);
  const trainIds = new Set(train.map((l) => l.trace.id));
  // judge on the held-out split (fall back to the whole sample if eval is empty).
  const judgeTargets = evalSet.length > 0 ? evalSet : sample;

  // EV-043 — one judge per EVAL-WORTHY criterion (fixables are NEVER judged).
  const evalWorthy = opts.criteria.filter((c) => c.flag === CriterionFlag.EvalWorthy);
  const verdicts: CriterionVerdict[] = [];
  const graded: GradedCriterion[] = [];
  for (const criterion of evalWorthy) {
    const spec = buildJudgeSpec(criterion, exemplarsFromTrain(train), trainIds);
    // judge a representative held-out subject trace (first eval target).
    const subjectTrace = judgeTargets[0]?.trace ?? sample[0]?.trace ?? traces[0];
    const verdict = await runJudge(spec, subjectTrace, judge, opts.pin);
    verdicts.push(verdict);
    graded.push({
      criterionId: criterion.id,
      severity: opts.severityById?.[criterion.id] ?? Severity.High,
      verdict,
    });
  }

  // EV-048 — severity-gated GATE + variance.
  const scorecard = rollupScorecard({ criteria: graded });

  // EV-051 — route ALL fixable criteria + any failing eval-worthy verdicts.
  const failures: FailureRef[] = [];
  for (const criterion of opts.criteria) {
    if (criterion.flag === CriterionFlag.Fixable) {
      failures.push({
        criterionId: criterion.id,
        severity: opts.severityById?.[criterion.id] ?? Severity.High,
        flag: CriterionFlag.Fixable,
        traceId: "(suite)",
        result: OutcomeVerdict.Fail,
        critique: `infra/dependency criterion — routed to diagnostics: ${criterion.statement}`,
      });
    }
  }
  for (const v of verdicts) {
    if (v.result !== OutcomeVerdict.Pass) {
      failures.push({
        criterionId: v.criterionId,
        severity: opts.severityById?.[v.criterionId] ?? Severity.High,
        flag: CriterionFlag.EvalWorthy,
        traceId: v.traceId,
        result: v.result,
        critique: v.critique,
      });
    }
  }
  const handoff = routeFailures({
    subject: opts.subject,
    failures,
    artifacts: opts.artifacts ?? [],
    producedBy: opts.producedBy,
    producedAt: opts.producedAt,
  });

  return { profile, outcomes, sample, verdicts, scorecard, handoff };
}
