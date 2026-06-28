/**
 * scripts/cli/prep.ts — the PREP entrypoint for the agent-dispatch engine.
 * ---------------------------------------------------------------------------
 * Emits the task-spec files the parent session dispatches to eval-judge /
 * error-analyst subagents (references/workflows/orchestrator-protocol.md). This
 * is the I/O shell over the TESTED PREP cores (scripts/prep-tasks.ts); it calls
 * NO LLM and NO provider — it only writes the EXACT prompts to be judged on the
 * host runtime, keyed by content hash.
 *
 *   prep.ts --stage determiner --traces <f.ndjson|.gz> --task-dir <dir> --model <pinned>
 *           [--profile <vocab.json|.yaml>]  # operator-supplied SubjectVocab (EV-049)
 *   prep.ts --stage judge      --traces <f> --criteria <criteria.json> \
 *           --verdict-dir <discover-verdicts> --task-dir <dir> --model <pinned>
 *
 * MODEL INTENT SACRED: --model is the pinned host model (temperature pinned 0,
 * C-PIN); it is carried verbatim on every task spec for the subagent to honor —
 * never swapped. The `judge` stage REQUIRES the determiner verdict files
 * (--verdict-dir) already collected (Stage A done) — see the protocol.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNdjsonTraces } from "../load-traces.ts";
import { prepDeterminerTasks, prepJudgeTasks } from "../prep-tasks.ts";
import { profileSubject } from "../profile-subject.ts";
import { loadProfileVocab } from "../load-profile-vocab.ts";
import { buildMatrixPacket, writeMatrixPacket, packetFileName } from "../matrix-judge.ts";
import type { JudgeTaskSpec, PinnedEnvelope } from "../agent-dispatch.ts";
import type { PipelineOptions } from "../run-pipeline.ts";
import type { DiscoveredCriterion } from "../contracts/eval-types.ts";
import type { MatrixCriterion } from "../contracts/eval-matrix.ts";
import { SubjectKind } from "../route-failures.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Normalize an export to compact NDJSON: .gz → gunzip | jq -c; else read text. */
function loadNdjson(file: string, limit?: number): string {
  const headN = limit !== undefined ? ` | head -n ${limit}` : "";
  if (file.endsWith(".gz")) {
    return execSync(`gunzip -c ${JSON.stringify(file)} | jq -c '.'${headN}`, {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
    });
  }
  const text = readFileSync(file, "utf8");
  if (limit === undefined) return text;
  return text.split("\n").slice(0, limit).join("\n");
}

/** Write a manifest of emitted task keys → verdict files (what the parent must dispatch + collect). */
function writeManifest(taskDir: string, specs: JudgeTaskSpec[]): void {
  const manifest = {
    count: specs.length,
    tasks: specs.map((s) => ({ key: s.key, unit: s.unit, taskFile: `${s.key}.task.json`, verdictFile: s.verdictFile })),
  };
  writeFileSync(join(taskDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stage = flag(argv, "stage");
  const tracesFile = flag(argv, "traces");
  const taskDir = flag(argv, "task-dir");
  const model = flag(argv, "model");
  const limit = flag(argv, "limit");

  if (tracesFile === undefined || taskDir === undefined || model === undefined) {
    throw new Error("prep: --traces <f>, --task-dir <dir> and --model <pinned> are required");
  }
  const pin: PinnedEnvelope = { model, temperature: 0 };
  const ndjson = loadNdjson(tracesFile, limit !== undefined ? Number.parseInt(limit, 10) : undefined);
  const { traces } = parseNdjsonTraces(ndjson);

  // DEFAULT *evaluate PREP — one eval-matrix packet per trajectory (the headline cell).
  if (stage === "matrix") {
    const criteriaFile = flag(argv, "criteria");
    if (criteriaFile === undefined) {
      throw new Error("prep --stage matrix: --criteria <matrix.json> is required");
    }
    const matrix = JSON.parse(readFileSync(criteriaFile, "utf8")) as MatrixCriterion[];
    const subjectName = traces[0]?.name ?? "unknown-subject";
    const ids = traces.map((trace) => writeMatrixPacket(taskDir, buildMatrixPacket(subjectName, trace, matrix, pin)));
    writeFileSync(
      join(taskDir, "manifest.json"),
      JSON.stringify({ count: ids.length, packets: ids.map((id) => ({ trajectoryId: id, packetFile: packetFileName(id) })) }, null, 2),
    );
    process.stdout.write(`prep: stage=matrix emitted ${ids.length} trajectory packet(s) → ${taskDir}\n`);
    return;
  }

  let specs: JudgeTaskSpec[];
  if (stage === "determiner") {
    // The determiner reads its subject vocab off the profile (EV-002 / EV-049).
    // The profiler auto-infers a best-effort vocab; the SEMANTIC fields it can't
    // infer (sendTool / recoveryTools / guardCounterAttr) stay empty → the engine
    // reports those signals as UNKNOWN (honest-null). An operator may supply them
    // via `--profile <f>` (JSON/YAML), which OVERLAYS the inferred-vocab base —
    // e.g. `{"sendTool":"sendMessage"}` for a sample subject — with NO subject
    // name hardcoded in the engine.
    const inferred = profileSubject(traces).vocab;
    const profileFile = flag(argv, "profile");
    const vocab =
      profileFile !== undefined ? loadProfileVocab(profileFile, inferred) : inferred;
    specs = prepDeterminerTasks(traces, { dir: taskDir, pin, vocab });
  } else if (stage === "judge") {
    const criteriaFile = flag(argv, "criteria");
    const verdictDir = flag(argv, "verdict-dir");
    if (criteriaFile === undefined || verdictDir === undefined) {
      throw new Error("prep --stage judge: --criteria <f> and --verdict-dir <discover-verdicts> are required");
    }
    const criteria = JSON.parse(readFileSync(criteriaFile, "utf8")) as DiscoveredCriterion[];
    const subjectName = traces[0]?.name ?? "unknown-subject";
    const pipeline: PipelineOptions = {
      criteria,
      pin: { modelId: model, temperature: 0 },
      subject: { kind: SubjectKind.Agent, name: subjectName, path: `subjects/${subjectName}` },
      producedBy: "mutagent-evaluator/prep",
      producedAt: "1970-01-01T00:00:00Z", // PREP-only stamp — judge prompts don't depend on it
    };
    specs = await prepJudgeTasks(traces, { verdictDir, taskDir, pin, pipeline });
  } else {
    throw new Error("prep: --stage must be 'matrix' (default *evaluate), 'determiner', or 'judge'");
  }

  writeManifest(taskDir, specs);
  process.stdout.write(
    `prep: stage=${stage} emitted ${specs.length} task-spec(s) → ${taskDir} ` +
      `(unique by content key: ${new Set(specs.map((s) => s.key)).size})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`prep FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
