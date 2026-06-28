/**
 * scripts/subject-profile.ts — §9.4.4 M1: the JUDGE-PACKET subject profile builder.
 * ---------------------------------------------------------------------------
 * M1 says the judge must know WHO the agent is BEFORE it judges — identity ·
 * purpose · tools · skill · scope. This is the SMALL, judge-facing profile that
 * rides in the `MatrixPacket` (distinct from the heavier trace-exploration
 * `SubjectProfile` in `profile-subject.ts`, which drives `*audit` / discover).
 *
 * Two construction paths, both PURE + deterministic:
 *   - GIVEN        — code/metadata access: caller passes identity/purpose/scope/
 *                    skill/harness/version; tools default to the reconstructed
 *                    inventory when not given.
 *   - RECONSTRUCTED — no access: identity/tools are reconstructed from the trace
 *                    batch (tool inventory via `inferToolInventory`); purpose/scope
 *                    are best-effort from the trace name + the prompts; the harness
 *                    is MARKED `unknown` (never confabulated), and every inferred
 *                    field is listed in `inferredFields` (honesty about provenance).
 *
 * NEVER confabulates: a field the inputs cannot establish is set to PROFILE_UNKNOWN,
 * not guessed. No clock / random / network.
 */
import {
  PROFILE_UNKNOWN,
  SubjectProfileProvenance,
  type SubjectProfile,
} from "./contracts/eval-matrix.ts";
import { inferToolInventory, inferSystemPrompt } from "./profile-subject.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";

/** The GIVEN facts a caller with code/metadata access can supply (M1). Any field
 *  left absent is RECONSTRUCTED from the trace batch or MARKED `unknown`. */
export interface GivenSubjectFacts {
  identity?: string;
  /** the KIND of subject (autonomous-agent · skill · tool). MARKED unknown when absent. */
  entityType?: string;
  purpose?: string;
  tools?: string[];
  skill?: string;
  scope?: string;
  harness?: string;
  version?: string;
  /** the agent's system prompt (code access). Rendered COLLAPSED; never confabulated. */
  systemPrompt?: string;
}

export interface BuildSubjectProfileParams {
  subjectName: string;
  traces: EvalTrace[];
  /** GIVEN facts (code access). ABSENT ⇒ a fully RECONSTRUCTED profile. */
  given?: GivenSubjectFacts;
}

/** The first non-empty prompt across the batch (a best-effort purpose anchor). */
function firstPrompt(traces: EvalTrace[]): string {
  for (const t of traces) {
    const p = t.input?.prompt;
    if (typeof p === "string" && p.trim().length > 0) return p.trim();
  }
  return "";
}

/**
 * M1 — build the judge-packet `SubjectProfile`. When `given` is supplied (code
 * access) those facts WIN and provenance is `given`; the remaining fields are
 * reconstructed from the traces. When `given` is absent the whole profile is
 * `reconstructed` and the harness is MARKED `unknown` (never confabulated). PURE.
 */
export function buildSubjectProfile(params: BuildSubjectProfileParams): SubjectProfile {
  const { subjectName, traces, given } = params;
  const hasGiven = given !== undefined && Object.keys(given).length > 0;

  // tools: GIVEN inventory wins; else reconstruct from observations[].type==="TOOL".
  const reconstructedTools = inferToolInventory(traces).map((t) => t.name);
  const tools = given?.tools && given.tools.length > 0 ? given.tools : reconstructedTools;

  // purpose/scope: GIVEN wins; else a best-effort from the trace name + a prompt.
  const promptAnchor = firstPrompt(traces);
  const inferredFields: string[] = [];

  const identity = given?.identity ?? subjectName;
  if (given?.identity === undefined) inferredFields.push("identity");

  let purpose = given?.purpose;
  if (purpose === undefined) {
    purpose =
      promptAnchor.length > 0
        ? `Reconstructed from the trace batch — handles inputs of the form: "${promptAnchor.slice(0, 120)}".`
        : `Reconstructed from the trace batch — purpose not stated in the traces (${PROFILE_UNKNOWN}).`;
    inferredFields.push("purpose");
  }

  let scope = given?.scope;
  if (scope === undefined) {
    scope =
      tools.length > 0
        ? `Reconstructed scope — observed to operate over: ${tools.slice(0, 8).join(", ")}.`
        : `Scope not establishable from the traces (${PROFILE_UNKNOWN}).`;
    inferredFields.push("scope");
  }

  if (given?.tools === undefined || given.tools.length === 0) inferredFields.push("tools");

  // harness: GIVEN wins; else MARKED unknown — NEVER confabulated.
  const harness = given?.harness ?? PROFILE_UNKNOWN;
  if (given?.harness === undefined) inferredFields.push("harness");

  // entityType: GIVEN-only (no trace reconstruction). ABSENT ⇒ omitted (the renderer
  // marks it `unknown`), and listed as inferred so the hero honesty signal stays accurate.
  if (given?.entityType === undefined) inferredFields.push("entityType");

  // systemPrompt (UI-14): GIVEN (code access) WINS; else RECONSTRUCT from the trace
  // batch — every LLM call's GENERATION observation carries the message list whose
  // `role:"system"` entry IS the prompt. Found ⇒ populate it (still listed as inferred
  // so the hero shows "RECONSTRUCTED · from traces"); NOT found ⇒ omit it (renderer
  // marks UNAVAILABLE). NEVER confabulated.
  let systemPrompt = given?.systemPrompt;
  if (systemPrompt === undefined) systemPrompt = inferSystemPrompt(traces);
  if (given?.systemPrompt === undefined) inferredFields.push("systemPrompt");

  const profile: SubjectProfile = {
    identity,
    purpose,
    tools,
    scope,
    harness,
    provenance: hasGiven ? SubjectProfileProvenance.Given : SubjectProfileProvenance.Reconstructed,
    ...(given?.entityType !== undefined ? { entityType: given.entityType } : {}),
    ...(given?.skill !== undefined ? { skill: given.skill } : {}),
    ...(given?.version !== undefined ? { version: given.version } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(inferredFields.length > 0 ? { inferredFields } : {}),
  };
  return profile;
}
