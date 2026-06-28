/**
 * scripts/cli/audit-run.ts — Mode A entrypoint.
 * ---------------------------------------------------------------------------
 * The harness spine: load the named subject profile + the run-bundle, run the
 * deterministic pass, assemble the two-track scorecard, render the 4-tab report.
 *
 *   audit-run.ts <runId> --subject <name> [--bundle-dir <dir>]
 *                [--subjects-root <dir>] [--out-dir <dir>]
 *                [--generated-at <iso>]
 *
 * The pinned-judge rows (trace-cross-ref / trajectory-diff) and the data-leak /
 * variance tabs are JUDGE-EXECUTION SEAMS: this deterministic spine runs fully
 * offline and emits the scorecard + report; the judge-filled tabs are composed
 * by the workflow harness (workflows/audit.workflow.js) which dispatches the
 * pinned judge. This CLI never silently fabricates judge verdicts.
 *
 * Deterministic spine: generatedAt is injected (default: a fixed sentinel so a
 * bare run is reproducible; pass --generated-at for a real stamp).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countCriteria,
  loadEvalMatrix,
  resolveProfilePaths,
} from "../load-profile.ts";
import { loadBundle } from "../load-bundle.ts";
import { runDeterministic } from "../run-deterministic.ts";
import { assembleScorecard } from "../assemble-scorecard.ts";
import { renderReport } from "../render-report.ts";
import { maskedCanonicalJson } from "../mask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");

/** Fixed sentinel so a bare audit-run is byte-reproducible without a clock. */
export const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";

interface Args {
  runId: string;
  subject: string;
  bundleDir: string;
  subjectsRoot: string;
  outDir?: string;
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
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const subject = (flags.subject as string) || "";
  const runId = positional[0] || "";
  if (!runId || !subject) {
    throw new Error(
      "usage: audit-run.ts <runId> --subject <name> [--bundle-dir <dir>] [--subjects-root <dir>] [--out-dir <dir>] [--generated-at <iso>] [--emit-masked]",
    );
  }
  return {
    runId,
    subject,
    bundleDir:
      (flags["bundle-dir"] as string) ||
      join(process.cwd(), ".mutagent-diagnostics", runId),
    subjectsRoot:
      (flags["subjects-root"] as string) || join(PKG_ROOT, "subjects"),
    outDir: (flags["out-dir"] as string) || undefined,
    generatedAt: (flags["generated-at"] as string) || DEFAULT_GENERATED_AT,
    emitMasked: flags["emit-masked"] === true,
  };
}

export function main(argvIn?: string[]): number {
  const argv =
    argvIn ??
    (typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);

  // 1. Subject profile
  const paths = resolveProfilePaths(args.subjectsRoot, args.subject);
  const { matrix, errors } = loadEvalMatrix(paths.evalMatrix);
  if (errors.length > 0) {
    console.error(
      `audit-run: subject '${args.subject}' eval-matrix has ${errors.length} schema error(s):`,
    );
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  // 2. Run-bundle
  const { bundle } = loadBundle(args.bundleDir, args.runId);

  // 3. Deterministic pass
  const det = runDeterministic(matrix, bundle);

  // 4. Two-track scorecard
  const scorecard = assembleScorecard({
    subject: matrix.subject,
    runId: bundle.runId,
    generatedAt: args.generatedAt,
    rows: det.rows,
  });

  // 5. Render
  const html = renderReport(scorecard);

  const outDir = args.outDir ?? args.bundleDir;
  mkdirSync(join(outDir, "audit"), { recursive: true });
  const scPath = join(outDir, "audit", "scorecard.json");
  const htmlPath = join(outDir, "audit", "master-audit.html");
  const scJson = args.emitMasked
    ? maskedCanonicalJson(scorecard)
    : JSON.stringify(scorecard, null, 2);
  writeFileSync(scPath, scJson + "\n");
  writeFileSync(htmlPath, html);

  const coverage = scorecard.coverage;

  console.info(
    JSON.stringify(
      {
        subject: matrix.subject,
        runId: bundle.runId,
        criteria: countCriteria(matrix),
        deterministicRows: det.deterministicCount,
        judgeRows: det.judgeCount,
        gateRunPass: scorecard.gate.runPass,
        coverage,
        scorecard: scPath,
        report: htmlPath,
        bundleWarnings: bundle.warnings.length,
      },
      null,
      2,
    ),
  );

  // Coverage honesty (EV-OUT-002): a near-vacuous PASS must never go out
  // SILENTLY. Surface the skip-rate WARNING loudly on stderr — this is a
  // warning ONLY; it does NOT change the exit code / gate decision.
  if (coverage?.coverageWarning) {
    console.warn(
      `audit-run: COVERAGE WARNING — only ${coverage.graded}/${coverage.total} ` +
        `criteria graded (skip-rate ${(coverage.skipRate * 100).toFixed(1)}% > ` +
        `${(coverage.skipRateWarnThreshold * 100).toFixed(1)}% threshold). ` +
        `gateRunPass=${scorecard.gate.runPass} is near-vacuous — most criteria were skipped.`,
    );
  }

  return scorecard.gate.runPass ? 0 : 1;
}

declare const Bun: { argv: string[] } | undefined;
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  process.exit(main());
}
