/**
 * scripts/judge-prompt-template.ts — EV-050 judge-PROMPT renderer + in-house/export run wrappers.
 * ---------------------------------------------------------------------------
 * The ONE place a judge prompt is rendered into a provider-callable string. This
 * is the operator-named **exception** to the script-austerity rule: "a script
 * that EXTRACTS/EXPORTS a custom LLM-as-judge PROMPT artifact (for the user's
 * CI/framework, EV-050) is fine — that's templating, not skill-triggered
 * judging." It exists for exactly two consumers:
 *
 *   (1) the OPTIONAL **in-house** provider substrate (`judge-provider.ts` →
 *       @langchain/google-genai) — it has no subagent, so it MUST carry the
 *       rendered prompt to call the model;
 *   (2) **user-framework export** (Vitest / promptfoo / Braintrust) — emit the
 *       judge prompt as an artifact for the user's own CI.
 *
 * **The DEFAULT agent-dispatch path NEVER imports this file.** Under
 * agent-dispatch the AUTHORITATIVE judging rubric lives in the subagent defs
 * (`assets/agents/{error-analyst,eval-judge,eval-matrix-judge}.md`); the host
 * runtime reasons from the def + the DATA packet, and the verdict file is keyed
 * by task DATA (trajectory id / criterion id), not by a rendered prompt. The
 * prose below is a MIRROR of those defs for the provider path — the defs are the
 * source of truth; keep them in lockstep.
 *
 * `determine-outcome.ts` + `build-evals.ts` are therefore slimmed to Type-A DATA
 * only (signals · parse · assemble · spec · split · leakage-guard). The
 * LLM-wrapper run functions (`determineOutcome` / `runJudge`) live HERE because
 * they call the injected `JudgeInvoke` seam.
 */
import {
  extractOutcomeSignals,
  parseCritiqueVerdict,
  type JudgeInvoke,
} from "./determine-outcome.ts";
import type { JudgePin } from "./build-evals.ts";
import type { SubjectProfile } from "./contracts/eval-matrix.ts";
import type {
  CriterionVerdict,
  EvalTrace,
  JudgeSpec,
  OutcomeResult,
  OutcomeSignals,
  SubjectVocab,
} from "./contracts/eval-types.ts";

function promptOf(trace: EvalTrace): string {
  return typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
}

// ── Determiner (EV-042) prompt — MIRRORS assets/agents/error-analyst.md ──────

/**
 * Render the determiner judge prompt for the in-house/export substrate. The
 * AUTHORITATIVE "inaction can be success" rubric is `error-analyst.md`; this is
 * its provider-callable mirror. No decision is made here.
 */
export function buildOutcomePrompt(
  trace: EvalTrace,
  signals: OutcomeSignals,
  vocab: SubjectVocab,
): { system: string; user: string } {
  const system = [
    "You are a success/failure determiner for an autonomous agent session.",
    "Decide whether the session REACHED THE GOAL implied by its input event.",
    "",
    "CRITICAL RULE — inaction can be success. Holding (sending nothing, calling",
    "no tool) is the CORRECT outcome when the event is a restraint directive",
    "(e.g. a guard/hold directive) or when acting would be wrong. You MUST NOT",
    'use "the agent called a tool" or "the agent sent a message" as a success',
    "proxy. A zero-tool session that correctly HOLDS is a PASS.",
    "",
    "Output STRICT JSON with the critique BEFORE the verdict:",
    '{ "critique": "<your reasoning>", "result": "pass"|"fail"|"uncertain",',
    '  "confidence": <0..1> }',
    "Reason first in `critique`, then commit to `result`.",
  ].join("\n");

  // Generic guard-counter label — the attribute NAME comes from the subject vocab.
  const guardLabel = vocab.guardCounterAttr ?? "guard counter";
  const user = [
    `Event kind: ${signals.eventKind}`,
    `Guard ${guardLabel}: ${signals.guardConsecutive ?? "n/a"}`,
    `Tools called: ${signals.toolCount}`,
    // EV-049 honest-null: render UNKNOWN as "unknown" (the subject's send tool is
    // unset/uninferred) — never coerce it to "false", which would lie to the judge.
    `Sent a message: ${signals.sentMessage === null ? "unknown" : signals.sentMessage}`,
    `Send succeeded: ${signals.sendSucceeded ?? "n/a (no send)"}`,
    `Recovery tool present: ${signals.recoveryPresent}`,
    "",
    "Input event prompt:",
    promptOf(trace),
    "",
    "Agent self-summary (output.response):",
    typeof trace.output?.response === "string" ? trace.output.response : "(none)",
  ].join("\n");

  return { system, user };
}

/**
 * In-house/export run wrapper for the determiner: render → call the injected
 * `JudgeInvoke` seam → parse (critique-before-verdict). Under the DEFAULT
 * agent-dispatch substrate the verdict instead comes from a dispatched
 * error-analyst subagent (a verdict file), and this wrapper is not used.
 * Deterministic given (trace, judge).
 */
export async function determineOutcome(
  trace: EvalTrace,
  judge: JudgeInvoke,
  vocab: SubjectVocab,
): Promise<OutcomeResult> {
  const signals = extractOutcomeSignals(trace, vocab);
  const { system, user } = buildOutcomePrompt(trace, signals, vocab);
  const raw = await judge(system, user);
  const verdict = parseCritiqueVerdict(raw);
  return {
    traceId: trace.id,
    reached: verdict.result as OutcomeResult["reached"],
    confidence: verdict.confidence,
    rationale: verdict.critique,
    signals,
  };
}

// ── Per-criterion judge (EV-043) prompt — MIRRORS assets/agents/eval-judge.md ─

/** Compact one trace for the judge's view (prompt + trajectory + response). */
function traceView(trace: EvalTrace): string {
  const prompt = typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
  const tools = trace.observations
    .filter((o) => o.type === "TOOL")
    .map((o) => o.name ?? "?")
    .join(", ");
  const resp = typeof trace.output?.response === "string" ? trace.output.response : "(none)";
  return [
    `Event/prompt:\n${prompt}`,
    `Tool trajectory: [${tools}]`,
    `Agent self-summary: ${resp}`,
  ].join("\n");
}

/** Render the M1 subject-profile preamble for the provider-path mirror (§9.4.4). */
function profilePreamble(profile?: SubjectProfile): string[] {
  if (profile === undefined) {
    return [
      "SUBJECT PROFILE (M1): not supplied — RECONSTRUCT who the agent is from the trace",
      "(its tools, the input it handled, its evident scope) before you judge. Mark the",
      "harness `unknown` if you cannot know it — NEVER confabulate it.",
      "",
    ];
  }
  return [
    "SUBJECT PROFILE (M1) — who the agent is (read this BEFORE judging):",
    `  identity: ${profile.identity}`,
    `  purpose:  ${profile.purpose}`,
    `  scope:    ${profile.scope}`,
    `  tools:    ${(profile.tools ?? []).join(", ") || "(none observed)"}`,
    profile.skill !== undefined ? `  skill:    ${profile.skill}` : "",
    `  harness:  ${profile.harness}`,
    `  provenance: ${profile.provenance}${profile.version !== undefined ? ` · version ${profile.version}` : ""}`,
    "",
  ].filter((l) => l !== "");
}

/**
 * Render the 4-component per-criterion judge prompt for the in-house/export
 * substrate. The AUTHORITATIVE 4-component / binary / critique-before-verdict
 * rubric is `eval-judge.md` (+ §9.4.4 M1–M5); this is its provider-callable mirror.
 */
export function buildJudgePrompt(
  spec: JudgeSpec,
  subjectTrace: EvalTrace,
  subjectProfile?: SubjectProfile,
): { system: string; user: string } {
  const fewShotBlock = spec.fewShot
    .map(
      (ex, i) =>
        `Example ${i + 1} (${ex.label}):\nCritique: ${ex.why}\nResult: ${ex.label}`,
    )
    .join("\n\n");

  const system = [
    "You are a BINARY Pass/Fail judge for ONE criterion. Judge exactly this and",
    "nothing else.",
    "",
    ...profilePreamble(subjectProfile),
    `Criterion: ${spec.statement}`,
    spec.passDefinition,
    spec.failDefinition,
    "",
    "JUDGE-WHAT-IS (M5): judge ONLY this defined criterion. If you notice a real",
    "failure with no matching criterion, you MAY note it as a detection — but NEVER",
    "mint a new eval or judge an undefined behaviour here.",
    "",
    "Outcomes are strictly BINARY: pass or fail (use uncertain ONLY if the trace",
    "genuinely lacks the evidence to decide). NO Likert scales, NO 1-5 / letter",
    "grades, NO partial credit — if severity matters, that is a separate judge.",
    "",
    spec.fewShot.length > 0 ? `Few-shot examples (from the TRAIN split only):\n${fewShotBlock}` : "",
    "",
    "Output STRICT JSON with the critique BEFORE the verdict (reason first, then",
    "commit). Follow the Judge DAG v2.2 walk (§9.4.2 + §9.4.4): GATHER (M2 — rephrase",
    "the agent's job in your own words, mark given-vs-inferred) → EXPECT (M3 — decide",
    "how the target SHOULD act BEFORE you examine) → EXAMINE actual-vs-expected (a",
    "truncated trace HARD short-circuits — emit INCOMPLETE and score NO criteria, never",
    "a row of abstains) → BIND → GROUND (absence-split: a bare-absence inferred from",
    "silence abstains, never fails) → CRITIQUE → DECIDE. Expose your train-of-thought at",
    "every phase (M4). Emit a `confidenceBand` (high|med|low) BESIDE the binary verdict",
    "— a calibration side-signal, NOT a Likert grade; it never alters `result`:",
    '{ "critique": "<detailed, evidence-citing assessment>", "result":',
    '  "pass"|"fail"|"uncertain", "confidence": <0..1>,',
    '  "confidenceBand": "high"|"med"|"low" }',
  ].join("\n");

  const user = ["Subject trace under evaluation:", "", traceView(subjectTrace)].join("\n");
  return { system, user };
}

/**
 * In-house/export run wrapper for one per-criterion judge under a PINNED model.
 * THROWS if the pin is not (modelId present AND temperature===0) — model intent
 * is sacred (C-PIN). Renders → calls the injected `JudgeInvoke` seam → parses
 * (critique-before-verdict). Under agent-dispatch the verdict instead comes from
 * a dispatched eval-judge subagent (a verdict file).
 */
export async function runJudge(
  spec: JudgeSpec,
  subjectTrace: EvalTrace,
  judge: JudgeInvoke,
  pin: JudgePin,
): Promise<CriterionVerdict> {
  if (typeof pin.modelId !== "string" || pin.modelId.length === 0) {
    throw new Error(
      "runJudge: judge is not pinned (missing modelId). MODEL INTENT IS SACRED " +
        "— a non-pinned judge can never produce a verdict (C-PIN).",
    );
  }
  if (pin.temperature !== 0) {
    throw new Error(
      `runJudge: judge temperature=${pin.temperature} (!= 0) — not pinned. ` +
        "MODEL INTENT IS SACRED: reruns must be byte-identical (C-PIN); refusing.",
    );
  }
  const { system, user } = buildJudgePrompt(spec, subjectTrace);
  const raw = await judge(system, user);
  const verdict = parseCritiqueVerdict(raw);
  return {
    criterionId: spec.criterionId,
    traceId: subjectTrace.id,
    result: verdict.result as OutcomeResult["reached"],
    confidence: verdict.confidence,
    critique: verdict.critique,
  };
}
