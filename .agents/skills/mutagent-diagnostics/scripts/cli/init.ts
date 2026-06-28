/**
 * scripts/cli/init.ts
 * CLI entrypoint: runtime detection + setup routing + cross-platform installer (Phase 3-E)
 * Invoked as: pnpx @mutagent/diagnostics init
 *
 * W9-10: single --mode flag dispatches all internal functions (no new files).
 *
 * Modes (via --mode <value> or legacy flag aliases):
 *   --mode init        (DEFAULT) — install skill+agents for detected platforms, then emit
 *                                   InitDescriptor JSON. pnpx invocation is this mode.
 *   --mode install     — cross-platform installer only (OQ-8); alias: --install
 *   --mode reconfigure — re-run onboarding; alias: --reconfigure
 *
 * Other flags (work across modes):
 *   --yes              Non-interactive: select all detected platforms
 *   --force            Force-overwrite during install
 *   --ensure-cli <p>   Probe source-platform CLI gate (PR-021); runs before mode dispatch
 *   --help             Show usage
 *
 * Phase 3-E (OQ-8): cross-platform installer (--mode install)
 *   1. Probe filesystem for platform markers: ~/.claude/ → Claude Code, ~/.codex/ → Codex,
 *      .cursor/ in cwd → Cursor. Detection uses home/env markers; the INSTALL TARGET is
 *      a separate concern (see install scope below).
 *   2. Surface multi-select (chat-fallback per PR-010) with detected platforms pre-checked
 *   3. Install to confirmed platforms: copy skill dir + install-agents.ts + doctor.ts verify
 *   4. Exit 0 on full success, 1 on any platform failure (continue others)
 *
 * Install scope (W9-fix — operator directive: respect the project working directory):
 *   project (DEFAULT) — install into the directory the user ran `pnpx … init` in:
 *     Claude Code → <cwd>/.claude/skills|agents,  Codex → <cwd>/.codex/skills|agents.
 *   global (--global) — install into the home dir (legacy behaviour):
 *     Claude Code → ~/.claude/…,  Codex → ~/.codex/….
 *   Cursor is always cwd-relative (.cursor/ in the project).
 *   DETECTION (does the platform exist on this machine?) still consults the home/env
 *   markers — a platform stays installable into the project even when only the global
 *   marker exists (the user is clearly using Claude Code).
 *
 * W9-10 init mode (--mode init = default):
 *   Runs the cross-platform install (same as --mode install), then emits InitDescriptor
 *   JSON so callers know setup + agent state. This is what pnpx @mutagent/diagnostics init
 *   does — one command installs skill+agents AND returns setup state.
 *
 * Self-contained templates (npm public release):
 *   The shared install-time templates (self-diagnosis-contract, spec.yaml, team.yaml,
 *   iter-handover, wave-dashboard) are BUNDLED into the skill tree at
 *   assets/templates/shared/ — see scripts/cli/shared-templates.ts. There is NO
 *   peer-install of and NO dependency on `@mutagent/templates`. Because the bundled
 *   directory lives inside the skill tree, the cpSync skill-dir copy below carries it
 *   to every platform automatically, so `init` works OFFLINE from the package alone.
 */

import {
  existsSync, readdirSync, lstatSync, realpathSync,
  mkdirSync, cpSync,
} from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { detectSetup, detectSourceCli } from "../setup/detect.ts";
import type { SetupState } from "../setup/detect.ts";
import { runCliInstall } from "../setup/ensure-cli.ts";
import type { CliEnsurePlan, CliProbe } from "../setup/ensure-cli.ts";
import type { SourcePlatform } from "../normalize/trace.ts";
import { verifyAgents } from "../setup/verify-agents.ts";
import type { AgentBoundaryState } from "../setup/verify-agents.ts";
import { installAgents, transcodeAgentFile } from "./install-agents.ts";
import { SHARED_TEMPLATE_FILES } from "./shared-templates.ts";

// ── Existing types (backward compat) ──────────────────────────────────────────

export type Runtime = "claude-code" | "codex" | "cursor" | "opencode" | "generic";

export interface InitDescriptor {
  runtime: Runtime;
  projectRoot: string;
  setupState: SetupState;
  /**
   * P2 pivot: "diagnostics" is retired. Use "protocol" for complete state.
   * "protocol" = load references/workflows/orchestrator-protocol.md and follow inline.
   * The parent session is the orchestrator — do NOT dispatch a coordinator sub-agent.
   */
  nextAction: "onboarding" | "protocol" | "reconfigure";
  message: string;
  /** F-SELF-01 / R-SELF-01-a — true if the host's .claude/agents/ is missing our agents */
  agentsInstalled: boolean;
  /** Hint command to install agents if agentsInstalled === false */
  agentsInstallHint?: string;
  /**
   * R-SELF-01-d: Agent-spin verification boundary.
   * "ready"          = all 3 agents present + valid frontmatter + no restart required
   * "pending-restart" = files installed but session not restarted yet
   * "missing"        = one or more agents not installed
   * "invalid"        = file present but frontmatter name wrong or unreadable
   */
  agentsBoundary: AgentBoundaryState;
}

// ── W9-10: mode type ──────────────────────────────────────────────────────────

/** Single dispatch flag — all internal functions route through this. */
export type InitMode = "init" | "install" | "reconfigure";

// ── W9-fix: install scope ─────────────────────────────────────────────────────

/**
 * Install scope — WHERE skill+agent files land.
 *   "project" (DEFAULT) → the directory the user invoked from (process.cwd()).
 *   "global"            → the home directory (~/.claude, ~/.codex). Opt-in via --global.
 *
 * Distinct from install-agents' InstallScope ("project" | "user"); we map
 * global → install-agents "user" when handing off agent installation.
 */
export type Scope = "project" | "global";

/**
 * Resolve install scope from argv. DEFAULT is "project" — the bug this fixes was
 * a hard-coded global target, so project-local must be the default. `--global`
 * opts back into the home-dir install.
 */
export function resolveScope(argv: string[]): Scope {
  return argv.includes("--global") ? "global" : "project";
}

/** Flags that consume the FOLLOWING argv token as their value (so it isn't a positional). */
const VALUE_FLAGS = new Set(["--mode", "--ensure-cli"]);

/**
 * Extract bare positional args, skipping flags AND the value token that immediately
 * follows a value-flag. Without this, `init --mode install` mistook "install" (the
 * --mode VALUE) for the projectRoot positional → project-local install targeted a
 * relative "install" dir instead of the user's cwd (W9-fix: surfaced once cwd mattered).
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

/**
 * Resolve --mode flag from argv. Legacy flags (--install, --reconfigure) map to
 * their --mode equivalents for backward compatibility.
 *
 * Priority: explicit --mode <value> > legacy alias > default ("init").
 */
export function resolveMode(argv: string[]): InitMode {
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1) {
    const val = argv[modeIdx + 1];
    if (val === "init" || val === "install" || val === "reconfigure") {
      return val;
    }
    process.stderr.write(
      `[init] WARNING: unknown --mode value "${val ?? ""}"; falling back to "init".\n`
    );
  }
  // Legacy aliases
  if (argv.includes("--install")) return "install";
  if (argv.includes("--reconfigure")) return "reconfigure";
  return "init";
}

/**
 * Detect the host coding-agent runtime from environment cues.
 * Used to set ask_tool.runtime in config.yaml.
 */
export function detectRuntime(): Runtime {
  // Claude Code: CLAUDE_CODE env var or claude-code process parent
  if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) {
    return "claude-code";
  }

  // Codex CLI: OPENAI_API_KEY + absence of Claude indicators + codex process
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return "codex";
  }

  // Cursor: CURSOR_* env vars
  if (process.env.CURSOR_WORKSPACE_ID || process.env.CURSOR_VERSION) {
    return "cursor";
  }

  // OpenCode: OPENCODE_* env vars (TBD — placeholder)
  if (process.env.OPENCODE_SESSION_ID) {
    return "opencode";
  }

  return "generic";
}

/**
 * Check whether our diagnostics-* agents are installed.
 *
 * W9-fix (scope-respecting, project-first): the bug this fixes was counting the
 * GLOBAL ~/.claude/agents as satisfying a PROJECT install — so when the home dir
 * already had our agents (e.g. dev symlinks), `pnpx … init` reported
 * already-installed and SKIPPED the project install entirely.
 *   - scope "project" (DEFAULT) → check ONLY <projectRoot>/.claude/agents.
 *   - scope "global"            → check ONLY ~/.claude/agents.
 * A project install must never be considered satisfied by the home dir.
 *
 * P2 pivot: returns true if both leaf worker agents (analyzer + apply-worker) are present.
 * diagnostics-orchestrator is no longer installed (it's an inline protocol now).
 *
 * @param projectRoot - The user's project root (install target in project scope).
 * @param scope - "project" (DEFAULT) | "global".
 */
export function checkAgentsInstalled(projectRoot: string, scope: Scope = "project"): boolean {
  // Realpath-resolve through any symlink chain (sibling of F-SELF-05 cwd-leak family)
  const scriptDir = realpathSync(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""));
  const skillAgentsDir = resolve(scriptDir, "../..", "assets", "agents");
  if (!existsSync(skillAgentsDir)) return false;
  const expected = readdirSync(skillAgentsDir).filter((f) => f.endsWith(".md"));
  if (expected.length === 0) return false;

  // Project-first: ONLY the scoped dir counts. Home never satisfies a project install.
  const scopedDir =
    scope === "global"
      ? join(homedir(), ".claude", "agents")
      : join(projectRoot, ".claude", "agents");
  for (const dir of [scopedDir]) {
    if (!existsSync(dir)) continue;
    const allPresent = expected.every((f) => {
      const dest = join(dir, f);
      if (!existsSync(dest)) return false;
      const stat = lstatSync(dest);
      if (!stat.isSymbolicLink()) return true; // assume operator chose copy install
      // Compare CANONICAL paths — symlink literal target may differ representationally
      try {
        const canonical = realpathSync(dest);
        const expectedCanonical = realpathSync(join(skillAgentsDir, f));
        return canonical === expectedCanonical;
      } catch {
        return false; // dangling
      }
    });
    if (allPresent) return true;
  }
  return false;
}

export function createInitDescriptor(
  projectRoot: string,
  reconfigure = false,
  scope: Scope = "project"
): InitDescriptor {
  const runtime = detectRuntime();
  const setup = detectSetup(projectRoot);
  // W9-fix: project-first agent check — home dir never satisfies a project install.
  const agentsInstalled = checkAgentsInstalled(projectRoot, scope);

  // R-SELF-01-d: verify agent boundary state (frontmatter + presence + restart status)
  // P2 pivot: only analyzer + apply-worker are checked (orchestrator is an inline protocol now)
  // Try project scope first, fall back to user scope
  let verifyResult = verifyAgents(projectRoot, "project");
  // P2: orchestrator is always "ready" (not installed) — check only leaf workers
  const projectAllMissing =
    verifyResult.analyzer === "missing" &&
    verifyResult.applyWorker === "missing";
  if (projectAllMissing) {
    const userResult = verifyAgents(projectRoot, "user");
    const userHasSome =
      userResult.analyzer !== "missing" ||
      userResult.applyWorker !== "missing";
    if (userHasSome) {
      verifyResult = userResult;
    }
  }

  // Compute overall agentsBoundary: worst state wins across 2 leaf workers
  const allStates: AgentBoundaryState[] = [
    verifyResult.analyzer,
    verifyResult.applyWorker,
  ];
  let agentsBoundary: AgentBoundaryState = "ready";
  if (allStates.includes("missing")) agentsBoundary = "missing";
  else if (allStates.includes("invalid")) agentsBoundary = "invalid";
  else if (allStates.includes("pending-restart")) agentsBoundary = "pending-restart";

  let nextAction: InitDescriptor["nextAction"];
  let message: string;

  if (reconfigure) {
    nextAction = "reconfigure";
    message = "Re-onboarding requested. Load references/workflows/onboarding.md to begin.";
  } else if (setup.state === "complete") {
    // P2 pivot: orchestrator is now inline. Load orchestrator-protocol.md — do NOT dispatch sub-agent.
    nextAction = "protocol";
    message = "Setup complete. Load references/workflows/orchestrator-protocol.md and follow inline. Do NOT dispatch a coordinator sub-agent.";
  } else if (setup.state === "partial") {
    nextAction = "onboarding";
    message = `Partial config detected. Missing fields: ${setup.missingFields.join(", ")}. Load references/workflows/onboarding.md.`;
  } else {
    nextAction = "onboarding";
    message = "No config found. Load references/workflows/onboarding.md to begin setup.";
  }

  // Surface agent install requirement (F-SELF-01 / R-SELF-01-a)
  const descriptor: InitDescriptor = {
    runtime,
    projectRoot,
    setupState: setup.state,
    nextAction,
    message,
    agentsInstalled,
    agentsBoundary,
  };
  if (!agentsInstalled) {
    descriptor.agentsInstallHint =
      `bun scripts/cli/run.sh scripts/cli/install-agents.ts "${projectRoot}" [--scope=project|user]`;
    descriptor.message +=
      `\n\ndiagnostics-* agents NOT installed in .claude/agents/ — analyzer dispatches will fall back to subagent_type=general-purpose. Run: ${descriptor.agentsInstallHint}` +
      `\n(After install, restart your Claude Code session — the subagent_type registry caches at boot.)`;
  }
  if (agentsBoundary === "pending-restart") {
    descriptor.message +=
      `\n\nRESTART REQUIRED: diagnostics-* agents were installed but the session has not been restarted.` +
      ` The subagent_type registry is loaded at boot. Restart now, then re-run init to confirm agentsBoundary=ready.`;
  }
  if (agentsBoundary === "invalid") {
    descriptor.message +=
      `\n\nAGENT VALIDATION FAILED: one or more installed agent files have invalid frontmatter.` +
      ` Re-run install-agents.ts with --force to replace them.`;
  }
  return descriptor;
}

// ── Phase 3-E: Cross-platform filesystem detection (OQ-8) ────────────────────

export type PlatformId = "claude-code" | "codex" | "cursor";
export type BindingFormat = "md" | "toml" | "mdc";

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
  /** File format for agent/skill bindings on this platform. */
  bindingFormat: BindingFormat;
}

/**
 * Probe the filesystem for installed coding-agent platforms.
 * Detection order per OQ-8: Claude Code → Codex → Cursor.
 * Uses os.homedir() — never literal ~/. (homedir-cross-platform gotcha §8)
 *
 * DETECTION vs INSTALL TARGET (W9-fix): `detected`/`detectionMarker` always probe the
 * home/env marker (does the platform exist on this machine?). The INSTALL TARGET
 * (`skillInstallPath` / `agentsInstallPath`) follows `scope`:
 *   "project" (DEFAULT) → <cwd>/.claude|.codex/…   "global" → <home>/.claude|.codex/…
 * A platform stays installable into the project even when only the global marker
 * exists — the user is clearly using that runtime.
 *
 * @param cwd   - The directory the user invoked from (process.cwd()). Install target
 *                root in project scope; also the CWD-relative probe root for Cursor.
 * @param scope - "project" (DEFAULT, cwd-relative) | "global" (home-relative). The bug
 *                this signature fixes was a hard-coded global target.
 */
export function detectInstalledPlatforms(
  cwd: string = process.cwd(),
  scope: Scope = "project"
): DetectedPlatform[] {
  const home = homedir();
  // Install-target roots follow scope; detection markers always use home.
  const claudeRoot = scope === "global" ? join(home, ".claude") : join(cwd, ".claude");
  const codexRoot = scope === "global" ? join(home, ".codex") : join(cwd, ".codex");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      detectionMarker: join(home, ".claude"),
      detected: existsSync(join(home, ".claude")),
      skillInstallPath: join(claudeRoot, "skills", "mutagent-diagnostics"),
      agentsInstallPath: join(claudeRoot, "agents"),
      bindingFormat: "md",
    },
    {
      id: "codex",
      label: "Codex",
      detectionMarker: join(home, ".codex"),
      detected: existsSync(join(home, ".codex")),
      skillInstallPath: join(codexRoot, "skills", "mutagent-diagnostics"),
      agentsInstallPath: join(codexRoot, "agents"),
      bindingFormat: "toml",
    },
    {
      id: "cursor",
      label: "Cursor",
      detectionMarker: join(cwd, ".cursor"),
      detected: existsSync(join(cwd, ".cursor")),
      skillInstallPath: join(cwd, ".cursor", "rules"),
      agentsInstallPath: null, // no agent primitive yet
      bindingFormat: "mdc",
    },
  ];
}

// ── Platform install implementation ───────────────────────────────────────────

export interface PlatformInstallResult {
  platform: PlatformId;
  success: boolean;
  steps: Array<{ step: string; ok: boolean; note?: string }>;
  errors: string[];
}

/**
 * Install mutagent-diagnostics to a single detected platform.
 * Performs: copy skill dir → install agents (with optional TOML transcode) → doctor verify.
 *
 * @param platform - The platform to install to (its install paths already follow scope).
 * @param skillSourceDir - The source skill directory (defaults to SKILL_DIR from script location).
 * @param force - Overwrite existing files.
 * @param scope - Install scope ("project" DEFAULT | "global"). Drives the install-agents
 *                handoff: project → install-agents "project" scope rooted at `cwd`;
 *                global → install-agents "user" scope (~/.claude/agents).
 * @param cwd   - The project root the user invoked from (process.cwd()). Used as the
 *                install-agents projectRoot in project scope. NOT the skill/script dir
 *                (F-SELF-05 cwd-leak family — the source dir is resolved separately).
 */
export function installToPlatform(
  platform: DetectedPlatform,
  skillSourceDir: string,
  force = false,
  scope: Scope = "project",
  cwd: string = process.cwd()
): PlatformInstallResult {
  const result: PlatformInstallResult = {
    platform: platform.id,
    success: false,
    steps: [],
    errors: [],
  };

  // ── Step 1: Copy skill directory ──────────────────────────────────────────
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

  // ── Step 1b: Verify bundled shared templates landed (offline self-contained) ──
  // The shared install-time templates are bundled at assets/templates/shared/ and
  // carried by the cpSync above (they live inside the skill tree — no peer-install,
  // no @mutagent/templates dependency). Confirm they materialised at the dest so a
  // partial/interrupted copy surfaces here rather than at first runtime use.
  const sharedDest = join(skillDest, "assets", "templates", "shared");
  const missingShared = SHARED_TEMPLATE_FILES.filter(
    (f) => !existsSync(join(sharedDest, f))
  );
  result.steps.push({
    step: "verify-shared-templates",
    ok: missingShared.length === 0,
    note:
      missingShared.length === 0
        ? `${SHARED_TEMPLATE_FILES.length} bundled shared template(s) present at ${sharedDest}`
        : `MISSING bundled shared template(s): ${missingShared.join(", ")}`,
  });
  if (missingShared.length > 0) {
    result.errors.push(
      `bundled shared templates missing after copy: ${missingShared.join(", ")}`
    );
  }

  // ── Step 2: Install agents ─────────────────────────────────────────────────
  const agentsDir = platform.agentsInstallPath;
  if (agentsDir !== null) {
    const agentsSrcDir = join(skillSourceDir, "assets", "agents");
    if (existsSync(agentsSrcDir)) {
      const agentFiles = readdirSync(agentsSrcDir).filter((f) => f.endsWith(".md"));
      try {
        mkdirSync(agentsDir, { recursive: true });
        if (platform.id === "codex") {
          // MD→TOML transcode for Codex
          for (const fname of agentFiles) {
            const src = join(agentsSrcDir, fname);
            const destName = basename(fname, ".md") + ".toml";
            const dest = join(agentsDir, destName);
            transcodeAgentFile(src, dest, "codex");
          }
          result.steps.push({
            step: "install-agents",
            ok: true,
            note: `Transcoded ${agentFiles.length} agent(s) to TOML in ${agentsDir}`,
          });
        } else {
          // Claude Code: symlink via existing installAgents.
          // W9-fix: scope-respecting target. project → install into <cwd>/.claude/agents
          // (install-agents "project" scope, rooted at the user's invocation dir);
          // global → ~/.claude/agents (install-agents "user" scope). Previously this
          // hard-coded "user", so a project install leaked agents into the home dir.
          const agentsScope = scope === "global" ? "user" : "project";
          const installResult = installAgents(cwd, agentsScope, force);
          const hadErrors = installResult.errors.length > 0;
          result.steps.push({
            step: "install-agents",
            ok: !hadErrors,
            note: hadErrors
              ? `Errors: ${installResult.errors.join("; ")}`
              : `${installResult.entries.filter((e) => e.action !== "skipped").length} agent(s) installed`,
          });
          if (hadErrors) {
            result.errors.push(...installResult.errors);
          }
        }
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

  // ── Step 3: Post-install doctor verify ────────────────────────────────────
  const scriptDir = realpathSync(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""));
  const doctorScript = join(scriptDir, "doctor.ts");
  const runSh = join(scriptDir, "run.sh");
  try {
    if (existsSync(doctorScript) && existsSync(runSh)) {
      const raw = execSync(`bash "${runSh}" "${doctorScript}"`, {
        encoding: "utf8",
        timeout: 15000,
      });
      const report = JSON.parse(raw) as { runtime: string };
      result.steps.push({
        step: "doctor-verify",
        ok: true,
        note: `Runtime: ${report.runtime}`,
      });
    } else {
      result.steps.push({
        step: "doctor-verify",
        ok: true,
        note: "doctor.ts not found — skipped",
      });
    }
  } catch (err) {
    const msg = `Doctor verify failed: ${err instanceof Error ? err.message : String(err)}`;
    result.steps.push({ step: "doctor-verify", ok: false, note: msg });
    // Doctor failure is non-fatal — log but don't block
    process.stderr.write(`[init] ⚠ ${msg}\n`);
  }

  result.success = result.errors.length === 0;
  return result;
}

// ── W9-10: internal mode implementations ─────────────────────────────────────

/**
 * mode=install — cross-platform installer (Phase 3-E).
 * Detects platforms, prompts for selection (or auto-selects with --yes), installs.
 * Returns exit code: 0 = all ok, 1 = any platform failure.
 */
export async function runModeInstall(
  skillDir: string,
  autoYes: boolean,
  force: boolean,
  scope: Scope = "project",
  cwd: string = process.cwd()
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
    const result = installToPlatform(platform, skillDir, force, scope, cwd);
    for (const step of result.steps) {
      const icon = step.ok ? "  ok" : "  FAIL";
      process.stdout.write(`${icon} ${step.step}: ${step.note ?? ""}\n`);
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
 * mode=init (W9-10 default) — install skill+agents, then emit InitDescriptor JSON.
 * This is the pnpx @mutagent/diagnostics init path: one command installs AND
 * returns setup state so the agent knows whether to run onboarding or diagnostics.
 */
export async function runModeInit(
  skillDir: string,
  projectRoot: string,
  autoYes: boolean,
  force: boolean,
  scope: Scope = "project"
): Promise<number> {
  // Install to all detected platforms (non-interactive if --yes).
  // projectRoot IS the user's invocation cwd — pass it as the install cwd so
  // project-scope installs land in the project, not the skill/script dir.
  await runModeInstall(skillDir, autoYes, force, scope, projectRoot);
  // Always emit InitDescriptor — install failures are non-fatal for setup routing
  const descriptor = createInitDescriptor(projectRoot, false, scope);
  process.stdout.write(JSON.stringify(descriptor, null, 2) + "\n");
  return 0;
}

/**
 * mode=reconfigure — back up config and signal agent to re-run onboarding.
 * The heavy lifting (asking questions, writing config) is handled by the agent
 * reading SKILL.md + references/workflows/onboarding.md inline. This mode emits
 * a thin route-signal so callers know a reconfigure pass is required.
 */
export function runModeReconfigure(projectRoot: string): number {
  // Thin route-signal: delegate to createInitDescriptor with reconfigure=true
  const descriptor = createInitDescriptor(projectRoot, true);
  process.stdout.write(JSON.stringify(descriptor, null, 2) + "\n");
  return 0;
}

// ── Chat-fallback multi-select (PR-010) ───────────────────────────────────────

/**
 * Chat-fallback multi-select: print detected platforms and ask user to confirm.
 * When AskUserQuestion is available (Claude Code native), callers should use that instead.
 * This function is the text-based fallback for direct CLI invocation.
 *
 * @param platforms - All probed platforms (detected and undetected).
 * @param autoYes - If true, skip prompt and select all detected platforms.
 * @returns Array of confirmed platform IDs.
 */
export async function promptPlatformSelection(
  platforms: DetectedPlatform[],
  autoYes: boolean
): Promise<PlatformId[]> {
  const detected = platforms.filter((p) => p.detected);
  const undetected = platforms.filter((p) => !p.detected);

  process.stdout.write("\n mutagent-diagnostics — Cross-Platform Install\n");
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

  // Read a single line from stdin
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: unknown) => {
      buf += String(chunk);
      resolve(buf.trim());
    });
    process.stdin.resume();
  });

  if (!line || line.toLowerCase() === "all" || line === "") {
    return detected.map((p) => p.id);
  }

  // Parse comma-separated numbers like "1,2" or "1"
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

// ── Source-platform CLI ensure (approve-to-install gate, PR-021) ──────────────

/**
 * Outcome of the ensure-source-cli flow. Records WHAT happened to the CLI so the
 * caller can persist "CLI absent — REST fallback in use" into the config/notes.
 */
export type EnsureCliOutcome =
  | "not-required"     // platform needs no CLI
  | "already-present"  // CLI was already on PATH
  | "installed"        // user APPROVED → install ran and succeeded
  | "install-failed"   // user approved but the install command failed
  | "declined"         // user DECLINED → continue with REST/file fallback
  | "no-installer";    // CLI missing, nothing installable → REST/file fallback

export interface EnsureCliResult {
  platform: SourcePlatform;
  plan: CliEnsurePlan;
  outcome: EnsureCliOutcome;
  /** True only when the CLI is usable afterward (present or freshly installed). */
  cliAvailable: boolean;
  /** Human-readable line for the onboarding transcript + config notes. */
  note: string;
}

/**
 * Approval callback. Returns true to APPROVE the install, false to DECLINE.
 *
 * Platform-portable by design: callers inject the right asker —
 *   - Claude Code: an adapter backed by the AskUserQuestion tool, OR
 *   - chat-based runtimes (Codex/Cursor/OpenCode/generic): the chat y/N fallback
 *     `promptInstallApprovalChat` below.
 * The ensure-cli orchestration NEVER asks on its own — it always calls this callback,
 * which makes the no-silent-install rule structurally enforced and unit-testable.
 */
// eslint-disable-next-line no-unused-vars
export type ApproveInstallFn = (plan: CliEnsurePlan) => Promise<boolean>;

/**
 * Chat-based y/N approval fallback (PR-010 portable-ask). Prints the docs link +
 * the install command, then reads a single y/N line from stdin. DEFAULT IS NO —
 * an empty line / EOF / anything not starting with "y" DECLINES. This guarantees
 * that a non-interactive or accidental Enter NEVER triggers an install.
 *
 * Claude Code callers should NOT use this — they pass an AskUserQuestion-backed
 * approver instead (see onboarding.md Phase 2).
 */
export async function promptInstallApprovalChat(plan: CliEnsurePlan): Promise<boolean> {
  process.stdout.write(
    `\n ${plan.spec.label} is not installed.\n` +
    `   Official docs: ${plan.docsUrl}\n` +
    `   Suggested install: ${plan.installCommand}\n` +
    `\n Install it now? This will run the command above on your machine. [y/N]: `
  );
  const line = await new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: unknown) => {
      resolve(String(chunk).trim());
    });
    process.stdin.resume();
  });
  // DEFAULT NO: only an explicit yes approves.
  return line.toLowerCase().startsWith("y");
}

/**
 * Ensure the chosen source platform's CLI is available for onboarding.
 *
 * Flow (operator directive — NO silent/automatic install on ANY path):
 *   1. plan = detectSourceCli(platform)  — pure probe, never installs.
 *   2. not-required / present → return immediately (cliAvailable reflects reality).
 *   3. missing-no-installer  → surface docs + REST/file fallback; do NOT ask, do NOT install.
 *   4. missing-installable   → print docs + install command, then ASK via `approve`.
 *        - approve() === true  → run the documented install (runCliInstall).
 *        - approve() === false → DECLINE: continue with REST/file fallback; record CLI absent.
 *
 * There is exactly ONE code path that installs (step 4 after approve() returns true).
 * `runCliInstall` is never reached otherwise.
 *
 * @param platform - The chosen source platform.
 * @param approve  - Approval callback (AskUserQuestion adapter or chat y/N fallback).
 * @param probe    - Injectable PATH probe (for deterministic tests).
 */
export async function ensureSourceCli(
  platform: SourcePlatform,
  approve: ApproveInstallFn,
  probe?: CliProbe
): Promise<EnsureCliResult> {
  const plan = detectSourceCli(platform, probe);

  if (plan.status === "not-required") {
    return {
      platform, plan, outcome: "not-required", cliAvailable: false,
      note: `${plan.spec.label}: no CLI required. Docs: ${plan.docsUrl}`,
    };
  }

  if (plan.status === "present") {
    return {
      platform, plan, outcome: "already-present", cliAvailable: true,
      note: `${plan.spec.label} already installed. Docs: ${plan.docsUrl}`,
    };
  }

  if (plan.status === "missing-no-installer") {
    return {
      platform, plan, outcome: "no-installer", cliAvailable: false,
      note:
        `${plan.spec.label} not installed and not auto-installable. ` +
        `Continuing with fallback. Docs: ${plan.docsUrl}. ${plan.spec.fallbackNote}`,
    };
  }

  // status === "missing-installable" → MUST ask before installing.
  const approved = await approve(plan);
  if (!approved) {
    return {
      platform, plan, outcome: "declined", cliAvailable: false,
      note:
        `${plan.spec.label} install DECLINED by user. Continuing with REST/file fallback. ` +
        `Docs: ${plan.docsUrl}. ${plan.spec.fallbackNote}`,
    };
  }

  // Approved → run the documented install. This is the ONLY install path.
  const installResult = runCliInstall(plan);
  if (installResult.ok) {
    return {
      platform, plan, outcome: "installed", cliAvailable: true,
      note: `${plan.spec.label} installed (user-approved): \`${installResult.command}\`.`,
    };
  }
  return {
    platform, plan, outcome: "install-failed", cliAvailable: false,
    note:
      `${plan.spec.label} install was approved but FAILED: ${installResult.error ?? "unknown error"}. ` +
      `Falling back to REST/file. Docs: ${plan.docsUrl}. ${plan.spec.fallbackNote}`,
  };
}

// ── Usage text ────────────────────────────────────────────────────────────────

const USAGE = `
mutagent-diagnostics init — cross-platform skill installer + setup routing

USAGE
  pnpx @mutagent/diagnostics init [--mode <mode>] [options]

MODES (--mode flag, W9-10)
  --mode init        DEFAULT — install skill+agents to detected platforms, then emit
                     InitDescriptor JSON with setup state (onboarding/protocol/reconfigure)
  --mode install     Cross-platform installer only (no descriptor output)
  --mode reconfigure Emit reconfigure-signal descriptor; agent re-runs onboarding inline

  Legacy aliases (backward compat):
    --install    → same as --mode install
    --reconfigure → same as --mode reconfigure

INSTALL SCOPE (install/init modes)
  (default)          PROJECT-LOCAL — install into the directory you ran init in:
                       Claude Code → <cwd>/.claude/…   Codex → <cwd>/.codex/…
  --global           HOME DIR — install into ~/.claude/… and ~/.codex/… (legacy behaviour)
                     (Cursor is always project-local: .cursor/ in the current directory.)

OPTIONS
  --global           Install into the home dir instead of the project (default: project-local)
  --yes              Non-interactive: select all detected platforms (install/init modes)
  --force            Force-overwrite existing skill/agent files during install
  --ensure-cli <p>   Probe source-platform CLI gate; never auto-installs (PR-021)
  --help             Show this message

PLATFORM DETECTION (install/init modes)
  Detection probes home/env markers (does the runtime exist?); the INSTALL TARGET
  follows the scope above — a platform stays installable into your project even
  when only the global marker exists.
  Claude Code  detected if ~/.claude/ exists
  Codex        detected if ~/.codex/ exists
  Cursor       detected if .cursor/ exists in current directory (project-scoped)

EXAMPLES
  pnpx @mutagent/diagnostics init                    # project-local install + descriptor (default)
  pnpx @mutagent/diagnostics init --global           # install into the home dir instead
  pnpx @mutagent/diagnostics init --yes              # install all detected, non-interactive
  pnpx @mutagent/diagnostics init --mode install     # installer only
  pnpx @mutagent/diagnostics init --mode reconfigure # signal reconfigure
  pnpx @mutagent/diagnostics init --install --yes    # legacy alias for --mode install --yes

DOCS
  references/source-platforms/install-paths.md  — install paths per platform
  references/source-platforms/codex.md          — Codex TOML format
  references/target-platforms/local-cursor.md   — Cursor binding status (apply target)
`.trim();

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);

  // --help
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  // --ensure-cli <platform>: probe source-platform CLI + approve-to-install gate (PR-021)
  // Handled before mode dispatch — it's a utility, not a mode.
  const ensureIdx = argv.indexOf("--ensure-cli");
  if (ensureIdx !== -1) {
    const platform = argv[ensureIdx + 1] as SourcePlatform | undefined;
    if (!platform) {
      process.stderr.write(
        "[init] ERROR: --ensure-cli requires a source platform argument.\n" +
        "  usage: init --ensure-cli <langfuse|otel|local-jsonl|claude-code|codex>\n"
      );
      process.exit(2);
    }
    // Chat-based approval fallback (this is a direct CLI invocation, not Claude Code).
    // Claude Code callers drive ensureSourceCli() directly with an AskUserQuestion adapter.
    const result = await ensureSourceCli(platform, promptInstallApprovalChat);
    process.stdout.write(`\n[init] ${result.note}\n`);
    process.stdout.write(JSON.stringify({
      platform: result.platform,
      outcome: result.outcome,
      cliAvailable: result.cliAvailable,
      status: result.plan.status,
      docsUrl: result.plan.docsUrl,
    }, null, 2) + "\n");
    // Exit 0 for every NON-error outcome (declined is a valid user choice → REST fallback).
    process.exit(result.outcome === "install-failed" ? 1 : 0);
  }

  // Resolve mode (W9-10 single dispatch flag) + install scope (W9-fix)
  const mode = resolveMode(argv);
  const scope = resolveScope(argv);
  const autoYes = argv.includes("--yes");
  const force = argv.includes("--force");

  // The skill SOURCE dir is resolved from import.meta (stays correct through symlink
  // chains). The install TARGET root is the user's invocation cwd — NEVER the script
  // dir (F-SELF-05 cwd-leak family). projectRoot = explicit positional arg, else cwd.
  const scriptDir = realpathSync(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""));
  const skillDir = resolve(scriptDir, "../..");
  // parsePositionals skips value-flag tokens (--mode <v>, --ensure-cli <v>) so the
  // --mode VALUE is never mistaken for projectRoot. Falls back to the invocation cwd.
  const projectRoot = parsePositionals(argv)[0] ?? process.cwd();

  if (mode === "install") {
    const code = await runModeInstall(skillDir, autoYes, force, scope, projectRoot);
    process.exit(code);
  }

  if (mode === "reconfigure") {
    const code = runModeReconfigure(projectRoot);
    process.exit(code);
  }

  // mode === "init" (default) — W9-10: install + emit descriptor
  const code = await runModeInit(skillDir, projectRoot, autoYes, force, scope);
  process.exit(code);
}
