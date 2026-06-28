/**
 * scripts/cli/dogfood.ts — EV-041..052 AGGREGATE runner (the #7 RUN entrypoint).
 * ---------------------------------------------------------------------------
 * Wires the W1 engine cores against a real trace export. This is the I/O shell —
 * it is reached ONLY from the CLI, never from the `bun test` gate (which
 * exercises the pure cores + a stub judge). The composition it calls
 * (run-pipeline.ts) is fully unit-tested.
 *
 *   # DEFAULT — agent-dispatch: AGGREGATE the verdict files dispatched subagents
 *   # wrote on the host runtime (PREP + dispatch happen first — see the protocol).
 *   dogfood.ts --traces <f.ndjson|.gz> --criteria <criteria.json>
 *              --substrate agent-dispatch --verdict-dir <dir> --model <pinned> [--out <report.json>]
 *
 *   # OPTIONAL — in-house: run the LIVE google-genai judge (CI/code-based export).
 *   dogfood.ts --traces <f> --criteria <criteria.json> --substrate in-house --model <gemini-*>
 *
 * The DEFAULT substrate (agent-dispatch) calls NO provider — it reads the
 * verdict files. The in-house substrate THROWS on an unsupported model / missing
 * GOOGLE_API_KEY (blocked, never a silent swap — model intent sacred). The
 * criteria come from `*discover` — this CLI does NOT fabricate them; it reads
 * them from --criteria so the run is grounded, never invented.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseNdjsonTraces } from "../load-traces.ts";
import { runEvalPipeline } from "../run-pipeline.ts";
import { resolveJudgeModel } from "../judge-provider.ts";
import { resolveSubstrate, judgeForSubstrate, describeSubstrate } from "../substrate.ts";
import type { JudgeInvoke } from "../determine-outcome.ts";
import { Substrate, type DiscoveredCriterion } from "../contracts/eval-types.ts";
import { SubjectKind } from "../route-failures.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Normalize an export to compact NDJSON: .gz → gunzip | jq -c; else read text. */
function loadNdjson(file: string, limit?: number): string {
  const headN = limit !== undefined ? ` | head -n ${limit}` : "";
  if (file.endsWith(".gz")) {
    // jq -c normalizes the multi-line JSON stream to one compact record per line.
    return execSync(`gunzip -c ${JSON.stringify(file)} | jq -c '.'${headN}`, {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
    });
  }
  const text = readFileSync(file, "utf8");
  if (limit === undefined) return text;
  return text.split("\n").slice(0, limit).join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tracesFile = flag(argv, "traces");
  const criteriaFile = flag(argv, "criteria");
  const model = flag(argv, "model");
  const limit = flag(argv, "limit");
  const out = flag(argv, "out");

  if (tracesFile === undefined || criteriaFile === undefined) {
    throw new Error("dogfood: --traces <file> and --criteria <criteria.json> are required");
  }

  // EV-050 substrate (DEFAULT = agent-dispatch). Model intent sacred: resolve
  // the pinned model exactly (no swap). --model is authoritative for the dogfood.
  const substrate = resolveSubstrate(flag(argv, "substrate"));
  const decision = resolveJudgeModel({ ...(model !== undefined ? { model } : {}) });

  let judge: JudgeInvoke;
  if (substrate === Substrate.AgentDispatch) {
    const verdictDir = flag(argv, "verdict-dir");
    if (verdictDir === undefined) {
      throw new Error(
        "dogfood --substrate agent-dispatch: --verdict-dir <dir> is required (the dir the " +
          "dispatched eval-judge/error-analyst subagents wrote their verdict files into). " +
          "Run PREP + dispatch first (references/workflows/orchestrator-protocol.md).",
      );
    }
    judge = judgeForSubstrate({ substrate, verdictDir }); // reads verdict files — NO provider
  } else {
    judge = judgeForSubstrate({ substrate, model: decision.model }); // in-house: THROWS if creds absent
  }

  const ndjson = loadNdjson(tracesFile, limit !== undefined ? Number.parseInt(limit, 10) : undefined);
  const { traces, skipped } = parseNdjsonTraces(ndjson);
  const criteria = JSON.parse(readFileSync(criteriaFile, "utf8")) as DiscoveredCriterion[];

  const subjectName = traces[0]?.name ?? "unknown-subject";
  const result = await runEvalPipeline(traces, judge, {
    criteria,
    pin: { modelId: decision.model, temperature: 0 },
    subject: { kind: SubjectKind.Agent, name: subjectName, path: `subjects/${subjectName}` },
    producedBy: "mutagent-evaluator/dogfood",
    // a real run stamp is acceptable here (CLI side); the cores stay clock-free.
    producedAt: new Date().toISOString(),
    artifacts: [{ id: "traces", kind: "trace", path: tracesFile }],
  });

  const substrateDesc = describeSubstrate(substrate);
  const summary = {
    substrate,
    judgeTransport: substrateDesc.transport,
    callsProvider: substrateDesc.callsProvider,
    model: decision.model,
    modelSource: decision.source,
    tracesLoaded: traces.length,
    tracesSkipped: skipped,
    profile: result.profile,
    gate: result.scorecard.gate,
    verdicts: result.verdicts,
    routedFailures: result.handoff.acceptance.criteria,
  };

  const json = JSON.stringify(summary, null, 2);
  if (out !== undefined) {
    writeFileSync(out, json);
    process.stdout.write(`dogfood: wrote ${out} (gate.passed=${result.scorecard.gate.passed})\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`dogfood FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
