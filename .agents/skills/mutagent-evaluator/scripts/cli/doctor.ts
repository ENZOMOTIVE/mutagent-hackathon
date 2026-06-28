/**
 * scripts/cli/doctor.ts
 * Runtime probe + environment validator + JSON health report.
 * Type A — Pure Script (deterministic environment inspection; READ-ONLY).
 *
 * Detects the JS runtime (bun | pnpm-tsx | npx-tsx | node), checks required
 * environment variables (name-level presence only — values are NEVER read or
 * surfaced), reports SKILL.md version, lock-file presence, and git availability.
 * Exits 0 with a structured JSON report — it mutates NOTHING (mirrors the
 * diagnostics doctor; the evaluator is a reviewer, never an executor).
 *
 * Usage: scripts/cli/run.sh scripts/cli/doctor.ts
 *
 * Output shape:
 *   { runtime, env: { present[], missing[] }, version, lockFile, gitAvailable, errors[] }
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * JS runtime executing this script. Corresponds to the runtime selector in
 * scripts/cli/run.sh: bun → `bun run`, pnpm-tsx → `pnpm exec tsx`,
 * npx-tsx → `npx tsx`, node → bare node.
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
  /** Presence/absence of required env vars (name-level only). */
  env: DoctorEnvReport;
  /** Skill version string from SKILL.md frontmatter, or null if unreadable. */
  version: string | null;
  /** Lock-file detected in the skill root, or null. */
  lockFile: string | null;
  /** Whether `git` is available in PATH (branch-hygiene operations need it). */
  gitAvailable: boolean;
  /** Non-fatal warnings or missing-env notices. Exit code is still 0. */
  errors: string[];
}

// ── Required env vars ──────────────────────────────────────────────────────────
//
// The evaluator's DEFAULT transport is host-runtime agent-dispatch (no provider
// SDK call), so none of these are hard requirements — they are surfaced as
// non-fatal notices. LANGFUSE_* enable a live trace SOURCE; GOOGLE_API_KEY is
// only needed on the OPTIONAL in-house AI-SDK judge substrate.
const REQUIRED_ENV_VARS: string[] = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASEURL",
  "GOOGLE_API_KEY",
];

// ── Runtime detection ─────────────────────────────────────────────────────────

/**
 * Detect the JS runtime executing this script.
 * Order: Bun (process.versions.bun) → pnpm (npm_config_user_agent) →
 * npx/npm (npm_execpath) → bare node.
 *
 * NOTE: this detects the SCRIPT RUNNER, not the coding-agent runtime. For the
 * coding-agent runtime (claude-code, codex, cursor…) see cli/init.ts.
 */
export function detectJsRuntime(): DoctorRuntime {
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) return "bun";

  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm-tsx";

  if (process.env.npm_execpath) return "npx-tsx";

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
    if (val && val.length > 0) present.push(name);
    else missing.push(name);
  }
  return { present, missing };
}

// ── SKILL.md version ──────────────────────────────────────────────────────────

/**
 * Read the skill version from SKILL.md frontmatter (the `version:` key, which is
 * nested under `metadata:` in the evaluator's frontmatter). Returns null if
 * SKILL.md is absent or the version field is missing.
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
 * Checks: bun.lockb, bun.lock, pnpm-lock.yaml, package-lock.json, yarn.lock.
 */
export function detectLockFile(dir: string): string | null {
  const candidates = ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return name;
  }
  return null;
}

// ── Git availability ──────────────────────────────────────────────────────────

/**
 * Check whether `git` is available in PATH. Uses execSync with stdio suppressed —
 * no shell expansion of user input.
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
 * Run the full doctor probe and return a structured report. Never throws —
 * errors are collected in report.errors[]. READ-ONLY: mutates nothing on disk.
 */
export function runDoctor(): DoctorReport {
  const errors: string[] = [];

  // Canonical script dir: realpath-resolve through any symlink chain (the skill
  // is often dev-symlinked into a worktree; mirrors init.ts cwd-leak safety).
  const scriptDir = realpathSync(
    import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, "")
  );

  const runtime = detectJsRuntime();
  const env = checkEnvVars();
  const version = readSkillVersion(scriptDir);
  const lockFile = detectLockFile(resolve(scriptDir, "../.."));
  const gitAvailable = checkGitAvailable();

  if (env.missing.length > 0) {
    errors.push(
      `Missing env vars: ${env.missing.join(", ")} ` +
        `(non-fatal — the DEFAULT agent-dispatch transport needs none; LANGFUSE_* enable a live ` +
        `trace source, GOOGLE_API_KEY only the OPTIONAL in-house judge substrate)`
    );
  }
  if (!gitAvailable) {
    errors.push("git not found in PATH — branch-hygiene / route-to-diagnostics operations will fail");
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
