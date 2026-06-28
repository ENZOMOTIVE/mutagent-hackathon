/**
 * scripts/normalize/platforms/otel.ts
 * OpenTelemetry spans → canonical TraceBody shape
 * Type A — Pure Script
 * Reference: references/source-platforms/otel.md
 */

import type { TraceBody, TraceMetadata, TraceMessage, EntityContext, CacheStatus } from "../trace.ts";
import { buildAgentEntityContext } from "./entity-context.ts";

interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
  status?: { code?: number; message?: string };
  events?: Array<{ name: string; timeUnixNano?: string; attributes?: Array<{ key: string; value: { stringValue?: string } }> }>;
}

function getAttr(span: OtelSpan, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value?.stringValue;
}

/**
 * W18-cache: read a numeric OTel attribute (GenAI token-usage attrs are emitted as
 * `intValue`, a stringified integer in the OTLP JSON shape; some exporters use
 * `stringValue`). Returns undefined when the attribute is absent OR unparseable —
 * undefined is load-bearing: it means the field was not present (→ unknown), NOT zero.
 */
function getIntAttr(span: OtelSpan, key: string): number | undefined {
  const v = span.attributes?.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  const raw = v.intValue ?? v.stringValue;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ── W18-cache: GROUNDED prompt-caching extraction (OTel GenAI conventions) ─────
//
// CORE RULE (W18-cache): cache state is read ONLY from explicit cache-token attrs.
// NEVER inferred from input-token magnitude or byte sizes. When NO cache attr is
// present, status is "unknown" — NOT "uncached". Absence of a cache field is not
// evidence of no caching.
//
// OTel GenAI semantic-convention cache attribute names (plus common vendor variants):
const OTEL_CACHE_READ_KEYS = [
  "gen_ai.usage.cache_read_input_tokens",
  "gen_ai.usage.input_cached_tokens",
  "llm.usage.cache_read_input_tokens",
] as const;
const OTEL_CACHE_CREATION_KEYS = [
  "gen_ai.usage.cache_creation_input_tokens",
  "llm.usage.cache_creation_input_tokens",
] as const;
const OTEL_INPUT_TOKEN_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.usage.prompt_tokens",
] as const;

function firstIntAttr(spans: OtelSpan[], keys: readonly string[]): number | undefined {
  let sum: number | undefined;
  for (const s of spans) {
    for (const k of keys) {
      const v = getIntAttr(s, k);
      if (v !== undefined) sum = (sum ?? 0) + v;
    }
  }
  return sum;
}

/** The grounded cache shape surfaced on TraceMetadata (W18-cache). */
export interface OtelCacheUsage {
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  cacheStatus?: CacheStatus;
  cacheHitRate?: number;
}

/**
 * W18-cache: compute GROUNDED cache usage from OTel GenAI cache-token attributes
 * ONLY. If NO cache-read AND NO cache-creation attribute is present on any span →
 * cacheStatus = "unknown" (NEVER "uncached"); all token/rate fields undefined.
 * When cache attrs ARE present:
 *   cachedInputTokens   = Σ cache_read attrs
 *   cacheCreationTokens = Σ cache_creation attrs
 *   denominator         = input-token attr sum when present, else falls back to
 *                         (cacheRead + cacheCreation) so the rate stays grounded.
 *   cacheHitRate        = cachedInputTokens / denominator (0 when denominator 0)
 *   cacheStatus         = "hit" when cacheRead > 0 else grounded "miss".
 * Deterministic — no clock/random/LLM.
 */
export function computeOtelCacheTokens(spans: OtelSpan[]): OtelCacheUsage {
  const cacheRead = firstIntAttr(spans, OTEL_CACHE_READ_KEYS);
  const cacheCreation = firstIntAttr(spans, OTEL_CACHE_CREATION_KEYS);

  // CORE RULE: no cache attr present anywhere → UNKNOWN, never "uncached".
  if (cacheRead === undefined && cacheCreation === undefined) {
    return { cacheStatus: "unknown" };
  }

  const read = cacheRead ?? 0;
  const creation = cacheCreation ?? 0;
  const inputTotal = firstIntAttr(spans, OTEL_INPUT_TOKEN_KEYS);
  const denominator = inputTotal !== undefined ? inputTotal : read + creation;
  const cacheHitRate = denominator > 0 ? read / denominator : 0;
  const cacheStatus: CacheStatus = read > 0 ? "hit" : "miss";
  return {
    cachedInputTokens: read,
    cacheCreationTokens: creation,
    cacheStatus,
    cacheHitRate,
  };
}

function nanoToMs(nano?: string): number | undefined {
  if (!nano) return undefined;
  return Math.floor(Number(BigInt(nano) / BigInt(1_000_000)));
}

export function normalizeOtelTrace(spans: OtelSpan[]): TraceBody {
  if (spans.length === 0) {
    return {
      metadata: {
        traceId: "unknown",
        sessionId: "unknown",
        hasError: false,
        hasFeedback: false,
        sourcePlatform: "otel",
      },
      messages: [],
    };
  }

  // Root span = span without parentSpanId or the root of the tree
  const rootSpan =
    spans.find((s) => !s.parentSpanId) ?? spans[0];

  const hasError = spans.some((s) => s.status?.code === 2);
  const startNs = rootSpan.startTimeUnixNano;
  const endNs = rootSpan.endTimeUnixNano;
  const startMs = nanoToMs(startNs);
  const endMs = nanoToMs(endNs);

  // W18-cache: GROUNDED cache state from GenAI cache-token attrs ONLY (never inferred).
  const cache = computeOtelCacheTokens(spans);

  const metadata: TraceMetadata = {
    traceId: rootSpan.traceId,
    sessionId: getAttr(rootSpan, "session.id") ?? rootSpan.traceId,
    agentId:
      getAttr(rootSpan, "agent.id") ??
      getAttr(rootSpan, "gen_ai.agent.id") ??
      rootSpan.name,
    startTime: startMs ? new Date(startMs).toISOString() : undefined,
    endTime: endMs ? new Date(endMs).toISOString() : undefined,
    latencyMs:
      startMs !== undefined && endMs !== undefined
        ? endMs - startMs
        : undefined,
    hasError,
    hasFeedback: false,
    sourcePlatform: "otel",
    tags: getAttr(rootSpan, "tags")?.split(","),
    // W18-cache: grounded cache state (cacheStatus="unknown" when no cache attr)
    cachedInputTokens: cache.cachedInputTokens,
    cacheCreationTokens: cache.cacheCreationTokens,
    cacheStatus: cache.cacheStatus,
    cacheHitRate: cache.cacheHitRate,
  };

  const messages: TraceMessage[] = spans.map((span, index) => ({
    index,
    role: span.kind === 2 ? "user" : "assistant",
    content: span.name,
    toolName: getAttr(span, "gen_ai.operation.name"),
    isError: span.status?.code === 2,
    timestamp: span.startTimeUnixNano
      ? new Date(nanoToMs(span.startTimeUnixNano) ?? 0).toISOString()
      : undefined,
  }));

  return { metadata, messages };
}

// ── R1.7 — EntityContext extraction (DETERMINISTIC, NO LLM) ───────────────────

/** First model attribute across spans (gen_ai.request.model / gen_ai.response.model). */
function firstOtelModel(spans: OtelSpan[]): string | undefined {
  for (const s of spans) {
    const m =
      getAttr(s, "gen_ai.request.model") ??
      getAttr(s, "gen_ai.response.model") ??
      getAttr(s, "llm.model_name");
    if (m) return m;
  }
  return undefined;
}

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): extract an agent-typed EntityContext from a set
 * of OTel spans, ALONGSIDE the normalized TraceBody. Content-derived, deterministic.
 */
export function extractOtelEntityContext(spans: OtelSpan[]): EntityContext {
  const body = normalizeOtelTrace(spans);
  return buildAgentEntityContext([body], {
    source: "otel-export",
    fallbackName: body.metadata.agentId ?? "otel-agent",
    model: firstOtelModel(spans),
  });
}

// ── REQ-052: INTERNAL CLI transport ───────────────────────────────────────────
//
// REQ-052 (langfuse-mirroring transport for all 5 platforms): makes the
// deterministic OTel normalizer + EntityContext extractor RUNNABLE via
// scripts/cli/run.sh, so entity-context production no longer needs inline `bun -e`
// glue (banned by R-SELF-03-c). INTERNAL transport — no product CLI flag added.
//
//   run.sh scripts/normalize/platforms/otel.ts \
//     --in <spans.json> \
//     [--out-metadata <traces-metadata.json>] \
//     [--out-entity <entity-context.json>]
//
// --in is a JSON array of OTel spans for ONE trace (or a single span object).
// --out-metadata writes TraceMetadata[] (one entry); --out-entity writes the
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
      "Usage: run.sh scripts/normalize/platforms/otel.ts --in <spans.json> " +
        "[--out-metadata <path>] [--out-entity <path>]\n"
    );
    process.exit(1);
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(inPath), "utf8"));
    const spans = (Array.isArray(parsed) ? parsed : [parsed]) as OtelSpan[];

    if (outMetadataPath) {
      const body = normalizeOtelTrace(spans);
      writeFileSync(resolve(outMetadataPath), JSON.stringify([body.metadata], null, 2), "utf8");
      process.stdout.write(`TraceMetadata[] (1) written to: ${outMetadataPath}\n`);
    }
    if (outEntityPath) {
      const entity = extractOtelEntityContext(spans);
      writeFileSync(resolve(outEntityPath), JSON.stringify(entity, null, 2), "utf8");
      process.stdout.write(`EntityContext written to: ${outEntityPath}\n`);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
