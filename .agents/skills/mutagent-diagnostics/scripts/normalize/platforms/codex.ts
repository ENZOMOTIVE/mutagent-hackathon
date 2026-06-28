/**
 * scripts/normalize/platforms/codex.ts
 * Codex CLI session transcript (.jsonl) → canonical TraceBody
 * Type A — Pure Script
 * Reference: references/source-platforms/codex-transcripts.md
 *
 * Codex session paths (CONFIRMED iter-8):
 *   Active:   ~/.codex/sessions/<session>.jsonl
 *   Archived: ~/.codex/archived_sessions/<session>.jsonl
 *   Config:   ~/.codex/config.toml
 *   Constants in codex-rs/rollout/src/lib.rs:
 *     SESSIONS_SUBDIR = "sessions"
 *     ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"
 *
 * Default-on. To suppress: codex exec --ephemeral
 */

import type { TraceBody, TraceMetadata, TraceMessage, EntityContext } from "../trace.ts";
import { buildAgentEntityContext, deterministicTraceId } from "./entity-context.ts";

/**
 * Codex rollout JSONL event (simplified from codex-rs/rollout shape).
 * The rollout format is a sequence of events per agent execution.
 */
interface CodexEvent {
  type?: string;
  /** Event timestamp */
  ts?: string;
  /** Session/execution identifier */
  session_id?: string;
  /** Agent type field (if multi-agent rollout) */
  agent_type?: string;
  /** Message content */
  content?: string;
  /** Role: user | assistant | tool */
  role?: string;
  /** Tool name for tool_call events */
  tool?: string;
  /** Tool call arguments */
  args?: unknown;
  /** Tool call result */
  result?: unknown;
  /** Error flag */
  error?: boolean | string;
  /** Feedback / approval events */
  approval?: "approved" | "rejected";
  /** Skill invocation tracking */
  skill?: string;
}

export function normalizeCodexSession(events: CodexEvent[]): TraceBody {
  if (events.length === 0) {
    return {
      metadata: {
        traceId: "codex-empty",
        sessionId: "codex-empty",
        hasError: false,
        hasFeedback: false,
        sourcePlatform: "codex",
      },
      messages: [],
    };
  }

  // Variance fix (Wave-13): no native session_id ⇒ derive a DETERMINISTIC id from
  // the event content (content hash), not `Date.now()`, so re-runs over the same
  // rollout produce the same id (stable dedup/selection primary key).
  const sessionId =
    events[0].session_id ??
    deterministicTraceId("codex", JSON.stringify(events));

  let hasError = false;
  let hasFeedback = false;

  const messages: TraceMessage[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    const isErrorEvent =
      ev.error === true ||
      (typeof ev.error === "string" && ev.error.length > 0);
    if (isErrorEvent) hasError = true;

    if (ev.approval !== undefined) hasFeedback = true;

    const role = (ev.role ?? (ev.type === "tool_call" ? "tool" : "assistant")) as TraceMessage["role"];

    messages.push({
      index: i,
      role,
      content: ev.content ?? (ev.result ? JSON.stringify(ev.result) : ""),
      toolName: ev.tool,
      toolArgs: ev.args ? JSON.stringify(ev.args) : undefined,
      toolResult: ev.result ? JSON.stringify(ev.result) : undefined,
      isError: isErrorEvent,
      timestamp: ev.ts,
    });
  }

  const startTime = events[0]?.ts;
  const endTime = events[events.length - 1]?.ts;
  const latencyMs =
    startTime && endTime
      ? new Date(endTime).getTime() - new Date(startTime).getTime()
      : undefined;

  const metadata: TraceMetadata = {
    traceId: sessionId,
    sessionId,
    agentId: events[0]?.agent_type,
    startTime,
    endTime,
    latencyMs,
    hasError,
    hasFeedback,
    sourcePlatform: "codex",
  };

  return { metadata, messages };
}

/**
 * Parse a Codex session .jsonl file and normalize.
 */
export function normalizeCodexFile(content: string): TraceBody {
  const events: CodexEvent[] = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexEvent];
      } catch {
        return [];
      }
    });

  return normalizeCodexSession(events);
}

// ── R1.7 — EntityContext extraction (DETERMINISTIC, NO LLM) ───────────────────

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): extract an agent-typed EntityContext from a set
 * of normalized Codex session TraceBodies. Content-derived, deterministic.
 */
export function extractCodexEntityContext(bodies: TraceBody[]): EntityContext {
  return buildAgentEntityContext(bodies, {
    source: "codex-jsonl",
    fallbackName: bodies[0]?.metadata.agentId ?? "codex-agent",
  });
}

// ── REQ-052: INTERNAL CLI transport ───────────────────────────────────────────
//
// REQ-052 (langfuse-mirroring transport for all 5 platforms): makes the
// deterministic Codex normalizer + EntityContext extractor RUNNABLE via
// scripts/cli/run.sh, so entity-context production no longer needs inline `bun -e`
// glue (banned by R-SELF-03-c). INTERNAL transport — no product CLI flag added.
//
//   run.sh scripts/normalize/platforms/codex.ts \
//     --in <session.jsonl> \
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>]
//
// --in is a single Codex rollout session .jsonl (many event lines → one
// TraceBody). --out-metadata writes TraceMetadata[]; --out-entity writes the
// EntityContext. ≥1 --out-* is required. Deterministic — no clock/random/network/LLM.

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
      "Usage: run.sh scripts/normalize/platforms/codex.ts --in <session.jsonl> " +
        "[--out-metadata <path>] [--out-entity <path>]\n"
    );
    process.exit(1);
  }

  try {
    const body = normalizeCodexFile(readFileSync(resolve(inPath), "utf8"));

    if (outMetadataPath) {
      writeFileSync(resolve(outMetadataPath), JSON.stringify([body.metadata], null, 2), "utf8");
      process.stdout.write(`TraceMetadata[] (1) written to: ${outMetadataPath}\n`);
    }
    if (outEntityPath) {
      const entity = extractCodexEntityContext([body]);
      writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
      process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
