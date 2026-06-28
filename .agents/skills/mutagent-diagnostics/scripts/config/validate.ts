/**
 * scripts/config/validate.ts
 * Schema validation for config.yaml using TypeBox
 * Type A — Pure Script (deterministic validation, typed errors)
 */

import { Value } from "@sinclair/typebox/value";
import { DiagnosticsConfigSchema } from "./schema.ts";
import type { DiagnosticsConfig } from "./schema.ts";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  missingFields: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * Validate a parsed config object against the TypeBox schema.
 * Returns typed errors and a list of missing required fields.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!Value.Check(DiagnosticsConfigSchema, raw)) {
    for (const error of Value.Errors(DiagnosticsConfigSchema, raw)) {
      errors.push({
        path: error.path,
        message: error.message,
        value: error.value,
      });
    }
  }

  // Identify missing required fields for per-field completeness check (FR-002)
  const missingFields: string[] = [];
  const config = raw as Partial<DiagnosticsConfig>;

  if (!config.source?.platform) missingFields.push("source.platform");
  if (!config.target?.platform) missingFields.push("target.platform");
  if (!config.ask_tool?.runtime) missingFields.push("ask_tool.runtime");

  return {
    valid: errors.length === 0 && missingFields.length === 0,
    errors,
    missingFields,
  };
}

// CLI usage: bun scripts/config/validate.ts [config-json-string]
if (import.meta.main) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write("Usage: bun scripts/config/validate.ts '<json>'\n");
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(input);
    const result = validateConfig(parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.valid ? 0 : 1);
  } catch (err) {
    process.stderr.write(`JSON parse error: ${err}\n`);
    process.exit(1);
  }
}
