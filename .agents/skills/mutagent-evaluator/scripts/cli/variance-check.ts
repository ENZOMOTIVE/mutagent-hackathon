/**
 * scripts/cli/variance-check.ts — coordinator entrypoint.
 * ---------------------------------------------------------------------------
 * The COORDINATOR role (executor != reviewer): compares TWO run bundles on the
 * fixed 15-dim determinism scorecard and emits the delta + trend. This is fully
 * deterministic — no judge, no model — so it runs as a complete wired script.
 *
 *   variance-check.ts <bundleDirA> <bundleDirB> [--out <scorecard.json>]
 *                     [--generated-at <iso>] [--emit-masked]
 */
import { writeFileSync } from "node:fs";
import { loadBundle } from "../load-bundle.ts";
import { varianceCompare } from "../variance-compare.ts";
import { assembleScorecard } from "../assemble-scorecard.ts";
import { maskedCanonicalJson } from "../mask.ts";
import { DEFAULT_GENERATED_AT } from "./audit-run.ts";

interface Args {
  a: string;
  b: string;
  out?: string;
  generatedAt: string;
  emitMasked: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  if (positional.length < 2) {
    throw new Error(
      "usage: variance-check.ts <bundleDirA> <bundleDirB> [--out <file>] [--generated-at <iso>] [--emit-masked]",
    );
  }
  return {
    a: positional[0],
    b: positional[1],
    out: (flags.out as string) || undefined,
    generatedAt: (flags["generated-at"] as string) || DEFAULT_GENERATED_AT,
    emitMasked: flags["emit-masked"] === true,
  };
}

export function main(argvIn?: string[]): number {
  const argv =
    argvIn ??
    (typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);

  const { bundle: a } = loadBundle(args.a);
  const { bundle: b } = loadBundle(args.b);
  const trend = varianceCompare(a, b);

  // Carry the trend into a TREND-only scorecard frame (GATE empty — this is the
  // coordinator's variance comparison, not a conformance gate).
  const scorecard = assembleScorecard({
    subject: a.runId,
    runId: `${a.runId}__vs__${b.runId}`,
    generatedAt: args.generatedAt,
    rows: [],
    trendDimensions: trend.dimensions,
    trendRunPair: trend.runPair,
  });

  const json = args.emitMasked
    ? maskedCanonicalJson(scorecard)
    : JSON.stringify(scorecard, null, 2);
  if (args.out) writeFileSync(args.out, json + "\n");

  console.info(
    JSON.stringify(
      {
        runPair: trend.runPair,
        varianceScore: trend.varianceScore,
        dimensions: trend.dimensions.length,
        diverged: trend.dimensions
          .filter((d) => d.divergence === "diverged")
          .map((d) => d.name),
        out: args.out ?? "(stdout only)",
      },
      null,
      2,
    ),
  );
  // exit 0 when byte-identical (varianceScore 0), 1 otherwise.
  return trend.varianceScore === 0 ? 0 : 1;
}

declare const Bun: { argv: string[] } | undefined;
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  process.exit(main());
}
