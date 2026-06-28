/**
 * scripts/normalize/platforms/langfuse.ts
 * Langfuse trace JSON → canonical TraceBody shape
 * Type A — Pure Script (deterministic mapping only — no I/O side effects)
 * Reference: references/source-platforms/langfuse.md
 */

import type { TraceBody, TraceMetadata, TraceMessage, EntityContext, CacheStatus } from "../trace.ts";
import { buildAgentEntityContext } from "./entity-context.ts";

/** Langfuse trace object shape (simplified — extend as needed) */
interface LangfuseTrace {
  id: string;
  sessionId?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  startTime?: string;
  endTime?: string;
  latency?: number;
  totalTokens?: number;
  /**
   * PRD-SO-07: Total run cost in USD, present on langfuse-export shapes.
   * Normalizer maps this → TraceMetadata.totalCostUsd.
   */
  totalCost?: number;
  status?: string;
  tags?: string[];
  scores?: LangfuseScore[];
  observations?: LangfuseObservation[];
  comments?: LangfuseComment[];
}

interface LangfuseScore {
  id: string;
  name: string;
  value: number;
  comment?: string;
}

interface LangfuseObservation {
  id: string;
  type: "GENERATION" | "SPAN" | "EVENT";
  name?: string;
  /** R1.7: model id on GENERATION observations — sourced for EntityContext.model. */
  model?: string;
  input?: unknown;
  output?: unknown;
  statusMessage?: string;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
  startTime?: string;
  endTime?: string;
  /**
   * PRD-SO-07: Per-observation latency field from langfuse-export shapes.
   * May be in seconds (< 60 and span > 1000ms) or milliseconds — heuristic applied.
   */
  latency?: number;
  /**
   * W12-12: Token usage on GENERATION observations (langfuse-export shape).
   * Newer Langfuse exports use `usage.input` / `usage.output`; older shapes use
   * `promptTokens` / `completionTokens`. Both are read by the billed-token sum.
   */
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    promptTokens?: number;
    completionTokens?: number;
    // ── W18-cache: cache-token fields on the usage object ────────────────────
    // Anthropic / Bedrock-Anthropic native names:
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /**
   * W18-cache: Langfuse-export cost/token breakdown. Newer Langfuse exports carry
   * a `usageDetails` map keyed by token category. Cache categories appear here as
   * `input_cached_tokens` (cache read) and `cache_creation_input_tokens` (cache write).
   * This is the GROUNDED source for cache state — read ONLY these, never infer.
   */
  usageDetails?: {
    input?: number;
    output?: number;
    input_cached_tokens?: number;
    cache_creation_input_tokens?: number;
    [k: string]: number | undefined;
  };
  /** W12-12: Legacy top-level usage aliases (some exports flatten these). */
  promptTokens?: number;
  completionTokens?: number;
  /** W18-cache: top-level flattened cache aliases (some exports flatten these too). */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface LangfuseComment {
  id: string;
  content: string;
  createdAt?: string;
}

// ── PRD-SO-07: timing + seconds→ms heuristic helpers ─────────────────────────

/**
 * PRD-SO-07 (F-SD-1 R2): Derive trace-level startTime from observations when the
 * top-level startTime is absent (langfuse-export shape). Returns the minimum
 * observation startTime as an ISO8601 string, or undefined when no obs have timing.
 */
function minObsStartTime(observations: LangfuseObservation[]): string | undefined {
  let min: number | undefined;
  for (const o of observations) {
    if (!o.startTime) continue;
    const t = new Date(o.startTime).getTime();
    if (!Number.isFinite(t)) continue;
    if (min === undefined || t < min) min = t;
  }
  return min !== undefined ? new Date(min).toISOString() : undefined;
}

/**
 * PRD-SO-07 (F-SD-1 R2): Derive trace-level endTime from observations when absent.
 * Returns the maximum observation endTime, or startTime when endTime is missing.
 */
function maxObsEndTime(observations: LangfuseObservation[]): string | undefined {
  let max: number | undefined;
  for (const o of observations) {
    const src = o.endTime ?? o.startTime;
    if (!src) continue;
    const t = new Date(src).getTime();
    if (!Number.isFinite(t)) continue;
    if (max === undefined || t > max) max = t;
  }
  return max !== undefined ? new Date(max).toISOString() : undefined;
}

/**
 * D-2 (Wave-13): Compute the authoritative span duration in milliseconds from the
 * trace start/end timestamps (derived from observation timing upstream — see
 * minObsStartTime/maxObsEndTime). The span is the GROUND TRUTH for latency:
 * unlike the raw trace-level `latency` field — whose unit (seconds vs ms) is
 * source-shape-dependent and unreliable on langfuse-export shapes — the span is
 * always wall-clock milliseconds. Returns undefined when no valid, ordered span
 * exists. (Honors feedback_evidence_first_debug: trust the span data, not the
 * raw `latency` field.)
 */
function spanDurationMs(
  startTime: string | undefined,
  endTime: string | undefined
): number | undefined {
  if (!startTime || !endTime) return undefined;
  const s = new Date(startTime).getTime();
  const e = new Date(endTime).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return undefined;
  return e - s;
}

/**
 * PRD-SO-07 (F-SD-1 R2, Q6) + D-2 fix (Wave-13): Convert a raw trace-level
 * `latency` field to milliseconds, using the authoritative SPAN duration to
 * disambiguate seconds-vs-ms. The span ARBITRATES — it is not blindly overridden,
 * and it is never pre-empted by a magnitude-only short-circuit.
 *
 * D-2 — the regression this fixes:
 *   The previous code did `if (latencyRaw >= 60) return latencyRaw;` BEFORE
 *   looking at the span. A trace whose true latency was 80 SECONDS carried
 *   `latency: 80`, was short-circuited as "already ms", and treated as 80ms
 *   downstream — mis-bucketing the slowest, most-diagnostic traces and flipping
 *   the headline p50 (fake ~10s vs real 54s). The `>= 60` magnitude check must
 *   NOT pre-empt the authoritative span duration.
 *
 * Resolution (span arbitrates the unit of `latencyRaw`):
 *   - No span / no raw value: keep the raw value as-is (best-effort; the
 *     config.source.latency_unit override — PRD-SO-03 — handles the known case).
 *   - latencyRaw interpreted as SECONDS matches the span (span ≈ latencyRaw*1000):
 *     the field is seconds → return the span ms. This both performs the classic
 *     seconds→ms conversion (raw 3.5s, span 3500ms ⇒ 3500) AND fixes the >=60s
 *     mis-bucketing (raw 80s, span 80_000ms ⇒ 80_000). Magnitude is irrelevant.
 *   - Otherwise latencyRaw is already plausible ms (span ≈ latencyRaw): keep it.
 *     A plausible trace-level ms value is NOT overridden by the span.
 *
 * "Matches the span" uses a ±25% tolerance band so jitter between the reported
 * latency and the wall-clock span doesn't misclassify the unit.
 */
export function applyLatencySecondsHeuristic(
  latencyRaw: number | undefined,
  startTime: string | undefined,
  endTime: string | undefined
): number | undefined {
  if (latencyRaw === undefined) return undefined;

  const spanMs = spanDurationMs(startTime, endTime);
  // No span to arbitrate against → cannot disambiguate s vs ms; keep raw.
  if (spanMs === undefined || spanMs <= 1000) return latencyRaw;

  // D-2: does `latencyRaw` interpreted as SECONDS match the authoritative span?
  // If so the raw field is seconds — the span (ms) wins. This is the ONLY case
  // where the span overrides the raw value, and it is independent of magnitude
  // (so an 80s field with an 80_000ms span is corrected, not short-circuited).
  const asSecondsMs = latencyRaw * 1000;
  const tol = 0.25; // ±25% tolerance for reported-vs-wallclock jitter
  const matchesAsSeconds = Math.abs(asSecondsMs - spanMs) <= spanMs * tol;
  if (matchesAsSeconds) return spanMs;

  // latencyRaw is already plausible ms (or doesn't match the span as seconds) —
  // keep the trace-level value. A plausible ms latency is NOT overridden here;
  // the W12-12 root-span fallback (agentRootLatencyMs) handles sub-second
  // implausibility separately in normalizeLangfuseTrace.
  return latencyRaw;
}

// ── W12-10: tool-inventory pollution filters ─────────────────────────────────

/** `agent.step.0`, `agent.step.11`, … — orchestration step markers, not tools. */
const AGENT_STEP_RE = /^agent\.step\.\d+$/;
/**
 * AI-SDK generation spans, in either bare or namespaced form:
 *   `ai.generateText`, `ai.generateText.doGenerate`,
 *   `mod:ai.generateText`, `svc.ai.generateText.doGenerate`.
 * These are SDK telemetry wrappers, not business tools.
 */
const AI_SDK_SPAN_RE = /(^|[.:])ai\.generateText(\.doGenerate)?$/;

/**
 * W12-10 (P5/DC-2): is this observation name a NON-tool span that pollutes the
 * tool inventory? Excludes:
 *   - `agent.step.N` orchestration markers
 *   - AI-SDK `ai.generateText[.doGenerate]` telemetry spans
 *   - the agent-root span (its name equals the trace/agent name — it's the
 *     top-level agent, not a tool it called)
 * Deterministic, name-only — no clock/random/LLM.
 */
export function isExcludedToolSpan(name: string | undefined, agentRootName?: string): boolean {
  if (!name) return true; // unnamed spans are never business tools
  if (AGENT_STEP_RE.test(name)) return true;
  if (AI_SDK_SPAN_RE.test(name)) return true;
  if (agentRootName && name === agentRootName) return true;
  return false;
}

// ── W12-12: billed-token + latency helpers ───────────────────────────────────

/** Leaf LLM-call span: `…ai.generateText.doGenerate`. The PARENT `ai.generateText`
 *  wrapper (no `.doGenerate`) repeats its children's usage, so we count leaves only. */
const DO_GENERATE_RE = /(^|[.:])ai\.generateText\.doGenerate$/;

/** Read input/output tokens from an observation's usage (new + legacy shapes). */
function obsUsage(o: LangfuseObservation): { input: number; output: number } {
  const u = o.usage;
  const input = u?.input ?? u?.promptTokens ?? o.promptTokens ?? 0;
  const output = u?.output ?? u?.completionTokens ?? o.completionTokens ?? 0;
  return {
    input: Number.isFinite(input) ? (input as number) : 0,
    output: Number.isFinite(output) ? (output as number) : 0,
  };
}

/**
 * W12-12: Sum billed tokens across doGenerate-ONLY generation spans, so the
 * parent `ai.generateText` wrapper (which repeats child usage) is not
 * double-counted. Returns undefined for a field when NO doGenerate span carried
 * any usage, so the absence is distinguishable from a genuine zero.
 */
export function computeBilledTokens(
  observations: LangfuseObservation[]
): { billedInputTokens?: number; billedOutputTokens?: number } {
  let input = 0;
  let output = 0;
  let sawUsage = false;
  for (const o of observations) {
    if (!o.name || !DO_GENERATE_RE.test(o.name)) continue;
    const hasUsage =
      o.usage !== undefined || o.promptTokens !== undefined || o.completionTokens !== undefined;
    if (!hasUsage) continue;
    const { input: i, output: out } = obsUsage(o);
    input += i;
    output += out;
    sawUsage = true;
  }
  if (!sawUsage) return {};
  return { billedInputTokens: input, billedOutputTokens: output };
}

// ── W18-cache: GROUNDED prompt-caching extraction ─────────────────────────────
//
// CORE RULE (W18-cache): cache state is read ONLY from explicit cache-token
// fields. NEVER inferred from `promptTokens` flatness or byte sizes. When NO
// cache-token field is present on any usage-bearing span, status is "unknown" —
// NOT "uncached". This is the fix for the real miss where ~89%-cached traffic was
// reported as "uncached → 408M billed tokens" inferred from byte sizes.

/**
 * W18-cache: read cache-read + cache-creation token counts from a single
 * observation's usage, across the known shapes:
 *   - Langfuse usageDetails.input_cached_tokens / .cache_creation_input_tokens
 *   - Anthropic/Bedrock usage.cache_read_input_tokens / .cache_creation_input_tokens
 *   - top-level flattened cache_read_input_tokens / cache_creation_input_tokens
 *
 * Returns `present: false` IFF NONE of these fields exist on the observation — the
 * caller uses this to distinguish a grounded zero (field present, value 0) from a
 * genuine absence (field missing → unknown). A present-but-non-finite value is
 * coerced to 0 while still counting as present.
 */
export function obsCacheTokens(
  o: LangfuseObservation
): { cacheRead: number; cacheCreation: number; present: boolean } {
  const u = o.usage;
  const d = o.usageDetails;

  const readRaw =
    d?.input_cached_tokens ??
    u?.cache_read_input_tokens ??
    o.cache_read_input_tokens;
  const creationRaw =
    d?.cache_creation_input_tokens ??
    u?.cache_creation_input_tokens ??
    o.cache_creation_input_tokens;

  const present = readRaw !== undefined || creationRaw !== undefined;
  const num = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  return { cacheRead: num(readRaw), cacheCreation: num(creationRaw), present };
}

/** The grounded cache shape surfaced on TraceMetadata (W18-cache). */
export interface CacheUsage {
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  cacheStatus?: CacheStatus;
  cacheHitRate?: number;
}

/**
 * W18-cache: compute GROUNDED cache usage across the doGenerate-only generation
 * spans (same span set as computeBilledTokens, so cache numbers line up with the
 * de-double-counted billed input). Cache state is derived ONLY from cache-token
 * fields:
 *
 *   - If NO usage-bearing doGenerate span carries any cache-token field →
 *     cacheStatus = "unknown" (NEVER "uncached"); hit-rate undefined; token fields
 *     undefined. Absence of a cache field is NOT evidence of no caching.
 *   - If cache fields ARE present:
 *       cachedInputTokens   = Σ cache_read across spans
 *       cacheCreationTokens = Σ cache_creation across spans
 *       totalInput          = Σ billed input across the SAME spans (cache_read is a
 *                             subset of input; cache_creation is also billed input)
 *       cacheHitRate        = cachedInputTokens / totalInput   (0 when totalInput 0)
 *       cacheStatus         = "hit" when cachedInputTokens > 0, else grounded "miss".
 *
 * Deterministic — no clock/random/LLM.
 */
export function computeCacheTokens(observations: LangfuseObservation[]): CacheUsage {
  let cacheRead = 0;
  let cacheCreation = 0;
  let totalInput = 0;
  let sawCacheField = false;

  for (const o of observations) {
    if (!o.name || !DO_GENERATE_RE.test(o.name)) continue;
    const hasUsage =
      o.usage !== undefined ||
      o.usageDetails !== undefined ||
      o.promptTokens !== undefined ||
      o.completionTokens !== undefined ||
      o.cache_read_input_tokens !== undefined ||
      o.cache_creation_input_tokens !== undefined;
    if (!hasUsage) continue;

    const cache = obsCacheTokens(o);
    if (cache.present) {
      sawCacheField = true;
      cacheRead += cache.cacheRead;
      cacheCreation += cache.cacheCreation;
    }
    // Billed input across the same spans = denominator basis (grounded, not bytes).
    totalInput += obsUsage(o).input;
  }

  // CORE RULE: no cache field anywhere → UNKNOWN, never "uncached".
  if (!sawCacheField) {
    return { cacheStatus: "unknown" };
  }

  const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;
  const cacheStatus: CacheStatus = cacheRead > 0 ? "hit" : "miss";
  return {
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    cacheStatus,
    cacheHitRate,
  };
}

/**
 * W12-12: Latency of the agent-root span (name === the trace/agent name), in ms.
 * Used as a fallback when trace-level latency is missing or implausible
 * (sub-second on a heavy multi-span trace). Returns undefined when no root span
 * with usable timing is found.
 */
export function agentRootLatencyMs(
  observations: LangfuseObservation[],
  agentRootName: string | undefined
): number | undefined {
  if (!agentRootName) return undefined;
  for (const o of observations) {
    if (o.name !== agentRootName) continue;
    if (o.startTime && o.endTime) {
      const s = new Date(o.startTime).getTime();
      const e = new Date(o.endTime).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) return e - s;
    }
  }
  return undefined;
}

// ── REQ-053 / LF-SP-1: system prompt lifted from GENERATION observation input ──
//
// The system prompt commonly lives NOT at the top-level trace input but inside a
// model-call GENERATION observation's `.input[]` as the leading `role:"system"`
// message — the standard Vercel-AI-SDK `doGenerate` shape (`input` is the chat
// message array passed to the model). `extractSystemPrompt` (entity-context.ts)
// only scans the top-level `TraceBody.messages`, so without lifting it the prompt
// is buried inside the JSON.stringify(observation.input) blob and the entity card
// falls back to SYSTEM_PROMPT_ABSENT_LABEL even though the prompt is present.
//
// This helper pulls the FIRST chronological GENERATION observation's leading
// system message out of `.input[]`, so the normalizer can splice it into
// TraceBody.messages as a real `role:"system"` turn. Deterministic, content-only.

/** A single chat message inside a GENERATION observation's `.input[]` array. */
interface ObsInputMessage {
  role?: string;
  content?: unknown;
}

/** Coerce a message `.content` (string OR content-block array) to plain text. */
function obsMessageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // AI-SDK content-block array: [{ type:"text", text:"…" }, …]. Join text parts.
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

/**
 * REQ-053 / LF-SP-1: extract the system-prompt text from the GENERATION
 * observations' `.input[]` — the leading `role:"system"` message of the FIRST
 * chronological GENERATION observation whose input carries one. Returns the raw
 * (un-sanitized) system text, or undefined when no observation input has a
 * system message. Deterministic — observation order is file order; no clock/random.
 *
 * Chronology: observations are ordered by their startTime when present (ties +
 * missing timestamps keep file order, which is the source's own chronology), so
 * the EARLIEST doGenerate call's system prompt wins — the most-complete prompt
 * before any mid-run context trimming.
 */
export function systemPromptFromObservationInput(
  observations: LangfuseObservation[]
): string | undefined {
  const generations = observations
    .filter((o) => o.type === "GENERATION" && Array.isArray(o.input))
    .slice()
    .sort((a, b) => {
      const ta = a.startTime ? new Date(a.startTime).getTime() : NaN;
      const tb = b.startTime ? new Date(b.startTime).getTime() : NaN;
      const fa = Number.isFinite(ta);
      const fb = Number.isFinite(tb);
      if (fa && fb && ta !== tb) return ta - tb;
      if (fa && !fb) return -1; // timestamped sorts before untimestamped
      if (!fa && fb) return 1;
      return 0; // both missing / equal → stable file order
    });

  for (const o of generations) {
    const input = o.input as ObsInputMessage[];
    const sys = input.find(
      (m) => m && typeof m === "object" && m.role === "system"
    );
    if (sys) {
      const text = obsMessageContentToText(sys.content);
      if (text.trim().length > 0) return text;
    }
  }
  return undefined;
}

export function normalizeLangfuseTrace(raw: LangfuseTrace): TraceBody {
  const hasError =
    raw.status === "ERROR" ||
    (raw.observations ?? []).some((o) => o.level === "ERROR");
  const scores = raw.scores ?? [];
  const firstScore = scores[0];
  const hasFeedback = scores.length > 0;

  // PRD-SO-07: derive startTime/endTime from observations when top-level fields absent
  const obs = raw.observations ?? [];
  const startTime = raw.startTime ?? minObsStartTime(obs);
  const endTime = raw.endTime ?? maxObsEndTime(obs);

  // PRD-SO-07: apply seconds→ms heuristic on the top-level latency field
  let latencyMs = applyLatencySecondsHeuristic(raw.latency, startTime, endTime);

  // W12-12: prefer the agent-root span latency when trace-level latency is
  // missing OR implausible (sub-second while the root span clearly ran longer).
  // A heavy multi-span agent run reporting < 1s is almost always a missing/
  // mis-scaled trace-level field; the root span's own start→end is authoritative.
  const rootLatency = agentRootLatencyMs(obs, raw.name);
  if (rootLatency !== undefined) {
    if (latencyMs === undefined) {
      latencyMs = rootLatency;
    } else if (latencyMs < 1000 && rootLatency >= 1000 && rootLatency > latencyMs) {
      latencyMs = rootLatency;
    }
  }

  // W12-12: billed tokens from doGenerate-only spans (de-double-counted).
  const billed = computeBilledTokens(obs);

  // W18-cache: GROUNDED cache state from cache-token fields ONLY (never inferred).
  const cache = computeCacheTokens(obs);

  const metadata: TraceMetadata = {
    traceId: raw.id,
    sessionId: raw.sessionId ?? raw.id,
    agentId: raw.name,
    startTime,
    endTime,
    latencyMs,
    totalTokens: raw.totalTokens,
    hasError,
    hasFeedback,
    rawScore: firstScore?.value,
    tags: raw.tags,
    sourcePlatform: "langfuse",
    // PRD-SO-07: total cost from langfuse-export raw.totalCost
    totalCostUsd: typeof raw.totalCost === "number" ? raw.totalCost : undefined,
    // W12-12: de-double-counted billed tokens (doGenerate-only spans)
    billedInputTokens: billed.billedInputTokens,
    billedOutputTokens: billed.billedOutputTokens,
    // W18-cache: grounded cache state (cacheStatus="unknown" when no cache field)
    cachedInputTokens: cache.cachedInputTokens,
    cacheCreationTokens: cache.cacheCreationTokens,
    cacheStatus: cache.cacheStatus,
    cacheHitRate: cache.cacheHitRate,
  };

  const messages: TraceMessage[] = [];
  let index = 0;

  // Root input
  if (raw.input !== undefined) {
    messages.push({
      index: index++,
      role: "user",
      content: JSON.stringify(raw.input),
    });
  }

  // Observations → messages.
  // W12-10: do NOT tag step-markers / AI-SDK spans / the agent-root span with a
  // toolName — they pollute the tool inventory (which groups by toolName). The
  // message content is still preserved; only the toolName tag is suppressed.
  for (const observation of obs) {
    const toolName = isExcludedToolSpan(observation.name, raw.name)
      ? undefined
      : observation.name;
    if (observation.input !== undefined) {
      messages.push({
        index: index++,
        role: "user",
        content: JSON.stringify(observation.input),
        toolName,
        isError: observation.level === "ERROR",
        timestamp: observation.startTime,
      });
    }
    if (observation.output !== undefined) {
      messages.push({
        index: index++,
        role: "assistant",
        content: JSON.stringify(observation.output),
        toolName,
        isError: observation.level === "ERROR",
        timestamp: observation.endTime,
      });
    }
  }

  // Root output
  if (raw.output !== undefined) {
    messages.push({
      index: index++,
      role: "assistant",
      content: JSON.stringify(raw.output),
    });
  }

  // REQ-053 / LF-SP-1: if NO top-level system message was assembled (the common
  // case — langfuse top-level input is pushed as role:"user"), lift the system
  // prompt out of the GENERATION observations' `.input[]` (the Vercel-AI-SDK
  // `doGenerate` shape) and splice it in as a real role:"system" turn at index 0.
  // This lets extractSystemPrompt (entity-context.ts) FIND it instead of falling
  // back to SYSTEM_PROMPT_ABSENT_LABEL. The absent-label then fires ONLY when no
  // system message exists ANYWHERE (top-level OR observation input).
  const hasTopLevelSystem = messages.some((m) => m.role === "system");
  if (!hasTopLevelSystem) {
    const liftedSystem = systemPromptFromObservationInput(obs);
    if (liftedSystem !== undefined) {
      messages.unshift({ index: 0, role: "system", content: liftedSystem });
      // Re-number indices so they stay contiguous after the unshift.
      for (let k = 0; k < messages.length; k++) messages[k].index = k;
    }
  }

  // Comments → user feedback
  const feedbackComments = raw.comments ?? [];
  const userFeedback =
    feedbackComments.length > 0
      ? feedbackComments.map((c) => c.content).join("\n")
      : undefined;

  return {
    metadata,
    messages,
    userFeedback,
    score: firstScore?.value,
  };
}

// ── R1.7 — EntityContext extraction (DETERMINISTIC, NO LLM) ───────────────────

/** First GENERATION observation's model across the trace set. */
function firstGenerationModel(raw: LangfuseTrace[]): string | undefined {
  for (const t of raw) {
    for (const o of t.observations ?? []) {
      if (o.type === "GENERATION" && o.model) return o.model;
    }
  }
  return undefined;
}

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): extract an EntityContext from a set of raw
 * Langfuse traces, ALONGSIDE the normalized TraceBody[]. Content-derived:
 *   name           = trace name / agentId majority vote
 *   model          = first GENERATION observation .model
 *   systemPrompt   = system-role message OR <system>…</system> (sanitized)
 *   toolInventory  = observations grouped by name (latency from end-start)
 *   inputSample    = first input, sanitized + sliced
 * Deterministic — byte-identical across re-runs (no clock, no random, no LLM).
 */
export function extractLangfuseEntityContext(raw: LangfuseTrace[]): EntityContext {
  const bodies = raw.map(normalizeLangfuseTrace);
  return buildAgentEntityContext(bodies, {
    source: "langfuse-export",
    fallbackName: raw[0]?.name ?? "langfuse-agent",
    model: firstGenerationModel(raw),
  });
}

// ── D-3 (Wave-13): streaming large-file ingest (NDJSON + gz) ───────────────────
//
// The array-JSON path (`JSON.parse(readFileSync(--in))`) loads the WHOLE file as
// one string AND materializes the entire parsed array — it OOMs on large
// langfuse-export sources (the real run was 2.84 GB NDJSON-gzip and could only
// be ingested by streaming OUTSIDE the skill via `gzcat | jq`). These helpers add
// a first-class streaming path so large NDJSON / NDJSON-gz exports ingest
// line-by-line without holding the raw bytes in memory.
//
// Determinism: line order is file order, normalization is pure — same input file
// yields byte-identical output across runs (no clock/random/network/LLM).

/** Ingest format detected for a `--in` source. */
export type LangfuseIngestFormat = "array-json" | "ndjson" | "ndjson-gz";

/**
 * Detect the ingest format of a source file WITHOUT reading it whole.
 *   - `.gz` / `.gzip` extension OR gzip magic bytes (0x1f 0x8b) → "ndjson-gz"
 *   - first non-whitespace byte is `[` → "array-json" (a single JSON array)
 *   - otherwise (first non-ws byte `{`, or `.ndjson`/`.jsonl` extension) → "ndjson"
 * Reads at most a small header slice; never loads the full file.
 */
export function detectLangfuseIngestFormat(
  inPath: string,
  headerBytes: Uint8Array
): LangfuseIngestFormat {
  // gzip magic number — authoritative regardless of extension.
  if (headerBytes.length >= 2 && headerBytes[0] === 0x1f && headerBytes[1] === 0x8b) {
    return "ndjson-gz";
  }
  const lower = inPath.toLowerCase();
  if (lower.endsWith(".gz") || lower.endsWith(".gzip")) return "ndjson-gz";

  // First non-whitespace byte disambiguates a JSON array from NDJSON.
  for (const b of headerBytes) {
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue; // ws
    if (b === 0x5b /* [ */) return "array-json";
    break; // first meaningful byte was not '[' → treat as NDJSON
  }
  return "ndjson";
}

/**
 * Stream a langfuse-export source file line-by-line, invoking `onTrace` for each
 * successfully-parsed raw trace. Transparently gunzips `.gz` sources. Lines that
 * fail JSON.parse are skipped (and counted) rather than aborting the whole ingest
 * — large exports occasionally carry a partial trailing line.
 *
 * Memory profile: only ONE line is held at a time (plus whatever `onTrace`
 * accumulates). The raw file bytes are never fully buffered.
 *
 * @returns counts of parsed + skipped lines.
 */
export async function streamLangfuseTraces(
  inPath: string,
  onTrace: (raw: LangfuseTrace) => void, // eslint-disable-line no-unused-vars
  format?: LangfuseIngestFormat
): Promise<{ parsed: number; skipped: number }> {
  const { createReadStream } = await import("fs");
  const { createInterface } = await import("readline");
  const { createGunzip } = await import("zlib");

  const isGz =
    format === "ndjson-gz" ||
    inPath.toLowerCase().endsWith(".gz") ||
    inPath.toLowerCase().endsWith(".gzip");

  const fileStream = createReadStream(inPath);
  // gunzip inline when needed; the source stream stays bounded by the highWaterMark.
  // Cast to the `input` parameter type `createInterface` expects so it accepts
  // either the raw file stream or the gunzip transform stream as its line source.
  type RlInput = Parameters<typeof createInterface>[0]["input"];
  const lineSource = (
    isGz ? fileStream.pipe(createGunzip()) : fileStream
  ) as unknown as RlInput;

  const rl = createInterface({
    input: lineSource,
    crlfDelay: Infinity,
  });

  let parsed = 0;
  let skipped = 0;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    onTrace(obj as LangfuseTrace);
    parsed += 1;
  }
  return { parsed, skipped };
}

/**
 * Streaming counterpart to the array-JSON CLI path: ingest a (possibly huge,
 * possibly gzipped) NDJSON langfuse-export file and emit BOTH `TraceMetadata[]`
 * and an `EntityContext`, matching what the array path produces — but without
 * loading the whole file into memory.
 *
 * NOTE: the returned `TraceMetadata[]` is still accumulated in memory (one small
 * object per trace), which is orders of magnitude lighter than holding the raw
 * 2.84 GB text + the parsed raw-trace array. The EntityContext is derived from
 * the accumulated TraceBody[] exactly as the array path does, so output is
 * identical for identical input.
 */
export async function ingestLangfuseFileStreaming(
  inPath: string,
  format?: LangfuseIngestFormat
): Promise<{ metadata: TraceMetadata[]; entity: EntityContext; parsed: number; skipped: number }> {
  const bodies: TraceBody[] = [];
  let fallbackName: string | undefined;
  let model: string | undefined;

  const { parsed, skipped } = await streamLangfuseTraces(
    inPath,
    (raw) => {
      const body = normalizeLangfuseTrace(raw);
      bodies.push(body);
      // First trace name / first GENERATION model — same selection the array
      // path makes (raw[0]?.name, firstGenerationModel), computed in one pass.
      if (fallbackName === undefined && raw.name) fallbackName = raw.name;
      if (model === undefined) {
        for (const o of raw.observations ?? []) {
          if (o.type === "GENERATION" && o.model) {
            model = o.model;
            break;
          }
        }
      }
    },
    format
  );

  const entity = buildAgentEntityContext(bodies, {
    source: "langfuse-export",
    fallbackName: fallbackName ?? "langfuse-agent",
    model,
  });
  const metadata = bodies.map((b) => b.metadata);
  return { metadata, entity, parsed, skipped };
}

// ── SD-5: verify-memory'd-workarounds guardrail (Chesterton's Fence) ───────────
//
// MEMORY CLAIM (this module): two langfuse-export workarounds were landed in
// Wave-13 and are claimed LIVE:
//   D-2 — applyLatencySecondsHeuristic: the authoritative SPAN duration arbitrates
//         the unit of the raw `latency` field (seconds vs ms), fixing the >=60s
//         mis-bucketing that flipped the headline p50 (see lines ~116-189).
//   D-3 — detectLangfuseIngestFormat + streamLangfuseTraces: NDJSON / NDJSON-gz
//         exports STREAM line-by-line so multi-GB sources ingest without OOM
//         (see lines ~446+).
//
// WHY a guardrail and not a removal: per `feedback_unwired_is_not_cold` +
// Chesterton's Fence, a memory note saying "already fixed" is NOT license to rip
// the code out. Both workarounds ARE the fix and ARE wired (D-2 at the latency
// step in normalizeLangfuseTrace; D-3 in the import.meta.main NDJSON branch).
// What memory CANNOT guarantee is that a LATER refactor didn't silently regress
// the behavior while leaving the functions in place. This guardrail re-checks the
// CLAIM against the CURRENT source's actual behavior — so a future dev who reads
// "D-2/D-3 already fixed" can VERIFY rather than re-patch (or rip out) blind.
//
// Pure + deterministic (drives the live functions with synthetic inputs — no
// clock/random/network/LLM). Throws on regression with a pointer to the claim.

/** SD-5: a single workaround-claim verification outcome. */
export interface WorkaroundCheck {
  id: "D-2" | "D-3";
  claim: string;
  live: boolean;
  detail: string;
}

/**
 * SD-5: re-verify the memory'd Wave-13 langfuse-export workarounds against the
 * CURRENT source behavior. Returns one WorkaroundCheck per claim. `live: false`
 * means the claimed corrective behavior is NO LONGER produced by the live code
 * (a silent regression) — the caller should investigate the workaround, NOT
 * reimplement it from scratch. Deterministic; safe to call from a test or a
 * pre-flight self-check.
 */
export function verifyLangfuseWorkarounds(): WorkaroundCheck[] {
  // D-2: a raw latency expressed in SECONDS (3.5) with a wall-clock span of
  // 3500ms MUST be corrected to 3500ms by the span-arbitration heuristic. If the
  // heuristic were bypassed it would echo 3.5 back.
  const d2 = applyLatencySecondsHeuristic(
    3.5,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:03.500Z"
  );
  const d2Live = d2 === 3500;

  // D-2 regression sentinel: the >=60s case the workaround specifically fixes —
  // raw 80 (seconds) with an 80_000ms span MUST become 80_000, not stay 80.
  const d2Big = applyLatencySecondsHeuristic(
    80,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:01:20.000Z"
  );
  const d2BigLive = d2Big === 80_000;

  // D-3: format detection must still distinguish gzip magic / array / ndjson —
  // the entry point that routes large sources to the streaming path.
  const gz = detectLangfuseIngestFormat("x.bin", new Uint8Array([0x1f, 0x8b, 0x00]));
  const arr = detectLangfuseIngestFormat("x.json", new Uint8Array([0x20, 0x5b]));
  const nd = detectLangfuseIngestFormat("x.ndjson", new Uint8Array([0x7b]));
  const d3Live = gz === "ndjson-gz" && arr === "array-json" && nd === "ndjson";

  return [
    {
      id: "D-2",
      claim:
        "applyLatencySecondsHeuristic: span arbitrates seconds-vs-ms (incl. >=60s)",
      live: d2Live && d2BigLive,
      detail: `3.5s/3500ms→${d2} (want 3500); 80s/80000ms→${d2Big} (want 80000)`,
    },
    {
      id: "D-3",
      claim:
        "detectLangfuseIngestFormat routes gzip/array/ndjson to the right ingest path",
      live: d3Live,
      detail: `gzip→${gz}; array→${arr}; ndjson→${nd}`,
    },
  ];
}

/**
 * SD-5: assert form — throws when ANY memory'd workaround is no longer live.
 * Use as a cheap pre-flight self-check before re-running an ingest that relies on
 * the Wave-13 corrections. The throw message names the regressed claim so the
 * next dev investigates the existing workaround instead of re-patching blind.
 */
export function assertLangfuseWorkaroundsLive(): void {
  const regressed = verifyLangfuseWorkarounds().filter((c) => !c.live);
  if (regressed.length > 0) {
    const lines = regressed.map((c) => `  ${c.id}: ${c.claim} — ${c.detail}`);
    throw new Error(
      "SD-5: memory'd langfuse-export workaround(s) regressed (claimed live but " +
        "not producing corrective behavior). INVESTIGATE the existing workaround — " +
        "do NOT reimplement:\n" +
        lines.join("\n")
    );
  }
}

// ── W12-11 (OP-8): INTERNAL CLI transport ─────────────────────────────────────
//
// Makes the deterministic Langfuse normalizer + EntityContext extractor RUNNABLE
// from run.sh so the orchestrator (Step 3.7 / 8.5a) no longer hand-wires
// EntityContext with inline `bun -e` glue (banned by R-SELF-03-c) — which was the
// ROOT of OP-7 (silent `diagnosedEntity` drop). NO product `mutagent` CLI flag is
// added — this transport is INTERNAL, invoked only via scripts/cli/run.sh.
//
//   run.sh scripts/normalize/platforms/langfuse.ts \
//     --in <raw-langfuse-export.json> \
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>]
//
// --in is EITHER a JSON array of raw Langfuse traces (the langfuse-export shape)
//   OR a line-delimited NDJSON file (one raw trace per line), optionally gzipped
//   (`.gz` / `.gzip`). The format is auto-detected (D-3): array sources keep the
//   in-memory path; NDJSON / NDJSON-gz sources STREAM line-by-line so multi-GB
//   exports ingest without OOM. `--format` overrides auto-detection if needed.
// --out-metadata writes TraceMetadata[]; --out-entity writes the EntityContext.
// At least one --out-* is required. Deterministic — no clock/random/network/LLM.

if (import.meta.main) {
  const { readFileSync, writeFileSync, openSync, readSync, closeSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const inPath = get("--in");
  const outMetadataPath = get("--out-metadata");
  const outEntityPath = get("--out-entity");
  const formatOverride = get("--format") as LangfuseIngestFormat | undefined;

  if (!inPath || (!outMetadataPath && !outEntityPath)) {
    process.stderr.write(
      "Usage: run.sh scripts/normalize/platforms/langfuse.ts --in <traces.json|.ndjson|.gz> " +
        "[--out-metadata <path>] [--out-entity <path>] [--format array-json|ndjson|ndjson-gz]\n"
    );
    process.exit(1);
  }

  try {
    const resolvedIn = resolve(inPath);

    // Peek a small header slice to detect the format WITHOUT reading the whole
    // file (the file may be multiple GB). gzip magic / first non-ws byte decide.
    let format: LangfuseIngestFormat;
    if (formatOverride) {
      format = formatOverride;
    } else {
      const fd = openSync(resolvedIn, "r");
      try {
        const header = Buffer.alloc(64);
        const n = readSync(fd, header, 0, header.length, 0);
        format = detectLangfuseIngestFormat(resolvedIn, header.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    }

    if (format === "array-json") {
      // In-memory path — appropriate for the (small) JSON-array export shape.
      const rawText = readFileSync(resolvedIn, "utf8");
      const parsed: unknown = JSON.parse(rawText);
      const traces = (Array.isArray(parsed) ? parsed : [parsed]) as LangfuseTrace[];

      if (outMetadataPath) {
        const metadata = traces.map((t) => normalizeLangfuseTrace(t).metadata);
        writeFileSync(resolve(outMetadataPath), JSON.stringify(metadata, null, 2), "utf8");
        process.stdout.write(`TraceMetadata[] (${metadata.length}) written to: ${outMetadataPath}\n`);
      }
      if (outEntityPath) {
        const entity = extractLangfuseEntityContext(traces);
        writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
        process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
      }
    } else {
      // D-3: STREAMING path — NDJSON / NDJSON-gz line-by-line, no whole-file load.
      const { metadata, entity, parsed, skipped } = await ingestLangfuseFileStreaming(
        resolvedIn,
        format
      );
      if (skipped > 0) {
        process.stderr.write(`[langfuse normalize] skipped ${skipped} unparseable line(s)\n`);
      }
      if (outMetadataPath) {
        writeFileSync(resolve(outMetadataPath), JSON.stringify(metadata, null, 2), "utf8");
        process.stdout.write(
          `TraceMetadata[] (${metadata.length}) written to: ${outMetadataPath} ` +
            `[streamed ${parsed} ${format} trace(s)]\n`
        );
      }
      if (outEntityPath) {
        writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
        process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
      }
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
