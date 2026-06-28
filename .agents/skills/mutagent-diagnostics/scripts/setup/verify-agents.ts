/**
 * scripts/setup/verify-agents.ts
 * R-SELF-01-d: Agent-spin verification boundary check.
 *
 * After install-agents.ts symlinks the 3 agent .md files, this script verifies
 * that each is present at its installed location AND that its YAML frontmatter
 * declares the expected `name:` field. This prevents the recurring failure mode
 * where agents are "installed" but the registry never picked them up.
 *
 * Usage: bun scripts/cli/run.sh scripts/setup/verify-agents.ts [project-root] [--scope=project|user]
 * Exit 0 = all agents ready
 * Exit 1 = one or more agents missing/invalid/pending restart
 */

import { existsSync, readFileSync, lstatSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export type AgentBoundaryState = "ready" | "missing" | "invalid" | "pending-restart";

export interface AgentVerifyEntry {
  agentName: string;
  expectedName: string;
  installedPath: string;
  state: AgentBoundaryState;
  note?: string;
}

export interface AgentVerifyResult {
  /**
   * I-009: orchestrator field removed from top-level schema.
   * diagnostics-orchestrator is retired (P2 pivot — inline protocol only).
   * Summary is derived from entries[] — see formatVerifyResult() + allReady check.
   */
  analyzer: AgentBoundaryState;
  applyWorker: AgentBoundaryState;
  /** True when at least one agent was installed but the session has NOT been restarted */
  harnessRestartRequired: boolean;
  /** Marker written by install-agents.ts to indicate a post-install restart is needed */
  restartMarkerExists: boolean;
  entries: AgentVerifyEntry[];
  errors: string[];
}

/**
 * P2 pivot: orchestrator sub-agent retired — procedure is now an inline protocol.
 * Only 2 agents remain as installed sub-agents: analyzer + apply-worker (leaf workers).
 */
const EXPECTED_AGENTS: Array<{ filename: string; expectedName: string; key: keyof Pick<AgentVerifyResult, "analyzer" | "applyWorker"> }> = [
  { filename: "diagnostics-analyzer.md",     expectedName: "diagnostics-analyzer",     key: "analyzer" },
  { filename: "diagnostics-apply-worker.md", expectedName: "diagnostics-apply-worker", key: "applyWorker" },
];

/** Minimal YAML frontmatter parser — extracts `name:` field only */
function extractFrontmatterName(content: string): string | null {
  // Frontmatter is delimited by --- at line start
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/m);
  if (!match) return null;
  const frontmatter = match[1];
  const nameLine = frontmatter.match(/^name:\s*(.+)$/m);
  if (!nameLine) return null;
  return nameLine[1].trim().replace(/^['"]|['"]$/g, ""); // strip optional quotes
}

export function verifyAgents(
  projectRoot: string,
  scope: "project" | "user" = "project"
): AgentVerifyResult {
  const result: AgentVerifyResult = {
    // I-009: orchestrator field removed — summary derived from entries[] only.
    analyzer: "missing",
    applyWorker: "missing",
    harnessRestartRequired: false,
    restartMarkerExists: false,
    entries: [],
    errors: [],
  };

  // Resolve the target agents directory
  let agentsDir: string;
  if (scope === "project") {
    agentsDir = join(projectRoot, ".claude", "agents");
  } else {
    agentsDir = join(homedir(), ".claude", "agents");
  }

  // Check for restart marker written by install-agents.ts
  const restartMarkerPath = join(agentsDir, ".mutagent-diagnostics-restart-required");
  if (existsSync(restartMarkerPath)) {
    result.restartMarkerExists = true;
    result.harnessRestartRequired = true;
  }

  for (const agent of EXPECTED_AGENTS) {
    const installedPath = join(agentsDir, agent.filename);
    const entry: AgentVerifyEntry = {
      agentName: agent.expectedName,
      expectedName: agent.expectedName,
      installedPath,
      state: "missing",
    };

    if (!existsSync(installedPath)) {
      entry.state = "missing";
      entry.note = `File not found at ${installedPath}. Run: bun scripts/cli/run.sh scripts/cli/install-agents.ts "${projectRoot}" --scope=${scope}`;
      result.entries.push(entry);
      result[agent.key] = "missing";
      continue;
    }

    // Check it's a readable file (or valid symlink)
    let content: string;
    try {
      const stat = lstatSync(installedPath);
      if (stat.isSymbolicLink()) {
        // resolve() already follows symlinks for existsSync, but we read actual content
      }
      content = readFileSync(installedPath, "utf8");
    } catch (err) {
      entry.state = "invalid";
      entry.note = `Could not read ${installedPath}: ${err}`;
      result.entries.push(entry);
      result[agent.key] = "invalid";
      result.errors.push(`${agent.filename}: read error — ${err}`);
      continue;
    }

    // Validate frontmatter name
    const parsedName = extractFrontmatterName(content);
    if (!parsedName) {
      entry.state = "invalid";
      entry.note = `No YAML frontmatter found in ${installedPath}. File may be corrupted or wrong format.`;
      result.entries.push(entry);
      result[agent.key] = "invalid";
      result.errors.push(`${agent.filename}: missing frontmatter`);
      continue;
    }

    if (parsedName !== agent.expectedName) {
      entry.state = "invalid";
      entry.note = `Frontmatter name mismatch: expected "${agent.expectedName}", got "${parsedName}". File at ${installedPath} may be a different agent.`;
      result.entries.push(entry);
      result[agent.key] = "invalid";
      result.errors.push(`${agent.filename}: name mismatch ("${parsedName}" vs "${agent.expectedName}")`);
      continue;
    }

    // All checks passed — but if restart is required, state is pending-restart
    if (result.harnessRestartRequired) {
      entry.state = "pending-restart";
      entry.note = "Agent file is valid. Session restart required for registry to pick up the new subagent_type.";
      result[agent.key] = "pending-restart";
    } else {
      entry.state = "ready";
      result[agent.key] = "ready";
    }

    result.entries.push(entry);
  }

  return result;
}

export function formatVerifyResult(res: AgentVerifyResult): string {
  const lines: string[] = ["[verify-agents]"];
  for (const e of res.entries) {
    const icon = e.state === "ready" ? "✓" : e.state === "pending-restart" ? "⏳" : e.state === "invalid" ? "✗" : "✗";
    lines.push(`  ${icon} ${e.agentName}: ${e.state}${e.note ? `\n     → ${e.note}` : ""}`);
  }
  if (res.harnessRestartRequired) {
    lines.push("");
    lines.push("⚠ RESTART REQUIRED: Restart your Claude Code session before running diagnostics.");
    lines.push("  The subagent_type registry is loaded at session boot — new agents are invisible until restart.");
  }
  if (res.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of res.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const projectRoot = resolve(positional[0] ?? process.cwd());
  const scopeArg = args.find((a) => a.startsWith("--scope="));
  const scope: "project" | "user" = scopeArg?.split("=")[1] === "user" ? "user" : "project";

  const result = verifyAgents(projectRoot, scope);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stderr.write(formatVerifyResult(result) + "\n");

  // I-009: summary derived from entries[] — orchestrator key removed from top-level schema.
  const allReady = result.analyzer === "ready" && result.applyWorker === "ready";
  process.exit(allReady ? 0 : 1);
}
