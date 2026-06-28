/**
 * scripts/determine-outcome.ts — EV-042 success/failure determiner (Type A — DATA only).
 * ---------------------------------------------------------------------------
 * The deterministic FOUNDATION of the W1 eval engine. sample traces are UNLABELED
 * (0 scores / 0 tags), so `*discover` has no ✓/✗ to mine until a trace is
 * deep-read and labeled. The DEEP-READ + the success/failure DECISION is an
 * LLM-only operation → it lives in the `error-analyst` subagent def (the host
 * runtime reasons; "inaction can be success" is the rubric encoded THERE).
 *
 * Script austerity (operator directive): this script holds NO judge prompt and
 * NO LLM-reasoning logic. It keeps only the Type-A pieces:
 *   - deterministic SIGNAL extraction (event kind · tool count · guard count · …)
 *     fed to the judge — NEVER a verdict (toolCount is a signal, never a proxy);
 *   - the verdict PARSER (critique-before-verdict schema enforcement);
 *   - the deterministic OUTCOME ASSEMBLER (parsed verdict + signals → result).
 * The judge-prompt rendering + the in-house/export run-wrapper (`determineOutcome`)
 * live in `judge-prompt-template.ts` (the EV-050 in-house/export exception). The
 * DEFAULT agent-dispatch path reads a verdict file the subagent wrote — no
 * prompt is rendered here, and no provider is ever constructed.
 */
import {
  OutcomeVerdict,
  UNCLASSIFIED_EVENT,
  type CritiqueVerdict,
  type EvalTrace,
  type OutcomeResult,
  type OutcomeSignals,
  type SubjectVocab,
  type TraceObservation,
} from "./contracts/eval-types.ts";

/**
 * The judge DI seam — `(systemPrompt, userPrompt) => raw text`. Under the DEFAULT
 * agent-dispatch substrate the verdict comes from a dispatched subagent (a
 * verdict file); under the OPTIONAL in-house substrate it is a provider call.
 * This module never builds a provider and never renders a prompt — it only
 * declares the seam type the in-house/export wrapper consumes.
 */
export type JudgeInvoke = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

// ── Event classification (the intended-goal half of the read) ───────────────
//
// SUBJECT-AGNOSTIC: the tag→kind rules come from the injected `vocab` (EV-002 /
// EV-049). This module holds NO subject tag names — only the generic matching
// machinery + the `UNCLASSIFIED_EVENT` sentinel.

/** Escape a vocab token so it is matched literally inside a RegExp. */
function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classify the event block → the intended goal, using the subject's tag rules.
 * Rules are tried in order; the first whose stem appears as an opening tag
 * (`<{tag}`, case-insensitive, prefix match) wins. No match → UNCLASSIFIED_EVENT.
 */
export function classifyEvent(prompt: string, vocab: SubjectVocab): string {
  for (const rule of vocab.eventTags) {
    if (new RegExp(`<${escapeRegExp(rule.tag)}`, "i").test(prompt)) return rule.kind;
  }
  return UNCLASSIFIED_EVENT;
}

/**
 * Parse a guard's consecutive-action count (`{attr}="N"`) from the prompt, using
 * the subject's `guardCounterAttr`. Returns null when the subject declares no
 * guard counter (`attr === null`) or the attribute is absent/non-numeric.
 */
export function extractGuardConsecutive(prompt: string, attr: string | null): number | null {
  if (attr === null) return null;
  const m = new RegExp(`${escapeRegExp(attr)}\\s*=\\s*"(\\d+)"`, "i").exec(prompt);
  if (m === null) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

// ── Tool-trajectory inspection ──────────────────────────────────────────────

function isTool(obs: TraceObservation): boolean {
  return obs.type === "TOOL";
}

/** Read `output.success` (boolean) off a tool observation, else null. */
function toolSuccess(obs: TraceObservation): boolean | null {
  const out = obs.output;
  if (out !== null && typeof out === "object" && "success" in out) {
    const s = (out as { success: unknown }).success;
    if (typeof s === "boolean") return s;
  }
  return null;
}

function promptOf(trace: EvalTrace): string {
  return typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
}

/**
 * Extract the deterministic signals. PURE — reads only what's in the trace, and
 * the subject NAMES (send tool · recovery tools · event tags · guard attr) from
 * the injected `vocab` (EV-002 / EV-049 — no module-level subject constants).
 * Decides NOTHING about goal-attainment (that is the judge's job over these
 * signals). In particular it does not map toolCount → pass/fail.
 */
export function extractOutcomeSignals(trace: EvalTrace, vocab: SubjectVocab): OutcomeSignals {
  const prompt = promptOf(trace);
  const tools = trace.observations.filter(isTool);

  // EV-049 HONEST-NULL: when the subject's send tool is unset/uninferred, we
  // CANNOT identify which observations are sends — so `sentMessage`/`sendSucceeded`
  // are UNKNOWN (null), NOT a false `false`. A bare `false` here lies to the
  // determiner ("Sent a message: false") even on traces that DID send. Only when
  // the send tool IS named do we count and report a real true/false.
  const sendToolKnown = vocab.sendTool.length > 0;
  const sends = sendToolKnown
    ? tools.filter((t) => t.name === vocab.sendTool)
    : [];

  let sentMessage: boolean | null = null;
  let sendSucceeded: boolean | null = null;
  if (sendToolKnown) {
    sentMessage = sends.length > 0;
    if (sends.length > 0) {
      // true if ANY send succeeded; false if every send failed/unknown-false.
      sendSucceeded = sends.some((t) => toolSuccess(t) === true);
    }
  }

  const recoverySet = new Set(vocab.recoveryTools);
  const recoveryPresent = tools.some(
    (t) => t.name !== undefined && recoverySet.has(t.name),
  );

  return {
    eventKind: classifyEvent(prompt, vocab),
    toolCount: tools.length,
    sentMessage,
    sendSucceeded,
    guardConsecutive: extractGuardConsecutive(prompt, vocab.guardCounterAttr),
    recoveryPresent,
  };
}

// ── Verdict parsing (critique-before-verdict enforced) ──────────────────────

/** Strip a ```json … ``` (or bare ```) fence if present. */
function stripFence(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  return fenced !== null ? fenced[1] : raw;
}

const VALID_RESULTS: ReadonlySet<string> = new Set([
  OutcomeVerdict.Pass,
  OutcomeVerdict.Fail,
  OutcomeVerdict.Uncertain,
]);

/**
 * Parse a judge's structured answer, ENFORCING critique-before-verdict: a
 * `critique` string MUST be present and non-empty (a bare verdict with no
 * reasoning is rejected), and `result` must be in the closed set. This is the
 * schema gate applied to a verdict file the subagent wrote (default path) OR the
 * in-house provider's raw text — same enforcement either way.
 */
export function parseCritiqueVerdict(raw: string): CritiqueVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw).trim());
  } catch {
    throw new Error(`parseCritiqueVerdict: not valid JSON: ${raw.slice(0, 120)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("parseCritiqueVerdict: expected a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.critique !== "string" || o.critique.trim().length === 0) {
    throw new Error(
      "parseCritiqueVerdict: missing/empty `critique` — critique-before-verdict " +
        "is mandatory (a bare verdict with no reasoning is rejected)",
    );
  }
  if (typeof o.result !== "string" || !VALID_RESULTS.has(o.result)) {
    throw new Error(
      `parseCritiqueVerdict: result '${String(o.result)}' not in ` +
        `{pass,fail,uncertain}`,
    );
  }
  const confidence = typeof o.confidence === "number" ? o.confidence : 0;
  return {
    critique: o.critique,
    result: o.result as CritiqueVerdict["result"],
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ── Deterministic outcome assembler (no judge call) ─────────────────────────

/**
 * Assemble the determiner's `OutcomeResult` from a trace's signals + a PARSED
 * verdict (read from a dispatched error-analyst's verdict file, default path).
 * PURE — no judge call, no clock/random. The verdict is the subagent's (never
 * derived from tool-count). This is the Type-A AGGREGATE half of EV-042; the
 * LLM-only DECISION lives in `error-analyst.md`.
 */
export function assembleOutcome(
  trace: EvalTrace,
  verdict: CritiqueVerdict,
  vocab: SubjectVocab,
): OutcomeResult {
  return {
    traceId: trace.id,
    reached: verdict.result as OutcomeResult["reached"],
    confidence: verdict.confidence,
    rationale: verdict.critique,
    signals: extractOutcomeSignals(trace, vocab),
  };
}
