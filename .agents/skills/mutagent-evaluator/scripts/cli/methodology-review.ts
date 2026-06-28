/**
 * scripts/cli/methodology-review.ts — Mode C entrypoint.
 * ---------------------------------------------------------------------------
 * Mode C emits process self-feedback: is the methodology the RIGHT/efficient
 * choice + how to rearrange (advisory, NOT pass/fail). §1.5 family / MR-1..9.
 *
 * MATURITY — functional seam, not fully wired:
 *   The deterministic spine here is REAL: it loads the subject's behavior-tree +
 *   methodology-review rubric, loads the run-bundle, and assembles the JUDGE
 *   PROMPT CONTEXT (the behavior-tree nodes + the run trajectory + the MR rubric)
 *   that the methodology-critic lens consumes. The actual fitness REASONING
 *   (decision-tree fitness · data-flow efficiency · ranked self-feedback) is a
 *   PINNED-JUDGE SEAM — it requires the pinned model running the
 *   lenses/methodology-critic-lens.md prompt. This CLI prepares + emits the
 *   judge context (so the judge has a complete, deterministic input) and marks
 *   the seam; it never fabricates fitness verdicts.
 *
 *   methodology-review.ts <runId> --subject <name> [--bundle-dir <dir>]
 *                         [--subjects-root <dir>]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfilePaths, loadYamlFile } from "../load-profile.ts";
import { loadBundle } from "../load-bundle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");

interface Args {
  runId: string;
  subject: string;
  bundleDir: string;
  subjectsRoot: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else positional.push(a);
  }
  if (!positional[0] || !flags.subject) {
    throw new Error(
      "usage: methodology-review.ts <runId> --subject <name> [--bundle-dir <dir>] [--subjects-root <dir>] [--out <file>]",
    );
  }
  return {
    runId: positional[0],
    subject: flags.subject,
    bundleDir:
      flags["bundle-dir"] ||
      join(process.cwd(), ".mutagent-diagnostics", positional[0]),
    subjectsRoot: flags["subjects-root"] || join(PKG_ROOT, "subjects"),
    out: flags.out || undefined,
  };
}

export function main(argvIn?: string[]): number {
  const argv =
    argvIn ??
    (typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);

  const paths = resolveProfilePaths(args.subjectsRoot, args.subject);
  const behaviorTree = loadYamlFile(paths.behaviorTree);
  const mrRubric = loadYamlFile(paths.methodologyReview);
  const { bundle } = loadBundle(args.bundleDir, args.runId);

  // Assemble the COMPLETE, deterministic judge context. The judge (the pinned
  // model running the methodology-critic lens) consumes exactly this.
  const judgeContext = {
    subject: args.subject,
    runId: bundle.runId,
    behaviorTree,
    methodologyRubric: mrRubric,
    runTrajectory: {
      runMeta: bundle.data.runMeta ?? null,
      renderInput: bundle.data.renderInput ?? null,
      evidence: bundle.data.evidence ?? null,
    },
    seam: "PINNED-JUDGE: the fitness reasoning (decision-tree fitness, data-flow efficiency, ranked self-feedback) is produced by the pinned model running lenses/methodology-critic-lens.md over this context. This CLI emits the context; it does not fabricate fitness verdicts.",
  };

  const json = JSON.stringify(judgeContext, null, 2);
  if (args.out) writeFileSync(args.out, json + "\n");

  console.info(
    JSON.stringify(
      {
        subject: args.subject,
        runId: bundle.runId,
        behaviorTreeNodes: Array.isArray(
          (behaviorTree as { nodes?: unknown[] })?.nodes,
        )
          ? (behaviorTree as { nodes: unknown[] }).nodes.length
          : 0,
        mrItems: Array.isArray((mrRubric as { items?: unknown[] })?.items)
          ? (mrRubric as { items: unknown[] }).items.length
          : 0,
        judgeContextOut: args.out ?? "(stdout only)",
        seam: judgeContext.seam,
      },
      null,
      2,
    ),
  );
  return 0;
}

declare const Bun: { argv: string[] } | undefined;
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  process.exit(main());
}
