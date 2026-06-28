/**
 * scripts/scan/trajectory.ts
 * BLOCK D1 — Mechanical tool-call TRAJECTORY scan.
 * Type A — Pure Script (deterministic sequence analysis, NO LLM, no I/O).
 *
 * This module is the MECHANICAL corroboration layer that makes the evidence
 * floor real. It reads ONLY a trace's tool-call / tool-result message sequence
 * and detects structural patterns deterministically — no clock, no random, no
 * model reasoning. The same trace in always yields a byte-identical result out.
 *
 * R1 (evidence floor): a signal discovered by the LLM analyzer (Block C) may be
 * promoted to PRIMARY only if it is mechanically corroborated here. The
 * `corroborations[]` array is exactly what Block C's floor consumes — each entry
 * pairs a signal with an `evidenceRef` pointing at the concrete trace span(s).
 *
 * R4 (pattern→signal map, LOCKED — do not reorder/rename without a wave gate):
 *   retry-loop     → loop/latency      (same tool repeated after failure / identical args)
 *   tool-error     → tool-misuse       (a tool-result carrying an error / exception)
 *   abandoned-call → handoff-loss      (a tool-call with no matching result)
 *   oscillation    → prompt-underspec  (A→B→A→B tool alternation)
 *
 * Input shape: the canonical TraceBody / TraceMessage from
 * scripts/normalize/trace.ts. Tool activity is carried two ways across platforms:
 *   (a) INLINE   — one message carries toolName + toolArgs + toolResult + isError
 *                  together (claude-code / local-jsonl normalizers).
 *   (b) SPLIT    — a tool-call message (role assistant/tool, toolName, toolArgs)
 *                  is followed by a separate tool-result message (role "tool",
 *                  toolResult / isError) (langfuse / otel-style normalizers).
 * Both shapes are handled by extracting a flat, ordered list of tool EVENTS,
 * each annotated with whether a result was observed and whether it errored.
 */

import type { TraceBody, TraceMessage } from "../normalize/trace.ts";
import { canonicalToolName } from "../normalize/platforms/entity-context.ts";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * The four mechanically-detectable trajectory pattern kinds (R4 keys).
 * `as const` object instead of a string-enum per coding-rules (no magic strings).
 * The const value object and its type alias use distinct names (SCREAMING_SNAKE
 * value, PascalCase type) so the core `no-redeclare` lint rule is satisfied.
 */
export const TRAJECTORY_PATTERN_KIND = {
  RetryLoop: "retry-loop",
  ToolError: "tool-error",
  AbandonedCall: "abandoned-call",
  Oscillation: "oscillation",
} as const;

export type TrajectoryPatternKind =
  (typeof TRAJECTORY_PATTERN_KIND)[keyof typeof TRAJECTORY_PATTERN_KIND];

/**
 * The signal a corroborated pattern maps to (R4 values). These are deliberately
 * coarse signal labels (NOT WhyCategory) — Block C maps them onto its own
 * taxonomy. `retry-loop` corroborates either a loop OR a latency signal, so its
 * value is the compound "loop/latency".
 */
export const TRAJECTORY_SIGNAL = {
  LoopLatency: "loop/latency",
  ToolMisuse: "tool-misuse",
  HandoffLoss: "handoff-loss",
  PromptUnderspec: "prompt-underspec",
} as const;

export type TrajectorySignal =
  (typeof TRAJECTORY_SIGNAL)[keyof typeof TRAJECTORY_SIGNAL];

/**
 * R4 LOCKED pattern→signal map. Single source of truth, exported so Block C can
 * wire its evidence floor against the exact same mapping (no drift).
 */
export const PATTERN_SIGNAL_MAP: Readonly<
  Record<TrajectoryPatternKind, TrajectorySignal>
> = {
  [TRAJECTORY_PATTERN_KIND.RetryLoop]: TRAJECTORY_SIGNAL.LoopLatency,
  [TRAJECTORY_PATTERN_KIND.ToolError]: TRAJECTORY_SIGNAL.ToolMisuse,
  [TRAJECTORY_PATTERN_KIND.AbandonedCall]: TRAJECTORY_SIGNAL.HandoffLoss,
  [TRAJECTORY_PATTERN_KIND.Oscillation]: TRAJECTORY_SIGNAL.PromptUnderspec,
} as const;

/**
 * One mechanically-detected trajectory pattern.
 * `spanRefs` are message-index pointers (`msg[i]`) into TraceBody.messages — the
 * concrete spans that evidence this pattern. `evidenceRef` is a single
 * human/grep-friendly string assembled from those spans + the trace id.
 */
export interface TrajectoryPattern {
  /** The pattern kind (R4 key). */
  kind: TrajectoryPatternKind;
  /** Canonical tool name(s) involved (deterministic ordering). */
  tools: string[];
  /** Message indices in TraceBody.messages that evidence this pattern. */
  spanRefs: number[];
  /** Pre-assembled evidence reference string pointing at the trace span(s). */
  evidenceRef: string;
  /** Plain-words narration of the mechanical event (deterministic, no LLM). */
  detail: string;
}

/**
 * A mechanical corroboration: a signal + the concrete trace span(s) that
 * evidence it. This is the R1 floor surface Block C consumes — a discovered
 * signal becomes PRIMARY only if it appears here.
 */
export interface TrajectoryCorroboration {
  signal: TrajectorySignal;
  evidenceRef: string;
}

export interface TrajectoryResult {
  patterns: TrajectoryPattern[];
  corroborations: TrajectoryCorroboration[];
}

// ── Internal: flattened tool-event model ─────────────────────────────────────

/**
 * A normalized tool EVENT extracted from one-or-two raw messages. Abstracts over
 * the INLINE vs SPLIT message shapes so the pattern detectors operate on a single
 * uniform sequence.
 */
interface ToolEvent {
  /** Canonical (tool.-stripped, camelCased) tool name. */
  tool: string;
  /** Raw tool args string, if any (used for identical-args retry detection). */
  args?: string;
  /** True when a tool-result (inline or split) was observed for this call. */
  hasResult: boolean;
  /** True when the observed result was an error / exception. */
  isError: boolean;
  /** Index of the originating tool-call message in TraceBody.messages. */
  callIndex: number;
  /** Index of the result message (split shape); equals callIndex for inline. */
  resultIndex?: number;
}

/**
 * A message "looks like" a tool-call when it carries a resolvable toolName.
 * Mirrors the entity-context aggregation rule so call-detection is consistent
 * across the skill (tool.send_message / send_message / sendMessage collapse).
 */
function isToolCallMessage(m: TraceMessage): boolean {
  return typeof m.toolName === "string" && m.toolName.length > 0;
}

/**
 * A message is a SPLIT tool-result when it carries result/error payload but no
 * toolName of its own (i.e. it belongs to the preceding tool-call).
 */
function isSplitResultMessage(m: TraceMessage): boolean {
  if (isToolCallMessage(m)) return false;
  return (
    m.role === "tool" ||
    m.toolResult !== undefined ||
    m.isError !== undefined
  );
}

/**
 * Flatten TraceBody.messages into an ordered list of ToolEvents.
 *
 * Handles both message shapes:
 *   - INLINE: a tool-call message that ALSO carries toolResult/isError is its own
 *     result. (claude-code / local-jsonl)
 *   - SPLIT:  a tool-call message with NO inline result; the immediately-following
 *     split-result message (role "tool" / toolResult / isError) supplies the
 *     result. (langfuse / otel-style)
 * A tool-call with neither inline nor a following split result = abandoned.
 */
function extractToolEvents(messages: TraceMessage[]): ToolEvent[] {
  const events: ToolEvent[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isToolCallMessage(m)) continue;

    const tool = canonicalToolName(m.toolName as string);

    // INLINE result: the call message itself carries result/error payload.
    const hasInlineResult = m.toolResult !== undefined || m.isError === true;
    if (hasInlineResult) {
      events.push({
        tool,
        args: m.toolArgs,
        hasResult: true,
        isError: m.isError === true,
        callIndex: m.index,
        resultIndex: m.index,
      });
      continue;
    }

    // SPLIT result: look at the immediately following message only. A result
    // that belongs to THIS call must directly follow it (deterministic, no
    // searching ahead past intervening calls — that would mis-pair).
    const next = messages[i + 1];
    if (next && isSplitResultMessage(next)) {
      events.push({
        tool,
        args: m.toolArgs,
        hasResult: true,
        isError: next.isError === true,
        callIndex: m.index,
        resultIndex: next.index,
      });
      continue;
    }

    // No inline result and no following split result → abandoned call.
    events.push({
      tool,
      args: m.toolArgs,
      hasResult: false,
      isError: false,
      callIndex: m.index,
    });
  }
  return events;
}

// ── Pattern detectors ────────────────────────────────────────────────────────

/**
 * tool-error → tool-misuse.
 * Each tool EVENT whose observed result errored yields one tool-error pattern.
 */
function detectToolErrors(
  events: ToolEvent[],
  traceId: string
): TrajectoryPattern[] {
  const out: TrajectoryPattern[] = [];
  for (const e of events) {
    if (!e.isError) continue;
    const spanRefs =
      e.resultIndex !== undefined && e.resultIndex !== e.callIndex
        ? [e.callIndex, e.resultIndex]
        : [e.callIndex];
    out.push({
      kind: TRAJECTORY_PATTERN_KIND.ToolError,
      tools: [e.tool],
      spanRefs,
      evidenceRef: makeEvidenceRef(traceId, spanRefs),
      detail: `tool "${e.tool}" returned an error result`,
    });
  }
  return out;
}

/**
 * abandoned-call → handoff-loss.
 * Each tool-call EVENT with no observed result yields one abandoned-call pattern.
 */
function detectAbandonedCalls(
  events: ToolEvent[],
  traceId: string
): TrajectoryPattern[] {
  const out: TrajectoryPattern[] = [];
  for (const e of events) {
    if (e.hasResult) continue;
    const spanRefs = [e.callIndex];
    out.push({
      kind: TRAJECTORY_PATTERN_KIND.AbandonedCall,
      tools: [e.tool],
      spanRefs,
      evidenceRef: makeEvidenceRef(traceId, spanRefs),
      detail: `tool "${e.tool}" was called with no matching result`,
    });
  }
  return out;
}

/**
 * retry-loop → loop/latency.
 * A retry-loop is the SAME canonical tool invoked again where the prior
 * invocation either (a) errored, or (b) was called with identical args. Each
 * maximal run of ≥2 such consecutive same-tool invocations yields ONE pattern
 * spanning every call in the run (deterministic grouping; no double-emit).
 */
function detectRetryLoops(
  events: ToolEvent[],
  traceId: string
): TrajectoryPattern[] {
  const out: TrajectoryPattern[] = [];
  let i = 0;
  while (i < events.length) {
    const run: ToolEvent[] = [events[i]];
    let j = i + 1;
    while (j < events.length && events[j].tool === events[i].tool) {
      const prev = events[j - 1];
      const cur = events[j];
      // A continuation qualifies as a retry when the PREVIOUS same-tool call
      // errored, OR the args are byte-identical (a re-issue of the same call).
      const isRetry =
        prev.isError ||
        (prev.args !== undefined && prev.args === cur.args);
      if (!isRetry) break;
      run.push(cur);
      j++;
    }
    if (run.length >= 2) {
      const spanRefs = run.map((e) => e.callIndex);
      out.push({
        kind: TRAJECTORY_PATTERN_KIND.RetryLoop,
        tools: [events[i].tool],
        spanRefs,
        evidenceRef: makeEvidenceRef(traceId, spanRefs),
        detail: `tool "${events[i].tool}" was retried ${run.length - 1} time(s) after failure or with identical args`,
      });
      i = j; // skip past the consumed run — no overlapping detections
    } else {
      i++;
    }
  }
  return out;
}

/**
 * oscillation → prompt-underspec.
 * An A→B→A→B alternation between exactly two distinct tools (no third tool
 * interleaved) of length ≥4. Each maximal alternating run yields ONE pattern.
 * Detected on the call sequence regardless of result/error state.
 */
function detectOscillations(
  events: ToolEvent[],
  traceId: string
): TrajectoryPattern[] {
  const out: TrajectoryPattern[] = [];
  const seq = events.map((e) => e.tool);
  let i = 0;
  while (i < seq.length) {
    // An oscillation needs two distinct tools at positions i, i+1.
    if (i + 1 >= seq.length || seq[i] === seq[i + 1]) {
      i++;
      continue;
    }
    const a = seq[i];
    const b = seq[i + 1];
    // Extend while the strict A,B,A,B,… alternation holds.
    let j = i + 2;
    while (j < seq.length && seq[j] === (((j - i) % 2 === 0) ? a : b)) {
      j++;
    }
    const runLen = j - i;
    if (runLen >= 4) {
      const spanRefs = events.slice(i, j).map((e) => e.callIndex);
      out.push({
        kind: TRAJECTORY_PATTERN_KIND.Oscillation,
        tools: [a, b],
        spanRefs,
        evidenceRef: makeEvidenceRef(traceId, spanRefs),
        detail: `tools "${a}" and "${b}" alternated ${runLen} times (A→B→A→B)`,
      });
      i = j; // consume the alternating run
    } else {
      i++;
    }
  }
  return out;
}

// ── Evidence-ref assembly ────────────────────────────────────────────────────

/**
 * Build a deterministic, grep-friendly evidence pointer at the form
 *   `trace:<traceId>#msg[i,j,...]`
 * into TraceBody.messages. This is the concrete span pointer Block C's floor
 * consumes — no clock, no random, pure function of inputs.
 */
function makeEvidenceRef(traceId: string, spanRefs: number[]): string {
  return `trace:${traceId}#msg[${spanRefs.join(",")}]`;
}

// ── Public entrypoint ────────────────────────────────────────────────────────

/**
 * Mechanically analyze a single trace's tool-call trajectory.
 *
 * DETERMINISTIC: pure function of `trace`. No clock, no random, no I/O, no LLM.
 * Patterns are emitted in a stable order: retry-loop, tool-error, abandoned-call,
 * oscillation (R4 map order), each internally ordered by first span index.
 *
 * Every detected pattern produces exactly one corroboration via the LOCKED
 * PATTERN_SIGNAL_MAP — this is the R1 evidence floor Block C wires against.
 */
export function analyzeTrajectory(trace: TraceBody): TrajectoryResult {
  const traceId = trace.metadata.traceId;
  const events = extractToolEvents(trace.messages);

  // R4 map order: retry-loop, tool-error, abandoned-call, oscillation.
  const patterns: TrajectoryPattern[] = [
    ...detectRetryLoops(events, traceId),
    ...detectToolErrors(events, traceId),
    ...detectAbandonedCalls(events, traceId),
    ...detectOscillations(events, traceId),
  ];

  const corroborations: TrajectoryCorroboration[] = patterns.map((p) => ({
    signal: PATTERN_SIGNAL_MAP[p.kind],
    evidenceRef: p.evidenceRef,
  }));

  return { patterns, corroborations };
}

/**
 * W17-WIRING — analyze MANY traces and return the FLAT, deduped corroboration set.
 *
 * This is the orchestrator-facing aggregator the CLI below stamps to JSON. It runs
 * analyzeTrajectory() over each sampled trace body (deterministic input order) and
 * concatenates the per-trace corroborations. Because each `evidenceRef` encodes the
 * originating `traceId` + span indices (see makeEvidenceRef), corroborations from
 * DIFFERENT traces never collide; the dedupe only collapses byte-identical
 * (signal, evidenceRef) pairs, which can only arise from re-processing the same body.
 *
 * DETERMINISTIC: pure function of `traces`. No clock, no random, no I/O. The same
 * ordered bodies in always yield a byte-identical corroborations array out — exactly
 * what Block C's evidence floor consumes via SignalCensusContext.corroborations.
 */
export function corroborationsForTraces(
  traces: ReadonlyArray<TraceBody>
): TrajectoryCorroboration[] {
  const out: TrajectoryCorroboration[] = [];
  const seen = new Set<string>();
  for (const trace of traces) {
    for (const c of analyzeTrajectory(trace).corroborations) {
      const key = `${c.signal} ${c.evidenceRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// ── CLI entrypoint (W17-WIRING) ──────────────────────────────────────────────
//
// INTERNAL transport (run.sh / bun only — NOT the product `mutagent` CLI). The
// orchestrator runs this at Step 6.5 to make trajectory corroborations COMPUTABLE
// without hand-rolled inline reasoning: it reads the sampled deep-read trace bodies
// and emits the flat corroboration set the enricher's SignalCensusContext consumes.
//
//   bun scripts/scan/trajectory.ts --bodies <traceBodies.json> [--out <corroborations.json>]
//
// `--bodies` is a JSON file containing EITHER a single TraceBody or a TraceBody[].
// Output is a TrajectoryCorroboration[] written to --out (or stdout when --out is
// absent). Deterministic — no clock, no random, no network, no LLM.
//
// Safe-by-default contract: an empty bodies array yields `[]`, which threads through
// to an empty SignalCensusContext.corroborations → discovered signals stay
// suspected-unconfirmed (never silently crowned).
if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const bodiesPath = get("--bodies");
  const outPath = get("--out");

  if (!bodiesPath) {
    process.stderr.write(
      "Usage: bun scripts/scan/trajectory.ts --bodies <traceBodies.json> [--out <corroborations.json>]\n"
    );
    process.exit(1);
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(bodiesPath), "utf8"));
    // Accept a single TraceBody OR a TraceBody[] (orchestrator may pass either shape).
    const traces = (Array.isArray(parsed) ? parsed : [parsed]) as TraceBody[];
    const corroborations = corroborationsForTraces(traces);
    const json = JSON.stringify(corroborations, null, 2);
    if (outPath) {
      writeFileSync(resolve(outPath), json, "utf8");
      process.stdout.write(`Corroborations written to: ${outPath}\n`);
    } else {
      process.stdout.write(`${json}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
