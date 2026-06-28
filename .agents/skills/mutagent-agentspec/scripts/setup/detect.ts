/**
 * scripts/setup/detect.ts
 * Minimal setup-presence probe used by SKILL.md §0.
 * Type A — Pure Script (file reads only — no I/O side effects).
 *
 * Wave-1 is LEAN: there is no onboarding FSM yet (that is a later wave). "complete" simply means
 * the skill is installed — i.e. its SKILL.md resolves from this script's location. The *spec
 * interview needs no config file to run; it reads from the operator interactively. So the probe is
 * deliberately thin: it confirms the skill tree is intact and reports a stable, JSON-shaped result.
 *
 * Usage: scripts/cli/run.sh scripts/setup/detect.ts
 *   exit 0 = skill installed (complete)
 *   exit 1 = skill tree incomplete (SKILL.md not found from the script location)
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface SetupResult {
  /** True when the skill tree is intact (SKILL.md resolves) — the Wave-1 completeness bar. */
  complete: boolean;
  /** Absolute path the probe checked for SKILL.md (for transparency / debugging). */
  skillMdPath: string;
  /** Human-readable note for the dashboard / caller. */
  note: string;
}

/**
 * Resolve this script's directory through any symlink chain (rapid-skill-iteration symlinks are an
 * intentional dev pattern), then check for the skill's SKILL.md two levels up:
 *   scripts/setup/detect.ts -> scripts/setup -> scripts -> <skill-root>/SKILL.md
 */
export function resolveSkillRoot(scriptDir: string): string {
  return resolve(scriptDir, "..", "..");
}

/**
 * Run the presence probe. Pure given `scriptDir` — the caller passes the resolved script dir so the
 * function is testable against a temp tree (no import.meta dependency inside the pure core).
 */
export function detectSetup(scriptDir: string): SetupResult {
  const skillRoot = resolveSkillRoot(scriptDir);
  const skillMdPath = resolve(skillRoot, "SKILL.md");
  const complete = existsSync(skillMdPath);
  return {
    complete,
    skillMdPath,
    note: complete
      ? "mutagent-agentspec is installed. Run *spec to begin the guided interview."
      : "mutagent-agentspec skill tree incomplete — SKILL.md not found. Reinstall: pnpx @mutagent/agentspec init",
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  // Realpath-resolve through any symlink chain (cwd-leak / symlink-iteration safety).
  const scriptDir = realpathSync(
    import.meta.dirname ??
      import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""),
  );
  const result = detectSetup(scriptDir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.complete ? 0 : 1);
}
