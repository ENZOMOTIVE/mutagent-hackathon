/**
 * scripts/setup/detect.ts
 * Detect config presence + per-field completeness (FR-001, FR-002)
 * Type A — Pure Script (file reads + state checks — no I/O side effects)
 *
 * Usage: bun scripts/setup/detect.ts [project-root]
 * Exit 0 = config present + complete
 * Exit 1 = config missing or incomplete
 */

import { existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../config/load.ts";
import { validateConfig } from "../config/validate.ts";
import { planCliEnsure } from "./ensure-cli.ts";
import type { CliEnsurePlan, CliProbe } from "./ensure-cli.ts";
import type { SourcePlatform } from "../normalize/trace.ts";

export type SetupState = "missing" | "partial" | "complete";

// ── R-SELF-05-a: CWD-leak guard helpers ──────────────────────────────────────

/**
 * Walk parent directories from `cwd` upward until we find a directory
 * containing a `.git` entry. Returns the git root, or null if not found
 * within the filesystem root.
 */
export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  const root = current.split("/")[0] + "/"; // filesystem root
  while (current !== root) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) break; // at filesystem root
    current = parent;
  }
  return null;
}

/**
 * Detect if `cwd` is inside a skills directory (i.e. ~/.claude/skills/<skill>
 * or any path that looks like a deployed skill dir). If so, exit(1) with an
 * actionable error message.
 *
 * The canonical smell is: cwd is inside `<home>/.claude/skills/` or the path
 * contains `/.claude/skills/` anywhere, which indicates the script is running
 * FROM inside the skill package rather than from a project root.
 *
 * R-SELF-05-a: prevents "detect confusing the skill dir for the project root"
 * which caused false-negative setup detection during dogfood (F-SELF-05).
 */
export function assertNotInSkillDir(cwd: string): void {
  const normalised = resolve(cwd);
  // Pattern 1: inside ~/.claude/skills/<skill>
  const home = process.env.HOME ?? "";
  const userSkillsPrefix = join(home, ".claude", "skills");
  if (home && normalised.startsWith(userSkillsPrefix + "/")) {
    process.stderr.write(
      `[mutagent-diagnostics] ERROR: detect.ts invoked with cwd="${normalised}",\n` +
      `which is INSIDE the skill's install directory (${userSkillsPrefix}/).\n` +
      `This means you are running setup detection FROM the skill package, not from your project root.\n` +
      `\nFIX: pass your project root as the argument:\n` +
      `  bun scripts/cli/run.sh scripts/setup/detect.ts /path/to/your/project\n` +
      `  # or omit the arg to use the current working directory of your shell.\n`
    );
    process.exit(1);
  }

  // Pattern 2: path contains /.claude/skills/ anywhere (worktree / symlink chain)
  if (normalised.includes("/.claude/skills/")) {
    process.stderr.write(
      `[mutagent-diagnostics] ERROR: detect.ts invoked with cwd="${normalised}",\n` +
      `which appears to be inside a .claude/skills/ directory.\n` +
      `Pass your actual project root instead of the skill install path.\n`
    );
    process.exit(1);
  }
}

export interface DetectResult {
  state: SetupState;
  configPath: string;
  exists: boolean;
  valid: boolean;
  missingFields: string[];
  errors: Array<{ path: string; message: string }>;
}

export function detectSetup(projectRoot: string): DetectResult {
  const configPath = resolve(projectRoot, ".mutagent-diagnostics", "config.yaml");
  const exists = existsSync(configPath);

  if (!exists) {
    return {
      state: "missing",
      configPath,
      exists: false,
      valid: false,
      missingFields: ["source.platform", "target.platform", "ask_tool.runtime"],
      errors: [],
    };
  }

  const loadResult = loadConfig(projectRoot);

  if (loadResult.error) {
    return {
      state: "partial",
      configPath,
      exists: true,
      valid: false,
      missingFields: [],
      errors: [{ path: "config.yaml", message: loadResult.error }],
    };
  }

  if (!loadResult.config) {
    return {
      state: "partial",
      configPath,
      exists: true,
      valid: false,
      missingFields: ["(empty config)"],
      errors: [],
    };
  }

  const validation = validateConfig(loadResult.config);

  return {
    state: validation.valid ? "complete" : "partial",
    configPath,
    exists: true,
    valid: validation.valid,
    missingFields: validation.missingFields,
    errors: validation.errors,
  };
}

// ── Source-platform CLI detection (PR-021) ────────────────────────────────────

/**
 * Probe whether the chosen source platform's CLI is installed, and return a
 * plan describing what onboarding should do (offer an approval-gated install,
 * fall back to REST/file, or nothing). Pure read — NEVER installs.
 *
 * Thin wrapper over `planCliEnsure` so callers can stay in the `setup/detect.ts`
 * surface for all "what state is setup in?" probes. The actual approval prompt
 * and install live in `cli/init.ts` (the only sanctioned installer).
 *
 * @param platform - The configured/chosen source platform.
 * @param probe - Injectable PATH probe (for deterministic tests).
 */
export function detectSourceCli(
  platform: SourcePlatform,
  probe?: CliProbe
): CliEnsurePlan {
  return planCliEnsure(platform, probe);
}

// CLI entrypoint
if (import.meta.main) {
  const argv = process.argv.slice(2);

  // Subcommand: `detect.ts --cli <platform>` — probe a source platform's CLI.
  const cliFlagIdx = argv.indexOf("--cli");
  if (cliFlagIdx !== -1) {
    const platform = argv[cliFlagIdx + 1] as SourcePlatform | undefined;
    if (!platform) {
      process.stderr.write(
        "[mutagent-diagnostics] ERROR: --cli requires a source platform argument.\n" +
        "  usage: detect.ts --cli <langfuse|otel|local-jsonl|claude-code|codex>\n"
      );
      process.exit(2);
    }
    const plan = detectSourceCli(platform);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    // Exit 0 when the CLI is present or not required; 1 when missing (any kind).
    process.exit(plan.status === "present" || plan.status === "not-required" ? 0 : 1);
  }

  const projectRoot = argv.filter((a) => !a.startsWith("--"))[0] ?? process.cwd();
  // R-SELF-05-a: guard against running from inside the skill dir
  assertNotInSkillDir(projectRoot);
  const result = detectSetup(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.state === "complete" ? 0 : 1);
}
