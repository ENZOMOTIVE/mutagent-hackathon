/**
 * scripts/cli/init.ts
 * LEAN cross-platform installer for mutagent-agentspec.
 * Invoked as: pnpx @mutagent/agentspec init
 *
 * Wave-1 keeps this minimal — NO onboarding FSM (that is a later wave). init's whole job:
 *   1. Detect installed coding-agent platforms via home markers (~/.claude, ~/.codex).
 *   2. Copy the skill tree into the install target:
 *        project (DEFAULT) → <cwd>/.claude/skills/mutagent-agentspec  (and .codex)
 *        global (--global)  → ~/.claude/skills/mutagent-agentspec      (and ~/.codex)
 *   3. Copy the two shipped sub-agent contracts (assets/agents/*.md) into <target>/.claude/agents.
 *
 * cwd discipline: the SOURCE skill dir is resolved from import.meta (correct through any symlink
 * chain); the install TARGET root is the user's invocation cwd (process.cwd()), NEVER the script
 * dir — overriding it would install the skill into itself.
 */

import {
  existsSync,
  readdirSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type Scope = "project" | "global";
export type PlatformId = "claude-code" | "codex";

export interface DetectedPlatform {
  id: PlatformId;
  label: string;
  /** Home marker probed to decide whether the platform exists on this machine. */
  detectionMarker: string;
  detected: boolean;
  /** Where the skill tree is installed (follows scope). */
  skillInstallPath: string;
  /** Where the sub-agent .md files are installed (follows scope). */
  agentsInstallPath: string;
}

export interface PlatformInstallResult {
  platform: PlatformId;
  success: boolean;
  steps: Array<{ step: string; ok: boolean; note: string }>;
  errors: string[];
}

/** Resolve install scope from argv. DEFAULT is project-local; `--global` opts into the home dir. */
export function resolveScope(argv: string[]): Scope {
  return argv.includes("--global") ? "global" : "project";
}

/**
 * Probe the filesystem for installed coding-agent platforms. Detection uses HOME markers (does the
 * runtime exist on this machine?); the install TARGET follows `scope`:
 *   project (DEFAULT) → <cwd>/.claude|.codex/…   global → <home>/.claude|.codex/…
 */
export function detectInstalledPlatforms(
  cwd: string = process.cwd(),
  scope: Scope = "project",
  home: string = homedir(),
): DetectedPlatform[] {
  const claudeRoot = scope === "global" ? join(home, ".claude") : join(cwd, ".claude");
  const codexRoot = scope === "global" ? join(home, ".codex") : join(cwd, ".codex");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      detectionMarker: join(home, ".claude"),
      detected: existsSync(join(home, ".claude")),
      skillInstallPath: join(claudeRoot, "skills", "mutagent-agentspec"),
      agentsInstallPath: join(claudeRoot, "agents"),
    },
    {
      id: "codex",
      label: "Codex",
      detectionMarker: join(home, ".codex"),
      detected: existsSync(join(home, ".codex")),
      skillInstallPath: join(codexRoot, "skills", "mutagent-agentspec"),
      agentsInstallPath: join(codexRoot, "agents"),
    },
  ];
}

/**
 * Install the skill + its sub-agent contracts to a single platform.
 * Pure-ish: all filesystem effects are scoped to the platform's install paths; the source dir is
 * injected so the function is testable against temp trees.
 */
export function installToPlatform(
  platform: DetectedPlatform,
  skillSourceDir: string,
  force = false,
): PlatformInstallResult {
  const result: PlatformInstallResult = {
    platform: platform.id,
    success: false,
    steps: [],
    errors: [],
  };

  // ── Step 1: copy the skill tree ──────────────────────────────────────────────
  const skillDest = platform.skillInstallPath;
  try {
    if (existsSync(skillDest) && !force) {
      result.steps.push({
        step: "copy-skill",
        ok: true,
        note: `Skill already exists at ${skillDest} (use --force to overwrite).`,
      });
    } else {
      mkdirSync(skillDest, { recursive: true });
      cpSync(skillSourceDir, skillDest, { recursive: true, force: true });
      result.steps.push({ step: "copy-skill", ok: true, note: `Copied skill to ${skillDest}.` });
    }
  } catch (err) {
    const msg = `Failed to copy skill to ${skillDest}: ${err instanceof Error ? err.message : String(err)}`;
    result.steps.push({ step: "copy-skill", ok: false, note: msg });
    result.errors.push(msg);
    return result;
  }

  // ── Step 2: copy the shipped sub-agent contracts ─────────────────────────────
  const agentsSrc = join(skillSourceDir, "assets", "agents");
  const agentsDest = platform.agentsInstallPath;
  try {
    if (existsSync(agentsSrc)) {
      const agentFiles = readdirSync(agentsSrc).filter((f) => f.endsWith(".md"));
      mkdirSync(agentsDest, { recursive: true });
      for (const f of agentFiles) {
        copyFileSync(join(agentsSrc, f), join(agentsDest, f));
      }
      result.steps.push({
        step: "install-agents",
        ok: true,
        note: `Installed ${agentFiles.length} sub-agent contract(s) to ${agentsDest}.`,
      });
    } else {
      result.steps.push({ step: "install-agents", ok: true, note: "No assets/agents/ — skipped." });
    }
  } catch (err) {
    const msg = `Failed to install agents to ${agentsDest}: ${err instanceof Error ? err.message : String(err)}`;
    result.steps.push({ step: "install-agents", ok: false, note: msg });
    result.errors.push(msg);
  }

  result.success = result.errors.length === 0;
  return result;
}

// ── Usage ─────────────────────────────────────────────────────────────────────
const USAGE = `
mutagent-agentspec init — cross-platform skill installer

USAGE
  pnpx @mutagent/agentspec init [--global] [--yes] [--force]

INSTALL SCOPE
  (default)   PROJECT-LOCAL — install into the directory you ran init in:
                Claude Code → <cwd>/.claude/…   Codex → <cwd>/.codex/…
  --global    HOME DIR      — install into ~/.claude/… and ~/.codex/…

OPTIONS
  --global    Install into the home dir instead of the project (default: project-local)
  --yes       Non-interactive: install to all detected platforms
  --force     Overwrite an existing skill install
  --help      Show this message

After install, open your coding agent and invoke the skill, then *spec to begin.
`.trim();

// ── CLI entrypoint ──────────────────────────────────────────────────────────────
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = (typeof Bun !== "undefined" ? Bun.argv : process.argv).slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  const scope = resolveScope(argv);
  const force = argv.includes("--force");
  const cwd = process.cwd();

  // SOURCE skill dir = two levels up from scripts/cli/ (resolved through symlinks).
  const scriptDir = realpathSync(
    import.meta.dirname ??
      import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""),
  );
  const skillDir = resolve(scriptDir, "..", "..");

  const platforms = detectInstalledPlatforms(cwd, scope).filter((p) => p.detected);
  if (platforms.length === 0) {
    process.stderr.write(
      "[init] No coding-agent platforms detected (~/.claude or ~/.codex).\n" +
        "  Install Claude Code or Codex first, then re-run init.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `[init] Install scope: ${scope}${scope === "project" ? ` (${cwd})` : " (home dir)"}\n`,
  );

  let anyFailure = false;
  for (const platform of platforms) {
    process.stdout.write(`\n[init] Installing to ${platform.label}...\n`);
    const r = installToPlatform(platform, skillDir, force);
    for (const step of r.steps) {
      process.stdout.write(`  ${step.ok ? "ok" : "FAIL"} ${step.step}: ${step.note}\n`);
    }
    if (r.success) {
      process.stdout.write(`[init] ${platform.label}: install complete.\n`);
      if (platform.id === "claude-code") {
        process.stdout.write("  Restart your Claude Code session, then invoke *spec.\n");
      }
    } else {
      process.stderr.write(`[init] ${platform.label}: FAILED — ${r.errors.join("; ")}\n`);
      anyFailure = true;
    }
  }

  process.exit(anyFailure ? 1 : 0);
}
