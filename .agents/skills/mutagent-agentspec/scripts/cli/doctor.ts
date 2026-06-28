/**
 * scripts/cli/doctor.ts
 * Runtime probe + JSON health report.
 * Type A — Pure Script (deterministic environment inspection).
 *
 * Detects the JS runtime (bun | pnpm-tsx | npx-tsx | node), reports the SKILL.md version, the
 * lock-file present in the skill root, and whether git is available. agentspec has NO external
 * provider deps (no Langfuse/Google), so there is NO required-env-var probe — keeping doctor lean.
 *
 * Usage: scripts/cli/run.sh scripts/cli/doctor.ts
 * Output: { runtime, version, lockFile, gitAvailable, errors[] }
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

export type DoctorRuntime = "bun" | "pnpm-tsx" | "npx-tsx" | "node";

export interface DoctorReport {
  /** JS runtime executing this skill's scripts. */
  runtime: DoctorRuntime;
  /** Skill version string from SKILL.md frontmatter/metadata, or null if unreadable. */
  version: string | null;
  /** Lock-file detected in the skill root, or null. */
  lockFile: string | null;
  /** Whether `git` is available in PATH. */
  gitAvailable: boolean;
  /** Non-fatal warnings. Exit code is still 0. */
  errors: string[];
}

/**
 * Detect the JS runtime executing this script.
 *   1. Bun: process.versions.bun set under Bun.
 *   2. pnpm-tsx: npm_config_user_agent starts with "pnpm".
 *   3. npx-tsx: npm_execpath set (npm/npx).
 *   4. node: bare node fallback.
 */
export function detectJsRuntime(): DoctorRuntime {
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) return "bun";
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm-tsx";
  if (process.env.npm_execpath) return "npx-tsx";
  return "node";
}

/**
 * Read the skill version from SKILL.md (the `version:` key, possibly indented under `metadata:`).
 * Returns null if SKILL.md is absent or the version field is missing.
 * SKILL.md lives at <skill-root>/SKILL.md; this script is at <skill-root>/scripts/cli/doctor.ts.
 */
export function readSkillVersion(scriptDir: string): string | null {
  const skillMd = resolve(scriptDir, "../..", "SKILL.md");
  if (!existsSync(skillMd)) return null;
  try {
    const content = readFileSync(skillMd, "utf8");
    const match = content.match(/^\s*version:\s*["']?([^"'\n\r]+?)["']?\s*$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Detect the first lock file present in `dir`. */
export function detectLockFile(dir: string): string | null {
  const candidates = ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return name;
  }
  return null;
}

/** Check whether `git` is available in PATH. */
export function checkGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run the full doctor probe and return a structured report. Never throws. */
export function runDoctor(): DoctorReport {
  const errors: string[] = [];
  const scriptDir = realpathSync(
    import.meta.dirname ??
      import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""),
  );

  const runtime = detectJsRuntime();
  const version = readSkillVersion(scriptDir);
  const lockFile = detectLockFile(resolve(scriptDir, "../.."));
  const gitAvailable = checkGitAvailable();

  if (!gitAvailable) {
    errors.push("git not found in PATH — branch-hygiene operations will fail");
  }
  if (version === null) {
    errors.push("Could not read SKILL.md version");
  }

  return { runtime, version, lockFile, gitAvailable, errors };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const report = runDoctor();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}
