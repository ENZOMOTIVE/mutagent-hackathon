/**
 * scripts/config/load.ts
 * Load and parse .mutagent-diagnostics/config.yaml, resolving env-ref secrets from .mutagentrc
 * Type A — Pure Script (deterministic YAML parse + env lookup)
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { DiagnosticsConfig } from "./schema.ts";

export interface LoadResult {
  config: DiagnosticsConfig | null;
  exists: boolean;
  error: string | null;
}

/**
 * Load config.yaml from the given host project root.
 * Secrets are NOT embedded in config.yaml — they are referenced by key name
 * (e.g., credential_ref: "LANGFUSE_SECRET_KEY") and must be in .mutagentrc.
 */
export function loadConfig(projectRoot: string): LoadResult {
  const configPath = resolve(projectRoot, ".mutagent-diagnostics", "config.yaml");

  if (!existsSync(configPath)) {
    return { config: null, exists: false, error: null };
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as DiagnosticsConfig;
    return { config: parsed, exists: true, error: null };
  } catch (err) {
    return {
      config: null,
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// CLI usage: bun scripts/config/load.ts [project-root]
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const result = loadConfig(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.error ? 1 : 0);
}
