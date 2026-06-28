/**
 * scripts/load-profile.ts
 * ---------------------------------------------------------------------------
 * Loads + validates a subject profile (subjects/<name>/eval-matrix.yaml and its
 * siblings) against the TypeBox contracts. The agent ships ZERO subject-specific
 * logic — everything skill-specific lives in these generated YAML profiles, so
 * this loader is the gateway that turns profile DATA into typed, validated input
 * for the deterministic engine.
 *
 * Deterministic: pure parse + validate, no clock/random/network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Value } from "@sinclair/typebox/value";
import { type EvalMatrix, EvalMatrixSchema } from "./contracts/types.ts";

export interface ProfilePaths {
  evalMatrix: string;
  behaviorTree: string;
  methodologyReview: string;
}

export function resolveProfilePaths(
  subjectsRoot: string,
  subject: string,
): ProfilePaths {
  const dir = join(subjectsRoot, subject);
  return {
    evalMatrix: join(dir, "eval-matrix.yaml"),
    behaviorTree: join(dir, "behavior-tree.yaml"),
    methodologyReview: join(dir, "methodology-review.yaml"),
  };
}

export interface LoadedEvalMatrix {
  matrix: EvalMatrix;
  errors: string[];
}

/**
 * Load + TypeBox-validate the eval-matrix. Returns structured errors (never a
 * boolean-only verdict) so callers can fail-loud with all schema violations.
 */
export function loadEvalMatrix(path: string): LoadedEvalMatrix {
  if (!existsSync(path)) {
    throw new Error(`load-profile: eval-matrix not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;

  const errors: string[] = [];
  for (const err of Value.Errors(EvalMatrixSchema, parsed)) {
    errors.push(`${err.path || "/"}: ${err.message}`);
  }
  // Even on schema errors we return the parsed value so a count assertion can
  // still run; callers decide whether to proceed.
  return { matrix: parsed as EvalMatrix, errors };
}

/** Raw YAML loader for the behavior-tree / methodology-review (judge-side). */
export function loadYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`load-profile: file not found: ${path}`);
  }
  return parseYaml(readFileSync(path, "utf8")) as unknown;
}

/** Total criteria across all components — used by the 132-count acceptance. */
export function countCriteria(matrix: EvalMatrix): number {
  return matrix.components.reduce((n, c) => n + c.criteria.length, 0);
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
declare const Bun: { argv: string[] } | undefined;
function main(): void {
  const argv =
    typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const path = argv[0];
  if (!path) {
    console.error("usage: load-profile.ts <eval-matrix.yaml>");
    process.exit(2);
  }
  const { matrix, errors } = loadEvalMatrix(path);
  console.info(
    JSON.stringify(
      {
        subject: matrix.subject,
        version: matrix.version,
        components: matrix.components?.length ?? 0,
        criteria: errors.length === 0 ? countCriteria(matrix) : "n/a",
        schemaErrors: errors,
      },
      null,
      2,
    ),
  );
  process.exit(errors.length === 0 ? 0 : 1);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  main();
}
