/**
 * scripts/scan/objection.ts
 * No-LLM OBJECTION / SENTIMENT static scan — Wave-17 Block A.
 * Type A — Pure Script (deterministic; no LLM, no clock, no random, no I/O).
 *
 * WHAT THIS IS
 * ------------
 * A deterministic substring scanner that flags trace messages carrying user
 * OBJECTION / dissatisfaction / correction / refusal cues. It exists to provide
 * a cheap, free (pre-LLM) signal for two downstream uses ONLY:
 *
 *   1. SAMPLING PRIORITY — traces with an objection cue are worth a closer
 *      (LLM / deep-read) look before unflagged traces.
 *   2. A CORROBORATING HINT — a hit can support a finding that a deep-read has
 *      already surfaced on independent evidence.
 *
 * WHAT THIS IS NOT
 * ----------------
 * `objectionRate` is **NOT** a first-class census signal. It is a heuristic with
 * a known, non-trivial false-positive surface (see HEURISTIC RISK below). It MUST
 * NOT be emitted as a primary-eligible signal on its own. A deep-read must
 * independently confirm an objection before any finding treats it as real. Treat
 * the output as "where to look", never "what is wrong".
 *
 * HEURISTIC RISK (documented false positives, intentionally not "fixed")
 * ---------------------------------------------------------------------
 *   - NEGATION: "no problem", "that's not wrong at all", "I can't thank you
 *     enough" contain cue substrings but invert the sentiment. We do NOT attempt
 *     negation parsing — that needs an LLM and would break determinism.
 *   - POLITE FILLER: "no worries", "not a big deal" read as cues but are benign.
 *   - NON-ENGLISH: cues are English-only; non-English dissatisfaction is missed
 *     (false negative) and English cue substrings inside other-language words may
 *     false-positive.
 *   - QUOTED / META text: a user pasting an error message ("it said 'incorrect'")
 *     trips a cue without expressing dissatisfaction.
 * Because of these, the scan is advisory only — see WHAT THIS IS NOT above.
 *
 * DETERMINISM
 * -----------
 * Output depends solely on the input `traces`. No Date.now(), no Math.random(),
 * no environment reads, no file/network I/O. Re-runs on identical input are
 * byte-identical. Matching is case-insensitive substring containment over a
 * curated cue list.
 */

/**
 * The shape this scanner reads. Kept structural (not importing the full
 * `TraceBody` from ../normalize/trace.ts) so the scanner stays dependency-light
 * and tolerant of the canonical type's churn. Any `TraceBody` satisfies it.
 *
 * NOTE: we deliberately do NOT scan assistant / tool / system content. An
 * objection is something the USER expresses about the agent's behavior; scanning
 * the assistant's own text would flood false positives (the agent narrating an
 * error, apologizing, quoting the user, etc.).
 */
export interface ObjectionScannableMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

export interface ObjectionScannableTrace {
  metadata: { traceId: string };
  messages: ObjectionScannableMessage[];
  /** Raw user feedback text if present — scanned alongside user messages. */
  userFeedback?: string;
}

/** Per-trace scan result: whether any cue hit, and which cue phrases matched. */
export interface ObjectionTraceResult {
  /** True iff at least one curated cue matched a user-authored string. */
  hit: boolean;
  /** The distinct cue phrases that matched, in curated-list order (deterministic). */
  cues: string[];
}

export interface ObjectionScanResult {
  /** traceId → per-trace result. One entry per input trace (including misses). */
  byTrace: Map<string, ObjectionTraceResult>;
  /**
   * Fraction of traces with >=1 cue hit, in [0, 1]. 0 when there are no traces.
   * ADVISORY ONLY — not a primary-eligible census signal (see file header).
   */
  objectionRate: number;
}

/**
 * Curated objection / dissatisfaction / correction / refusal cues.
 *
 * Each entry is a lowercase phrase matched as a case-insensitive substring.
 * Grouped + commented by intent so the list stays auditable and easy to prune.
 * Phrases are chosen to be multi-word where possible to cut false positives
 * (e.g. "not what" instead of bare "not", "i can't" instead of bare "can").
 *
 * `as const` so the phrases are a fixed, typed tuple (coding-rules: no magic
 * strings — categorical values live in an `as const` object/array).
 */
export const OBJECTION_CUES = [
  // ── Direct correction / "you got it wrong" ──────────────────────────────────
  "that's wrong",
  "thats wrong", // apostrophe-less variant
  "that is wrong",
  "this is wrong",
  "you're wrong",
  "youre wrong",
  "incorrect",
  "that's incorrect",
  "not correct",
  "not right",
  "that's not what", // "that's not what I asked / meant"
  "not what i", // "not what I asked for / wanted / meant"
  "that's not it",
  "thats not it",

  // ── It didn't work / failure complaint ──────────────────────────────────────
  "didn't work",
  "didnt work",
  "doesn't work",
  "doesnt work",
  "not working",
  "still broken",
  "still failing",
  "still doesn't",
  "still not",

  // ── Explicit dissatisfaction ────────────────────────────────────────────────
  "this is not what i wanted",
  "not what i wanted",
  "not what i expected",
  "that's not helpful",
  "not helpful",
  "useless",
  "frustrated",
  "frustrating",

  // ── Correction / retry-after-complaint markers ──────────────────────────────
  "actually no", // "actually, no — ..."
  "no, actually",
  "try again",
  "do it again",
  "redo",
  "that's not right",
  "let me rephrase", // user re-asking after a bad answer
  "i already told you",
  "as i said",
  "i said",

  // ── Refusal / capability complaint surfaced by the user echoing the agent ───
  // (kept narrow + multi-word to limit false positives)
  "you can't even",
  "unable to",
  "you keep",
  "stop doing",
] as const;

/** A single curated cue phrase (lowercase). */
export type ObjectionCue = (typeof OBJECTION_CUES)[number];

/**
 * Collect every user-authored string from a trace: user-role message contents
 * plus the optional `userFeedback` field. Assistant/tool/system content is
 * intentionally excluded (see ObjectionScannableMessage note).
 */
function userAuthoredStrings(trace: ObjectionScannableTrace): string[] {
  const out: string[] = [];
  for (const message of trace.messages) {
    if (message.role === "user" && message.content) {
      out.push(message.content);
    }
  }
  if (trace.userFeedback) {
    out.push(trace.userFeedback);
  }
  return out;
}

/**
 * Match the curated cues against one trace's user-authored text.
 * Returns the distinct matched cues in curated-list order (deterministic).
 */
function matchCues(trace: ObjectionScannableTrace): string[] {
  const haystacks = userAuthoredStrings(trace).map((s) => s.toLowerCase());
  const matched: string[] = [];
  // Iterate OBJECTION_CUES (not the haystack) so result order is the stable,
  // curated order regardless of input message order.
  for (const cue of OBJECTION_CUES) {
    if (haystacks.some((h) => h.includes(cue))) {
      matched.push(cue);
    }
  }
  return matched;
}

/**
 * Deterministic, NO-LLM objection/sentiment scan.
 *
 * Scans each trace's user-authored content for curated objection cues and
 * reports per-trace hits plus an aggregate `objectionRate`.
 *
 * @param traces canonical trace bodies (any TraceBody[] satisfies the structural
 *               ObjectionScannableTrace[] shape).
 * @returns `{ byTrace, objectionRate }`. `byTrace` has one entry per input trace
 *          (misses included, `hit: false`). `objectionRate` is the fraction of
 *          traces with >=1 hit, 0 when `traces` is empty.
 *
 * ADVISORY ONLY: see the file header — this output drives sampling priority and
 * may corroborate a deep-read finding, but is NOT a primary census signal.
 */
export function scanObjections(
  traces: ObjectionScannableTrace[]
): ObjectionScanResult {
  const byTrace = new Map<string, ObjectionTraceResult>();
  let hitCount = 0;

  for (const trace of traces) {
    const cues = matchCues(trace);
    const hit = cues.length > 0;
    if (hit) hitCount += 1;
    byTrace.set(trace.metadata.traceId, { hit, cues });
  }

  const objectionRate = traces.length === 0 ? 0 : hitCount / traces.length;

  return { byTrace, objectionRate };
}
