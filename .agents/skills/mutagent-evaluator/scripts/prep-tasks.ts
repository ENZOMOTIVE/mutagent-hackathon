/**
 * scripts/prep-tasks.ts — the deterministic PREP half of the agent-dispatch engine.
 * ---------------------------------------------------------------------------
 * The agent-dispatch substrate splits judging into PREP (this file) + DISPATCH
 * (the parent session, per references/workflows/orchestrator-protocol.md) +
 * AGGREGATE (run-pipeline.ts reading the verdict files). PREP emits one
 * task-spec file per judging unit — the EXACT (system, user) prompt a dispatched
 * leaf subagent must reason over, keyed by a content-hash so AGGREGATE re-derives
 * the same key from the prompt alone.
 *
 * There is a HARD STAGE BARRIER (the same dependency diagnostics has between its
 * deep-read and its analyzer fan-out): the determiner labels (EV-042) must be
 * REAL before the *build-evals judge prompts can be built, because the judge
 * few-shot block is drawn from the determiner-labeled TRAIN split. So PREP runs
 * in two stages:
 *
 *   Stage A — prepDeterminerTasks  (no label dependency; pure per-trace prompt).
 *             → dispatch error-analyst → collect determiner verdict files.
 *   Stage B — prepJudgeTasks       (REQUIRES stage-A verdicts collected; replays
 *             the pipeline with a capturing judge so the emitted judge prompts
 *             are byte-identical to what AGGREGATE will build).
 *
 * PURE except for fs (writes task-spec files; reads stage-A verdict files). No
 * clock / random / network. Model intent SACRED: the pinned envelope is carried
 * on every task spec for the host runtime to honor.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractOutcomeSignals, type JudgeInvoke } from "./determine-outcome.ts";
import { buildOutcomePrompt } from "./judge-prompt-template.ts";
import {
  writeJudgeTask,
  verdictFileName,
  type JudgeTaskSpec,
  type PinnedEnvelope,
} from "./agent-dispatch.ts";
import { runEvalPipeline } from "./run-pipeline.ts";
import type { PipelineOptions } from "./run-pipeline.ts";
import type { EvalTrace, SubjectVocab } from "./contracts/eval-types.ts";

/** A PREP placeholder verdict — lets the pipeline complete during stage-B capture; never reported. */
const PREP_PLACEHOLDER = JSON.stringify({
  critique: "PREP placeholder — awaiting the dispatched subagent's verdict file",
  result: "pass",
  confidence: 0,
});

/**
 * Stage A PREP — emit one determiner (EV-042) task-spec per trace. The
 * determiner prompt has NO label dependency (it reads the trace's own event +
 * trajectory + terminal state), so these can be emitted + dispatched first.
 * The dispatched error-analyst writes each verdict file; AGGREGATE-A reads them.
 */
export function prepDeterminerTasks(
  traces: EvalTrace[],
  opts: { dir: string; pin: PinnedEnvelope; vocab: SubjectVocab },
): JudgeTaskSpec[] {
  return traces.map((trace) => {
    const { system, user } = buildOutcomePrompt(
      trace,
      extractOutcomeSignals(trace, opts.vocab),
      opts.vocab,
    );
    return writeJudgeTask(opts.dir, {
      unit: { kind: "discover", traceId: trace.id },
      system,
      user,
      pin: opts.pin,
    });
  });
}

/**
 * A capturing JudgeInvoke: when a prompt's verdict file is already present
 * (stage-A determiner verdicts), READ it; otherwise CAPTURE the prompt as a
 * judge task-spec and return a deterministic placeholder so the pipeline runs to
 * completion. Replaying the real pipeline with this judge emits the *build-evals
 * judge prompts using the REAL determiner labels — guaranteeing they are
 * byte-identical to the prompts AGGREGATE will build (same code, same labels).
 */
export function createCapturingJudge(opts: {
  verdictDir: string;
  taskDir: string;
  pin: PinnedEnvelope;
}): { judge: JudgeInvoke; captured: JudgeTaskSpec[] } {
  const captured: JudgeTaskSpec[] = [];
  const judge: JudgeInvoke = (system, user) => {
    const vpath = join(opts.verdictDir, verdictFileName(system, user));
    if (existsSync(vpath)) return Promise.resolve(readFileSync(vpath, "utf8"));
    captured.push(
      // D4 — the criterion judging axis (*build-evals / Step-2b). `kind` now matches the
      // command (was mis-tagged "evaluate" pre-merge). ENVELOPE-ONLY retag: `unit` is not
      // part of promptHash(system, user), so the rendered prompt + its key (8b58d9ca) are
      // invariant — only the task.json envelope carries the new {kind, axis}.
      writeJudgeTask(opts.taskDir, {
        unit: { kind: "build-evals", axis: "criterion" },
        system,
        user,
        pin: opts.pin,
      }),
    );
    return Promise.resolve(PREP_PLACEHOLDER);
  };
  return { judge, captured };
}

/**
 * Stage B PREP — emit the *build-evals / *evaluate judge (EV-043/048) task-specs.
 * REQUIRES the stage-A determiner verdict files to already be collected in
 * `verdictDir` (else the determiner prompts would themselves be captured with
 * placeholder labels, corrupting the judge few-shot). Replays runEvalPipeline
 * with the capturing judge and returns the captured judge tasks for dispatch.
 */
export async function prepJudgeTasks(
  traces: EvalTrace[],
  opts: { verdictDir: string; taskDir: string; pin: PinnedEnvelope; pipeline: PipelineOptions },
): Promise<JudgeTaskSpec[]> {
  const { judge, captured } = createCapturingJudge({
    verdictDir: opts.verdictDir,
    taskDir: opts.taskDir,
    pin: opts.pin,
  });
  await runEvalPipeline(traces, judge, opts.pipeline);
  return captured;
}
