/**
 * scripts/normalize/platforms/entity-context.ts
 * Wave-5 R1.7 (APPENDIX-A §A.2): shared, DETERMINISTIC EntityContext extraction
 * helpers used by every per-platform normalizer.
 * Type A — Pure Script (content-derived only — NO LLM, NO clock, NO random).
 *
 * Each platform normalizer derives an EntityContext from its TraceBody[] using
 * these helpers so re-runs over identical input are byte-identical.
 */

import { createHash } from "crypto";
import type {
  TraceBody,
  EntityContext,
  EntityIdentityPointers,
  SizedText,
  ToolInventoryEntry,
} from "../trace.ts";
import type { AgentIdentity } from "../../config/schema.ts";

// ── byte-length + token approximation (deterministic) ────────────────────────

/** UTF-8 byte length of a string (Buffer.byteLength is deterministic). */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Approximate token count from character length (≈ 4 chars/token).
 * Deterministic heuristic — no tokenizer, no network.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build a SizedText with byteLength + token approximation filled in. */
export function sized(text: string): SizedText {
  return { text, sizeBytes: byteLength(text), tokensApprox: approxTokens(text) };
}

// ── Variance fix (Wave-13): deterministic synthetic trace IDs ─────────────────
//
// The non-langfuse normalizers used to mint synthetic IDs from `Date.now()`
// (`cc-${Date.now()}`, `codex-${Date.now()}`, `local-${Date.now()}`) when the
// source carried no native id. That poisons the dedup / selection primary key:
// the SAME input file produces a DIFFERENT id on every run, so re-runs can't be
// compared and identical traces look distinct.
//
// Replace with a content hash over STABLE trace content — same input always
// yields the same id, across runs and machines. No clock, no random.

/**
 * Deterministic synthetic trace id: `<prefix>-<first 16 hex of sha256(content)>`.
 *
 * `content` MUST be derived from stable, content-bearing fields of the trace
 * (e.g. JSON.stringify of the raw events / line) — NEVER from a clock or random
 * source. The 16-hex (64-bit) prefix is collision-safe for trace-set sizes and
 * keeps the id short + readable.
 *
 * Determinism contract: same `prefix` + same `content` ⇒ byte-identical id.
 */
export function deterministicTraceId(prefix: string, content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `${prefix}-${digest.slice(0, 16)}`;
}

// ── PII sanitization (deterministic regex scrub) ─────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Long bearer/api tokens (20+ base64-ish chars), AWS-style keys, sk- prefixed keys.
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9_-]{32,})\b/g;

/**
 * Scrub obvious PII / secrets from a text blob before it lands in a report.
 * Deterministic — same input → same output.
 */
export function sanitize(text: string): string {
  return text.replace(EMAIL_RE, "<email>").replace(TOKEN_RE, "<token>");
}

// ── W12-09: input-envelope unwrap (deterministic, conservative) ──────────────

/**
 * Common single-field text envelopes a trace input may be wrapped in. When the
 * input text is `JSON.stringify(raw.input)` (langfuse normalizer behaviour) and
 * the parsed object has exactly ONE of these as its dominant text field, we
 * extract that field's prose so the entity card shows clean text instead of a
 * `{"prompt":"…"}` escaped wrapper.
 */
const ENVELOPE_TEXT_KEYS = ["prompt", "input", "content", "text", "query"] as const;

/**
 * W12-09 (P2): deterministically unwrap a common JSON text-envelope.
 *
 * Behaviour (CONSERVATIVE — never mangle legitimately-structured input):
 *   - If `text` does NOT parse as JSON → return it unchanged (plain prose).
 *   - If it parses to a STRING → return that string (a doubly-encoded prompt).
 *   - If it parses to an OBJECT with a DOMINANT text field, extract it:
 *       • a single `ENVELOPE_TEXT_KEYS` entry whose value is a non-empty string
 *         (e.g. `{"prompt":"hello"}` → "hello"); OR
 *       • a `messages` array whose LAST entry has a string `.content`
 *         (chat-style envelope → the latest turn's text).
 *   - Otherwise (no dominant text field, multiple competing text keys, an
 *     array of non-messages, nested objects) → return the ORIGINAL text
 *     unchanged so genuinely-structured input is preserved verbatim.
 *
 * Deterministic — pure string→string, no clock/random/LLM.
 */
export function unwrapEnvelope(text: string): string {
  const trimmed = text.trim();
  // Cheap guard: only attempt a parse on JSON-looking payloads.
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"')) {
    return text;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text; // not JSON → leave as-is
  }

  // Doubly-encoded string → the inner prose.
  if (typeof parsed === "string") return parsed;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;

    // Count how many of the known text keys carry a non-empty string value.
    const present = ENVELOPE_TEXT_KEYS.filter(
      (k) => typeof obj[k] === "string" && (obj[k] as string).trim().length > 0
    );
    // Exactly one dominant text field → unwrap it.
    if (present.length === 1) {
      return obj[present[0]] as string;
    }

    // Chat-style envelope: `messages[]` whose last entry has string content.
    if (present.length === 0 && Array.isArray(obj.messages) && obj.messages.length > 0) {
      const last = obj.messages[obj.messages.length - 1];
      if (last && typeof last === "object" && typeof (last as Record<string, unknown>).content === "string") {
        const content = (last as Record<string, unknown>).content as string;
        if (content.trim().length > 0) return content;
      }
    }
  }

  // No dominant text field (structured input) → preserve verbatim.
  return text;
}

/**
 * Build a sanitized, sized input sample (sliced to `maxChars`, default 4096).
 *
 * W12-09: first unwrap a common JSON text-envelope (`{"prompt":"…"}` etc.) so
 * the card shows clean prose, not an escaped wrapper. Unwrap is conservative —
 * structured input with no dominant text field passes through unchanged.
 */
export function inputSample(
  text: string,
  maxChars = 4096
): SizedText & { sanitized: boolean } {
  const unwrapped = unwrapEnvelope(text);
  const sliced = unwrapped.slice(0, maxChars);
  const clean = sanitize(sliced);
  return {
    ...sized(clean),
    sanitized: clean !== sliced,
  };
}

// ── system-prompt extraction ─────────────────────────────────────────────────

const SYSTEM_TAG_RE = /<system>([\s\S]*?)<\/system>/i;

/**
 * F-S2c: the set of redaction placeholders `sanitize()` substitutes in. A prompt
 * whose sanitized form is ONLY these placeholders + whitespace carried no real
 * (non-secret) content — it was a credentials-only prompt, fully redacted.
 */
const REDACTION_PLACEHOLDER_RE = /<email>|<token>/g;

/**
 * F-S2c (PR-055 proposed): build a system-prompt SizedText from a FOUND raw
 * source, distinguishing "present but fully redacted" from "genuinely absent".
 *
 * The caller only invokes this when a system-prompt SOURCE was located (a
 * non-empty system-role message or <system> block). If sanitizing that source
 * leaves NOTHING but redaction placeholders + whitespace (e.g. a credentials-only
 * prompt: `sk-…`, an email, etc.), the prompt WAS present but carried no
 * non-secret content — we mark `fullyRedacted: true` (text "", sizeBytes 0) so a
 * consumer can say "system prompt present but fully redacted" rather than
 * mistaking it for "no system prompt" (which is `undefined`).
 */
function buildSystemPromptSized(rawFound: string): SizedText {
  const clean = sanitize(rawFound);
  // Strip the placeholders sanitize() injected; if only whitespace remains, the
  // source was entirely secrets → present-but-redacted.
  const residue = clean.replace(REDACTION_PLACEHOLDER_RE, "").trim();
  if (residue.length === 0) {
    // Present-but-redacted: keep text empty + sizeBytes 0, flag it explicitly.
    return { ...sized(""), fullyRedacted: true };
  }
  return sized(clean);
}

/**
 * Pull a system prompt from a set of traces:
 *   1. the first system-role message content, OR
 *   2. a <system>…</system> block inside the first user/assistant message.
 *
 * Returns:
 *   - a sanitized SizedText when a prompt was found and survived sanitization,
 *   - a SizedText with `fullyRedacted: true` (text "", sizeBytes 0) when a prompt
 *     WAS found but sanitized to empty (F-S2c — distinguishes redacted from absent),
 *   - `undefined` ONLY when no system prompt was found at all.
 */
export function extractSystemPrompt(traces: TraceBody[]): SizedText | undefined {
  for (const t of traces) {
    const sys = t.messages.find((m) => m.role === "system" && m.content.trim());
    if (sys) return buildSystemPromptSized(sys.content);
  }
  for (const t of traces) {
    for (const m of t.messages) {
      const match = SYSTEM_TAG_RE.exec(m.content);
      if (match && match[1].trim()) return buildSystemPromptSized(match[1].trim());
    }
  }
  return undefined;
}

// ── W18-context: FULL untruncated system-prompt extraction (diagnosis-context) ─

/** Where a system prompt was located in the trace — provenance for grounding. */
export type SystemPromptOrigin =
  /** Verbatim content of a `role:"system"` message. */
  | "system-role-message"
  /** Text inside a `<system>…</system>` block in a user/assistant message. */
  | "system-tag-block";

/**
 * W18-context: a FULL, untruncated system-prompt extraction WITH provenance.
 *
 * Distinct from `extractSystemPrompt` (the entity-CARD path), which returns a
 * `SizedText` for a small UI card. This is the LENS path: the analyzer reads the
 * full system prompt as grounding BEFORE searching for failure modes, so the
 * client (no-codeAccess) case can supply the WHOLE prompt extracted from the
 * traces — NOT a 220c card.
 *
 * Grounding contract (PR-026 / W18 operator principle): every field here is a
 * directly-extracted FACT. `origin` records WHERE the text came from so the
 * context can cite it. No truncation, no distillation, no seeded hypotheses.
 */
export interface FullSystemPrompt {
  /** The PII-sanitized, FULL system-prompt text. Never truncated. */
  text: string;
  /** UTF-8 byte length of `text` (post-sanitization). */
  sizeBytes: number;
  /** Approximate token count (chars/4 heuristic — deterministic). */
  tokensApprox: number;
  /** Where the prompt was located — provenance for grounding. */
  origin: SystemPromptOrigin;
  /** Index of the trace (within the passed array) the prompt was found in. */
  traceIndex: number;
  /**
   * True when a prompt SOURCE was found but sanitized down to nothing but
   * redaction placeholders + whitespace (credentials-only prompt). Mirrors
   * `SizedText.fullyRedacted` — present-but-redacted vs genuinely-absent.
   */
  fullyRedacted: boolean;
}

/**
 * W18-context: extract the FULL system prompt (untruncated) + its provenance.
 *
 * Search order matches `extractSystemPrompt` for consistency:
 *   1. the first `role:"system"` message whose content is non-empty, ELSE
 *   2. the first `<system>…</system>` block in any user/assistant message.
 *
 * Returns `undefined` ONLY when no system-prompt source exists in any trace.
 * When a source IS found but is entirely secrets, returns a record with
 * `fullyRedacted:true` and empty `text` (distinguishes redacted from absent).
 *
 * Deterministic — pure function of the input traces (no clock/random/LLM).
 */
export function extractFullSystemPrompt(
  traces: TraceBody[]
): FullSystemPrompt | undefined {
  for (let i = 0; i < traces.length; i++) {
    const sys = traces[i].messages.find(
      (m) => m.role === "system" && m.content.trim()
    );
    if (sys) return buildFullSystemPrompt(sys.content, "system-role-message", i);
  }
  for (let i = 0; i < traces.length; i++) {
    for (const m of traces[i].messages) {
      const match = SYSTEM_TAG_RE.exec(m.content);
      if (match && match[1].trim()) {
        return buildFullSystemPrompt(match[1].trim(), "system-tag-block", i);
      }
    }
  }
  return undefined;
}

/** Build a FullSystemPrompt from a FOUND raw source (sanitize, never truncate). */
function buildFullSystemPrompt(
  rawFound: string,
  origin: SystemPromptOrigin,
  traceIndex: number
): FullSystemPrompt {
  const clean = sanitize(rawFound);
  const residue = clean.replace(REDACTION_PLACEHOLDER_RE, "").trim();
  if (residue.length === 0) {
    return {
      text: "",
      sizeBytes: 0,
      tokensApprox: 0,
      origin,
      traceIndex,
      fullyRedacted: true,
    };
  }
  return {
    text: clean,
    sizeBytes: byteLength(clean),
    tokensApprox: approxTokens(clean),
    origin,
    traceIndex,
    fullyRedacted: false,
  };
}

/**
 * W12-09 (P2): explicit label rendered when a system prompt is genuinely absent
 * from the trace. The system prompt lives in the agent's config, not the trace
 * input, so an absent value is EXPECTED — we surface that fact rather than a
 * blank field. Carried as a `SizedText` so the renderer's `systemPromptCtx`
 * branch renders it (forced-collapsed) like any other system-prompt value.
 */
export const SYSTEM_PROMPT_ABSENT_LABEL =
  "system prompt not present in trace (lives in agent config)";

// ── majority-vote name ───────────────────────────────────────────────────────

/**
 * Majority-vote the entity name across traces (agentId, falling back to the
 * platform). Ties broken by first-seen order for determinism.
 */
export function majorityName(traces: TraceBody[], fallback: string): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const t of traces) {
    const n = t.metadata.agentId;
    if (!n) continue;
    if (!counts.has(n)) order.push(n);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  if (order.length === 0) return fallback;
  let best = order[0];
  for (const n of order) {
    if ((counts.get(n) ?? 0) > (counts.get(best) ?? 0)) best = n;
  }
  return best;
}

// ── tool inventory aggregation ───────────────────────────────────────────────

interface ToolAccumulator {
  name: string;
  calls: number;
  latencies: number[];
  signature?: string;
}

// ── W12-10: conservative tool-name canonicalization (alias dedup) ─────────────

/** Convert a snake_case identifier to camelCase. `send_message` → `sendMessage`. */
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * W12-10 (P5/DC-2): CONSERVATIVELY canonicalize a tool name for dedup grouping.
 *   1. Strip a single leading `tool.` prefix (`tool.send_message` → `send_message`).
 *   2. Fold snake_case → camelCase so a snake/camel PAIR that are EXACTLY the
 *      same identifier merge (`send_message` + `sendMessage` → `sendMessage`),
 *      while two genuinely-different tools never collide.
 *
 * The returned value is the GROUPING KEY. Display-name selection is handled by
 * the caller (prefers the camelCase form deterministically). Pure + deterministic.
 */
export function canonicalToolName(name: string): string {
  const stripped = name.startsWith("tool.") ? name.slice("tool.".length) : name;
  return snakeToCamel(stripped);
}

/**
 * F-S2b (PR-055 proposed): tool-inventory aggregation result WITH coverage stats.
 *   entries             -- the aggregated per-tool inventory (as before).
 *   skippedCount        -- tool/tool-result messages SKIPPED because they had no
 *                          resolvable `toolName` (the inventory undercounts by this).
 *   toolsWithoutLatency -- distinct tools in `entries` with NO latency data
 *                          (avg/p95 undefined) — lets the renderer caveat latency coverage.
 */
export interface ToolInventoryResult {
  entries: ToolInventoryEntry[];
  skippedCount: number;
  toolsWithoutLatency: number;
}

/**
 * F-S2b (PR-055 proposed): aggregate tool usage across traces AND surface what
 * the aggregation could not account for.
 *
 * Groups tool messages by the CANONICAL `toolName`, counts calls, and computes
 * avg + p95 latency when per-message timing exists — identical to the prior
 * `aggregateToolInventory` behaviour for the inventory itself. ADDITIONALLY:
 *   - counts messages that LOOK like tool activity but carry no resolvable
 *     `toolName` (previously silently `continue`-skipped), and
 *   - counts distinct aggregated tools that ended up with NO latency data,
 * so the EntityContext can show "N messages skipped (no toolName)" and caveat
 * latency coverage instead of silently undercounting.
 *
 * "Looks like tool activity" = a message whose role is `tool` OR which carries
 * tool-shaped fields (`toolArgs` / `toolResult` / `isError`) but has an empty
 * `toolName`. A plain user/assistant text turn is NOT counted as a skip — only
 * messages that were genuinely tool-ish but un-attributable.
 *
 * Deterministic — sorted by callCount desc, then name asc.
 */
export function aggregateToolInventoryWithStats(
  traces: TraceBody[]
): ToolInventoryResult {
  const acc = new Map<string, ToolAccumulator>();
  // W12-10: callsPerTrace denominator = the full population of traces passed in
  // (NOT a sample) — the caller supplies the population it wants scoped, so the
  // per-tool call-stats are population-scoped by construction.
  const traceCount = traces.length || 1;
  let skippedCount = 0;

  for (const t of traces) {
    // Pair tool_use timestamps with the following tool_result for latency.
    const msgs = t.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m.toolName) {
        // F-S2b: a tool-ish message with no resolvable toolName is SKIPPED from the
        // inventory (as before) but now COUNTED so the undercount is visible.
        const looksToolish =
          m.role === "tool" ||
          m.toolArgs !== undefined ||
          m.toolResult !== undefined ||
          m.isError !== undefined;
        if (looksToolish) skippedCount += 1;
        continue;
      }
      // W12-10: group by the CANONICAL name so aliases (`tool.send_message`,
      // `send_message`, `sendMessage`) collapse into ONE row with summed
      // callCount — while two genuinely-different tools never merge.
      const key = canonicalToolName(m.toolName);
      let a = acc.get(key);
      if (!a) {
        // Display name = the canonical (camelCase, tool.-stripped) form, so the
        // merged row has a single deterministic label regardless of which alias
        // was seen first.
        a = { name: key, calls: 0, latencies: [] };
        acc.set(key, a);
      }
      a.calls += 1;
      if (!a.signature && m.toolArgs) {
        a.signature = m.toolArgs.slice(0, 120);
      }
      // Latency: this tool message timestamp → next message timestamp.
      const next = msgs[i + 1];
      if (m.timestamp && next?.timestamp) {
        const dt = new Date(next.timestamp).getTime() - new Date(m.timestamp).getTime();
        if (Number.isFinite(dt) && dt >= 0) a.latencies.push(dt);
      }
    }
  }

  const entries: ToolInventoryEntry[] = [];
  let toolsWithoutLatency = 0;
  for (const a of acc.values()) {
    const entry: ToolInventoryEntry = {
      name: a.name,
      callCount: a.calls,
      callsPerTrace: Math.round((a.calls / traceCount) * 100) / 100,
    };
    if (a.latencies.length > 0) {
      const sorted = a.latencies.slice().sort((x, y) => x - y);
      const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
      entry.avgLatencyMs = Math.round(avg);
      const rank = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
      entry.p95LatencyMs = sorted[rank];
    } else {
      // F-S2b: this tool produced no usable latency sample → caveat-able.
      toolsWithoutLatency += 1;
    }
    if (a.signature) entry.signature = a.signature;
    entries.push(entry);
  }

  entries.sort((x, y) => (y.callCount - x.callCount) || x.name.localeCompare(y.name));
  return { entries, skippedCount, toolsWithoutLatency };
}

/**
 * Aggregate tool usage across traces. Groups tool messages by `toolName`,
 * counts calls, and computes avg + p95 latency when per-message timing exists.
 * Deterministic — sorted by callCount desc, then name asc.
 *
 * F-S2b: thin wrapper over `aggregateToolInventoryWithStats` that drops the
 * coverage stats — preserves the original `ToolInventoryEntry[]` return for
 * existing callers (e.g. the claude-code normalizer). Call
 * `aggregateToolInventoryWithStats` to surface the skipped / no-latency counters.
 */
export function aggregateToolInventory(
  traces: TraceBody[]
): ToolInventoryEntry[] {
  return aggregateToolInventoryWithStats(traces).entries;
}

// ── input sample extraction ──────────────────────────────────────────────────

/** First user-role message content across traces, or the first message content. */
export function firstUserInput(traces: TraceBody[]): string | undefined {
  for (const t of traces) {
    const u = t.messages.find((m) => m.role === "user" && m.content.trim());
    if (u) return u.content;
  }
  for (const t of traces) {
    if (t.messages[0]?.content) return t.messages[0].content;
  }
  return undefined;
}

// ── generic agent EntityContext builder ──────────────────────────────────────

/**
 * Build an agent-typed EntityContext from a set of normalized traces + a model
 * resolved by the caller (platform-specific). Shared by all source platforms.
 */
export function buildAgentEntityContext(
  traces: TraceBody[],
  opts: { source: string; fallbackName: string; model?: string }
): EntityContext {
  const ctx: EntityContext = {
    name: majorityName(traces, opts.fallbackName),
    entityType: "agent",
    codeAccess: false,
    source: opts.source,
  };
  if (opts.model) ctx.model = opts.model;

  // W12-09: render an explicit "absent" label instead of a blank field when the
  // trace carries no system prompt (it lives in the agent config, not the trace).
  const sys = extractSystemPrompt(traces);
  ctx.systemPrompt = sys ?? sized(SYSTEM_PROMPT_ABSENT_LABEL);

  // F-S2b: use the stats-bearing aggregator so the EntityContext can SURFACE
  // messages skipped for lack of a toolName + tools with no latency coverage.
  const toolStats = aggregateToolInventoryWithStats(traces);
  if (toolStats.entries.length > 0) ctx.toolInventory = toolStats.entries;
  if (toolStats.skippedCount > 0) ctx.skippedCount = toolStats.skippedCount;
  if (toolStats.toolsWithoutLatency > 0)
    ctx.toolsWithoutLatency = toolStats.toolsWithoutLatency;

  const inp = firstUserInput(traces);
  if (inp) ctx.inputSample = inputSample(inp);

  return ctx;
}

// ── PRD-SD-01: skill-typed self-entity context builder ───────────────────────

/**
 * PRD-SD-01 (PR-022 / PR-025): Build a skill-typed EntityContext for self-diagnosis runs.
 * The skill diagnoses ITSELF — entityType is 'skill', codeAccess is true (we have the
 * source in the worktree), and applyTarget points at the skill source tree.
 *
 * Deterministic: all fields are derived from the provided metadata, no LLM, no clock.
 * Called by self-diagnostics/dispatch.ts which passes it to the enricher via the
 * descriptor so the enricher can inject it via --entity-context.
 *
 * Q12 (self-diag re-run cadence): on-demand only — this function is pure and
 * stateless; the caller (dispatch.ts) gates behind self_diagnostics.enabled.
 */
export function buildSkillSelfEntityContext(opts: {
  /** Skill name — defaults to 'mutagent-diagnostics'. */
  skillName?: string;
  /** Skill version from package.json — optional. */
  version?: string;
  /** Host runtime where the skill is executing (for provenance). */
  source?: string;
  /** Session-transcript-derived tool inventory (when available). */
  toolInventory?: ToolInventoryEntry[];
  /** Sanitized system-prompt sample derived from session transcript. */
  systemPromptText?: string;
}): EntityContext {
  const name = opts.skillName ?? "mutagent-diagnostics";
  const source = opts.source ?? "claude-code-self-diag";

  const ctx: EntityContext = {
    name,
    entityType: "skill",
    codeAccess: true,
    source,
    /**
     * PRD-SD-01: applyTarget for skill-typed subjects explicitly states that
     * in REPORT-ONLY runs the skill source is READ-ONLY (no source modification).
     * Apply-workers may modify skill assets (config.yaml, .claude/skills/) but
     * NEVER the source scripts. This mirrors the self-diag security note in
     * references/internal/self-diagnostics.md.
     */
    applyTarget:
      "~/.claude/skills/mutagent-diagnostics/* (skill source — READ-ONLY in report-only runs)",
  };

  if (opts.version) {
    // Encode version in the name for disambiguation across deploys.
    ctx.name = `${name}@${opts.version}`;
  }

  if (opts.systemPromptText) {
    ctx.systemPrompt = sized(sanitize(opts.systemPromptText));
  }

  if (opts.toolInventory && opts.toolInventory.length > 0) {
    ctx.toolInventory = opts.toolInventory;
  }

  return ctx;
}

// ── W11-07: Agent identity resolution ────────────────────────────────────────

/**
 * W11-07: Look up a named entity in the config's agents[] identity map and
 * return its cross-platform identity pointers, or undefined when not declared.
 *
 * Deterministic + pure: only performs a case-insensitive name lookup.
 * Called at Step 3.7 AFTER the normalizer has produced its EntityContext,
 * to annotate the context with identity pointers from config.
 *
 * @param entityName - The code-level entity name (from parse-brief.entity or
 *                     EntityContext.name). Compared case-insensitively.
 * @param agents     - The config.agents[] array (from DiagnosticsConfig).
 *                     Pass undefined or empty array when absent (no-op).
 * @returns EntityIdentityPointers for the matched agent, or undefined.
 */
export function resolveEntityIdentity(
  entityName: string | undefined,
  agents: AgentIdentity[] | undefined
): EntityIdentityPointers | undefined {
  if (!entityName || !agents || agents.length === 0) return undefined;

  const lower = entityName.toLowerCase();
  const match = agents.find((a) => a.name.toLowerCase() === lower);
  if (!match) return undefined;

  const pointers: EntityIdentityPointers = {};

  if (match.langfuse) {
    pointers.langfuse = {};
    if (match.langfuse.traceName !== undefined)
      pointers.langfuse.traceName = match.langfuse.traceName;
    if (match.langfuse.tags !== undefined)
      pointers.langfuse.tags = match.langfuse.tags;
    if (match.langfuse.agentIdField !== undefined)
      pointers.langfuse.agentIdField = match.langfuse.agentIdField;
  }

  if (match.otel) {
    pointers.otel = {};
    if (match.otel.serviceName !== undefined)
      pointers.otel.serviceName = match.otel.serviceName;
    if (match.otel.resourceAttrs !== undefined)
      pointers.otel.resourceAttrs = match.otel.resourceAttrs;
  }

  // Only return if at least one platform has data.
  if (!pointers.langfuse && !pointers.otel) return undefined;
  return pointers;
}
