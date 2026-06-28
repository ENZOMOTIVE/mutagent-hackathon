/**
 * scripts/cli/init.ts
 * Cross-platform skill installer + setup routing.
 * Invoked as: pnpx @mutagent/evaluator init
 *
 * Mirrors the mutagent-diagnostics installer BEHAVIOR (project-local default,
 * --global opt-in, platform detection, copy skill tree + agents, emit an
 * InitDescriptor JSON) — but is SELF-CONTAINED: it imports no setup/* helper
 * modules (the evaluator does not ship them) so `init` works OFFLINE from the
 * package alone.
 *
 * Modes (via --mode <value> or legacy flag aliases):
 *   --mode init        (DEFAULT) — install skill+agents for detected platforms, then emit
 *                                   InitDescriptor JSON. The pnpx invocation is this mode.
 *   --mode install     — cross-platform installer only; alias: --install
 *   --mode reconfigure — emit a reconfigure-signal descriptor; alias: --reconfigure
 *
 * Other flags (work across modes):
 *   --yes              Non-interactive: select all detected platforms
 *   --force            Force-overwrite existing skill/agent files during install
 *   --help             Show usage
 *
 * Install scope (operator directive — respect the project working directory):
 *   project (DEFAULT) — install into the directory the user ran `pnpx … init` in:
 *     Claude Code → <cwd>/.claude/skills|agents,  Codex → <cwd>/.codex/skills|agents.
 *   global (--global) — install into the home dir:
 *     Claude Code → ~/.claude/…,  Codex → ~/.codex/….
 *   Cursor is always cwd-relative (.cursor/ in the project).
 *   DETECTION (does the platform exist on this machine?) consults the home/env
 *   markers — a platform stays installable into the project even when only the
 *   global marker exists (the user is clearly using that runtime).
 *
 * cwd discipline (mirrors diagnostics' W9-fix, cwd-leak family): the SKILL SOURCE
 * dir is resolved from import.meta (correct through symlink chains); the install
 * TARGET root is the user's invocation cwd — NEVER the script dir. Overriding the
 * child cwd to the skill dir would have made init install into the skill package
 * itself.
 */

import {
  existsSync, readdirSync, realpathSync,
  mkdirSync, cpSync, copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ── Types ───────────────────────────────────────────────────────────────────

export type Runtime = "claude-code" | "codex" | "cursor" | "opencode" | "generic";

/** Single dispatch flag — all internal modes route through this. */
export type InitMode = "init" | "install" | "reconfigure";

/**
 * Install scope — WHERE skill+agent files land.
 *   "project" (DEFAULT) → the directory the user invoked from (process.cwd()).
 *   "global"            → the home directory (~/.claude, ~/.codex). Opt-in via --global.
 */
export type Scope = "project" | "global";

export type PlatformId = "claude-code" | "codex" | "cursor";

export interface InitDescriptor {
  runtime: Runtime;
  projectRoot: string;
  scope: Scope;
  /**
   * "protocol"  = setup complete; load SKILL.md and follow inline (the parent
   *               session is the orchestrator — do NOT dispatch a coordinator).
   * "reconfigure" = re-run onboarding.
   */
  nextAction: "protocol" | "reconfigure";
  message: string;
  /** true if the host's .claude/agents/ (scoped) already has our agents. */
  agentsInstalled: boolean;
  /** Hint command to install agents if agentsInstalled === false. */
  agentsInstallHint?: string;
}

// ── Flag parsing ────────────────────────────────────────────────────────────

/** Flags that consume the FOLLOWING argv token as their value (not a positional). */
const VALUE_FLAGS = new Set(["--mode"]);

/**
 * Extract bare positional args, skipping flags AND the value token that
 * immediately follows a value-flag (so `init --mode install` never mistakes
 * "install" for the projectRoot positional — the diagnostics W9-fix).
 */
export function parsePositionals(argv: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      if (VALUE_FLAGS.has(tok)) i++; // skip this flag's value token
      continue;
    }
    positionals.push(tok);
  }
  return positionals;
}

/** Resolve install scope. DEFAULT is "project"; `--global` opts into the home dir. */
export function resolveScope(argv: string[]): Scope {
  return argv.includes("--global") ? "global" : "project";
}

/**
 * Resolve --mode. Legacy flags (--install, --reconfigure) map to their --mode
 * equivalents. Priority: explicit --mode <value> > legacy alias > default ("init").
 */
export function resolveMode(argv: string[]): InitMode {
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1) {
    const val = argv[modeIdx + 1];
    if (val === "init" || val === "install" || val === "reconfigure") return val;
    process.stderr.write(
      `[init] WARNING: unknown --mode value "${val ?? ""}"; falling back to "init".\n`
    );
  }
  if (argv.includes("--install")) return "install";
  if (argv.includes("--reconfigure")) return "reconfigure";
  return "init";
}

/**
 * Detect the host coding-agent runtime from environment cues. Used only to
 * annotate the descriptor; it does NOT gate which platforms get installed.
 */
export function detectRuntime(): Runtime {
  if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) return "claude-code";
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "codex";
  if (process.env.CURSOR_WORKSPACE_ID || process.env.CURSOR_VERSION) return "cursor";
  if (process.env.OPENCODE_SESSION_ID) return "opencode";
  return "generic";
}

// ── Platform detection ──────────────────────────────────────────────────────

export interface DetectedPlatform {
  id: PlatformId;
  label: string;
  /** Human-readable description of what was probed. */
  detectionMarker: string;
  /** Whether the platform's marker was found on this machine. */
  detected: boolean;
  /** Where the skill directory should be installed. */
  skillInstallPath: string;
  /** Where agent files should be installed, or null if not applicable. */
  agentsInstallPath: string | null;
}

/**
 * Probe the filesystem for installed coding-agent platforms (Claude Code → Codex
 * → Cursor). Detection markers always use the HOME dir; the INSTALL TARGET
 * follows `scope` (project → <cwd>/…, global → <home>/…). A platform stays
 * installable into the project even when only the global marker exists.
 */
export function detectInstalledPlatforms(
  cwd: string = process.cwd(),
  scope: Scope = "project"
): DetectedPlatform[] {
  const home = homedir();
  const claudeRoot = scope === "global" ? join(home, ".claude") : join(cwd, ".claude");
  const codexRoot = scope === "global" ? join(home, ".codex") : join(cwd, ".codex");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      detectionMarker: join(home, ".claude"),
      detected: existsSync(join(home, ".claude")),
      skillInstallPath: join(claudeRoot, "skills", "mutagent-evaluator"),
      agentsInstallPath: join(claudeRoot, "agents"),
    },
    {
      id: "codex",
      label: "Codex",
      detectionMarker: join(home, ".codex"),
      detected: existsSync(join(home, ".codex")),
      skillInstallPath: join(codexRoot, "skills", "mutagent-evaluator"),
      agentsInstallPath: join(codexRoot, "agents"),
    },
    {
      id: "cursor",
      label: "Cursor",
      detectionMarker: join(cwd, ".cursor"),
      detected: existsSync(join(cwd, ".cursor")),
      skillInstallPath: join(cwd, ".cursor", "rules", "mutagent-evaluator"),
      agentsInstallPath: null, // no agent primitive yet
    },
  ];
}

/**
 * Are our evaluator agents installed in the SCOPED .claude/agents dir?
 * Project-first: a project install is NEVER satisfied by the home dir (mirrors
 * the diagnostics W9-fix — global agents must not mask a missing project install).
 */
export function checkAgentsInstalled(
  skillSourceDir: string,
  projectRoot: string,
  scope: Scope = "project"
): boolean {
  const agentsSrc = join(skillSourceDir, "assets", "agents");
  if (!existsSync(agentsSrc)) return false;
  const expected = readdirSync(agentsSrc).filter((f) => f.endsWith(".md"));
  if (expected.length === 0) return false;

  const scopedDir =
    scope === "global"
      ? join(homedir(), ".claude", "agents")
      : join(projectRoot, ".claude", "agents");
  if (!existsSync(scopedDir)) return false;

  return expected.every((f) => existsSync(join(scopedDir, f)));
}

// ── Single-platform install ─────────────────────────────────────────────────

export interface PlatformInstallResult {
  platform: PlatformId;
  success: boolean;
  steps: Array<{ step: string; ok: boolean; note?: string }>;
  errors: string[];
}

/**
 * Install mutagent-evaluator to a single detected platform:
 *   copy skill tree → copy agents/*.md into the platform agents dir → doctor verify.
 *
 * Agent copy is a plain .md file copy (Claude Code + Codex both read markdown
 * agent defs in their `agents/` dir; the evaluator ships no MD→TOML transcoder).
 * Cursor has no agent primitive — agents are skipped there.
 */
export function installToPlatform(
  platform: DetectedPlatform,
  skillSourceDir: string,
  force = false
): PlatformInstallResult {
  const result: PlatformInstallResult = {
    platform: platform.id,
    success: false,
    steps: [],
    errors: [],
  };

  // ── Step 1: copy the skill tree ──────────────────────────────────────────
  const skillDest = platform.skillInstallPath;
  try {
    if (existsSync(skillDest) && !force) {
      result.steps.push({
        step: "copy-skill",
        ok: true,
        note: `Skill already exists at ${skillDest} (use --force to overwrite)`,
      });
    } else {
      mkdirSync(skillDest, { recursive: true });
      cpSync(skillSourceDir, skillDest, { recursive: true, force: true });
      result.steps.push({ step: "copy-skill", ok: true, note: `Copied to ${skillDest}` });
    }
  } catch (err) {
    const msg = `Failed to copy skill to ${skillDest}: ${err instanceof Error ? err.message : String(err)}`;
    result.steps.push({ step: "copy-skill", ok: false, note: msg });
    result.errors.push(msg);
    return result;
  }

  // ── Step 2: install agents (plain .md copy) ──────────────────────────────
  const agentsDir = platform.agentsInstallPath;
  if (agentsDir !== null) {
    const agentsSrcDir = join(skillSourceDir, "assets", "agents");
    if (existsSync(agentsSrcDir)) {
      const agentFiles = readdirSync(agentsSrcDir).filter((f) => f.endsWith(".md"));
      try {
        mkdirSync(agentsDir, { recursive: true });
        let installed = 0;
        let skipped = 0;
        for (const fname of agentFiles) {
          const dest = join(agentsDir, fname);
          if (existsSync(dest) && !force) {
            skipped++;
            continue;
          }
          copyFileSync(join(agentsSrcDir, fname), dest);
          installed++;
        }
        result.steps.push({
          step: "install-agents",
          ok: true,
          note: `${installed} agent(s) installed${skipped ? `, ${skipped} skipped (exists; use --force)` : ""} in ${agentsDir}`,
        });
      } catch (err) {
        const msg = `Failed to install agents to ${agentsDir}: ${err instanceof Error ? err.message : String(err)}`;
        result.steps.push({ step: "install-agents", ok: false, note: msg });
        result.errors.push(msg);
      }
    } else {
      result.steps.push({ step: "install-agents", ok: true, note: "No assets/agents/ dir — skipped" });
    }
  } else {
    result.steps.push({
      step: "install-agents",
      ok: true,
      note: `${platform.label} has no agent primitive — agents skipped`,
    });
  }

  // ── Step 3: post-install doctor verify ───────────────────────────────────
  const scriptDir = realpathSync(
    import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, "")
  );
  const doctorScript = join(scriptDir, "doctor.ts");
  const runSh = join(scriptDir, "run.sh");
  try {
    if (existsSync(doctorScript) && existsSync(runSh)) {
      const raw = execSync(`bash ${JSON.stringify(runSh)} ${JSON.stringify(doctorScript)}`, {
        encoding: "utf8",
        timeout: 15000,
      });
      const report = JSON.parse(raw) as { runtime: string };
      result.steps.push({ step: "doctor-verify", ok: true, note: `Runtime: ${report.runtime}` });
    } else {
      result.steps.push({ step: "doctor-verify", ok: true, note: "doctor.ts not found — skipped" });
    }
  } catch (err) {
    const msg = `Doctor verify failed: ${err instanceof Error ? err.message : String(err)}`;
    result.steps.push({ step: "doctor-verify", ok: false, note: msg });
    // Doctor failure is non-fatal — log but don't block.
    process.stderr.write(`[init] WARN ${msg}\n`);
  }

  result.success = result.errors.length === 0;
  return result;
}

// ── Chat-fallback multi-select (portable-ask) ───────────────────────────────

/**
 * Print detected platforms and ask the user to confirm. When AskUserQuestion is
 * available (Claude Code native), the orchestrator should use that instead; this
 * is the text-based fallback for a direct CLI invocation. `--yes` auto-selects
 * all detected platforms.
 */
export async function promptPlatformSelection(
  platforms: DetectedPlatform[],
  autoYes: boolean
): Promise<PlatformId[]> {
  const detected = platforms.filter((p) => p.detected);
  const undetected = platforms.filter((p) => !p.detected);

  process.stdout.write("\n mutagent-evaluator — Cross-Platform Install\n");
  process.stdout.write(" ──────────────────────────────────────────────\n");
  process.stdout.write(" Detected platforms:\n");

  if (detected.length === 0) {
    process.stdout.write("   (none — no platform markers found)\n");
    process.stdout.write(
      "\n No platforms detected. Install at least one of:\n" +
        "   Claude Code: https://claude.ai/claude-code\n" +
        "   Codex CLI:   npm install -g @openai/codex\n" +
        "   Cursor:      https://cursor.com\n"
    );
    return [];
  }

  detected.forEach((p, i) => {
    process.stdout.write(`   [${i + 1}] ${p.label} (${p.detectionMarker}) detected\n`);
  });
  if (undetected.length > 0) {
    process.stdout.write(" Not detected:\n");
    undetected.forEach((p) => {
      process.stdout.write(`       ${p.label} (${p.detectionMarker})\n`);
    });
  }

  if (autoYes) {
    process.stdout.write(`\n --yes: installing all ${detected.length} detected platform(s).\n`);
    return detected.map((p) => p.id);
  }

  process.stdout.write(
    `\n Install to which platforms? [all/${detected.map((_, i) => i + 1).join(",")}] (default: all): `
  );

  const line = await new Promise<string>((res) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: unknown) => {
      buf += String(chunk);
      res(buf.trim());
    });
    process.stdin.resume();
  });

  if (!line || line.toLowerCase() === "all") return detected.map((p) => p.id);

  const indices = line
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < detected.length);

  if (indices.length === 0) {
    process.stdout.write(" No valid selection — defaulting to all detected.\n");
    return detected.map((p) => p.id);
  }
  return indices.map((i) => detected[i]!.id);
}

// ── Descriptor ───────────────────────────────────────────────────────────────

export function createInitDescriptor(
  skillSourceDir: string,
  projectRoot: string,
  scope: Scope,
  reconfigure = false
): InitDescriptor {
  const runtime = detectRuntime();
  const agentsInstalled = checkAgentsInstalled(skillSourceDir, projectRoot, scope);

  const descriptor: InitDescriptor = {
    runtime,
    projectRoot,
    scope,
    nextAction: reconfigure ? "reconfigure" : "protocol",
    message: reconfigure
      ? "Re-onboarding requested. Load SKILL.md §0 setup and re-run the interview."
      : "Setup ready. Load SKILL.md and follow inline. The parent session is the orchestrator — do NOT dispatch a coordinator sub-agent.",
    agentsInstalled,
  };

  if (!agentsInstalled) {
    descriptor.agentsInstallHint =
      `bun scripts/cli/run.sh scripts/cli/init.ts "${projectRoot}"${scope === "global" ? " --global" : ""}`;
    descriptor.message +=
      `\n\nmutagent-evaluator agents NOT installed in ${scope === "global" ? "~/.claude" : "<project>/.claude"}/agents/ — ` +
      `dispatches will fall back to subagent_type=general-purpose. Re-run init to install them.` +
      `\n(After install, restart your Claude Code session — the subagent_type registry caches at boot.)`;
  }
  return descriptor;
}

// ── Mode implementations ───────────────────────────────────────────────────

/**
 * mode=install — detect platforms, prompt (or auto-select with --yes), install.
 * Returns exit code: 0 = all ok, 1 = any platform failure (others continue).
 */
export async function runModeInstall(
  skillDir: string,
  autoYes: boolean,
  force: boolean,
  scope: Scope,
  cwd: string
): Promise<number> {
  const platforms = detectInstalledPlatforms(cwd, scope);
  const selectedIds = await promptPlatformSelection(platforms, autoYes);

  if (selectedIds.length === 0) {
    process.stderr.write("[init] No platforms selected — nothing to install.\n");
    return 0;
  }

  process.stdout.write(
    `[init] Install scope: ${scope}${scope === "project" ? ` (${cwd})` : " (home dir)"}\n`
  );

  let anyFailure = false;
  for (const id of selectedIds) {
    const platform = platforms.find((p) => p.id === id)!;
    process.stdout.write(`\n[init] Installing to ${platform.label}...\n`);
    const result = installToPlatform(platform, skillDir, force);
    for (const step of result.steps) {
      process.stdout.write(`${step.ok ? "  ok" : "  FAIL"} ${step.step}: ${step.note ?? ""}\n`);
    }
    if (result.success) {
      process.stdout.write(`[init] ${platform.label}: install complete.\n`);
      if (platform.id === "claude-code") {
        process.stdout.write(
          "  Restart your Claude Code session — the subagent_type registry caches at boot.\n"
        );
      }
    } else {
      process.stderr.write(`[init] ${platform.label}: FAILED — ${result.errors.join("; ")}\n`);
      anyFailure = true;
    }
  }
  return anyFailure ? 1 : 0;
}

/**
 * mode=init (default) — install skill+agents, then emit InitDescriptor JSON. This
 * is the pnpx @mutagent/evaluator init path: one command installs AND returns
 * setup state. Install failures are non-fatal for the descriptor routing.
 */
export async function runModeInit(
  skillDir: string,
  projectRoot: string,
  autoYes: boolean,
  force: boolean,
  scope: Scope
): Promise<number> {
  await runModeInstall(skillDir, autoYes, force, scope, projectRoot);
  const descriptor = createInitDescriptor(skillDir, projectRoot, scope, false);
  process.stdout.write(JSON.stringify(descriptor, null, 2) + "\n");
  return 0;
}

/** mode=reconfigure — emit a reconfigure-signal descriptor (the interview is inline in SKILL.md). */
export function runModeReconfigure(
  skillDir: string,
  projectRoot: string,
  scope: Scope
): number {
  const descriptor = createInitDescriptor(skillDir, projectRoot, scope, true);
  process.stdout.write(JSON.stringify(descriptor, null, 2) + "\n");
  return 0;
}

// ── Usage ────────────────────────────────────────────────────────────────────

const USAGE = `
mutagent-evaluator init — cross-platform skill installer + setup routing

USAGE
  pnpx @mutagent/evaluator init [--mode <mode>] [options]

MODES (--mode flag)
  --mode init        DEFAULT — install skill+agents to detected platforms, then emit
                     InitDescriptor JSON with setup state.
  --mode install     Cross-platform installer only (no descriptor output)
  --mode reconfigure Emit reconfigure-signal descriptor; the interview is inline in SKILL.md

  Legacy aliases (backward compat):
    --install     → same as --mode install
    --reconfigure → same as --mode reconfigure

INSTALL SCOPE (install/init modes)
  (default)          PROJECT-LOCAL — install into the directory you ran init in:
                       Claude Code → <cwd>/.claude/…   Codex → <cwd>/.codex/…
  --global           HOME DIR — install into ~/.claude/… and ~/.codex/…
                     (Cursor is always project-local: .cursor/ in the current directory.)

OPTIONS
  --global           Install into the home dir instead of the project (default: project-local)
  --yes              Non-interactive: select all detected platforms
  --force            Force-overwrite existing skill/agent files during install
  --help             Show this message

PLATFORM DETECTION
  Detection probes home/env markers (does the runtime exist?); the INSTALL TARGET
  follows the scope above — a platform stays installable into your project even
  when only the global marker exists.
  Claude Code  detected if ~/.claude/ exists
  Codex        detected if ~/.codex/ exists
  Cursor       detected if .cursor/ exists in current directory (project-scoped)

EXAMPLES
  pnpx @mutagent/evaluator init                    # project-local install + descriptor (default)
  pnpx @mutagent/evaluator init --global           # install into the home dir instead
  pnpx @mutagent/evaluator init --yes              # install all detected, non-interactive
  pnpx @mutagent/evaluator init --mode install     # installer only
`.trim();

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  const mode = resolveMode(argv);
  const scope = resolveScope(argv);
  const autoYes = argv.includes("--yes");
  const force = argv.includes("--force");

  // The skill SOURCE dir is resolved from import.meta (stays correct through
  // symlink chains). scriptDir = scripts/cli → skillRoot is two dirs up. The
  // install TARGET root is the user's invocation cwd — NEVER the script dir.
  const scriptDir = realpathSync(
    import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, "")
  );
  const skillDir = resolve(scriptDir, "../..");
  // parsePositionals skips value-flag tokens so a --mode VALUE is never mistaken
  // for projectRoot. Falls back to the invocation cwd.
  const projectRoot = parsePositionals(argv)[0] ?? process.cwd();

  if (mode === "install") {
    const code = await runModeInstall(skillDir, autoYes, force, scope, projectRoot);
    process.exit(code);
  }
  if (mode === "reconfigure") {
    process.exit(runModeReconfigure(skillDir, projectRoot, scope));
  }
  // mode === "init" (default)
  const code = await runModeInit(skillDir, projectRoot, autoYes, force, scope);
  process.exit(code);
}
