/**
 * scripts/cli/aggregate.ts — the AGGREGATE entrypoint for the agent-dispatch engine.
 * ---------------------------------------------------------------------------
 * Symmetric with `cli/prep.ts`: PREP emits task/packet files → the parent
 * dispatches subagents (they write verdict files) → this reads the verdict files
 * back and rolls them up. Type A — deterministic, NO LLM and NO provider. See
 * `references/workflows/orchestrator-protocol.md`.
 *
 *   # DEFAULT *evaluate — eval-matrix × trajectory: fold per-trajectory verdict
 *   # files into the severity-gated GATE + variance scorecard.
 *   aggregate.ts --stage evaluate --traces <f.ndjson> --criteria <matrix.json> \
 *                --verdict-dir <dir> [--out scorecard.json]
 *
 *   # *discover — mine emergent criteria from the dispatched error-analyst
 *   # annotation files (one TraceAnnotation[] JSON per batch in --annotations-dir).
 *   aggregate.ts --stage discover --annotations-dir <dir> [--out criteria.json]
 *
 * The matrix path keys verdict files by TASK DATA (trajectory id), never a
 * rendered prompt — so AGGREGATE re-derives the key from the trajectory ids in
 * the trace set. No judge prompt is rendered here.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseNdjsonTraces } from "../load-traces.ts";
import { readMatrixVerdictFiles, aggregateMatrixScorecard } from "../matrix-judge.ts";
import { deriveCriteria, type TraceAnnotation } from "../discover-criteria.ts";
import type { MatrixCriterion } from "../contracts/eval-matrix.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function loadNdjson(file: string): string {
  if (file.endsWith(".gz")) {
    return execSync(`gunzip -c ${JSON.stringify(file)} | jq -c '.'`, {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
    });
  }
  return readFileSync(file, "utf8");
}

/** Read every *.json file in a dir and JSON.parse each → flat array. */
function readJsonDir<T>(dir: string): T[] {
  const out: T[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as T | T[];
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const stage = flag(argv, "stage");
  const out = flag(argv, "out");

  if (stage === "evaluate") {
    const tracesFile = flag(argv, "traces");
    const criteriaFile = flag(argv, "criteria");
    const verdictDir = flag(argv, "verdict-dir");
    if (tracesFile === undefined || criteriaFile === undefined || verdictDir === undefined) {
      throw new Error("aggregate --stage evaluate: --traces, --criteria and --verdict-dir are required");
    }
    const { traces } = parseNdjsonTraces(loadNdjson(tracesFile));
    const criteria = JSON.parse(readFileSync(criteriaFile, "utf8")) as MatrixCriterion[];
    const trajectoryIds = traces.map((t) => t.id);
    const verdictFilesRaw = readMatrixVerdictFiles(verdictDir, trajectoryIds);
    const result = aggregateMatrixScorecard({ criteria, verdictFilesRaw });
    const json = JSON.stringify(result, null, 2);
    if (out !== undefined) {
      writeFileSync(out, json);
      process.stdout.write(`aggregate: wrote ${out} (gate.passed=${result.scorecard.gate.passed})\n`);
    } else {
      process.stdout.write(json + "\n");
    }
    return;
  }

  if (stage === "discover") {
    const annotationsDir = flag(argv, "annotations-dir");
    if (annotationsDir === undefined) {
      throw new Error("aggregate --stage discover: --annotations-dir <dir of TraceAnnotation[] json> is required");
    }
    const annotations = readJsonDir<TraceAnnotation>(annotationsDir);
    const criteria = deriveCriteria(annotations);
    const json = JSON.stringify(criteria, null, 2);
    if (out !== undefined) {
      writeFileSync(out, json);
      process.stdout.write(`aggregate: wrote ${out} (${criteria.length} criteria)\n`);
    } else {
      process.stdout.write(json + "\n");
    }
    return;
  }

  throw new Error("aggregate: --stage must be 'evaluate' (matrix) or 'discover'");
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`aggregate FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
