/**
 * scripts/discover-criteria.ts — EV-041 `*discover`.
 * ---------------------------------------------------------------------------
 * Derive emergent BINARY ACTIONABLE eval criteria from LABELED ✓/✗ traces.
 *
 * The clustering itself is the LLM error-analyst's job (deep-read each trace,
 * note the FIRST thing that went wrong, assign an emergent category — never a
 * pre-defined list; error-analysis CORE §2/§3). This is the PURE, deterministic
 * remainder of `*discover`:
 *   - aggregate annotations → one criterion per emergent category (support)
 *   - compute per-category failure rates (prioritize what matters)
 *   - FLAG fixable (infra/dependency) vs eval-worthy (behavioral). Fixables are
 *     ROUTED to diagnostics (EV-051), NEVER fixed and NEVER judged on the model.
 *   - detect saturation: stop when no NEW category emerges across rounds.
 *
 * "a judge is only a judge" — this module FLAGS, it does not fix. There is no
 * `resolve`/`fix` field on a DiscoveredCriterion by construction.
 *
 * PURE + deterministic: criteria ranked by support desc then id; no clock/random.
 */
import {
  AssumptionKind,
  CheckMethod,
  CriterionFlag,
  Generality,
  Grounding,
  JudgeKind,
  MetricDimension,
  MetricLevel,
  MetricSubstrate,
  OutcomeVerdict,
  Severity,
  assertGroundingHonest,
  type CheckMethodValue,
  type CriterionFlagValue,
  type DiscoveredCriterion,
  type DiscoveryRef,
  type GeneralityValue,
  type GroundingValue,
  type JudgeKindValue,
  type MetricDimensionValue,
  type MetricLevelValue,
  type MetricMetadata,
  type MetricSubstrateValue,
  type MinedCriterion,
  type DiscoveryRationale,
  type OutcomeVerdictValue,
  type SeverityValue,
} from "./contracts/eval-types.ts";
import type { CodeEvalSpec } from "./code-eval.ts";

/**
 * One annotation: the error-analyst's deep-read of a single trace. For a
 * failure it carries the first-thing-that-went-wrong `note` + the emergent
 * `category` + a classification (`infra` => fixable, else behavioral).
 * `statement`/`judgeKind`/`judgeInputs` are the analyst's criterion proposal,
 * carried on the first annotation that defines a category.
 */
export interface TraceAnnotation {
  traceId: string;
  label: OutcomeVerdictValue;
  category?: string;
  note?: string;
  failureClass?: "infra" | "behavioral";
  judgeKind?: JudgeKindValue;
  statement?: string;
  judgeInputs?: string[];
  /**
   * §5c evidence ref — a concrete `trace-id/field` pointer the analyst cited for
   * THIS trace's failure. When present it is used as the grounding ref; else the
   * traceId itself is the ref. ADDITIVE (P2b).
   */
  evidencePointer?: string;
  /**
   * GA-1 — STRUCTURED grounding refs `{obs,path,value}` the `#mode-discover` leaf
   * cited for THIS trace's failure. PREFERRED over `evidencePointer` (which is
   * synthesized into a best-effort structured ref when `refs` is absent). The
   * `value` is the EXACT cited text so the ref re-resolves against the trace.
   */
  refs?: DiscoveryRef[];
  /**
   * Optional §5b metadata PROPOSALS the `#mode-discover` leaf may emit (additive
   * agent-contract extension). When present they override the generic defaults
   * `deriveMinedCriteria` would otherwise compute; when absent, defaults apply.
   */
  dimension?: MetricDimensionValue;
  level?: MetricLevelValue;
  generality?: GeneralityValue;
  severity?: SeverityValue;
  appliesTo?: string[];
  /**
   * The UNIFORM-STANDARD executable code-check the `#mode-discover` leaf EMITS when
   * a mined criterion is deterministically checkable (it picks a registry primitive
   * + field/params and tags the category `code`/`hybrid`). Carried onto the
   * `MinedCriterion.codeEval` so the tier-0 pre-pass runs it (zero judge tokens).
   * Absent for a pure `llm-judge` category. ADDITIVE.
   */
  codeEval?: CodeEvalSpec;
}

/** Group annotations by their emergent category (uncategorized are dropped). */
export function groupByCategory(
  annotations: TraceAnnotation[],
): Map<string, TraceAnnotation[]> {
  const groups = new Map<string, TraceAnnotation[]>();
  for (const a of annotations) {
    if (a.category === undefined || a.category.length === 0) continue;
    const list = groups.get(a.category) ?? [];
    list.push(a);
    groups.set(a.category, list);
  }
  return groups;
}

export interface CategoryRate {
  category: string;
  fails: number;
  total: number;
  rate: number;
}

/** Per-category failure rate, ranked by fails desc then category asc. */
export function failureRates(annotations: TraceAnnotation[]): CategoryRate[] {
  const groups = groupByCategory(annotations);
  const rates: CategoryRate[] = [];
  for (const [category, list] of groups) {
    const fails = list.filter((a) => a.label === OutcomeVerdict.Fail).length;
    const total = list.length;
    rates.push({ category, fails, total, rate: total === 0 ? 0 : fails / total });
  }
  return rates.sort((a, b) =>
    b.fails - a.fails !== 0 ? b.fails - a.fails : a.category.localeCompare(b.category),
  );
}

/** Pick the first non-empty value of `key` across a category's annotations. */
function firstDefined<K extends keyof TraceAnnotation>(
  list: TraceAnnotation[],
  key: K,
): TraceAnnotation[K] | undefined {
  for (const a of list) {
    if (a[key] !== undefined) return a[key];
  }
  return undefined;
}

/** A category is FIXABLE iff any of its failures is classified infra. */
function flagFor(list: TraceAnnotation[]): CriterionFlagValue {
  const anyInfra = list.some(
    (a) => a.label === OutcomeVerdict.Fail && a.failureClass === "infra",
  );
  return anyInfra ? CriterionFlag.Fixable : CriterionFlag.EvalWorthy;
}

/**
 * Derive one BINARY ACTIONABLE criterion per emergent category. Ranked by
 * support (member count) desc then id asc. PURE — no fix is applied; the
 * returned objects carry no resolution field.
 */
export function deriveCriteria(annotations: TraceAnnotation[]): DiscoveredCriterion[] {
  const groups = groupByCategory(annotations);
  const out: DiscoveredCriterion[] = [];
  for (const [category, list] of groups) {
    const statement = firstDefined(list, "statement") ?? `behavior is correct for: ${category}`;
    const judgeKind = firstDefined(list, "judgeKind") ?? JudgeKind.Llm;
    const judgeInputs = firstDefined(list, "judgeInputs") ?? ["prompt", "trajectory", "response"];
    out.push({
      id: category,
      statement,
      judgeInputs,
      judgeKind,
      flag: flagFor(list),
      supportCount: list.length,
    });
  }
  return out.sort((a, b) =>
    b.supportCount - a.supportCount !== 0
      ? b.supportCount - a.supportCount
      : a.id.localeCompare(b.id),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// P2 / P2b — mined criteria with §5b metadata + §5c DR-2 (evidence-first)
// ════════════════════════════════════════════════════════════════════════════

/** Map the analyst's JudgeKind → the §5b check_method router (SF-2). */
function checkMethodFor(judgeKind: JudgeKindValue): CheckMethodValue {
  if (judgeKind === JudgeKind.Code) return CheckMethod.Deterministic;
  if (judgeKind === JudgeKind.Hybrid) return CheckMethod.Hybrid;
  return CheckMethod.LlmJudge;
}

/** §5b substrate is DERIVED from check_method: deterministic→code, else judge. */
function substrateFor(checkMethod: CheckMethodValue): MetricSubstrateValue {
  return checkMethod === CheckMethod.Deterministic ? MetricSubstrate.Code : MetricSubstrate.Judge;
}

/** Generic generality heuristic: a code/deterministic check is general-structural
 *  (reusable on any pipeline); a judge check is specific-semantic. The leaf may
 *  override via `annotation.generality`. */
function generalityFor(checkMethod: CheckMethodValue): GeneralityValue {
  return checkMethod === CheckMethod.Deterministic
    ? Generality.GeneralStructural
    : Generality.SpecificSemantic;
}

/** Generic severity heuristic from observed failure count (leaf may override). */
function severityFor(fails: number): SeverityValue {
  if (fails >= 2) return Severity.High;
  if (fails === 1) return Severity.Med;
  return Severity.Low;
}

/** Map the criterion flag → the §5c fix_or_eval routing string. */
function fixOrEvalFor(flag: CriterionFlagValue): DiscoveryRationale["fix_or_eval"] {
  return flag === CriterionFlag.Fixable ? "fixable->diagnostics" : "eval-worthy";
}

/** Synthesize a best-effort structured ref from a legacy `trace-id/field`
 *  pointer string + note (GA-1 back-compat: the leaf may still emit a pointer). */
function synthRef(a: TraceAnnotation): DiscoveryRef {
  const ptr = a.evidencePointer ?? a.traceId;
  const slash = ptr.indexOf("/");
  const obs = slash >= 0 ? ptr.slice(0, slash) : a.traceId;
  const path = slash >= 0 ? ptr.slice(slash + 1) : "";
  // value = the exact cited text (note) when present, else the pointer itself.
  const value = a.note !== undefined && a.note.length > 0 ? a.note : ptr;
  return { obs, path, value };
}

/** GA-1 — the STRUCTURED evidence refs for a category = the failing annotations'
 *  cited structured refs (preferred), else a synthesized ref from the legacy
 *  pointer. REAL refs, in input order. */
function refsFor(list: TraceAnnotation[]): DiscoveryRef[] {
  const out: DiscoveryRef[] = [];
  for (const a of list) {
    if (a.label !== OutcomeVerdict.Fail) continue;
    if (a.refs !== undefined && a.refs.length > 0) out.push(...a.refs);
    else out.push(synthRef(a));
  }
  return out;
}

/**
 * Derive the full set of MINED criteria from real annotations: the existing
 * `deriveCriteria` output ENRICHED with the §5b unified metadata + the §5c DR-2
 * discovery-rationale, grounded in the actual support set. EVIDENCE-FIRST:
 *   - OBSERVED iff a failure was actually seen (fails>0) — cites the real failing
 *     refs + an honest `k/n sampled` prevalence; never promotes inferred→observed.
 *   - a pass-only category is INFERRED (good-practice guard, no failure yet).
 * PURE + deterministic (same ranking as deriveCriteria: support desc, id asc).
 */
export function deriveMinedCriteria(annotations: TraceAnnotation[]): MinedCriterion[] {
  const groups = groupByCategory(annotations);
  const base = deriveCriteria(annotations); // ranked; carries id/statement/judgeKind/judgeInputs/flag/support
  return base.map((c) => {
    const list = groups.get(c.id) ?? [];
    const fails = list.filter((a) => a.label === OutcomeVerdict.Fail).length;
    const total = list.length;
    const refs = refsFor(list);
    const firstNote = firstDefined(list, "note");

    const checkMethod = checkMethodFor(c.judgeKind);
    const grounding: GroundingValue = fails > 0 && refs.length > 0 ? Grounding.Observed : Grounding.Inferred;
    const severity = firstDefined(list, "severity") ?? severityFor(fails);

    const metadata: MetricMetadata = {
      generality: firstDefined(list, "generality") ?? generalityFor(checkMethod),
      dimension: firstDefined(list, "dimension") ?? MetricDimension.OperationCorrectness,
      level: firstDefined(list, "level") ?? MetricLevel.Output,
      check_method: checkMethod,
      substrate: substrateFor(checkMethod),
      applies_to: firstDefined(list, "appliesTo") ?? [],
      severity,
      judge_inputs: c.judgeInputs,
      flag: c.flag,
    };

    const discovery: DiscoveryRationale = {
      targets: `the '${c.id}' behavior/failure mode`,
      why_problem:
        fails > 0
          ? `failure mode observed${firstNote !== undefined ? ` (first-thing-wrong: ${firstNote})` : ""}`
          : "good-practice guard — no failure observed in the sample yet",
      evidence: {
        grounding,
        seen_in_traces: fails > 0,
        prevalence: `${fails}/${total} sampled`,
        refs: grounding === Grounding.Observed ? refs : [],
      },
      reasoning:
        `${fails}/${total} trace(s) in category '${c.id}'` +
        `${firstNote !== undefined ? `; first-thing-wrong: ${firstNote}` : ""} → criterion`,
      assumptions:
        grounding === Grounding.Observed
          ? [
              {
                text: "the observed failure recurs under the same template",
                status: "unverified",
                kind: AssumptionKind.FactualIntent,
              },
            ]
          : [
              {
                text: "preventive guard; no failure observed yet",
                status: "hypothesis",
                kind: AssumptionKind.Normative,
              },
            ],
      expected_impact: {
        severity,
        coverage: `${total} sampled trace(s)`,
        confidence: grounding === Grounding.Observed ? (fails >= 2 ? "high" : "med") : "low",
      },
      fix_or_eval: fixOrEvalFor(c.flag),
    };

    // UNIFORM STANDARD — carry the leaf-emitted executable code-check (when the
    // category is deterministically checkable) onto the criterion so the tier-0
    // pre-pass can run it. A pure judge category leaves it undefined.
    const codeEval = firstDefined(list, "codeEval");

    const mined: MinedCriterion = {
      ...c,
      metadata,
      discovery,
      ...(codeEval !== undefined ? { codeEval } : {}),
    };
    assertGroundingHonest(mined); // defensive — never ship inferred-as-observed
    return mined;
  });
}

/**
 * Saturation: the next round surfaced NO new category. `prev` is the cumulative
 * category set; `next` is the latest round's categories. Saturated iff every
 * category in `next` is already in `prev`.
 */
export function isSaturated(prev: string[], next: string[]): boolean {
  const seen = new Set(prev);
  return next.every((c) => seen.has(c));
}

/** The error-analysis target band: aim for 5-10 distinct categories. */
export function withinSaturationBand(categories: string[]): boolean {
  return categories.length >= 5 && categories.length <= 10;
}
