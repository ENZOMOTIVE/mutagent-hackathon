/**
 * scripts/validate/findings-contract.ts
 * W12-07 (OP-6 / CC-09): Findings-contract validator — the enabler.
 *
 * Runs at orchestrator Step 7 (post-aggregate, pre-RCA) over the aggregated
 * findings array. Enforces the CC-09 force-emit field set (was prose-only in
 * handover-contract.md `required_remedy_fields`). On any violation it emits a
 * machine-readable `RESEND <findingId> with <missing fields>` directive and exits
 * non-zero so the orchestrator can re-dispatch the analyzer for the offending
 * finding (handover-contract `on_missing_field`, max_redispatch: 2).
 *
 * This is the upstream guard that keeps a malformed finding from ever reaching
 * the renderer: the contract catches the missing field here, so the renderer
 * never has to crash on optional-field absence.
 *
 * TypeBox over Finding / Remedy / Assumption (defined in scripts/normalize/trace.ts).
 * W12-08 (PR-052 proposed): every remedy must link to a target (`applyTarget`)
 * and focus on an origin; cite the source via `diff` when findable, else carry an
 * explicit `diffStatus` marker — NEVER a fabricated diff.
 *
 * Usage: bun scripts/cli/run.sh scripts/validate/findings-contract.ts <findings.json>
 *
 * Exit 0 = every finding satisfies the contract.
 * Exit 1 = one or more findings violate it (RESEND directives on stdout).
 *
 * Type A — Pure Script (deterministic, no I/O except the CLI argument file).
 */

import { Type } from "@sinclair/typebox";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Finding } from "../normalize/trace.ts";

// ── Field contract — the SINGLE source of truth mirrors handover-contract.md ──
//
// Keep these in lock-step with `required_remedy_fields` / `required_finding_fields`
// in references/workflows/handover-contract.md. The validator is the executable
// form of that prose contract.

/**
 * CC-09 / W12-08 force-emit remedy fields, each non-null.
 *
 * W13-C (D-1): `cost` + `correctness` join the force-emit set. They are categorical
 * judgments only the analyzer can make from trace evidence, so absence is caught here
 * with a RESEND rather than rendering `cost:undefined` / `correct:undefined` badges.
 * `rank` is deliberately NOT in this set — it is enricher-DERIVED from `cost ×
 * correctness` (orchestrator-protocol §8), never analyzer-supplied. See
 * scripts/enrich/rank-remedies.ts.
 */
export const REQUIRED_REMEDY_FIELDS = [
  "applyTarget",
  "targetClass",
  "rationale",
  "whyWorks",
  "applyInstructions",
  "assumptions",
  // W13-C (D-1): the two cost/correctness header-badge inputs — required from the analyzer.
  "cost",
  "correctness",
] as const;

/** Required finding fields (analyzer self-validates before return). */
export const REQUIRED_FINDING_FIELDS = [
  "findingId",
  "actionable",
  // Phase-1 (W18-problem): descriptive problem statement, REQUIRED. W18-gate additionally
  // enforces it reads as a DESCRIPTION, not a task/remedy (see isTaskPhrasedProblem).
  "problem",
  "failureOrigin",
  "whyChain",
  "sourceTraceIds",
  "referenceIds",
  "audience",
] as const;

// ── TypeBox schemas (structural floor; field-level required-ness below) ───────

const AssumptionSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("verified"),
    Type.Literal("unverified"),
    Type.Literal("hypothesis-pending"),
  ]),
  basis: Type.String({ minLength: 1 }),
});

const DiffSchema = Type.Object({
  before: Type.String(),
  after: Type.String(),
});

const DiffStatusSchema = Type.Union([
  Type.Literal("source-unavailable"),
  Type.Literal("origin-unknown"),
]);

/**
 * W13-C (D-1): the cost / correctness categorical scale. Mirrors the canonical
 * Remedy.cost / Remedy.correctness union in scripts/normalize/trace.ts. Both feed
 * the renderer's header badges AND the enricher's deterministic rank derivation.
 */
const CostCorrectnessSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

/**
 * W12-08: the contract-enforced Remedy shape. Fields the operator made HARD-required
 * are non-optional here; `diff` / `diffStatus` are validated by the XOR rule in
 * `remedyFieldViolations` (TypeBox alone cannot express "exactly one of").
 */
const RemedyContractSchema = Type.Object({
  remedyId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  // applyTarget — HARD-required: every remedy must link to a target.
  applyTarget: Type.String({ minLength: 1 }),
  targetClass: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  whyWorks: Type.String({ minLength: 1 }),
  applyInstructions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  // W13-C (D-1): cost + correctness are force-emit categorical scalars.
  cost: CostCorrectnessSchema,
  correctness: CostCorrectnessSchema,
  // diff / diffStatus validated via XOR in remedyFieldViolations (not here).
  diff: Type.Optional(DiffSchema),
  diffStatus: Type.Optional(DiffStatusSchema),
});

// ── Result shapes ──────────────────────────────────────────────────────────────

export interface FindingContractViolation {
  findingId: string;
  /** remedyId when the violation is on a remedy; undefined for finding-level. */
  remedyId?: string;
  /** The missing / invalid field names. */
  missingFields: string[];
}

export interface FindingsContractResult {
  valid: boolean;
  totalFindings: number;
  violations: FindingContractViolation[];
  /** One machine-readable `RESEND <id> with <fields>` directive per offending finding. */
  resendDirectives: string[];
}

// ── Field-level checks ──────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function hasStructuralFloor(schema: TObject, value: unknown): boolean {
  return Value.Check(schema, value);
}

/**
 * Collect the missing required-field names for a single remedy. Encodes:
 *   - applyTarget HARD-required (link to a target)
 *   - targetClass / rationale / whyWorks required (non-empty)
 *   - applyInstructions required (≥1 entry)
 *   - assumptions required (≥1 structured entry) — this lives on the FINDING in
 *     the schema, but the operator-required "≥1 assumption" is enforced at finding
 *     level (see findingFieldViolations); remedies do not carry assumptions.
 *   - diff XOR diffStatus: exactly one must be present (PR-052 proposed) — never
 *     a fabricated diff, never neither.
 */
export function remedyFieldViolations(remedy: unknown): string[] {
  const missing: string[] = [];
  const r = (remedy ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(r.applyTarget)) missing.push("applyTarget");
  if (!isNonEmptyString(r.targetClass)) missing.push("targetClass");
  if (!isNonEmptyString(r.rationale)) missing.push("rationale");
  if (!isNonEmptyString(r.whyWorks)) missing.push("whyWorks");

  if (
    !Array.isArray(r.applyInstructions) ||
    r.applyInstructions.length === 0 ||
    r.applyInstructions.some((s) => !isNonEmptyString(s))
  ) {
    missing.push("applyInstructions");
  }

  // W13-C (D-1): cost + correctness force-emit — must be a low|medium|high enum value.
  // (rank is NOT checked: it is enricher-derived from these two, never analyzer-supplied.)
  if (!Value.Check(CostCorrectnessSchema, r.cost)) missing.push("cost");
  if (!Value.Check(CostCorrectnessSchema, r.correctness)) missing.push("correctness");

  // diff XOR diffStatus — exactly one. Honors feedback_model_intent_sacred:
  // a remedy with no findable source carries the marker, not a guessed diff.
  const hasDiff = Value.Check(DiffSchema, r.diff);
  const hasDiffStatus = Value.Check(DiffStatusSchema, r.diffStatus);
  if (!hasDiff && !hasDiffStatus) {
    missing.push("diff-or-diffStatus");
  } else if (hasDiff && hasDiffStatus) {
    // Ambiguous: a remedy must not claim both a concrete diff and "source not found".
    missing.push("diff-xor-diffStatus(both-present)");
  }

  // Structural floor catch-all (wrong types on the required scalars).
  if (
    missing.length === 0 &&
    !hasStructuralFloor(RemedyContractSchema, {
      remedyId: r.remedyId,
      title: r.title,
      applyTarget: r.applyTarget,
      targetClass: r.targetClass,
      rationale: r.rationale,
      whyWorks: r.whyWorks,
      applyInstructions: r.applyInstructions,
      cost: r.cost,
      correctness: r.correctness,
      diff: r.diff,
      diffStatus: r.diffStatus,
    })
  ) {
    missing.push("remedy(structural)");
  }

  return missing;
}

// ── W18-gate: problem-statement FORMAT check (first content gate) ────────────────
//
// WHY: Phase-1 made `Finding.problem` REQUIRED (trace.ts), but presence ≠ correct
// shape. Every gate before this one is a SHAPE gate (field present / non-empty / right
// type). This is the first CONTENT gate: the required `problem` must DESCRIBE the
// failure + quantified impact, NOT read as a task/remedy. trace.ts documents the
// format: "<subject> <observed behavior, declarative> — <quantified impact + evidence>"
// and explicitly bans the todo phrasing ("Make X faster — use a smaller model"). The
// fix belongs ONLY in `remedies`; a `problem` written in imperative/prescriptive mood
// leaks the remedy into the description slot. RESEND on violation (file-consistent).
//
// FALSE-POSITIVE DISCIPLINE (operator directive — be conservative):
//   We target the IMPERATIVE MOOD (a leading bare verb with no subject), NOT any
//   occurrence of a banned word. The guard rests on two facts:
//     1. The imperative form is the BARE verb exactly ("reduce", "increase"). Past-tense
//        observations use inflected forms ("reduced", "increased", "reduces") which do
//        NOT match an exact bare-verb token. So "throughput reduced to 12 req/s" — whose
//        FIRST word is the subject "throughput" — is never flagged.
//     2. We only inspect the FIRST word of the FIRST clause. A descriptive statement
//        leads with its subject; an imperative leads with its verb.
//   Prescriptive modals ("should" / "must" / "needs to") are checked ONLY in the MAIN
//   clause (before the first em-dash that separates the impact/evidence tail), so a
//   quoted impact phrase after the "—" can't trip them.

/**
 * Imperative verbs that, as the LEADING bare verb of the problem statement, signal a
 * task/remedy rather than a description. Matched as the exact first token (after
 * lowercasing + stripping trailing punctuation) — never as a substring, never inflected.
 */
export const BANNED_LEADING_IMPERATIVE_VERBS = new Set<string>([
  "make",
  "use",
  "cap",
  "add",
  "reduce",
  "switch",
  "replace",
  "enable",
  "fix",
  "consider",
  "try",
  "avoid",
  "ensure",
  "implement",
  "increase",
  "decrease",
  "move",
  "remove",
  "update",
  "set",
]);

/**
 * Extract the first word-token of a string: leading whitespace/quotes stripped, then
 * the run of leading letters (so "Make," → "make", "“Use…" → "use"). Returns "" when
 * there is no leading alphabetic token.
 */
function leadingWord(s: string): string {
  const m = s.trimStart().match(/^["'“”‘’*_([]*([a-zA-Z]+)/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * The MAIN clause = everything before the first em-dash / " - " hyphen separator that
 * trace.ts uses to split "<description> — <quantified impact + evidence>". Prescriptive
 * modals are searched only here so a legitimately-quoted impact tail can't trip the gate.
 */
function mainClause(problem: string): string {
  // Split on em-dash, en-dash, or a spaced hyphen (the documented impact separator).
  return problem.split(/\s+[—–]\s+|\s+-\s+/)[0] ?? problem;
}

/**
 * W18-gate: true when the (already-present, non-empty) problem statement reads like a
 * task/remedy rather than a descriptive problem statement.
 *
 * Two conservative signals:
 *   (a) Imperative mood — the FIRST word of the FIRST clause is a bare imperative verb
 *       from BANNED_LEADING_IMPERATIVE_VERBS (subject-less directive).
 *   (b) Prescription modal in the MAIN clause — "should" / "must" / "needs to" used to
 *       prescribe (e.g. "X should be cached"). Bounded to the pre-em-dash clause.
 */
export function isTaskPhrasedProblem(problem: unknown): boolean {
  if (typeof problem !== "string") return false;
  const text = problem.trim();
  if (text === "") return false;

  // (a) Leading bare-verb imperative. Inspect ONLY the first clause's first word so that
  //     "throughput reduced to 12 req/s" (subject-first, past tense) is never flagged.
  const firstClause = mainClause(text);
  if (BANNED_LEADING_IMPERATIVE_VERBS.has(leadingWord(firstClause))) {
    return true;
  }

  // (b) Prescriptive modals in the main clause only. Word-boundaried; "needs to" requires
  //     the infinitive marker so a descriptive "the agent needs three retries" (no "to")
  //     does not trip. "should" / "must" are inherently prescriptive when present.
  const clause = firstClause.toLowerCase();
  if (/\b(should|must)\b/.test(clause) || /\bneeds\s+to\b/.test(clause)) {
    return true;
  }

  return false;
}

/** The RESEND-facing message for a task-phrased problem (W18-gate). */
export const PROBLEM_TASK_PHRASED_MESSAGE =
  "Problem reads like a task/remedy — it must DESCRIBE the failure + quantified " +
  "impact; move the fix to remedies.";

// ── S3.5 (Wave-15 Block B): no-code-access assumption CONTENT check ──────────────
//
// WHY: the Step-7.1 gate previously checked `assumptions.length>0` but NOT content.
// When `entity.codeAccess === false`, the REQUIRED "no-code-access" assumption (the
// "source code was not provided; findings are evidence-only" disclaimer) could vanish
// uncaught — a finding could ship with a different assumption and pass the length
// check. FIX (operator option A): when codeAccess===false, assert a no-code-access
// assumption is PRESENT by content (text/status), not just array length. RESEND on
// violation.

/**
 * S3.5: true when an assumption is the no-code-access disclaimer — matched by
 * SEMANTIC SIGNATURE rather than an exact string, so BOTH the enricher-synthesized
 * form (synthesizeNoCodeAccessAssumption: status "hypothesis-pending", text
 * "Source code for X was not provided; findings are evidence-only.") AND an
 * analyzer-authored equivalent are accepted. Signature:
 *   status === "hypothesis-pending"  AND
 *   text or basis references the no-code-access / source-unavailable concept.
 */
function isNoCodeAccessAssumption(a: unknown): boolean {
  if (!Value.Check(AssumptionSchema, a)) return false;
  const asm = a as { text: string; status: string; basis: string };
  if (asm.status !== "hypothesis-pending") return false;
  const haystack = `${asm.text} ${asm.basis}`.toLowerCase();
  // "source code … not provided / unavailable", "no code access", "codeAccess === false",
  // "evidence-only" — any of the recognized no-code-access phrasings.
  const mentionsSource = /\b(source code|source|code access|codeaccess)\b/.test(haystack);
  const mentionsUnavailable =
    /\bnot provided\b|\bunavailable\b|\bno (code )?access\b|\bevidence[- ]only\b|\bcodeaccess\s*===?\s*false\b|\bnot accessible\b/.test(
      haystack
    );
  return mentionsSource && mentionsUnavailable;
}

/**
 * Collect the missing required-field names at the finding level, plus the
 * operator-required "≥1 assumption" rule (assumptions live on the Finding).
 *
 * S3.5: when `opts.entityCodeAccess === false`, ALSO require that ≥1 assumption is a
 * no-code-access disclaimer (content check). Omitting `opts` (or leaving
 * entityCodeAccess undefined / true) preserves the prior length-only behavior.
 */
export function findingFieldViolations(
  finding: unknown,
  opts: { entityCodeAccess?: boolean } = {}
): string[] {
  const missing: string[] = [];
  const f = (finding ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(f.findingId)) missing.push("findingId");
  if (!isNonEmptyString(f.actionable)) missing.push("actionable");
  if (typeof f.failureOrigin !== "object" || f.failureOrigin === null) {
    missing.push("failureOrigin");
  } else {
    // EV-gate (Wave-15 Block B, gate half of EV-1): Block 0 added the required field
    // `whatHappened: string` to FailureOrigin — the plain-words narration companion to
    // the `evidence` pointer. A finding is REJECTED (RESEND) when the narration is
    // empty/missing, OR when the `evidence` pointer is empty/missing (still required).
    const fo = f.failureOrigin as Record<string, unknown>;
    if (!isNonEmptyString(fo.whatHappened)) missing.push("failureOrigin.whatHappened");
    if (!isNonEmptyString(fo.evidence)) missing.push("failureOrigin.evidence");
  }
  if (!Array.isArray(f.whyChain) || f.whyChain.length === 0) {
    missing.push("whyChain");
  } else {
    // EV-gate: every why-chain step carries the required `whatHappened` narration
    // (Block 0 added it to WhyChainEntry). Reject when ANY step's narration is
    // empty/missing. `evidence` stays required per-step too.
    const badNarration = f.whyChain.some(
      (w) => !isNonEmptyString((w as Record<string, unknown>)?.whatHappened)
    );
    const badEvidence = f.whyChain.some(
      (w) => !isNonEmptyString((w as Record<string, unknown>)?.evidence)
    );
    if (badNarration) missing.push("whyChain[].whatHappened");
    if (badEvidence) missing.push("whyChain[].evidence");
  }
  if (!Array.isArray(f.sourceTraceIds) || f.sourceTraceIds.length === 0) {
    missing.push("sourceTraceIds");
  }
  if (typeof f.referenceIds !== "object" || f.referenceIds === null) {
    missing.push("referenceIds");
  }
  if (!isNonEmptyString(f.audience)) missing.push("audience");

  // Phase-1 (W18-problem): `problem` is REQUIRED (trace.ts) — must be present + non-empty.
  if (!isNonEmptyString(f.problem)) {
    missing.push("problem");
  } else if (isTaskPhrasedProblem(f.problem)) {
    // W18-gate (this wave): the first CONTENT gate. A present, non-empty problem that
    // reads as a task/remedy (imperative mood / prescriptive modal) is REJECTED so the
    // descriptive-statement contract is actually enforced, not just field presence.
    missing.push("problem(task-phrased)");
  }

  // Operator-required: ≥1 structured assumption per finding (PR-030 / W12-08).
  const assumptionsValid =
    Array.isArray(f.assumptions) &&
    f.assumptions.length > 0 &&
    f.assumptions.every((a) => Value.Check(AssumptionSchema, a));
  if (!assumptionsValid) {
    missing.push("assumptions");
  }

  // S3.5: no-code-access CONTENT check. Only fires when the diagnosed entity has
  // no source access (entity.codeAccess === false). The required disclaimer must be
  // PRESENT — a length-only-valid assumptions array that omits it is rejected.
  if (opts.entityCodeAccess === false) {
    const hasDisclaimer =
      Array.isArray(f.assumptions) && f.assumptions.some(isNoCodeAccessAssumption);
    if (!hasDisclaimer) {
      missing.push("assumptions(no-code-access)");
    }
  }

  // Every finding must carry ≥1 remedy.
  if (!Array.isArray(f.remedies) || f.remedies.length === 0) {
    missing.push("remedies");
  }

  return missing;
}

// ── Aggregate validator ─────────────────────────────────────────────────────────

/**
 * Options for the aggregate validator.
 * S3.5: `entityCodeAccess` is the diagnosed entity's `EntityContext.codeAccess`.
 * When `false`, every finding must carry a no-code-access disclaimer assumption
 * (content check). Undefined/true ⇒ the content check is skipped (length-only).
 */
export interface FindingsContractOptions {
  entityCodeAccess?: boolean;
}

/**
 * Validate an aggregated findings array against the contract.
 * One violation row per offending (finding, remedy) pair; one RESEND directive
 * per offending finding (fields merged across the finding + its remedies).
 */
export function validateFindingsContract(
  findings: unknown[],
  opts: FindingsContractOptions = {}
): FindingsContractResult {
  const violations: FindingContractViolation[] = [];

  for (const finding of findings) {
    const f = (finding ?? {}) as Record<string, unknown>;
    const findingId = isNonEmptyString(f.findingId)
      ? (f.findingId as string)
      : "(missing-findingId)";

    const findingMissing = findingFieldViolations(finding, {
      entityCodeAccess: opts.entityCodeAccess,
    });
    if (findingMissing.length > 0) {
      violations.push({ findingId, missingFields: findingMissing });
    }

    const remedies = Array.isArray(f.remedies) ? f.remedies : [];
    for (const remedy of remedies) {
      const r = (remedy ?? {}) as Record<string, unknown>;
      const remedyMissing = remedyFieldViolations(remedy);
      if (remedyMissing.length > 0) {
        violations.push({
          findingId,
          remedyId: isNonEmptyString(r.remedyId)
            ? (r.remedyId as string)
            : "(missing-remedyId)",
          missingFields: remedyMissing,
        });
      }
    }
  }

  // One RESEND directive per offending finding (merge field names, dedup).
  const byFinding = new Map<string, Set<string>>();
  for (const v of violations) {
    const set = byFinding.get(v.findingId) ?? new Set<string>();
    for (const field of v.missingFields) {
      // Qualify remedy-level fields so the analyzer knows where to look.
      set.add(v.remedyId ? `remedy:${v.remedyId}.${field}` : field);
    }
    byFinding.set(v.findingId, set);
  }

  const resendDirectives = [...byFinding.entries()].map(
    ([findingId, fields]) =>
      `RESEND ${findingId} with ${[...fields].join(", ")}`
  );

  return {
    valid: violations.length === 0,
    totalFindings: findings.length,
    violations,
    resendDirectives,
  };
}

/**
 * Guard: throws (with all RESEND directives) if any finding violates the contract.
 * Useful at the Step-7 aggregate boundary before handing findings to RCA/render.
 * S3.5: pass `opts.entityCodeAccess` to enforce the no-code-access content check.
 */
export function assertFindingsContract(
  findings: unknown[],
  opts: FindingsContractOptions = {}
): asserts findings is Finding[] {
  const result = validateFindingsContract(findings, opts);
  if (!result.valid) {
    throw new Error(
      `Findings-contract validation failed (${result.violations.length} violation(s)):\n` +
        result.resendDirectives.map((d) => `  ${d}`).join("\n")
    );
  }
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const flagVal = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // Positional findings path = first non-flag arg (preserves the legacy invocation).
  const entityContextPath = flagVal("--entity-context");
  const inputPath = argv.find(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--entity-context"
  );

  if (!inputPath) {
    process.stderr.write(
      "Usage: bun scripts/cli/run.sh scripts/validate/findings-contract.ts <findings.json> [--entity-context <entity-context.json>]\n" +
        "\n" +
        "Validates an aggregated Finding[] against the CC-09 / W12-08 contract.\n" +
        "On violation, prints one `RESEND <findingId> with <fields>` directive per\n" +
        "offending finding and exits non-zero (orchestrator Step 7 re-dispatches).\n" +
        "S3.5: when --entity-context resolves an entity with codeAccess===false, each\n" +
        "finding must carry a no-code-access disclaimer assumption (content check).\n"
    );
    process.exit(1);
  }

  let findings: unknown[];
  try {
    const raw = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
    if (!Array.isArray(raw)) {
      process.stderr.write("Error: input file must contain a JSON array of findings\n");
      process.exit(1);
    }
    findings = raw;
  } catch (err) {
    process.stderr.write(`Error reading ${inputPath}: ${err}\n`);
    process.exit(1);
  }

  // S3.5: resolve the diagnosed entity's codeAccess when --entity-context is supplied.
  let entityCodeAccess: boolean | undefined;
  if (entityContextPath) {
    try {
      const ec = JSON.parse(readFileSync(resolve(entityContextPath), "utf8")) as {
        codeAccess?: boolean;
      };
      entityCodeAccess = ec.codeAccess;
    } catch (err) {
      process.stderr.write(`Error reading ${entityContextPath}: ${err}\n`);
      process.exit(1);
    }
  }

  const result = validateFindingsContract(findings, { entityCodeAccess });

  if (result.valid) {
    process.stderr.write(
      `[findings-contract] PASS — ${result.totalFindings} finding(s) satisfy the contract.\n`
    );
    process.exit(0);
  }

  // RESEND directives on stdout (machine-readable — orchestrator re-dispatches).
  for (const directive of result.resendDirectives) {
    process.stdout.write(directive + "\n");
  }
  process.stderr.write(
    `[findings-contract] FAIL — ${result.violations.length} violation(s) across ` +
      `${result.resendDirectives.length} finding(s).\n`
  );
  process.exit(1);
}
