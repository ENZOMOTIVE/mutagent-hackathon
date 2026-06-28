/**
 * scripts/normalize/platforms/local-jsonl.ts
 * Generic local .jsonl / .ndjson trace file → canonical TraceBody
 * Type A — Pure Script
 * Reference: references/source-platforms/local-jsonl.md
 *
 * Expects one JSON object per line. The schema is lenient — unknown fields are ignored.
 * If a line has a `messages` array, treat it as a trace-with-messages.
 * Otherwise treat the whole line as a single message event.
 */

import type { TraceBody, TraceMetadata, TraceMessage, EntityContext } from "../trace.ts";
import { buildAgentEntityContext, deterministicTraceId } from "./entity-context.ts";

interface LocalJsonlLine {
  id?: string;
  traceId?: string;
  sessionId?: string;
  agentId?: string;
  startTime?: string;
  endTime?: string;
  latencyMs?: number;
  hasError?: boolean;
  hasFeedback?: boolean;
  score?: number;
  feedback?: string;
  tags?: string[];
  messages?: LocalJsonlMessage[];
  // Single-message fields
  role?: string;
  content?: string;
  toolName?: string;
  timestamp?: string;
}

interface LocalJsonlMessage {
  role?: string;
  content?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string;
}

export function normalizeLocalJsonlLine(raw: LocalJsonlLine): TraceBody {
  // Variance fix (Wave-13): no native id/traceId ⇒ derive a DETERMINISTIC id from
  // the line content (content hash), not `Date.now()`, so the same line always
  // hashes to the same id (stable dedup/selection primary key across runs).
  const traceId = raw.id ?? raw.traceId ?? deterministicTraceId("local", JSON.stringify(raw));

  const metadata: TraceMetadata = {
    traceId,
    sessionId: raw.sessionId ?? traceId,
    agentId: raw.agentId,
    startTime: raw.startTime,
    endTime: raw.endTime,
    latencyMs: raw.latencyMs,
    hasError: raw.hasError ?? false,
    hasFeedback: raw.hasFeedback ?? (raw.score !== undefined || !!raw.feedback),
    rawScore: raw.score,
    tags: raw.tags,
    sourcePlatform: "local-jsonl",
  };

  const messages: TraceMessage[] = raw.messages
    ? raw.messages.map((m, index) => ({
        index,
        role: (m.role ?? "assistant") as TraceMessage["role"],
        content: m.content ?? "",
        toolName: m.toolName,
        isError: m.isError,
        timestamp: m.timestamp,
      }))
    : [
        {
          index: 0,
          role: (raw.role ?? "assistant") as TraceMessage["role"],
          content: raw.content ?? JSON.stringify(raw),
          toolName: raw.toolName,
          timestamp: raw.timestamp,
        },
      ];

  return {
    metadata,
    messages,
    userFeedback: raw.feedback,
    score: raw.score,
  };
}

// ── F-S7: tolerant-but-visible NDJSON line drops (PR-055 proposed) ────────────

/** Default number of raw bad-line samples retained for operator triage. */
export const DEFAULT_DROPPED_SAMPLE_LIMIT = 5;

/**
 * F-S7 (PR-055 proposed): a single source's partial-load record — shape-matches
 * `RunMeta.partial_loads[N]` in trace.ts so the producer can attach it directly.
 *   source           -- provenance label (e.g. 'local-jsonl: traces.ndjson')
 *   droppedLineCount -- total NDJSON lines dropped (failed JSON.parse) for this source
 *   droppedSamples   -- first-N raw bad lines (verbatim), capped at the sample limit
 */
export interface LocalJsonlPartialLoad {
  source: string;
  droppedLineCount: number;
  droppedSamples: string[];
}

/**
 * F-S7 (PR-055 proposed): result of parsing an NDJSON file with VISIBLE drops.
 * `bodies` is one TraceBody per successfully-parsed line. `partialLoad` is
 * present ONLY when ≥1 line was dropped — so the caller can spread it (or not)
 * into `runMeta.partial_loads` without a length check.
 */
export interface LocalJsonlParseResult {
  bodies: TraceBody[];
  /** Present iff droppedLineCount > 0. Attach to runMeta.partial_loads. */
  partialLoad?: LocalJsonlPartialLoad;
}

/**
 * F-S7 (PR-055 proposed): parse a full .jsonl/.ndjson file (string) with
 * TOLERANT-BUT-VISIBLE line drops.
 *
 * Behaviour (the "tolerant but visible" contract):
 *   - Lines that fail JSON.parse are STILL skipped (parsing stays resilient to
 *     truncation / bad unicode — one bad line never aborts the whole corpus), BUT
 *   - the count of dropped lines is accumulated, AND
 *   - the first-N (default 5) raw bad lines are retained verbatim as samples, AND
 *   - when ≥1 line dropped, a `partialLoad` record is returned so the producer
 *     can thread it into `runMeta.partial_loads` and the report can caveat coverage
 *     honestly instead of silently undercounting.
 *
 * @param content      Raw file contents (NDJSON).
 * @param sourceLabel  Provenance label for the partial-load record
 *                     (e.g. 'local-jsonl: traces.ndjson'). Defaults to 'local-jsonl'.
 * @param sampleLimit  Max raw bad-line samples to retain. Default 5.
 *
 * Deterministic — same input → same bodies, count, and samples.
 */
export function normalizeLocalJsonlFileWithDrops(
  content: string,
  sourceLabel = "local-jsonl",
  sampleLimit: number = DEFAULT_DROPPED_SAMPLE_LIMIT
): LocalJsonlParseResult {
  const bodies: TraceBody[] = [];
  let droppedLineCount = 0;
  const droppedSamples: string[] = [];

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      bodies.push(normalizeLocalJsonlLine(JSON.parse(line)));
    } catch {
      // Keep skipping bad lines (tolerant) — but COUNT + SAMPLE them (visible).
      droppedLineCount += 1;
      if (droppedSamples.length < sampleLimit) {
        droppedSamples.push(line);
      }
    }
  }

  if (droppedLineCount === 0) return { bodies };
  return {
    bodies,
    partialLoad: { source: sourceLabel, droppedLineCount, droppedSamples },
  };
}

/**
 * Parse a full .jsonl file (string) and return one TraceBody per line.
 * Lines that fail JSON.parse are skipped.
 *
 * F-S7: this thin wrapper preserves the original `TraceBody[]`-returning
 * signature for existing callers. To SURFACE dropped lines (the tolerant-but-
 * visible contract), call `normalizeLocalJsonlFileWithDrops` instead and thread
 * its `partialLoad` into `runMeta.partial_loads`.
 */
export function normalizeLocalJsonlFile(content: string): TraceBody[] {
  return normalizeLocalJsonlFileWithDrops(content).bodies;
}

// ── R1.7 — EntityContext extraction (DETERMINISTIC, NO LLM) ───────────────────

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): extract an agent-typed EntityContext from a set
 * of normalized local-jsonl TraceBodies. Content-derived, deterministic.
 */
export function extractLocalJsonlEntityContext(bodies: TraceBody[]): EntityContext {
  return buildAgentEntityContext(bodies, {
    source: "local-jsonl",
    fallbackName: bodies[0]?.metadata.agentId ?? "local-agent",
  });
}

// ── REQ-052: INTERNAL CLI transport ───────────────────────────────────────────
//
// REQ-052 (langfuse-mirroring transport for all 5 platforms): makes the
// deterministic local-jsonl normalizer + EntityContext extractor RUNNABLE via
// scripts/cli/run.sh, so entity-context production no longer needs inline `bun -e`
// glue (banned by R-SELF-03-c). INTERNAL transport — no product CLI flag added.
//
//   run.sh scripts/normalize/platforms/local-jsonl.ts \
//     --in <traces.jsonl|.ndjson> \
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>]
//
// --in is a .jsonl/.ndjson file (one trace per line). Bad lines are tolerated-
// but-visible (F-S7): the dropped-line count is reported to stderr. --out-metadata
// writes TraceMetadata[]; --out-entity writes the EntityContext. ≥1 --out-* is
// required. Deterministic — no clock/random/network/LLM.

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const inPath = get("--in");
  const outMetadataPath = get("--out-metadata");
  const outEntityPath = get("--out-entity");

  if (!inPath || (!outMetadataPath && !outEntityPath)) {
    process.stderr.write(
      "Usage: run.sh scripts/normalize/platforms/local-jsonl.ts --in <traces.jsonl> " +
        "[--out-metadata <path>] [--out-entity <path>]\n"
    );
    process.exit(1);
  }

  try {
    const resolvedIn = resolve(inPath);
    const { bodies, partialLoad } = normalizeLocalJsonlFileWithDrops(
      readFileSync(resolvedIn, "utf8"),
      `local-jsonl: ${inPath}`
    );
    if (partialLoad) {
      process.stderr.write(
        `[local-jsonl normalize] dropped ${partialLoad.droppedLineCount} unparseable line(s)\n`
      );
    }

    if (outMetadataPath) {
      const metadata = bodies.map((b) => b.metadata);
      writeFileSync(resolve(outMetadataPath), JSON.stringify(metadata, null, 2), "utf8");
      process.stdout.write(`TraceMetadata[] (${metadata.length}) written to: ${outMetadataPath}\n`);
    }
    if (outEntityPath) {
      const entity = extractLocalJsonlEntityContext(bodies);
      writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
      process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
