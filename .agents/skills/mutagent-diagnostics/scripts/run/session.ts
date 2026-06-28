/**
 * scripts/run/session.ts
 * v0.3 run-tagging: generate + persist run metadata per diagnostic session.
 *
 * Every diagnostic run gets a unique runId + a set of tags for
 * tracking/filtering in diagnostics-history. Self-diagnostics runs
 * auto-tag with ["self-diagnostics", "internal"].
 *
 * Usage:
 *   import { createRunSession, persistRunMeta, finalizeRunSession } from "./session.ts";
 *
 *   const session = createRunSession({ configRoot, extraTags: ["my-run"] });
 *   // ... run diagnostics ...
 *   await finalizeRunSession(session, { traceCount: 12, source: "langfuse", target: "local-claude" });
 *
 * Type A — Pure Script (file I/O only, no LLM calls)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { RunMeta } from "../config/schema.ts";

export interface RunSessionInit {
  /** Root of the host project (where .mutagent-diagnostics/ lives) */
  configRoot: string;
  /** Additional tags from --tag CLI args or caller context */
  extraTags?: string[];
  /** Tags from config.yaml run_tags (applied to every run) */
  configTags?: string[];
  /** Override runId — useful for testing or replay */
  runIdOverride?: string;
}

export interface RunSession {
  runId: string;
  tags: string[];
  startedAt: string;
  sessionDir: string;
  metaPath: string;
}

/**
 * Generate a short random hex suffix to distinguish parallel runs in the same second.
 */
function shortHex(n = 6): string {
  const arr = new Uint8Array(n);
  // Use Math.random as a portable fallback (no crypto in all environments)
  for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a new run session — generates runId, resolves tags, creates session dir.
 */
export function createRunSession(init: RunSessionInit): RunSession {
  const { configRoot, extraTags = [], configTags = [], runIdOverride } = init;

  const ts = Date.now();
  const runId = runIdOverride ?? `run-${ts}-${shortHex(4)}`;
  const startedAt = new Date(ts).toISOString();

  // Merge tags, dedup, preserve order (configTags first, then extraTags)
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of [...configTags, ...extraTags]) {
    const normalized = t.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
  }

  const historyBase = resolve(configRoot, ".mutagent-diagnostics", "diagnostics-history");
  const sessionDir = join(historyBase, runId);
  const metaPath = join(sessionDir, "run-meta.json");

  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  return { runId, tags, startedAt, sessionDir, metaPath };
}

/**
 * Persist run-meta.json to the session directory.
 * Call this immediately after createRunSession (partial write — no endedAt yet).
 */
export function persistRunMeta(
  session: RunSession,
  partial: Partial<Pick<RunMeta, "source" | "target" | "traceCount" | "operatorInvocation">> = {}
): RunMeta {
  const meta: RunMeta = {
    runId: session.runId,
    tags: session.tags,
    startedAt: session.startedAt,
    ...partial,
  };
  writeFileSync(session.metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

/**
 * Finalize the run session — writes endedAt + final traceCount to run-meta.json.
 */
export function finalizeRunSession(
  session: RunSession,
  final: Partial<Pick<RunMeta, "source" | "target" | "traceCount" | "operatorInvocation">> = {}
): RunMeta {
  // Read existing meta if present (preserves fields written at start)
  let existing: RunMeta = {
    runId: session.runId,
    tags: session.tags,
    startedAt: session.startedAt,
  };
  if (existsSync(session.metaPath)) {
    try {
      existing = JSON.parse(readFileSync(session.metaPath, "utf8")) as RunMeta;
    } catch {
      // ignore parse errors — overwrite with current state
    }
  }
  const meta: RunMeta = {
    ...existing,
    ...final,
    endedAt: new Date().toISOString(),
  };
  writeFileSync(session.metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

/**
 * Compute run tags for a self-diagnostics invocation.
 * Self-diag runs always carry ["self-diagnostics", "internal"].
 */
export function selfDiagTags(extraTags: string[] = []): string[] {
  return ["self-diagnostics", "internal", ...extraTags];
}

// CLI entrypoint: create + print a new run session (useful for scripting)
if (import.meta.main) {
  const args = process.argv.slice(2);
  const configRoot = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const tagArgs = args
    .filter((a) => a.startsWith("--tag="))
    .map((a) => a.slice("--tag=".length));
  const isSelfDiag = args.includes("--self-diagnostics");
  const extraTags = isSelfDiag ? selfDiagTags(tagArgs) : tagArgs;

  const session = createRunSession({ configRoot, extraTags });
  const meta = persistRunMeta(session);
  process.stdout.write(JSON.stringify({ session, meta }, null, 2) + "\n");
  process.exit(0);
}
