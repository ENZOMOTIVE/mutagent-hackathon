/**
 * scripts/cli/profile-subject.ts — Mode B entrypoint.
 * ---------------------------------------------------------------------------
 * Mode B GENERATES a subject profile (subjects/<name>/{eval-matrix,behavior-tree,
 * methodology-review}.yaml) from a skill/agent definition + traces. This is how
 * the matrix is BORN — generated, not embedded in the agent.
 *
 * MATURITY — functional seam, not fully wired:
 *   The deterministic spine here is REAL: it (a) validates inputs exist, (b)
 *   scaffolds the subjects/<name>/ directory, and (c) writes schema-conformant
 *   SEED YAML files (empty-but-valid frames carrying subject/version/generatedAt
 *   + the 12 design principles + the MR-1..9 rubric skeleton) that pass the
 *   shape contracts. The criteria-DERIVATION step (reading the def + traces and
 *   proposing component x dimension x checkMethod rows + an interesting-dataset
 *   shortlist) is a PINNED-JUDGE SEAM — it requires the pinned model reasoning
 *   over the subject's source + traces. The agent card's Mode-B workflow + the
 *   audit workflow dispatch that judge. This CLI writes the SEED + marks the
 *   seam; it never fabricates derived criteria silently.
 *
 *   profile-subject.ts <defPath> <tracesPath> --name <subject>
 *                      [--subjects-root <dir>] [--generated-at <iso>]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_GENERATED_AT } from "./audit-run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");

const MR_RUBRIC_SKELETON = [
  { id: "MR-1", title: "Decision-tree fitness", reads: "behavior-tree + run outcomes", how: "judge reasons over each fork vs what the run needed", family: "decision-tree-fitness", advisory: true },
  { id: "MR-2", title: "Data-flow efficiency", reads: "pipeline trace", how: "scan for redundant/recomputed transforms, collapsible stages", family: "data-flow-efficiency", advisory: true },
  { id: "MR-3", title: "Methodology fitness given findings", reads: "run trajectory + findings", how: "did depth/breadth match the need?", family: "methodology-fitness", advisory: true },
  { id: "MR-4", title: "Sequence soundness", reads: "transcript trajectory", how: "does later work invalidate earlier work?", family: "sequence-soundness", advisory: true },
  { id: "MR-5", title: "Process self-feedback", reads: "all of the above", how: "ranked rearrange/improve proposals", family: "process-self-feedback", advisory: true },
  { id: "MR-6", title: "Followed != Right", reads: "matrix (Tab-1) vs this (Tab-4)", how: "separate conformance from fitness", family: "conformance-vs-fitness", advisory: true },
  { id: "MR-7", title: "Signal/failure-mode selection", reads: "tier0 -> awareness -> deep-read chain", how: "was the primary signal grounded in the right evidence tier?", family: "signal-selection", advisory: true },
  { id: "MR-8", title: "Confidence derivation", reads: "coverageConfidence vs deep-read sample", how: "does the confidence FOLLOW from the LLM-trace evidence?", family: "confidence-derivation", advisory: true },
  { id: "MR-9", title: "Focus determination -> search-shaping", reads: "scope/focus decision + examined traces", how: "expected-focus vs observed-focus given brief + tier-0 signals", family: "focus-determination", advisory: true },
];

const DESIGN_PRINCIPLES_SEED = [
  "Determinism-before-judgment: prefer deterministic-script / typebox-schema / gate; reserve llm-judge + trajectory-diff for genuinely behavioral rows.",
  "Severity by variance-impact, not code size.",
  "Three-dimension MECE coverage per component (operation-correctness / data-correctness / operational-deviation).",
  "Full-dereference-surface gate principle (C-GATE).",
  "Pin-and-record every stochastic/environmental variable (C-PIN), honoring model-intent-sacred.",
  "Byte-identity masking contract as the determinism acceptance test.",
  "Scope-locus attribution for every criterion (MECE SKILL/AGENT/COMMAND).",
  "Existing-coverage honesty: covered/partial/none against the actual test+gate inventory.",
  "No-filler rule: every criterion grounded in a cited intended behavior or observed deviation.",
];

interface Args {
  defPath: string;
  tracesPath: string;
  name: string;
  subjectsRoot: string;
  generatedAt: string;
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
  if (positional.length < 2 || !flags.name) {
    throw new Error(
      "usage: profile-subject.ts <defPath> <tracesPath> --name <subject> [--subjects-root <dir>] [--generated-at <iso>]",
    );
  }
  return {
    defPath: positional[0],
    tracesPath: positional[1],
    name: flags.name,
    subjectsRoot: flags["subjects-root"] || join(PKG_ROOT, "subjects"),
    generatedAt: flags["generated-at"] || DEFAULT_GENERATED_AT,
  };
}

export function main(argvIn?: string[]): number {
  const argv =
    argvIn ??
    (typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2));
  const args = parseArgs(argv);

  if (!existsSync(args.defPath)) {
    console.error(`profile-subject: definition not found: ${args.defPath}`);
    return 2;
  }
  if (!existsSync(args.tracesPath)) {
    console.error(`profile-subject: traces not found: ${args.tracesPath}`);
    return 2;
  }

  const dir = join(args.subjectsRoot, args.name);
  mkdirSync(dir, { recursive: true });

  // SEED frames — schema-conformant, empty components/nodes awaiting the judge.
  const evalMatrixSeed = {
    subject: args.name,
    version: "v1",
    generatedAt: args.generatedAt,
    designPrinciples: DESIGN_PRINCIPLES_SEED,
    components: [] as unknown[],
  };
  const behaviorTreeSeed = {
    subject: args.name,
    version: "v1",
    generatedAt: args.generatedAt,
    root: "ROOT",
    nodes: [] as unknown[],
  };
  const methodologyReviewSeed = {
    subject: args.name,
    version: "v1",
    generatedAt: args.generatedAt,
    items: MR_RUBRIC_SKELETON,
  };

  writeFileSync(
    join(dir, "eval-matrix.yaml"),
    "# SEED profile — components[] derived by the Mode-B pinned-judge seam.\n" +
      stringifyYaml(evalMatrixSeed),
  );
  writeFileSync(
    join(dir, "behavior-tree.yaml"),
    "# SEED behavior-tree — nodes[] derived by the Mode-B pinned-judge seam.\n" +
      stringifyYaml(behaviorTreeSeed),
  );
  writeFileSync(
    join(dir, "methodology-review.yaml"),
    "# MR rubric — MR-1..9 skeleton (generic, reused per subject).\n" +
      stringifyYaml(methodologyReviewSeed),
  );

  console.info(
    JSON.stringify(
      {
        subject: args.name,
        seededAt: dir,
        files: ["eval-matrix.yaml", "behavior-tree.yaml", "methodology-review.yaml"],
        seam: "PINNED-JUDGE: criteria + behavior-tree nodes + interesting-dataset shortlist are derived by the Mode-B judge reading the def + traces. SEED frames written; derived rows NOT fabricated.",
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
