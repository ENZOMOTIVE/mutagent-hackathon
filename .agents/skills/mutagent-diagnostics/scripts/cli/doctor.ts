/**
 * scripts/cli/doctor.ts
 * Runtime probe + environment validator + JSON health report (I-018)
 * Type A — Pure Script (deterministic environment inspection)
 *
 * Detects the JS runtime (bun | pnpm-tsx | npx-tsx | node), checks required
 * environment variables, reports SKILL.md version, lock-file presence, and git
 * availability. Exits 0 with a structured JSON report.
 *
 * Usage: scripts/cli/run.sh scripts/cli/doctor.ts
 *
 * Output shape:
 *   { runtime, env: { present[], missing[] }, version, lockFile, gitAvailable, errors[] }
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * JS runtime executing this script.
 * Corresponds to the runtime selector in scripts/cli/run.sh:
 *   bun        → `bun run`
 *   pnpm-tsx   → `pnpm exec tsx`
 *   npx-tsx    → `npx tsx`
 *   node       → bare node (ESM or CJS, no tsx transpile)
 */
export type DoctorRuntime = "bun" | "pnpm-tsx" | "npx-tsx" | "node";

export interface DoctorEnvReport {
  /** Env var names that are SET (non-empty). Values are never surfaced. */
  present: string[];
  /** Env var names that are ABSENT or empty. */
  missing: string[];
}

export interface DoctorReport {
  /** JS runtime executing this skill's scripts. */
  runtime: DoctorRuntime;
  /** Presence/absence of required env vars (LANGFUSE_*, GOOGLE_API_KEY). */
  env: DoctorEnvReport;
  /** Skill version string from SKILL.md frontmatter, or null if unreadable. */
  version: string | null;
  /** Lock-file detected in the skill root (bun.lockb, pnpm-lock.yaml, etc.), or null. */
  lockFile: string | null;
  /** Whether `git` is available in PATH. Some skill operations require git. */
  gitAvailable: boolean;
  /** Non-fatal warnings or missing-env notices. Exit code is still 0. */
  errors: string[];
}

// ── Required env vars (I-018) ─────────────────────────────────────────────────

const REQUIRED_ENV_VARS: string[] = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASEURL",
  "GOOGLE_API_KEY",
];

// ── Runtime detection ─────────────────────────────────────────────────────────

/**
 * Detect the JS runtime executing this script.
 *
 * Detection order:
 *  1. Bun: `process.versions.bun` is set when running under the Bun runtime.
 *  2. pnpm-tsx: npm_config_user_agent starts with "pnpm" (pnpm sets this).
 *  3. npx-tsx: npm_execpath is set (npm/npx sets this).
 *  4. node: bare node fallback.
 *
 * NOTE: This detects the SCRIPT RUNNER, not the coding-agent runtime.
 * For the coding-agent runtime (claude-code, codex, cursor…) see cli/init.ts.
 */
export function detectJsRuntime(): DoctorRuntime {
  // Bun runtime sets process.versions.bun
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) {
    return "bun";
  }

  // pnpm sets npm_config_user_agent like "pnpm/8.x.x npm/9.x.x ..."
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) {
    return "pnpm-tsx";
  }

  // npx/npm sets npm_execpath to the npm/npx binary path
  if (process.env.npm_execpath) {
    return "npx-tsx";
  }

  return "node";
}

// ── Env var check ─────────────────────────────────────────────────────────────

/**
 * Check which required env vars are present vs missing.
 * Values are never read or returned — only name-level presence/absence.
 */
export function checkEnvVars(required: string[] = REQUIRED_ENV_VARS): DoctorEnvReport {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const val = process.env[name];
    if (val && val.length > 0) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }
  return { present, missing };
}

// ── SKILL.md version ──────────────────────────────────────────────────────────

/**
 * Read the skill version from SKILL.md frontmatter (the `version:` key).
 * Returns null if SKILL.md is absent or the version field is missing.
 *
 * SKILL.md lives at <skill-root>/SKILL.md; this script is at
 * <skill-root>/scripts/cli/doctor.ts → two directories up.
 */
export function readSkillVersion(scriptDir: string): string | null {
  const skillMd = resolve(scriptDir, "../..", "SKILL.md");
  if (!existsSync(skillMd)) return null;
  try {
    const content = readFileSync(skillMd, "utf8");
    // Match `version: "0.1.0"` or `  version: "0.1.0"` (indented in metadata: block)
    const match = content.match(/^\s*version:\s*["']?([^"'\n\r]+?)["']?\s*$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ── Lock file detection ───────────────────────────────────────────────────────

/**
 * Detect the first lock file present in the given directory.
 * Checks: bun.lockb, pnpm-lock.yaml, package-lock.json, yarn.lock.
 */
export function detectLockFile(dir: string): string | null {
  const candidates = ["bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return name;
  }
  return null;
}

// ── Git availability ──────────────────────────────────────────────────────────

/**
 * Check whether `git` is available in PATH.
 * Uses child_process.execSync with stdio suppressed — no shell expansion.
 */
export function checkGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Main doctor function ──────────────────────────────────────────────────────

/**
 * Run the full doctor probe and return a structured report.
 * Never throws — errors are collected in report.errors[].
 */
export function runDoctor(): DoctorReport {
  const errors: string[] = [];

  // Canonical script dir: realpath-resolve through any symlink chain
  // (same pattern as install-agents.ts / init.ts for cwd-leak safety)
  const scriptDir = realpathSync(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""));

  const runtime = detectJsRuntime();
  const env = checkEnvVars();
  const version = readSkillVersion(scriptDir);
  const lockFile = detectLockFile(resolve(scriptDir, "../.."));
  const gitAvailable = checkGitAvailable();

  // Collect non-fatal warnings
  if (env.missing.length > 0) {
    errors.push(`Missing env vars: ${env.missing.join(", ")}`);
  }
  if (!gitAvailable) {
    errors.push("git not found in PATH — branch-hygiene operations will fail");
  }
  if (version === null) {
    errors.push("Could not read SKILL.md version");
  }

  return { runtime, env, version, lockFile, gitAvailable, errors };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const report = runDoctor();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}
