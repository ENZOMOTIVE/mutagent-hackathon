/**
 * scripts/lint-grounding.ts — GA the deterministic grounding-lint floor (L3).
 * ---------------------------------------------------------------------------
 * A pure, code-only lint that runs BEFORE any judgement and enforces the cheap,
 * mechanical grounding hygiene the LLM should never have to be trusted with:
 *
 *   R1 assumption-token-without-surfaced-assumption — text that hedges
 *      ("assume", "presumably", "likely", "should", "expected to", …) WITHOUT a
 *      surfaced assumption is a hidden premise → flag.
 *   R2 every claim → resolvable ref (L2 floor) — a judge-class `observed`
 *      criterion must cite ≥1 ref (and, when traces are supplied, ≥1 must
 *      RE-RESOLVE exact-match). Code-class rows verify FREE → exempt.
 *   R3 ground absence (L3) — an OBSERVED judge-class absence claim ("did not",
 *      "never", "no X", "missing", "without") needs a positive check of the
 *      field where X would be → ≥1 cited ref that re-resolves. Scoped to
 *      `observed` (mirrors R2): an INFERRED criterion deliberately empties its
 *      refs, so its absence wording is a good-practice guard, NOT flagged.
 *
 * GRANDFATHER (regression-safety rule #3): findings on a NEWLY-MINTED artifact
 * are ERRORS (`ok=false`); findings on a PRE-EXISTING artifact are WARNINGS
 * (`ok=true`). `isNew` selects which — never retroactively voids old evals.
 *
 * PURE — no clock/random/network. Deterministic findings in criterion order.
 */
import {
  Grounding,
  MetricSubstrate,
  assertGroundingHonest,
  type CriterionVerdict,
  type EvalTrace,
  type MinedCriterion,
} from "./contracts/eval-types.ts";

/** Hedge tokens that signal an un-surfaced assumption (R1). */
const ASSUMPTION_TOKENS: readonly string[] = [
  "assume",
  "assuming",
  "presumably",
  "probably",
  "likely",
  "should be",
  "should have",
  "expected to",
  "i think",
  "seems to",
  "appears to",
  "must have",
];

/** Absence-claim tokens (R3) — a negative claim needs a positive field check. */
const ABSENCE_TOKENS: readonly string[] = [
  "did not",
  "didn't",
  "never",
  "no ",
  "not ",
  "missing",
  "without",
  "absent",
  "failed to",
];

export interface LintFinding {
  criterionId: string;
  rule: "R1-assumption-token" | "R2-claim-needs-ref" | "R3-ground-absence";
  level: "error" | "warn";
  message: string;
}

export interface LintOptions {
  /** newly-minted artifact ⇒ findings are ERRORS; pre-existing ⇒ WARNINGS. */
  isNew?: boolean;
  /** trace batch for R2 exact re-resolution (optional — structural-only if absent). */
  traces?: EvalTrace[];
}

export interface LintResult {
  findings: LintFinding[];
  errorCount: number;
  warnCount: number;
  /** false iff ≥1 ERROR-level finding (only possible on a new artifact). */
  ok: boolean;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function hasToken(haystack: string, tokens: readonly string[]): boolean {
  const h = lower(haystack);
  return tokens.some((t) => h.includes(t));
}

/** Is this criterion a CODE-class row (verifies FREE → exempt from R2/R3)? */
function isCodeClass(c: MinedCriterion): boolean {
  return c.metadata.substrate === MetricSubstrate.Code;
}

/** Lint ONE mined criterion. Returns findings (level fixed by `isNew`). PURE. */
export function lintGroundingCriterion(
  c: MinedCriterion,
  opts: LintOptions = {},
): LintFinding[] {
  const level: LintFinding["level"] = opts.isNew === true ? "error" : "warn";
  const out: LintFinding[] = [];
  const text = `${c.statement} ${c.discovery.targets} ${c.discovery.why_problem} ${c.discovery.reasoning}`;
  const surfaced = c.discovery.assumptions.length > 0;

  // R1 — hedge token without a surfaced assumption.
  if (hasToken(text, ASSUMPTION_TOKENS) && !surfaced) {
    out.push({
      criterionId: c.id,
      rule: "R1-assumption-token",
      level,
      message:
        "text hedges (assumption token present) but surfaces NO assumption — " +
        "a hidden premise; surface it as a typed assumption.",
    });
  }

  const observed = c.discovery.evidence.grounding === Grounding.Observed;
  const codeFree = isCodeClass(c);

  // R2 — judge-class observed claim must cite ≥1 (re-resolving) ref.
  if (observed && !codeFree) {
    if (c.discovery.evidence.refs.length === 0) {
      out.push({
        criterionId: c.id,
        rule: "R2-claim-needs-ref",
        level,
        message: "observed (judge-class) criterion cites NO refs — every claim needs a resolvable ref.",
      });
    } else if (opts.traces !== undefined && opts.traces.length > 0) {
      let resolves = true;
      try {
        assertGroundingHonest(c, opts.traces);
      } catch {
        resolves = false;
      }
      if (!resolves) {
        out.push({
          criterionId: c.id,
          rule: "R2-claim-needs-ref",
          level,
          message: "observed criterion's refs do NOT re-resolve exact-match against the trace batch.",
        });
      }
    }
  }

  // R3 — absence claim on an OBSERVED judge-class row needs a positive field
  // check (a re-resolving ref). Scoped to `observed && !codeFree` to MIRROR R2:
  // an INFERRED criterion deliberately empties its refs (deriveMinedCriteria) —
  // its absence wording is a good-practice guard, not an ungrounded observation,
  // so it must NOT trigger R3. The observed path is NOT weakened: an observed
  // absence claim with no ref — OR with a ref that does not re-resolve against
  // the supplied trace batch — still fires.
  if (observed && !codeFree && hasToken(text, ABSENCE_TOKENS)) {
    if (c.discovery.evidence.refs.length === 0) {
      out.push({
        criterionId: c.id,
        rule: "R3-ground-absence",
        level,
        message:
          "observed (judge-class) absence claim ('did not'/'never'/'no …') with no " +
          "cited ref — ground the absence with a positive check of the field where " +
          "the behavior would appear.",
      });
    } else if (opts.traces !== undefined && opts.traces.length > 0) {
      let resolves = true;
      try {
        assertGroundingHonest(c, opts.traces);
      } catch {
        resolves = false;
      }
      if (!resolves) {
        out.push({
          criterionId: c.id,
          rule: "R3-ground-absence",
          level,
          message:
            "observed (judge-class) absence claim's ref does NOT re-resolve exact-match " +
            "against the trace batch — ground the absence with a positive field check.",
        });
      }
    }
  }

  return out;
}

/** Lint a batch of mined criteria. PURE — deterministic, criterion order. */
export function lintGrounding(
  criteria: MinedCriterion[],
  opts: LintOptions = {},
): LintResult {
  const findings = criteria.flatMap((c) => lintGroundingCriterion(c, opts));
  const errorCount = findings.filter((f) => f.level === "error").length;
  const warnCount = findings.filter((f) => f.level === "warn").length;
  return { findings, errorCount, warnCount, ok: errorCount === 0 };
}

/**
 * Lint a JUDGE VERDICT (the GA `*build-evals`/`*evaluate` floor): R1 hedge
 * tokens in the critique without a surfaced assumption, and an `uncertain`
 * verdict that carries NO `blockedBy` (an unrouted abstain). PURE.
 */
export function lintVerdict(v: CriterionVerdict, opts: LintOptions = {}): LintFinding[] {
  const level: LintFinding["level"] = opts.isNew === true ? "error" : "warn";
  const out: LintFinding[] = [];
  const surfaced = (v.assumptions?.length ?? 0) > 0 || v.blockedBy !== undefined;
  if (hasToken(v.critique, ASSUMPTION_TOKENS) && !surfaced) {
    out.push({
      criterionId: v.criterionId,
      rule: "R1-assumption-token",
      level,
      message: "critique hedges but surfaces no assumption / blockedBy — a hidden premise.",
    });
  }
  if (v.result === "uncertain" && v.blockedBy === undefined) {
    out.push({
      criterionId: v.criterionId,
      rule: "R3-ground-absence",
      level,
      message: "uncertain verdict with NO blockedBy — an unrouted abstain; type the blocker.",
    });
  }
  return out;
}
