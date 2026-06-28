/**
 * scripts/build-evals.ts — EV-043 `*build-evals` judge-SPEC builder (Type A — DATA only).
 * ---------------------------------------------------------------------------
 * Assembles the DATA a per-criterion judge needs (the 4-component judge SPEC) +
 * the held-out TRAIN/EVAL split + the data-leakage guard. The judging itself —
 * rendering the prompt + producing the verdict — is NOT here:
 *   - under the DEFAULT agent-dispatch substrate the verdict comes from a
 *     dispatched `eval-judge` subagent (the rubric is in `eval-judge.md`);
 *   - the OPTIONAL in-house/export prompt rendering + run-wrapper (`runJudge`)
 *     live in `judge-prompt-template.ts` (the EV-050 exception).
 *
 * Script austerity (operator directive): this script holds NO judge prompt and
 * NO LLM-reasoning logic. It keeps only the Type-A pieces:
 *   1. the held-out split (`splitTrainEval`) — deterministic, reproducible;
 *   2. the data-leakage guard (`assertExemplarsFromTrain`) — few-shot from TRAIN
 *      only, or THROW;
 *   3. the 4-component judge SPEC (`buildJudgeSpec`) — DATA (criterion statement,
 *      binary Pass/Fail definitions, few-shot), NO Likert.
 * PURE — no clock/random/network.
 */
import type { LabeledTrace } from "./sample-traces.ts";
import {
  type DiscoveredCriterion,
  type JudgeExemplar,
  type JudgeSpec,
} from "./contracts/eval-types.ts";

/** A pinned judge declaration. Pinned iff modelId present AND temperature===0. */
export interface JudgePin {
  modelId: string;
  temperature: number;
}

export interface TrainEvalSplit {
  /** the small TRAIN split — few-shot exemplars are drawn ONLY from here. */
  train: LabeledTrace[];
  /** the held-out EVAL split — judges are validated/run against this. */
  evalSet: LabeledTrace[];
}

/**
 * Set aside a TRAIN split (default 15%, the 10-20% band) for few-shot, holding
 * out the rest for eval. Deterministic: orders by traceId, takes the first
 * fraction as train (no random, no clock) so splits are reproducible.
 */
export function splitTrainEval(
  labeled: LabeledTrace[],
  trainFraction = 0.15,
): TrainEvalSplit {
  const ordered = [...labeled].sort((a, b) => a.trace.id.localeCompare(b.trace.id));
  const n = Math.max(0, Math.min(ordered.length, Math.round(ordered.length * trainFraction)));
  return { train: ordered.slice(0, n), evalSet: ordered.slice(n) };
}

/**
 * Guard against data leakage: every few-shot exemplar MUST come from the train
 * split. A dev/test exemplar used as few-shot is leakage — THROW.
 */
export function assertExemplarsFromTrain(
  exemplars: JudgeExemplar[],
  trainIds: ReadonlySet<string>,
): void {
  for (const ex of exemplars) {
    if (!trainIds.has(ex.traceId)) {
      throw new Error(
        `assertExemplarsFromTrain: exemplar '${ex.traceId}' is NOT in the train ` +
          "split — using a dev/test trace as a few-shot example is DATA LEAKAGE. " +
          "Draw few-shot only from splitTrainEval().train.",
      );
    }
  }
}

/**
 * Build the judge spec (4 components) for one criterion. Pass def = the
 * criterion statement; fail def = its negation. Few-shot is validated against
 * the train split (leakage guard). PURE.
 */
export function buildJudgeSpec(
  criterion: DiscoveredCriterion,
  fewShot: JudgeExemplar[],
  trainIds: ReadonlySet<string>,
): JudgeSpec {
  assertExemplarsFromTrain(fewShot, trainIds);
  return {
    criterionId: criterion.id,
    statement: criterion.statement,
    passDefinition: `Pass = ${criterion.statement}.`,
    failDefinition: `Fail = the agent fails to satisfy: ${criterion.statement}.`,
    fewShot,
    judgeKind: criterion.judgeKind,
  };
}
