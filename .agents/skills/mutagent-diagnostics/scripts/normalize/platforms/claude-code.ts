/**
 * scripts/normalize/platforms/claude-code.ts
 * Claude Code session transcript (.jsonl) → canonical TraceBody
 * Type A — Pure Script
 * Reference: references/source-platforms/claude-code-transcripts.md
 *
 * Claude Code stores sessions at:
 *   ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 *
 * Each line is a JSON object representing one turn/event in the session.
 * Format confirmed per Anthropic docs (data-usage page) + local observation.
 * Default retention: cleanupPeriodDays (30 days by default).
 */

import type { TraceBody, TraceMetadata, TraceMessage, EntityContext } from "../trace.ts";
import {
  buildAgentEntityContext,
  aggregateToolInventory,
  sized,
  inputSample as buildInputSample,
  firstUserInput,
  deterministicTraceId,
} from "./entity-context.ts";

/** Claude Code JSONL event shapes (simplified) */
interface ClaudeCodeEvent {
  type:
    | "user"
    | "assistant"
    | "tool_use"
    | "tool_result"
    | "system"
    | string;
  /** R-SELF-06-a: JSONL event subtype for api_error and compact_boundary */
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  /** R-SELF-09-a: parent session identifier (dispatch chain) */
  parentSessionId?: string;
  /** R-SELF-09-a: agent setting/role from agent-setting events */
  agentSetting?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ClaudeCodeContentBlock[];
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  toolUseId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  costUSD?: number;
  // R-SELF-06-a: api_error fields
  retryAttempt?: number;
  maxRetries?: number;
  // R-SELF-06-a: compact_boundary fields
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}

interface ClaudeCodeContentBlock {
  type: "text" | "tool_use" | "tool_result" | string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string | ClaudeCodeContentBlock[];
  is_error?: boolean;
}

function extractTextContent(content: string | ClaudeCodeContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_use") return `[tool:${block.name}]`;
      return "";
    })
    .join(" ")
    .trim();
}

export function normalizeClaudeCodeSession(events: ClaudeCodeEvent[]): TraceBody {
  if (events.length === 0) {
    return {
      metadata: {
        traceId: "claude-code-empty",
        sessionId: "claude-code-empty",
        hasError: false,
        hasFeedback: false,
        sourcePlatform: "claude-code",
      },
      messages: [],
    };
  }

  // Variance fix (Wave-13): when the session carries no native id, derive a
  // DETERMINISTIC id from the event content (content hash) instead of `Date.now()`,
  // so the same transcript always yields the same id (dedup/selection primary key).
  const sessionId =
    events[0].sessionId ??
    events[0].uuid?.split("-")[0] ??
    deterministicTraceId("cc", JSON.stringify(events));

  let hasError = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // R-SELF-06-a: collect api_error and compact_boundary events
  const apiErrors: NonNullable<TraceMetadata["apiErrors"]> = [];
  const compactionEvents: NonNullable<TraceMetadata["compactionEvents"]> = [];

  // R-SELF-09-a: provenance fields — read from first agent-setting event
  let parentSessionId: string | undefined;
  let agentSetting: string | undefined;
  let isTeammate: boolean | undefined;

  const messages: TraceMessage[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // R-SELF-06-a: detect api_error subtype events
    if (ev.subtype === "api_error" && typeof ev.retryAttempt === "number") {
      apiErrors.push({
        retryAttempt: ev.retryAttempt,
        maxRetries: ev.maxRetries ?? 0,
        timestamp: ev.timestamp ?? new Date().toISOString(),
      });
    }

    // R-SELF-06-a: detect compact_boundary subtype events
    if (ev.subtype === "compact_boundary" && typeof ev.preTokens === "number") {
      compactionEvents.push({
        preTokens: ev.preTokens,
        postTokens: ev.postTokens ?? 0,
        durationMs: ev.durationMs ?? 0,
      });
    }

    // R-SELF-09-a: extract parent session + agent role from agent-setting events
    if (ev.type === "agent-setting" || ev.subtype === "agent-setting") {
      if (!parentSessionId && ev.parentSessionId) {
        parentSessionId = ev.parentSessionId;
      }
      if (!agentSetting && ev.agentSetting) {
        agentSetting = ev.agentSetting;
      }
      if (isTeammate === undefined && ev.parentSessionId) {
        // Presence of parentSessionId implies this is a dispatched teammate
        isTeammate = true;
      }
    }

    const msg = ev.message;
    const role = (msg?.role ?? ev.type ?? "assistant") as TraceMessage["role"];

    const content = msg?.content
      ? extractTextContent(msg.content)
      : ev.output
        ? JSON.stringify(ev.output)
        : ev.input
          ? JSON.stringify(ev.input)
          : "";

    if (ev.isError || (typeof msg?.content === "string" && msg.content.includes("error"))) {
      hasError = true;
    }

    if (msg?.usage) {
      totalInputTokens += msg.usage.input_tokens ?? 0;
      totalOutputTokens += msg.usage.output_tokens ?? 0;
    }

    messages.push({
      index: i,
      role,
      content,
      toolName: ev.toolName,
      toolArgs: ev.input ? JSON.stringify(ev.input) : undefined,
      toolResult: ev.output ? JSON.stringify(ev.output) : undefined,
      isError: ev.isError,
      timestamp: ev.timestamp,
    });
  }

  const startTime = events[0]?.timestamp;
  const endTime = events[events.length - 1]?.timestamp;
  const latencyMs =
    startTime && endTime
      ? new Date(endTime).getTime() - new Date(startTime).getTime()
      : undefined;

  const metadata: TraceMetadata = {
    traceId: sessionId,
    sessionId,
    startTime,
    endTime,
    latencyMs,
    totalTokens: totalInputTokens + totalOutputTokens,
    hasError,
    hasFeedback: false, // Claude Code uses /feedback thumbs — detected post-normalization
    sourcePlatform: "claude-code",
    // R-SELF-06-a: only attach arrays if non-empty
    ...(apiErrors.length > 0 ? { apiErrors } : {}),
    ...(compactionEvents.length > 0 ? { compactionEvents } : {}),
    // R-SELF-09-a: only attach provenance if detected
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(agentSetting !== undefined ? { agentSetting } : {}),
    ...(isTeammate !== undefined ? { isTeammate } : {}),
  };

  return { metadata, messages };
}

/**
 * Parse a Claude Code session .jsonl file (string) into events + normalize.
 */
export function normalizeClaudeCodeFile(content: string): TraceBody {
  const events: ClaudeCodeEvent[] = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeCodeEvent];
      } catch {
        return [];
      }
    });

  return normalizeClaudeCodeSession(events);
}

// ── R1.7 — EntityContext extraction (DETERMINISTIC, NO LLM) ───────────────────

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): extract an agent-typed EntityContext from a set
 * of Claude Code session TraceBodies. Content-derived, deterministic.
 * Used when claude-code is the SOURCE platform (diagnosing some other agent run
 * captured as a Claude Code session).
 */
export function extractClaudeCodeEntityContext(bodies: TraceBody[]): EntityContext {
  return buildAgentEntityContext(bodies, {
    source: "claude-code-jsonl",
    fallbackName: bodies[0]?.metadata.agentId ?? "claude-code-agent",
  });
}

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2, self-diag path): build a SKILL-typed EntityContext
 * for the diagnostics skill diagnosing ITSELF. The system prompt is the skill's
 * own SKILL.md (read verbatim by the caller — passed in to keep this pure), the
 * tool inventory comes from the script filenames + session tool_use events, and
 * the input sample is the operator's invocation prompt.
 *
 * All inputs are passed by the caller (no fs reads here) so this stays a pure,
 * deterministic Type-A function. The enricher reads SKILL.md + scripts/ and the
 * session JSONL, then calls this.
 */
export function buildSkillSelfEntityContext(args: {
  skillName: string;
  skillMd: string;
  scriptFiles: string[];
  sessionBodies: TraceBody[];
  operatorPrompt?: string;
}): EntityContext {
  const ctx: EntityContext = {
    name: args.skillName,
    entityType: "skill",
    codeAccess: true,
    source: "claude-code-jsonl",
    applyTarget: "config.yaml / skill assets (NEVER source)",
    systemPrompt: sized(args.skillMd),
  };

  // Tool inventory: script filenames (as op→file map) + observed tool_use calls.
  const scriptTools = args.scriptFiles.map((f) => ({
    name: f,
    callCount: 0,
    callsPerTrace: 0,
  }));
  const observed = aggregateToolInventory(args.sessionBodies);
  // Merge: observed calls override the zero-count script entries by name.
  const byName = new Map(scriptTools.map((t) => [t.name, t]));
  for (const o of observed) byName.set(o.name, o);
  const tools = [...byName.values()].sort(
    (a, b) => (b.callCount - a.callCount) || a.name.localeCompare(b.name)
  );
  if (tools.length > 0) ctx.toolInventory = tools;

  const inp = args.operatorPrompt ?? firstUserInput(args.sessionBodies);
  if (inp) ctx.inputSample = buildInputSample(inp);

  return ctx;
}

// ── SD-2 + REQ-052: INTERNAL CLI transport ────────────────────────────────────
//
// SD-2: the claude-code normalizer previously had NO `import.meta.main` CLI, so
// it was UNREACHABLE via scripts/cli/run.sh — EntityContext production for a
// Claude Code session could only be hand-wired with inline `bun -e` glue
// (banned by R-SELF-03-c). This mirrors the langfuse.ts CLI entrypoint so the
// orchestrator can run it through run.sh.
//
// REQ-052: --out-entity makes EntityContext production runnable for the
// claude-code platform (the langfuse-mirroring transport for all 5 platforms).
//
//   run.sh scripts/normalize/platforms/claude-code.ts \
//     --in <session.jsonl> \
//     [--mode generic|self-diag] \        # SD-2: which entity builder to use
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>] \
//     [--skill-md <SKILL.md>]    \        # self-diag: skill system prompt source
//     [--skill-name <name>]      \        # self-diag: defaults to mutagent-diagnostics
//     [--scripts-csv <a.ts,b.ts>] \       # self-diag: script-file tool inventory seed
//     [--operator-prompt <text>]          # self-diag: invocation prompt sample
//
// --in is a single Claude Code session .jsonl file (one session = many event
// lines → one TraceBody). --mode picks the entity builder:
//   generic   → extractClaudeCodeEntityContext (agent-typed; diagnosing some
//               OTHER agent run captured as a Claude Code session). DEFAULT.
//   self-diag → buildSkillSelfEntityContext (skill-typed; the diagnostics skill
//               diagnosing ITSELF). Requires --skill-md.
// At least one --out-* is required. Deterministic — no clock/random/network/LLM.

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const inPath = get("--in");
  const mode = (get("--mode") ?? "generic") as "generic" | "self-diag";
  const outMetadataPath = get("--out-metadata");
  const outEntityPath = get("--out-entity");
  const skillMdPath = get("--skill-md");
  const skillName = get("--skill-name") ?? "mutagent-diagnostics";
  const scriptsCsv = get("--scripts-csv");
  const operatorPrompt = get("--operator-prompt");

  const usage =
    "Usage: run.sh scripts/normalize/platforms/claude-code.ts --in <session.jsonl> " +
    "[--mode generic|self-diag] [--out-metadata <path>] [--out-entity <path>] " +
    "[--skill-md <SKILL.md>] [--skill-name <name>] [--scripts-csv <a.ts,b.ts>] " +
    "[--operator-prompt <text>]\n";

  if (!inPath || (!outMetadataPath && !outEntityPath)) {
    process.stderr.write(usage);
    process.exit(1);
  }
  if (mode !== "generic" && mode !== "self-diag") {
    process.stderr.write(`Error: --mode must be 'generic' or 'self-diag' (got '${mode}')\n`);
    process.exit(1);
  }
  if (mode === "self-diag" && outEntityPath && !skillMdPath) {
    process.stderr.write("Error: --mode self-diag with --out-entity requires --skill-md\n");
    process.exit(1);
  }

  try {
    const body = normalizeClaudeCodeFile(readFileSync(resolve(inPath), "utf8"));

    if (outMetadataPath) {
      writeFileSync(resolve(outMetadataPath), JSON.stringify([body.metadata], null, 2), "utf8");
      process.stdout.write(`TraceMetadata[] (1) written to: ${outMetadataPath}\n`);
    }

    if (outEntityPath) {
      let entity: EntityContext;
      if (mode === "self-diag") {
        const skillMd = readFileSync(resolve(skillMdPath as string), "utf8");
        const scriptFiles = scriptsCsv
          ? scriptsCsv.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        entity = buildSkillSelfEntityContext({
          skillName,
          skillMd,
          scriptFiles,
          sessionBodies: [body],
          operatorPrompt,
        });
      } else {
        entity = extractClaudeCodeEntityContext([body]);
      }
      writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
      process.stdout.write(`EntityContext (${mode}) written to: ${outEntityPath}\n`);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
