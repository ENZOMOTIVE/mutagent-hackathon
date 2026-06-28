/**
 * scripts/awareness/llm-sample.ts
 * R2.2 — awareness-layer LLM mini-sample (REPIVOT; NO severity weights).
 * Type A — Pure Script (deterministic SELECTION + result structuring; clock injected).
 *
 * THE R2.2 INSIGHT (Wave-6 plan §4 R2.2): latency auto-wins as the "primary signal"
 * because Tier-0 can only MEASURE cheap signals — that is a MEASUREMENT problem,
 * not a scoring one. Re-weighting signals by severity (the abandoned scoring-bias
 * thread) treats the symptom. The fix is at the MEASUREMENT layer: fire a tiny 5-trace LLM
 * mini-sample BEFORE primary-signal selection to DISCOVER signals Tier-0 cannot see
 * (hallucination, handoff-loss, prompt-underspec…), then feed those into selection.
 *
 * THIS MODULE is the deterministic plumbing: it SELECTS which 5 traces the LLM
 * mini-sample reads (a spread across the population), and STRUCTURES the awareness
 * result into runMeta.awarenessSample. The LLM reasoning itself is performed by the
 * diagnostics-analyzer agent (host-native) — this module never calls an LLM.
 *
 * FIRE POLICY: the awareness sample fires on FRESH runs ONLY. When the class-memory
 * library already has priors for the entity (R2.3), the awareness layer is SKIPPED
 * (the priors already encode the discovered signals) and the Methodology renders a
 * placeholder. shouldFireAwareness() encodes this.
 *
 * CAP ACCOUNTING (R2.1): the 5 awareness traces COUNT against the deep-read caps —
 * they are not double-counted. The caller adds AWARENESS_SAMPLE_SIZE to tracesRead.
 */

import type { TraceMetadata } from "../normalize/trace.ts";

/** R2.2 — the awareness mini-sample reads exactly this many traces (~$0.50/run). */
export const AWARENESS_SAMPLE_SIZE = 5;

/**
 * Wave-17 Block B — expanded discovery first-pass size. The original 5-trace
 * mini-sample (AWARENESS_SAMPLE_SIZE) is too small to give the awareness layer
 * statistical power: with only 5 reads, a failure mode present in (say) 15% of
 * traces has a real chance of never appearing in the sample. A ~12-trace
 * first-pass meaningfully raises the odds of surfacing Tier-0-invisible signals
 * while staying cheap (~$1.20/run) and inside the deep-read cap (reconciled via
 * caps.ts:reconcileFirstPass). Callers can override the size param to tune this.
 */
export const AWARENESS_DISCOVERY_SIZE = 12;

// ── Wave-17 Block B: deterministic seeded PRNG for the random reserve ─────────
//
// The cascade ranking (below) ALWAYS reserves a random portion so that failures
// Tier-0 / objection-scan / feedback can't see still surface. "Random" here must
// be DETERMINISTIC: same corpus + same runId ⇒ same reserve, every run (no
// Date.now, no Math.random — those would make the sample non-reproducible and
// break byte-stable report tests). We derive the reserve from a seeded PRNG whose
// seed is hash(corpus + runId): the corpus key is the stable join of the sorted
// trace IDs (so it depends only on WHICH traces are in scope, not their order),
// and runId distinguishes successive runs over the same corpus so the reserve
// rotates across runs rather than re-picking the identical traces forever.

/** 32-bit FNV-1a hash of a string → unsigned int seed. Deterministic, no I/O. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis.
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // force unsigned 32-bit.
}

/**
 * mulberry32 — a tiny, well-distributed seeded PRNG. Given a 32-bit seed it yields
 * a deterministic stream of floats in [0, 1). Same seed ⇒ identical stream. Pure.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the stable corpus key for a population: the sorted, joined trace IDs.
 * Depends only on the SET of traces in scope (order-independent). Exported so the
 * seed derivation is testable + reusable by callers that pre-compute it.
 */
export function corpusKey(traces: TraceMetadata[]): string {
  return traces
    .map((t) => t.traceId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(""); // SOH separator — can't appear inside a normal trace ID.
}

/**
 * Derive the deterministic reserve seed from the corpus + runId. Exported so a
 * caller (or test) can reproduce the exact seed used for a given run.
 */
export function reserveSeed(traces: TraceMetadata[], runId: string): number {
  return fnv1a32(`${corpusKey(traces)}${runId}`); // STX separates corpus from runId.
}

/**
 * Deterministically shuffle `ids` using a mulberry32 stream seeded from
 * hash(corpus + runId). Same (corpus, runId) ⇒ same order. This is the engine
 * behind the cascade's random reserve: we shuffle the non-prioritized remainder
 * and take from the front. Fisher-Yates with the seeded PRNG. Pure.
 */
function seededShuffle(ids: string[], seed: number): string[] {
  const out = [...ids];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export interface AwarenessFirePolicyInput {
  /** R2.3 — reference into the class-memory library, when priors exist. */
  priorSignalsRef?: string;
}

export interface AwarenessFireDecision {
  /** True → fire the 5-trace LLM mini-sample. False → SKIP (priors exist). */
  fire: boolean;
  /** Why the decision was made (rendered in the placeholder when skipped). */
  reason: string;
}

/**
 * R2.2 fire policy: fire on FRESH runs only; SKIP when library priors exist.
 * Pure boolean logic.
 */
export function shouldFireAwareness(input: AwarenessFirePolicyInput): AwarenessFireDecision {
  if (input.priorSignalsRef && input.priorSignalsRef.trim().length > 0) {
    return {
      fire: false,
      reason: `Library priors exist (${input.priorSignalsRef}); awareness layer skipped (R2.2).`,
    };
  }
  return { fire: true, reason: "Fresh run — firing the 5-trace awareness mini-sample (R2.2)." };
}

/**
 * Deterministically SELECT the traces the awareness mini-sample reads. Uses an
 * even stride across the population (sorted by traceId for stability) so the 5
 * traces SPREAD across the run rather than clustering on the worst tail (the
 * point is to DISCOVER, not to confirm the already-loud signal). Returns up to
 * AWARENESS_SAMPLE_SIZE trace IDs.
 *
 * Pure + deterministic — NO random, NO clock.
 */
export function selectAwarenessTraces(
  traces: TraceMetadata[],
  size: number = AWARENESS_SAMPLE_SIZE
): string[] {
  if (traces.length === 0) return [];
  // Stable order by traceId so selection is deterministic regardless of input order.
  const sorted = [...traces].sort((a, b) => (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
  const n = sorted.length;
  const take = Math.min(size, n);
  if (take === n) return sorted.map((t) => t.traceId);
  const selected: string[] = [];
  // Even stride across [0, n): pick at fractional positions, floor to index.
  for (let i = 0; i < take; i++) {
    const idx = Math.floor((i * n) / take);
    selected.push(sorted[idx].traceId);
  }
  return selected;
}

// ── Wave-17 Block B: CASCADE selection (priority bands + random reserve) ──────
//
// selectAwarenessTraces (above) spreads evenly to DISCOVER. The cascade adds
// targeting: when we have cheap priority signals (operator feedback, objection
// cues, Tier-0 flags) we should LOOK THERE FIRST — but we must NOT let the loud
// signals consume the whole budget, or we only ever confirm what we can already
// see. So the cascade fills the sample from ranked bands in order, then ALWAYS
// reserves a deterministic-random portion so Tier-0-INVISIBLE failures surface:
//
//   Band 1  feedback/low-score   (operator-stated reality + low normalizedScore)
//   Band 2  objection-scan hit   (user objection cues — sampling priority)
//   Band 3  Tier-0-flagged       (hasError / hasFeedback — cheap measurable signal)
//   Band 4  random reserve       (seeded shuffle of the remainder — ALWAYS ≥ reserve)
//
// Two further invariants compose in:
//   - LEDGER SUBTRACTION: traces already deep-read in a prior run (injected
//     `isLedgered` predicate) are removed FIRST → the sample is MARGINAL reads only.
//   - DETERMINISM: the reserve is a seeded shuffle (hash(corpus+runId)); the whole
//     function has no clock + no Math.random → byte-stable across re-runs.

/** A low normalizedScore at/below this counts as a Band-1 "low-score" candidate. */
export const LOW_SCORE_THRESHOLD = 0.5;

export interface CascadeSelectionInput {
  /** The full population in scope (post-fetch, pre-ledger). */
  traces: TraceMetadata[];
  /** Stable run identifier — seeds the random reserve so it rotates across runs. */
  runId: string;
  /**
   * Trace IDs the objection scan flagged (scan/objection.ts → byTrace where hit).
   * Band 2 priority. Pass [] when the scan did not run.
   */
  objectionHitTraceIds?: string[];
  /**
   * LEDGER predicate (R2 clean boundary): returns true when a trace was already
   * deep-read in a prior run and must be EXCLUDED (marginal reads only). Injected
   * so this module stays pure/IO-free — the caller wires library/store.ts:
   * `(id) => isLedgered(entityName, id)`. Omit → nothing is subtracted.
   */
  isLedgered?: (traceId: string) => boolean; // eslint-disable-line no-unused-vars
  /** Total sample size to fill (default = expanded discovery size). */
  size?: number;
  /**
   * Minimum random-reserve slots that MUST come from Band 4 even when priority
   * bands could fill the whole sample. Guarantees Tier-0-invisible coverage.
   * Defaults to ~⅓ of `size` (floored, ≥1 when size ≥ 1).
   */
  minReserve?: number;
}

export interface CascadeSelectionResult {
  /** Final selected trace IDs (≤ size), in band order then reserve order. */
  selected: string[];
  /** Per-band attribution for the Methodology tab + tests (deterministic). */
  bands: {
    feedbackLowScore: string[];
    objection: string[];
    tier0: string[];
    randomReserve: string[];
  };
  /** Count removed by ledger subtraction (marginal-reads accounting). */
  ledgeredExcluded: number;
}

/** True when a trace carries a Band-1 feedback/low-score signal. */
function isFeedbackLowScore(t: TraceMetadata): boolean {
  if (t.hasFeedback) return true;
  return typeof t.normalizedScore === "number" && t.normalizedScore <= LOW_SCORE_THRESHOLD;
}

/** True when a trace carries a Band-3 Tier-0-measurable signal (cheap). */
function isTier0Flagged(t: TraceMetadata): boolean {
  if (t.hasError) return true;
  if ((t.skillBehaviorDeviationCount ?? 0) > 0) return true;
  if (Array.isArray(t.apiErrors) && t.apiErrors.length > 0) return true;
  return false;
}

/**
 * Wave-17 Block B — CASCADE awareness selection. Ledger-subtracts, ranks candidates
 * into priority bands, and ALWAYS includes a deterministic-random reserve so
 * Tier-0-invisible failures surface. Pure + deterministic (seed = hash(corpus+runId);
 * no clock, no Math.random). Returns the selection plus per-band attribution.
 */
export function selectAwarenessTracesCascade(input: CascadeSelectionInput): CascadeSelectionResult {
  const size = input.size ?? AWARENESS_DISCOVERY_SIZE;
  const emptyBands = { feedbackLowScore: [], objection: [], tier0: [], randomReserve: [] };
  if (size <= 0 || input.traces.length === 0) {
    return { selected: [], bands: { ...emptyBands }, ledgeredExcluded: 0 };
  }

  // 1. LEDGER SUBTRACTION (marginal reads only). Stable order by traceId so all
  //    downstream banding is deterministic regardless of input order.
  const sorted = [...input.traces].sort((a, b) =>
    a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0
  );
  const isLedgered = input.isLedgered ?? (() => false);
  const marginal = sorted.filter((t) => !isLedgered(t.traceId));
  const ledgeredExcluded = sorted.length - marginal.length;
  if (marginal.length === 0) {
    return { selected: [], bands: { ...emptyBands }, ledgeredExcluded };
  }

  // 2. RESERVE accounting: how many slots are GUARANTEED to Band 4.
  const reserveDefault = Math.max(size >= 1 ? 1 : 0, Math.floor(size / 3));
  const minReserve = Math.min(
    size,
    Math.max(0, input.minReserve ?? reserveDefault)
  );
  const prioritySlots = size - minReserve;

  const objectionHits = new Set(input.objectionHitTraceIds ?? []);
  const selected = new Set<string>();
  const bands = {
    feedbackLowScore: [] as string[],
    objection: [] as string[],
    tier0: [] as string[],
    randomReserve: [] as string[],
  };

  // 3. Fill PRIORITY bands in cascade order, never exceeding prioritySlots. Each
  //    trace lands in the FIRST band it qualifies for (no double-count).
  const tryAddPriority = (id: string, band: keyof typeof bands): void => {
    if (selected.size >= prioritySlots) return;
    if (selected.has(id)) return;
    selected.add(id);
    bands[band].push(id);
  };

  for (const t of marginal) {
    if (selected.size >= prioritySlots) break;
    if (isFeedbackLowScore(t)) tryAddPriority(t.traceId, "feedbackLowScore");
  }
  for (const t of marginal) {
    if (selected.size >= prioritySlots) break;
    if (objectionHits.has(t.traceId)) tryAddPriority(t.traceId, "objection");
  }
  for (const t of marginal) {
    if (selected.size >= prioritySlots) break;
    if (isTier0Flagged(t)) tryAddPriority(t.traceId, "tier0");
  }

  // 4. RANDOM RESERVE: seeded-shuffle the not-yet-selected marginal remainder and
  //    take from the front until the sample is full. Seed = hash(corpus + runId)
  //    over the FULL marginal set so the reserve is stable + reproducible.
  const seed = reserveSeed(marginal, input.runId);
  const remainder = marginal.map((t) => t.traceId).filter((id) => !selected.has(id));
  const shuffled = seededShuffle(remainder, seed);
  for (const id of shuffled) {
    if (selected.size >= size) break;
    selected.add(id);
    bands.randomReserve.push(id);
  }

  return { selected: Array.from(selected), bands, ledgeredExcluded };
}

export interface AwarenessSample {
  /** Trace IDs the LLM mini-sample read. */
  traces: string[];
  /** Signal/finding labels the LLM surfaced (free-form, agent-supplied). */
  findings: string[];
  /** ISO8601 timestamp the sample fired (INJECTED — deterministic in tests). */
  firedAt: string;
}

/**
 * Structure an awareness result into runMeta.awarenessSample. The `findings` come
 * from the analyzer agent's LLM pass; this function just packages them with the
 * selected traces + an INJECTED timestamp. Pure.
 */
export function buildAwarenessSample(
  selectedTraces: string[],
  discoveredSignals: string[],
  firedAtIso: string
): AwarenessSample {
  return {
    traces: selectedTraces,
    findings: discoveredSignals,
    firedAt: firedAtIso,
  };
}

// ── PRD-MP-08: feedback-source-aware trace selection ─────────────────────────

import type { FeedbackSource } from "../normalize/trace.ts";

/**
 * PRD-MP-08 (R2.2): When Finding.feedbackSources[] is populated, the awareness
 * mini-sample PRIORITIZES traces referenced by feedback content — grounding the
 * awareness layer in operator-stated reality rather than purely random worst-sampling.
 *
 * Extraction strategy:
 *   - trace-score sources: prefer traces whose traceId matches a score's traceId
 *   - chat sources: prefer traces whose agentId/tags match keywords in chat body
 *   - Falls back to current selectAwarenessTraces() when no traces match feedback
 *
 * Returns up to `size` trace IDs: feedback-referenced traces first, then gap-filled
 * from the even-stride fallback. Deterministic (no clock, no random).
 */
export function selectAwarenessTracesWithFeedback(
  traces: TraceMetadata[],
  feedbackSources: FeedbackSource[],
  size: number = AWARENESS_SAMPLE_SIZE
): string[] {
  if (feedbackSources.length === 0) {
    // No feedback sources → use existing deterministic selection
    return selectAwarenessTraces(traces, size);
  }

  // 1+2. Feedback-referenced traces first (trace-score IDs, then chat keyword hits).
  const selected = new Set<string>(feedbackReferencedTraceIds(traces, feedbackSources, size));

  // 3. Gap-fill from even-stride selection to reach `size`
  if (selected.size < size) {
    const fallback = selectAwarenessTraces(traces, size);
    for (const id of fallback) {
      if (selected.size >= size) break;
      selected.add(id);
    }
  }

  return Array.from(selected).slice(0, size);
}

/**
 * Resolve the trace IDs a feedback set EXPLICITLY references, in priority order:
 * trace-score `traceId` matches first, then chat-body keyword hits against each
 * trace's agentId + tags. Returns at most `cap` IDs (deduped, first-seen order).
 * Pure + deterministic — extracted so both the legacy gap-fill path and the
 * Block-B cascade share one feedback-resolution definition (DRY).
 */
export function feedbackReferencedTraceIds(
  traces: TraceMetadata[],
  feedbackSources: FeedbackSource[],
  cap: number = AWARENESS_DISCOVERY_SIZE
): string[] {
  const out = new Set<string>();

  // trace-score sources: direct traceId references.
  for (const src of feedbackSources) {
    if (out.size >= cap) break;
    if (src.sourceType !== "trace-score" || !src.traceId) continue;
    const match = traces.find((t) => t.traceId === src.traceId);
    if (match) out.add(match.traceId);
  }

  // chat sources: keyword-match agentId + tags against the feedback body.
  for (const src of feedbackSources) {
    if (out.size >= cap) break;
    if (src.sourceType !== "chat") continue;
    const keywords = src.body
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 10);
    for (const t of traces) {
      if (out.size >= cap) break;
      const surface = [t.agentId ?? "", ...(t.tags ?? [])].join(" ").toLowerCase();
      if (keywords.some((kw) => surface.includes(kw))) out.add(t.traceId);
    }
  }

  return Array.from(out).slice(0, cap);
}

/**
 * Wave-17 Block B — feedback-aware CASCADE selection. Composes the cascade
 * (ledger-subtract → priority bands → seeded random reserve) with PRD-MP-08
 * feedback grounding: traces the feedback set explicitly references are forced
 * to the TOP of Band 1 (feedback/low-score) before the rest of the cascade runs,
 * so operator-stated reality outranks every cheaper heuristic — while the random
 * reserve still guarantees Tier-0-invisible coverage. Pure + deterministic.
 *
 * Mechanism: feedback-referenced IDs are pre-marked; the underlying cascade then
 * banding/reserve-fills the remainder. Because ledger subtraction runs inside the
 * cascade, a feedback-referenced trace that was ALREADY deep-read is dropped too
 * (marginal reads only) — feedback does not override the ledger.
 */
export function selectAwarenessTracesWithFeedbackCascade(
  input: CascadeSelectionInput & { feedbackSources: FeedbackSource[] }
): CascadeSelectionResult {
  const size = input.size ?? AWARENESS_DISCOVERY_SIZE;
  const referenced = new Set(
    feedbackReferencedTraceIds(input.traces, input.feedbackSources, size)
  );

  // Synthesize hasFeedback on referenced traces so the cascade's Band 1 picks them
  // up FIRST (and reorders them to the front of the marginal scan). We do NOT mutate
  // the caller's objects — shallow-copy only the referenced ones.
  const traces = input.traces.map((t) =>
    referenced.has(t.traceId) && !t.hasFeedback ? { ...t, hasFeedback: true } : t
  );

  return selectAwarenessTracesCascade({ ...input, traces, size });
}

// ── SO-05 CLI entrypoint ──────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const metadataPath = get("--metadata");
  if (!metadataPath) {
    process.stderr.write(
      "Usage: bun scripts/awareness/llm-sample.ts --metadata <traces-metadata.json> [--output <file>] " +
        "[--priors-ref <ref>] [--run-id <id>] [--entity <name>] [--size <n>]\n" +
        "  --run-id enables the Block-B cascade (expanded discovery + seeded random reserve).\n" +
        "  --entity additionally ledger-subtracts already-deep-read traces (marginal reads only).\n"
    );
    process.exit(1);
  }

  const { readFileSync, writeFileSync } = await import("fs");

  let traces: TraceMetadata[];
  try {
    traces = JSON.parse(readFileSync(metadataPath, "utf8")) as TraceMetadata[];
  } catch (err) {
    process.stderr.write(`Failed to read metadata: ${err}\n`);
    process.exit(1);
  }

  const priorsRef = get("--priors-ref");
  const decision = shouldFireAwareness({ priorSignalsRef: priorsRef });
  const firedAt = new Date().toISOString();

  const runId = get("--run-id");
  const entity = get("--entity");
  const sizeArg = get("--size");
  const size = sizeArg !== undefined && !Number.isNaN(Number(sizeArg)) ? Number(sizeArg) : undefined;

  let selectedTraces: string[] = [];
  let cascadeResult: CascadeSelectionResult | undefined;
  if (decision.fire) {
    if (runId) {
      // Block-B cascade path. Ledger-subtract when an entity is named (wires
      // library/store.ts:isLedgered → marginal reads only).
      const { isLedgered } = await import("../library/store.ts");
      cascadeResult = selectAwarenessTracesCascade({
        traces,
        runId,
        size,
        isLedgered: entity ? (id: string) => isLedgered(entity, id) : undefined,
      });
      selectedTraces = cascadeResult.selected;
    } else {
      // Legacy even-stride path (backward-compatible default).
      selectedTraces = selectAwarenessTraces(traces, size);
    }
  }

  const result = {
    decision,
    selectedTraces,
    firedAt,
    sampleSize: runId ? (size ?? AWARENESS_DISCOVERY_SIZE) : AWARENESS_SAMPLE_SIZE,
    cascade: cascadeResult
      ? { bands: cascadeResult.bands, ledgeredExcluded: cascadeResult.ledgeredExcluded }
      : undefined,
  };

  const out = JSON.stringify(result, null, 2);
  const outputPath = get("--output");
  if (outputPath) {
    writeFileSync(outputPath, out, "utf8");
    process.stderr.write(`Awareness sample written to ${outputPath}\n`);
  } else {
    process.stdout.write(out + "\n");
  }
  process.exit(0);
}
