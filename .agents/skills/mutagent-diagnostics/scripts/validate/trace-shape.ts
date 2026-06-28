/**
 * scripts/validate/trace-shape.ts
 * F-SELF-08: Validate that raw trace data conforms to TraceMetadata shape before
 * feeding into tier0-scan or per-platform normalizers.
 *
 * This is NOT a normalizer — it validates that objects already normalized by a
 * per-platform module (or manually constructed) meet the structural contract
 * required by the rest of the diagnostics pipeline.
 *
 * Usage: bun scripts/cli/run.sh scripts/validate/trace-shape.ts <traces.json>
 *
 * Exit 0 = all traces valid.
 * Exit 1 = one or more traces have structural violations (details on stderr).
 *
 * Type A — Pure Script (deterministic, no I/O except argument file)
 */

import { readFileSync } from "fs";
import type { TraceMetadata } from "../normalize/trace.ts";

export interface TraceShapeViolation {
  traceIndex: number;
  traceId?: string;
  field: string;
  message: string;
}

export interface TraceShapeResult {
  valid: boolean;
  totalTraces: number;
  invalidCount: number;
  violations: TraceShapeViolation[];
}

/**
 * Validate a single trace object against the TraceMetadata structural contract.
 * Returns a list of violations (empty = valid).
 */
export function validateTraceShape(
  raw: unknown,
  index: number
): TraceShapeViolation[] {
  const violations: TraceShapeViolation[] = [];

  // Must be a non-null object
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    violations.push({
      traceIndex: index,
      field: "(root)",
      message: `Expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    });
    return violations; // No point checking fields on non-objects
  }

  const t = raw as Record<string, unknown>;

  // ── Required fields ────────────────────────────────────────────────────────

  if (typeof t.traceId !== "string" || t.traceId.trim() === "") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "traceId",
      message: "Required string field is missing or empty",
    });
  }

  if (typeof t.sessionId !== "string" || t.sessionId.trim() === "") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "sessionId",
      message: "Required string field is missing or empty",
    });
  }

  if (typeof t.hasError !== "boolean") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "hasError",
      message: `Required boolean field is ${t.hasError === undefined ? "missing" : `type "${typeof t.hasError}"`}`,
    });
  }

  if (typeof t.hasFeedback !== "boolean") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "hasFeedback",
      message: `Required boolean field is ${t.hasFeedback === undefined ? "missing" : `type "${typeof t.hasFeedback}"`}`,
    });
  }

  const validPlatforms = new Set(["langfuse", "otel", "local-jsonl", "claude-code", "codex"]);
  if (typeof t.sourcePlatform !== "string" || !validPlatforms.has(t.sourcePlatform)) {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "sourcePlatform",
      message: `Expected one of ${[...validPlatforms].join(", ")}, got ${JSON.stringify(t.sourcePlatform)}`,
    });
  }

  // ── Optional fields — type-check only if present ───────────────────────────

  if (t.latencyMs !== undefined && typeof t.latencyMs !== "number") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "latencyMs",
      message: `Optional field present but wrong type: expected number, got "${typeof t.latencyMs}"`,
    });
  }

  if (t.rawScore !== undefined && typeof t.rawScore !== "number") {
    violations.push({
      traceIndex: index,
      traceId: typeof t.traceId === "string" ? t.traceId : undefined,
      field: "rawScore",
      message: `Optional field present but wrong type: expected number, got "${typeof t.rawScore}"`,
    });
  }

  if (t.normalizedScore !== undefined) {
    if (typeof t.normalizedScore !== "number") {
      violations.push({
        traceIndex: index,
        traceId: typeof t.traceId === "string" ? t.traceId : undefined,
        field: "normalizedScore",
        message: `Optional field present but wrong type: expected number, got "${typeof t.normalizedScore}"`,
      });
    } else if (t.normalizedScore < 0 || t.normalizedScore > 1) {
      violations.push({
        traceIndex: index,
        traceId: typeof t.traceId === "string" ? t.traceId : undefined,
        field: "normalizedScore",
        message: `normalizedScore must be in [0, 1], got ${t.normalizedScore}`,
      });
    }
  }

  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags)) {
      violations.push({
        traceIndex: index,
        traceId: typeof t.traceId === "string" ? t.traceId : undefined,
        field: "tags",
        message: `Optional field present but wrong type: expected string[], got "${typeof t.tags}"`,
      });
    } else if (t.tags.some((tag: unknown) => typeof tag !== "string")) {
      violations.push({
        traceIndex: index,
        traceId: typeof t.traceId === "string" ? t.traceId : undefined,
        field: "tags",
        message: "tags array contains non-string elements",
      });
    }
  }

  // R-SELF-06-a: validate apiErrors shape if present
  if (t.apiErrors !== undefined) {
    if (!Array.isArray(t.apiErrors)) {
      violations.push({
        traceIndex: index,
        traceId: typeof t.traceId === "string" ? t.traceId : undefined,
        field: "apiErrors",
        message: `Expected array, got "${typeof t.apiErrors}"`,
      });
    } else {
      for (let i = 0; i < t.apiErrors.length; i++) {
        const e = t.apiErrors[i] as Record<string, unknown>;
        if (typeof e.retryAttempt !== "number") {
          violations.push({
            traceIndex: index,
            traceId: typeof t.traceId === "string" ? t.traceId : undefined,
            field: `apiErrors[${i}].retryAttempt`,
            message: `Expected number, got "${typeof e.retryAttempt}"`,
          });
        }
        if (typeof e.maxRetries !== "number") {
          violations.push({
            traceIndex: index,
            traceId: typeof t.traceId === "string" ? t.traceId : undefined,
            field: `apiErrors[${i}].maxRetries`,
            message: `Expected number, got "${typeof e.maxRetries}"`,
          });
        }
        if (typeof e.timestamp !== "string") {
          violations.push({
            traceIndex: index,
            traceId: typeof t.traceId === "string" ? t.traceId : undefined,
            field: `apiErrors[${i}].timestamp`,
            message: `Expected string, got "${typeof e.timestamp}"`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Validate an array of raw trace objects.
 * Returns a summary result with all violations.
 */
export function validateTraceShapes(raws: unknown[]): TraceShapeResult {
  const allViolations: TraceShapeViolation[] = [];
  for (let i = 0; i < raws.length; i++) {
    const v = validateTraceShape(raws[i], i);
    allViolations.push(...v);
  }
  const invalidSet = new Set(allViolations.map((v) => v.traceIndex));
  return {
    valid: allViolations.length === 0,
    totalTraces: raws.length,
    invalidCount: invalidSet.size,
    violations: allViolations,
  };
}

/**
 * Guard: throws if any violations found. Useful at normalizer output boundaries.
 */
export function assertTraceShapes(traces: unknown[]): asserts traces is TraceMetadata[] {
  const result = validateTraceShapes(traces);
  if (!result.valid) {
    const lines = result.violations.map(
      (v) => `  [trace #${v.traceIndex}${v.traceId ? ` (${v.traceId})` : ""}] ${v.field}: ${v.message}`
    );
    throw new Error(`TraceMetadata shape validation failed (${result.invalidCount} invalid traces):\n${lines.join("\n")}`);
  }
}

// CLI entrypoint
if (import.meta.main) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("Usage: bun scripts/cli/run.sh scripts/validate/trace-shape.ts <traces.json>\n");
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(inputPath, "utf8"));
    if (!Array.isArray(raw)) {
      process.stderr.write("Error: input file must contain a JSON array\n");
      process.exit(1);
    }
    const result = validateTraceShapes(raw);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.valid) {
      process.stderr.write(`Validation failed: ${result.invalidCount}/${result.totalTraces} traces have violations\n`);
      process.exit(1);
    }
    process.stderr.write(`Validation passed: ${result.totalTraces} traces OK\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
