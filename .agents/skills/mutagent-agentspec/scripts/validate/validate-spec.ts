/**
 * scripts/validate/validate-spec.ts
 * The *validate-spec gate — TypeBox round-trip validation of an agentspec.yaml file.
 * Type A — Pure Script (a pure parse+validate function + a thin guarded CLI).
 *
 * Usage: scripts/cli/run.sh scripts/validate/validate-spec.ts <path-to-agentspec.yaml>
 *   exit 0 = the spec parses + validates against agentspec.v0.2.0  → "[validate-spec] PASS"
 *   exit 1 = parse error OR schema violation (field-pathed errors on stdout)
 *
 * Mirrors the handover-contract.ts CLI: guarded file read, deterministic (the only input is the
 * file argument), `import.meta.main` entrypoint. Never throws on validation — only on a genuinely
 * unreadable file (surfaced as exit 1 with a message).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { validateAgentSpec } from "../contract/agentspec.schema.ts";
import type { ValidationResult } from "../contract/agentspec.schema.ts";

export interface SpecValidationOutcome extends ValidationResult {
  /** True when the YAML failed to parse (distinct from a schema violation). */
  parseError: boolean;
}

/**
 * Parse a YAML spec STRING and validate it against the agentspec contract. Pure: no I/O.
 * A YAML parse failure is reported as { ok:false, parseError:true } rather than thrown, so callers
 * get a uniform outcome shape.
 */
export function validateSpecYaml(yamlText: string): SpecValidationOutcome {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    return {
      ok: false,
      parseError: true,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const result = validateAgentSpec(parsed);
  return { ...result, parseError: false };
}

/**
 * Read a spec file from disk and validate it. Throws ONLY when the file cannot be read; a parse or
 * schema failure is returned as a non-ok outcome.
 */
export function validateSpecFile(filePath: string): SpecValidationOutcome {
  const text = fs.readFileSync(path.resolve(filePath), "utf-8");
  return validateSpecYaml(text);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function runCli(argv: string[]): number {
  const inputPath = argv.slice(2).find((a) => !a.startsWith("--"));
  if (inputPath === undefined) {
    process.stderr.write(
      "Usage: scripts/cli/run.sh scripts/validate/validate-spec.ts <agentspec.yaml>\n" +
        "Validates a spec against the frozen agentspec.v0.2.0 contract.\n" +
        "Exit 0 = valid; exit 1 = parse error or schema violation.\n",
    );
    return 1;
  }

  let outcome: SpecValidationOutcome;
  try {
    outcome = validateSpecFile(inputPath);
  } catch (err) {
    process.stderr.write(`Error reading ${inputPath}: ${String(err)}\n`);
    return 1;
  }

  if (outcome.ok) {
    console.info(`[validate-spec] PASS — ${inputPath} is a valid agentspec.v0.2.0.`);
    return 0;
  }
  for (const e of outcome.errors) console.info(e);
  process.stderr.write(
    `[validate-spec] FAIL — ${outcome.errors.length} error(s) in ${inputPath}.\n`,
  );
  return 1;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
