/**
 * scripts/load-traces.ts — NDJSON trace loader (dogfood input adapter).
 * ---------------------------------------------------------------------------
 * Maps raw Langfuse-style records → the in-package EvalTrace shape. The sample
 * export is a stream of JSON records; the dogfood CLI normalizes it to compact
 * NDJSON (gunzip -c FILE | jq -c '.') before this PURE parser maps each line.
 *
 * Tolerant by design (a multi-GB export must not abort on one bad line):
 * malformed lines are SKIPPED and COUNTED (the count is surfaced, never
 * swallowed). PURE + deterministic.
 */
import type { EvalTrace, TraceObservation } from "./contracts/eval-types.ts";

function asObservations(raw: unknown): TraceObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const obj = (o ?? {}) as Record<string, unknown>;
    return {
      type: typeof obj.type === "string" ? obj.type : "UNKNOWN",
      ...(typeof obj.name === "string" ? { name: obj.name } : {}),
      ...(obj.output !== undefined ? { output: obj.output } : {}),
      ...(obj.input !== undefined ? { input: obj.input } : {}),
    };
  });
}

/**
 * Derive a prompt string from a structured input GENERICALLY — tolerating ≥2
 * coexisting prompt-template shapes (SV-1). Handles the two common LLM shapes
 * without hard-coding any subject/template literal:
 *   - `{ prompt: "…" }`         → the prompt verbatim
 *   - `{ messages: [{role,content},…] }` → the LAST message's text content
 * Returns undefined when no prompt text can be derived (caller leaves it unset).
 */
function derivePromptText(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.prompt === "string") return obj.prompt;
  if (Array.isArray(obj.messages) && obj.messages.length > 0) {
    for (let i = obj.messages.length - 1; i >= 0; i--) {
      const m = obj.messages[i] as Record<string, unknown> | null;
      const content = m?.content;
      if (typeof content === "string" && content.length > 0) return content;
    }
  }
  return undefined;
}

/**
 * Normalize the `input` field: a bare string is wrapped to { prompt }. A
 * structured input is preserved verbatim AND, when it carries no top-level
 * `prompt`, a `prompt` is derived generically from a known template shape (SV-1:
 * ≥2 templates coexist) so downstream consumers always find `input.prompt`.
 */
function asInput(raw: unknown): EvalTrace["input"] {
  if (typeof raw === "string") return { prompt: raw };
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.prompt !== "string") {
      const derived = derivePromptText(obj);
      if (derived !== undefined) return { ...obj, prompt: derived } as EvalTrace["input"];
    }
    return obj as EvalTrace["input"];
  }
  return undefined;
}

/**
 * SV-1: production traces routinely carry a null/absent trace-level `.output` —
 * the real output lives in the GENERATION observation. Read the FIRST GENERATION
 * observation's output (case-insensitive type match) and normalize it to the
 * EvalTrace output shape: a bare string is wrapped to { response }, an object is
 * passed through. GENERIC — no client field/template literal. Returns undefined
 * when no GENERATION output is present.
 */
function deriveOutputFromObservations(
  observations: TraceObservation[],
): EvalTrace["output"] | undefined {
  for (const o of observations) {
    if (typeof o.type === "string" && o.type.toUpperCase() === "GENERATION") {
      const out = o.output;
      if (typeof out === "string") return { response: out };
      if (out !== null && typeof out === "object") return out as EvalTrace["output"];
    }
  }
  return undefined;
}

/** Map one raw Langfuse record → EvalTrace. Tolerant of missing fields. */
export function mapRecord(raw: Record<string, unknown>): EvalTrace {
  const out: EvalTrace = {
    id: typeof raw.id === "string" ? raw.id : String(raw.id ?? ""),
    observations: asObservations(raw.observations),
  };
  if (typeof raw.name === "string") out.name = raw.name;
  const input = asInput(raw.input);
  if (input !== undefined) out.input = input;
  if (raw.output !== null && typeof raw.output === "object") {
    out.output = raw.output as EvalTrace["output"];
  } else {
    // SV-1: trace-level output is null/absent → fall back to the GENERATION obs.
    const derived = deriveOutputFromObservations(out.observations);
    if (derived !== undefined) out.output = derived;
  }
  if (Array.isArray(raw.scores)) out.scores = raw.scores;
  if (Array.isArray(raw.tags)) out.tags = raw.tags.filter((t): t is string => typeof t === "string");
  if (typeof raw.latencyMs === "number") out.latencyMs = raw.latencyMs;
  else if (typeof raw.latency === "number") out.latencyMs = raw.latency;
  if (typeof raw.costUsd === "number") out.costUsd = raw.costUsd;
  else if (typeof raw.totalCost === "number") out.costUsd = raw.totalCost;
  return out;
}

export interface ParsedTraces {
  traces: EvalTrace[];
  /** count of lines that failed to parse (surfaced, never swallowed). */
  skipped: number;
}

/** Parse compact NDJSON (one JSON record per line) → EvalTrace[]. PURE. */
export function parseNdjsonTraces(text: string): ParsedTraces {
  const traces: EvalTrace[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      traces.push(mapRecord(rec));
    } catch {
      skipped += 1;
    }
  }
  return { traces, skipped };
}
