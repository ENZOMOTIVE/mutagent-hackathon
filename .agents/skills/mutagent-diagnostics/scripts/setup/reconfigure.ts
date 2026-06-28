/**
 * scripts/setup/reconfigure.ts
 * AGENT-HANDLE route-signal (W9-10 simplify — FR-003)
 *
 * Backs up the current config and emits a route-signal JSON so the agent knows
 * a fresh onboarding pass is needed. The interactive re-onboarding itself is
 * handled by the agent reading SKILL.md + references/workflows/onboarding.md
 * inline — this script does NOT orchestrate the questions or write new config.
 *
 * Usage: bun scripts/cli/run.sh scripts/setup/reconfigure.ts [project-root]
 * Or:    pnpx @mutagent/diagnostics init --mode reconfigure [project-root]
 */

import { existsSync, copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

/**
 * Route-signal emitted to the agent. The agent reads `action` and `message`,
 * then re-runs onboarding.md Phase 1..8 inline. It does NOT dispatch a sub-agent.
 */
export interface ReconfigureSignal {
  action: "reconfigure";
  backupPath: string | null;
  backupCreated: boolean;
  message: string;
}

/** @deprecated Use ReconfigureSignal instead. Kept for backward compatibility. */
export type ReconfigureResult = ReconfigureSignal;

/**
 * Back up the existing config and return a route-signal for the agent.
 * The agent is responsible for re-running onboarding.md inline after receiving this.
 */
export function prepareReconfigure(projectRoot: string): ReconfigureSignal {
  const configDir = resolve(projectRoot, ".mutagent-diagnostics");
  const configPath = resolve(configDir, "config.yaml");
  const backupPath = resolve(configDir, `config.yaml.bak.${Date.now()}`);

  if (!existsSync(configPath)) {
    return {
      action: "reconfigure",
      backupPath: null,
      backupCreated: false,
      message: "No existing config found — starting fresh onboarding. Load references/workflows/onboarding.md.",
    };
  }

  try {
    mkdirSync(configDir, { recursive: true });
    copyFileSync(configPath, backupPath);
    return {
      action: "reconfigure",
      backupPath,
      backupCreated: true,
      message: `Config backed up to ${backupPath}. Load references/workflows/onboarding.md to reconfigure.`,
    };
  } catch (err) {
    return {
      action: "reconfigure",
      backupPath: null,
      backupCreated: false,
      message: `Warning: could not back up config: ${err}. Load references/workflows/onboarding.md to reconfigure.`,
    };
  }
}

// CLI entrypoint — emits route-signal JSON; agent handles the rest
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const signal = prepareReconfigure(projectRoot);
  process.stdout.write(JSON.stringify(signal, null, 2) + "\n");
  process.exit(0);
}
