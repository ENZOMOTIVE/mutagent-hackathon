/**
 * scripts/fetch/feedback-sources.ts
 * PRD-SD-02: Collect FeedbackSource[] for a named entity from three configurable
 * sources: chat transcripts, Langfuse trace scores, and external platform REST.
 *
 * Opt-in via config.feedback_sources.enabled: true (Q11 recommendation).
 * Each sub-source has its own enabled flag for granular control.
 *
 * Returns a deduped FeedbackSource[] (keyed on sourceType + provenance + body head).
 * The orchestrator threads this into each Finding.feedbackSources[] before render.
 *
 * Type A — Pure Script (I/O via injected seams; business logic is deterministic).
 *
 * Usage: bun scripts/cli/run.sh scripts/fetch/feedback-sources.ts
 *   --entity <name>        Entity name to search for (required)
 *   --window-hours N       Time window for chat scan (default: 48)
 *   --output <file>        Write FeedbackSource[] JSON here (default: stdout)
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, resolve } from "path";
import os from "os";
import type { FeedbackSource } from "../normalize/trace.ts";
import type { FeedbackSourcesConfig } from "../config/schema.ts";

// ── Deduplication key ──────────────────────────────────────────────────────────

function dedupKey(s: FeedbackSource): string {
  return `${s.sourceType}|${s.provenance}|${s.body.slice(0, 80)}`;
}

// ── (a) Chat source: scan Claude Code session JSONL files ─────────────────────

/** Minimal JSONL message shape from Claude Code session transcripts. */
interface SessionMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  timestamp?: string;
}

/**
 * Extract text content from a session message (handles string + content-array forms).
 */
function extractContent(msg: SessionMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Encode a project path the same way Claude Code does for its projects dir.
 * Best-effort replication of Claude Code's encoding (path separators → hyphens).
 */
function encodeProjectPath(p: string): string {
  return resolve(p).replace(/\//g, "-").replace(/^-/, "");
}

export interface ChatScanOptions {
  entityName: string;
  /** Absolute path to project root (used to derive the encoded sessions dir). */
  projectRoot: string;
  /** Max session files to scan (default: 10 per config.feedback_sources.chat.max_sessions). */
  maxSessions?: number;
  /** How far back to look in time (hours, default: 48). */
  windowHours?: number;
  /** Override the ~/.claude/projects root (injected in tests). */
  claudeProjectsRoot?: string;
}

/**
 * PRD-SD-02 (a): Scan recent Claude Code session JSONL files for operator messages
 * mentioning the entity by name. Returns FeedbackSource[] (sourceType: 'chat').
 *
 * Heuristic: splits each .jsonl by newline, parses line-by-line (cheap linear scan),
 * matches user-role messages containing the entityName (case-insensitive).
 */
export function collectChatFeedback(opts: ChatScanOptions): FeedbackSource[] {
  const claudeRoot = opts.claudeProjectsRoot ?? join(os.homedir(), ".claude", "projects");
  if (!existsSync(claudeRoot)) return [];

  const encodedPath = encodeProjectPath(opts.projectRoot);
  const sessionDir = join(claudeRoot, encodedPath);
  if (!existsSync(sessionDir)) return [];

  const maxSessions = opts.maxSessions ?? 10;
  const windowHours = opts.windowHours ?? 48;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const entityLower = opts.entityName.toLowerCase();

  // Collect .jsonl files, sort by mtime desc (most recent first)
  let files: string[];
  try {
    files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      })
      .slice(0, maxSessions);
  } catch {
    return [];
  }

  const results: FeedbackSource[] = [];

  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let msg: SessionMessage;
      try {
        msg = JSON.parse(line) as SessionMessage;
      } catch {
        continue;
      }

      // Only scan user-role (operator) messages
      if (msg.role !== "user" && msg.role !== "human") continue;

      const text = extractContent(msg);
      if (!text.toLowerCase().includes(entityLower)) continue;

      // Time-window filter
      if (msg.timestamp) {
        const ts = new Date(msg.timestamp).getTime();
        if (Number.isFinite(ts) && ts < cutoff) continue;
      }

      const capturedAt = msg.timestamp ?? undefined;
      const provenance = capturedAt
        ? `Operator chat (${capturedAt.slice(0, 10)})`
        : "Operator chat (timestamp unavailable)";

      results.push({
        sourceType: "chat",
        provenance,
        body: text.slice(0, 2000), // cap to avoid enormous blocks
        capturedAt,
      });
    }
  }

  return results;
}

// ── (b) Langfuse trace-score source ──────────────────────────────────────────

export interface LangfuseScoreScanOptions {
  entityName: string;
  /** Langfuse REST base URL (e.g. https://cloud.langfuse.com). */
  langfuseBaseUrl: string;
  /** base64(publicKey:secretKey) — never store; passed via env. */
  authB64: string;
  /** Minimum score value to include. Absent = all scores. */
  minScore?: number;
  /** Look back N hours (default: 48). */
  windowHours?: number;
  /** Max pages to fetch (each page = 100 scores, safety cap). */
  maxPages?: number;
}

/**
 * HTTP GET via curl (synchronous execSync — matches the pattern in fetch/langfuse.ts).
 * Returns the response body string, or throws on non-zero exit.
 */
function curlGet(url: string, headers: Record<string, string>): string {
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" ");
  return execSync(`curl -sS -m 30 ${headerArgs} ${JSON.stringify(url)}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * PRD-SD-02 (b): Fetch Langfuse trace scores with non-empty comments that match
 * the entity name. Returns FeedbackSource[] (sourceType: 'trace-score').
 *
 * Uses the public REST API (GET /api/public/scores) with Basic auth via curl.
 * Returns empty array on network failure (opt-in path; non-fatal).
 */
export function collectLangfuseScoreFeedback(
  opts: LangfuseScoreScanOptions
): FeedbackSource[] {
  const windowHours = opts.windowHours ?? 48;
  const maxPages = opts.maxPages ?? 10;
  const fromDate = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const entityLower = opts.entityName.toLowerCase();

  const results: FeedbackSource[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const qs = `page=${page}&limit=100&fromTimestamp=${encodeURIComponent(fromDate)}`;
    const url = `${opts.langfuseBaseUrl}/api/public/scores?${qs}`;

    let body: { data?: Array<Record<string, unknown>> };
    try {
      const raw = curlGet(url, { Authorization: `Basic ${opts.authB64}` });
      body = JSON.parse(raw) as typeof body;
    } catch {
      break; // network or parse failure — return what we have
    }

    const items = body.data ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const comment = typeof item.comment === "string" ? item.comment.trim() : "";
      if (!comment) continue;

      // Match entity by trace name / agentId / comment content
      const traceName = typeof item.traceName === "string" ? item.traceName : "";
      const traceId = typeof item.traceId === "string" ? item.traceId : "";
      const matchSurface = `${traceName} ${comment}`.toLowerCase();
      if (!matchSurface.includes(entityLower)) continue;

      const scoreValue = typeof item.value === "number" ? item.value : undefined;
      if (opts.minScore !== undefined && scoreValue !== undefined && scoreValue < opts.minScore) {
        continue;
      }

      const capturedAt = typeof item.timestamp === "string" ? item.timestamp : undefined;
      const scoreName = typeof item.name === "string" ? item.name : "score";
      const scorerType = typeof item.dataType === "string" ? item.dataType : undefined;

      const provenance = capturedAt
        ? `Langfuse score: ${scoreName} (${capturedAt.slice(0, 10)})`
        : `Langfuse score: ${scoreName}`;

      const fb: FeedbackSource = {
        sourceType: "trace-score",
        provenance,
        body: comment,
        capturedAt,
        traceId: traceId || undefined,
        score: scoreValue !== undefined
          ? { name: scoreName, value: scoreValue, scorerType }
          : undefined,
      };
      results.push(fb);
    }

    // If the page was not full, no next page
    if (items.length < 100) break;
  }

  return results;
}

// ── (c) External platform source ─────────────────────────────────────────────

export interface ExternalFeedbackOptions {
  entityName: string;
  /** REST endpoint returning FeedbackSource[] JSON. */
  endpoint: string;
  /** Authorization header value (Bearer <token> or similar). Passed via env. */
  authHeader?: string;
}

/**
 * PRD-SD-02 (c): Fetch feedback from an external platform REST endpoint via curl.
 * The endpoint is expected to return a JSON array of FeedbackSource objects.
 * Returns empty array on failure (opt-in path; non-fatal).
 */
export function collectExternalFeedback(opts: ExternalFeedbackOptions): FeedbackSource[] {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authHeader) headers["Authorization"] = opts.authHeader;

    // Append entity name as a query param for best-effort filtering
    const sep = opts.endpoint.includes("?") ? "&" : "?";
    const url = `${opts.endpoint}${sep}entity=${encodeURIComponent(opts.entityName)}`;

    const raw = curlGet(url, headers);
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];

    // Validate + coerce shape (best-effort — external platforms may return loose JSON)
    const results: FeedbackSource[] = [];
    for (const item of data as Array<Record<string, unknown>>) {
      const sourceType = item.sourceType;
      if (sourceType !== "chat" && sourceType !== "trace-score" && sourceType !== "external") {
        continue;
      }
      if (typeof item.provenance !== "string" || typeof item.body !== "string") continue;
      results.push({
        sourceType,
        provenance: item.provenance,
        body: item.body,
        capturedAt: typeof item.capturedAt === "string" ? item.capturedAt : undefined,
        externalPlatform:
          typeof item.externalPlatform === "string" ? item.externalPlatform : undefined,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Orchestration: collectFeedbackSources ─────────────────────────────────────

export interface CollectFeedbackSourcesOptions {
  entityName: string;
  /** Absolute path to project root (for chat scan). */
  projectRoot: string;
  /** Config from config.yaml feedback_sources block. */
  config: FeedbackSourcesConfig;
  /** For Langfuse source: pre-built base64 auth string. */
  langfuseAuthB64?: string;
  /** For Langfuse source: base URL. */
  langfuseBaseUrl?: string;
  /** For external source: pre-built auth header. */
  externalAuthHeader?: string;
  /** Time window for chat + Langfuse scans (hours, default: 48). */
  windowHours?: number;
  /** Test seam: override Claude Code projects root. */
  claudeProjectsRoot?: string;
}

/**
 * PRD-SD-02: Master collection entry point. Gated by config.feedback_sources.enabled.
 * When disabled, returns [] immediately (zero I/O). Each sub-source is independently
 * gated by its own enabled flag. All failures are non-fatal (empty array returned).
 *
 * Returns deduped FeedbackSource[] sorted: chat first, trace-score second, external last.
 * All network I/O uses curl via execSync (matching the langfuse.ts fetch pattern).
 */
export function collectFeedbackSources(opts: CollectFeedbackSourcesOptions): FeedbackSource[] {
  if (!opts.config.enabled) return [];

  const all: FeedbackSource[] = [];

  // (a) Chat source
  if (opts.config.chat?.enabled !== false) {
    try {
      const chatResults = collectChatFeedback({
        entityName: opts.entityName,
        projectRoot: opts.projectRoot,
        maxSessions: opts.config.chat?.max_sessions ?? 10,
        windowHours: opts.windowHours ?? 48,
        claudeProjectsRoot: opts.claudeProjectsRoot,
      });
      all.push(...chatResults);
    } catch {
      // Non-fatal
    }
  }

  // (b) Langfuse trace-score source
  if (opts.config.trace_score?.enabled !== false && opts.langfuseAuthB64 && opts.langfuseBaseUrl) {
    try {
      const scoreResults = collectLangfuseScoreFeedback({
        entityName: opts.entityName,
        langfuseBaseUrl: opts.langfuseBaseUrl,
        authB64: opts.langfuseAuthB64,
        minScore: opts.config.trace_score?.min_score,
        windowHours: opts.windowHours ?? 48,
      });
      all.push(...scoreResults);
    } catch {
      // Non-fatal
    }
  }

  // (c) External platform source
  if (opts.config.external?.enabled === true && opts.config.external?.endpoint) {
    try {
      const externalResults = collectExternalFeedback({
        entityName: opts.entityName,
        endpoint: opts.config.external.endpoint,
        authHeader: opts.externalAuthHeader,
      });
      all.push(...externalResults);
    } catch {
      // Non-fatal
    }
  }

  // Deduplicate by content key
  const seen = new Set<string>();
  const deduped = all.filter((s) => {
    const k = dedupKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort: chat first, trace-score second, external last
  const order = { chat: 0, "trace-score": 1, external: 2 } as const;
  return deduped.sort((a, b) => (order[a.sourceType] ?? 3) - (order[b.sourceType] ?? 3));
}

// ── CLI entrypoint (PRD-SO-05 pattern) ───────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const entityName = get("--entity");
  if (!entityName) {
    process.stderr.write("Usage: bun scripts/fetch/feedback-sources.ts --entity <name> [--window-hours N] [--output <file>]\n");
    process.exit(1);
  }

  const projectRoot = get("--project-root") ?? process.cwd();
  const windowHours = get("--window-hours") ? Number(get("--window-hours")) : 48;
  const outputPath = get("--output");

  // Minimal config: chat-only by default for the CLI (no creds required)
  const config: FeedbackSourcesConfig = {
    enabled: true,
    chat: { enabled: true, max_sessions: 10 },
    trace_score: { enabled: false },
    external: { enabled: false },
  };

  const results = collectFeedbackSources({
    entityName,
    projectRoot,
    config,
    windowHours,
  });

  const out = JSON.stringify(results, null, 2);
  if (outputPath) {
    writeFileSync(outputPath, out, "utf8");
    process.stderr.write(`Wrote ${results.length} feedback source(s) to ${outputPath}\n`);
  } else {
    process.stdout.write(out + "\n");
  }
  process.exit(0);
}
