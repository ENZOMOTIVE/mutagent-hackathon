/**
 * scripts/self-audit.ts — EV-055 the EVAL-OF-THE-EVAL deterministic core (Type A — Code-only).
 * ---------------------------------------------------------------------------
 * The evaluator audits its OWN eval-development artifacts — *is my judge
 * validated? is my dataset balanced? are my criteria grounded? is my suite
 * living?* — by running the `eval-audit` six-area diagnostic (S16) over the
 * evaluator's own output (S17 meta-skill). It REUSES the existing surfaces — it
 * consumes the `*validate` `ValidationResult[]`, the `*review` `HumanLabel[]`,
 * the `*discover` `DiscoveredCriterion[]`, and the living-suite provenance — it
 * does NOT rebuild a second auditor (`references/eval-audit.md`).
 *
 * Austerity (Type A): this core holds NO judge-prompt prose and makes NO
 * subjective pass/fail decision. It emits FINDING DATA — a deterministic
 * threshold check per area, exactly like `validate-judge.ts` emits a
 * `validated`/`unvalidated` status from TPR/TNR thresholds. The NUANCED
 * judgments (is this criterion *actionable* vs merely generic? does this judge
 * prompt target ONE failure mode?) are dispatched to the `audit-executor`
 * subagent (`*self-audit` mode, host-runtime, NO provider key) — Type B. The
 * overall "is the evaluator healthy?" verdict is the AGENT's, never this script's.
 *
 * PURE — no clock / random / network; same input → byte-identical report.
 */
import {
  CriterionFlag,
  JudgeKind,
  type DiscoveredCriterion,
} from "./contracts/eval-types.ts";
import {
  HumanVerdict,
  ValidationStatus,
  type HumanLabel,
  type ValidationResult,
} from "./contracts/validation.ts";
import { TARGET_TPR, TARGET_TNR } from "./validate-judge.ts";

// ── The six diagnostic areas (eval-audit S16) ───────────────────────────────
export const SelfAuditArea = {
  /** Area 1 — were criteria MINED from real ✓/✗ traces (vs brainstormed)? */
  ErrorAnalysis: "error-analysis",
  /** Area 2 — binary · failure-mode-specific · code-where-possible? */
  EvaluatorDesign: "evaluator-design",
  /** Area 3 — judges validated vs human labels (TPR/TNR · clean split)? */
  JudgeValidation: "judge-validation",
  /** Area 4 — domain experts · full traces · enough human labels to validate? */
  HumanReview: "human-review",
  /** Area 5 — enough + balanced labeled data (≥ per-class minimum)? */
  LabeledData: "labeled-data",
  /** Area 6 — suite living (never shrinks) · re-validated after model change? */
  PipelineHygiene: "pipeline-hygiene",
} as const;
export type SelfAuditAreaValue = (typeof SelfAuditArea)[keyof typeof SelfAuditArea];

/** Stable area ordering for the deterministic report sort (S16 order). */
const AREA_ORDER: SelfAuditAreaValue[] = [
  SelfAuditArea.ErrorAnalysis,
  SelfAuditArea.EvaluatorDesign,
  SelfAuditArea.JudgeValidation,
  SelfAuditArea.HumanReview,
  SelfAuditArea.LabeledData,
  SelfAuditArea.PipelineHygiene,
];

/** A finding's status — a DETERMINISTIC threshold outcome, NOT a subjective verdict. */
export const SelfAuditStatus = {
  /** a measured threshold was breached — the agent should act on it. */
  Problem: "problem",
  /** the deterministic check passed; the nuanced read is still the agent's. */
  Ok: "ok",
  /** the artifact needed to decide is absent — neither pass nor problem. */
  CannotDetermine: "cannot-determine",
} as const;
export type SelfAuditStatusValue = (typeof SelfAuditStatus)[keyof typeof SelfAuditStatus];

/** Severity = IMPACT on trustworthiness (not code size). Drives the report sort. */
export const SelfAuditSeverity = {
  /** blocks the whole trust chain (e.g. zero labels ⇒ no judge can be validated). */
  Crit: "crit",
  /** a judge/criterion the suite relies on is untrustworthy. */
  High: "high",
  /** a quality smell that widens CIs / weakens coverage. */
  Med: "med",
  /** advisory hygiene. */
  Low: "low",
} as const;
export type SelfAuditSeverityValue = (typeof SelfAuditSeverity)[keyof typeof SelfAuditSeverity];

/** Higher rank sorts FIRST (most impactful finding leads the report). */
const SEVERITY_RANK: Record<SelfAuditSeverityValue, number> = {
  [SelfAuditSeverity.Crit]: 3,
  [SelfAuditSeverity.High]: 2,
  [SelfAuditSeverity.Med]: 1,
  [SelfAuditSeverity.Low]: 0,
};

/** One deterministic finding — DATA, never judge prose. */
export interface SelfAuditFinding {
  area: SelfAuditAreaValue;
  status: SelfAuditStatusValue;
  severity: SelfAuditSeverityValue;
  /** the criterion/judge this finding concerns, when scoped to one. */
  subjectId?: string;
  /** the measured fact (a signal string: "tpr 0.82 < 0.90 target"), NOT a verdict. */
  signal: string;
}

/** The per-class minimum labeled examples for a reliable TPR/TNR (eval-audit Area 5). */
export const MIN_LABELS_PER_CLASS = 50;

/** The eval-development artifacts the self-audit reasons over (all REUSED, none rebuilt). */
export interface SelfAuditInput {
  /** the `*discover` output — Areas 1 + 2. */
  criteria?: DiscoveredCriterion[];
  /** the `*validate` output, one per calibrated judge — Area 3. */
  validations?: ValidationResult[];
  /** the `*review` human labels — Areas 4 + 5. */
  labels?: HumanLabel[];
  /** living-suite size before→after a `*derive-dataset` / `*discover` append — Area 6. */
  suiteGrowth?: { beforeCount: number; afterCount: number };
  /** judge-pin hygiene — did the model change without a re-validation? Area 6. */
  pinHygiene?: { modelChanged: boolean; revalidatedAfterChange: boolean };
}

/** The eval-of-the-eval report — findings ordered by impact + per-area/-status tallies. */
export interface SelfAuditReport {
  /** findings, sorted most-impactful first (severity desc → area order → subjectId). */
  findings: SelfAuditFinding[];
  /** the areas that surfaced at least one `problem` finding. */
  areasWithProblems: SelfAuditAreaValue[];
  /** deterministic tallies for the rollup. */
  totals: {
    problem: number;
    ok: number;
    cannotDetermine: number;
    crit: number;
    high: number;
  };
}

// ── Area 1 — Error Analysis (were criteria mined from real ✓/✗ evidence?) ─────

/**
 * A criterion with ZERO support count was not surfaced by an actual ✓/✗ split —
 * a brainstormed-not-observed smell (eval-audit Area 1). PURE.
 */
export function auditErrorAnalysis(criteria: DiscoveredCriterion[]): SelfAuditFinding[] {
  return criteria
    .filter((c) => c.supportCount <= 0)
    .map((c) => ({
      area: SelfAuditArea.ErrorAnalysis,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.High,
      subjectId: c.id,
      signal: `criterion supportCount=0 — ungrounded (no ✓/✗ trace evidence); brainstormed-not-observed`,
    }));
}

// ── Area 2 — Evaluator Design (code-before-judge: not all-LLM) ───────────────

/**
 * Among the eval-worthy criteria, if NONE is code-based the suite likely
 * over-relies on LLM judges where a deterministic check would do (eval-audit
 * Area 2 — "code where possible"). Binary-not-Likert + one-failure-mode are
 * invariants by construction; the nuanced "is THIS one objectively checkable?"
 * read is the agent's. PURE.
 */
export function auditEvaluatorDesign(criteria: DiscoveredCriterion[]): SelfAuditFinding[] {
  const evalWorthy = criteria.filter((c) => c.flag === CriterionFlag.EvalWorthy);
  if (evalWorthy.length === 0) return [];
  const codeBased = evalWorthy.filter((c) => c.judgeKind === JudgeKind.Code);
  if (codeBased.length > 0) return [];
  return [
    {
      area: SelfAuditArea.EvaluatorDesign,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.Med,
      signal:
        `${evalWorthy.length} eval-worthy criteria, 0 code-based — possible over-reliance ` +
        `on LLM judges; reserve judges for interpretation, use code for objective checks`,
    },
  ];
}

// ── Area 3 — Judge Validation (validated vs human labels, TPR/TNR ≥ target) ───

/**
 * A judge is trustworthy only when its `*validate` result is `validated` AND its
 * TPR/TNR clear the target (eval-audit Area 3). Consumes the `ValidationResult[]`
 * straight from `*validate` (EV-044) — no recompute. PURE.
 */
export function auditJudgeValidation(validations: ValidationResult[]): SelfAuditFinding[] {
  const findings: SelfAuditFinding[] = [];
  for (const v of validations) {
    if (v.status === ValidationStatus.Unvalidated) {
      findings.push({
        area: SelfAuditArea.JudgeValidation,
        status: SelfAuditStatus.Problem,
        severity: SelfAuditSeverity.High,
        subjectId: v.criterionId,
        signal: `judge status=unvalidated (labelCount=${v.labelCount}) — verdicts bias-corrected, not trusted raw`,
      });
      continue;
    }
    const lowTpr = v.tpr !== null && v.tpr < TARGET_TPR;
    const lowTnr = v.tnr !== null && v.tnr < TARGET_TNR;
    if (lowTpr || lowTnr) {
      findings.push({
        area: SelfAuditArea.JudgeValidation,
        status: SelfAuditStatus.Problem,
        severity: SelfAuditSeverity.High,
        subjectId: v.criterionId,
        signal:
          `judge below target: tpr=${fmt(v.tpr)} (≥${TARGET_TPR}) · ` +
          `tnr=${fmt(v.tnr)} (≥${TARGET_TNR})`,
      });
    }
  }
  return findings;
}

/**
 * Every eval-worthy LLM/hybrid criterion SHOULD have a validation result; one
 * with no `ValidationResult` at all has an uncalibrated judge (eval-audit Area 3).
 * PURE.
 */
export function auditUncalibratedJudges(
  criteria: DiscoveredCriterion[],
  validations: ValidationResult[],
): SelfAuditFinding[] {
  const calibrated = new Set(validations.map((v) => v.criterionId));
  return criteria
    .filter(
      (c) =>
        c.flag === CriterionFlag.EvalWorthy &&
        (c.judgeKind === JudgeKind.Llm || c.judgeKind === JudgeKind.Hybrid) &&
        !calibrated.has(c.id),
    )
    .map((c) => ({
      area: SelfAuditArea.JudgeValidation,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.High,
      subjectId: c.id,
      signal: `${c.judgeKind} judge has NO validation result — uncalibrated; run *validate before trusting it`,
    }));
}

// ── Area 4 — Human Review (any ground-truth labels at all?) ──────────────────

/** Non-deferred Pass/Fail labels — the calibration ground truth. */
function decidedLabels(labels: HumanLabel[]): HumanLabel[] {
  return labels.filter((l) => l.label !== HumanVerdict.Defer);
}

/**
 * With zero decided human labels NO judge can be validated — the trust chain is
 * broken at the root (eval-audit Area 4). CRIT. PURE.
 */
export function auditHumanReview(labels: HumanLabel[]): SelfAuditFinding[] {
  if (decidedLabels(labels).length > 0) return [];
  return [
    {
      area: SelfAuditArea.HumanReview,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.Crit,
      signal: `0 decided human labels (Pass/Fail) — no ground truth; *validate cannot calibrate any judge`,
    },
  ];
}

// ── Area 5 — Labeled Data (enough + balanced per class) ──────────────────────

/**
 * Reliable TPR/TNR needs ≥ MIN_LABELS_PER_CLASS of EACH class; a Fail-starved
 * set can't measure TNR (eval-audit Area 5). Skipped (cannot-determine) when
 * there are no labels at all — that gap is Area 4's CRIT, not double-counted
 * here. PURE.
 */
export function auditLabeledData(labels: HumanLabel[]): SelfAuditFinding[] {
  const decided = decidedLabels(labels);
  if (decided.length === 0) {
    return [
      {
        area: SelfAuditArea.LabeledData,
        status: SelfAuditStatus.CannotDetermine,
        severity: SelfAuditSeverity.Low,
        signal: `no labels to measure balance (see human-review CRIT)`,
      },
    ];
  }
  const pass = decided.filter((l) => l.label === HumanVerdict.Pass).length;
  const fail = decided.filter((l) => l.label === HumanVerdict.Fail).length;
  if (pass >= MIN_LABELS_PER_CLASS && fail >= MIN_LABELS_PER_CLASS) return [];
  return [
    {
      area: SelfAuditArea.LabeledData,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.Med,
      signal:
        `insufficient/imbalanced labels: ${pass} Pass / ${fail} Fail ` +
        `(need ≥${MIN_LABELS_PER_CLASS} of each for reliable TPR/TNR)`,
    },
  ];
}

// ── Area 6 — Pipeline Hygiene (living suite · re-validate on model change) ────

/**
 * A living suite NEVER shrinks (EV-053), and a judge-model change forces a
 * re-validation (C-PIN). Either violation is an Area-6 finding. PURE.
 */
export function auditPipelineHygiene(input: SelfAuditInput): SelfAuditFinding[] {
  const findings: SelfAuditFinding[] = [];
  const g = input.suiteGrowth;
  if (g && g.afterCount < g.beforeCount) {
    findings.push({
      area: SelfAuditArea.PipelineHygiene,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.Crit,
      signal: `suite shrank ${g.beforeCount}→${g.afterCount} — monotonic-growth violation (EV-053)`,
    });
  }
  const p = input.pinHygiene;
  if (p && p.modelChanged && !p.revalidatedAfterChange) {
    findings.push({
      area: SelfAuditArea.PipelineHygiene,
      status: SelfAuditStatus.Problem,
      severity: SelfAuditSeverity.High,
      signal: `judge model changed without re-validation — stale calibration (C-PIN)`,
    });
  }
  return findings;
}

// ── The aggregate eval-of-the-eval ───────────────────────────────────────────

/**
 * Run the six-area diagnostic over the evaluator's own eval-dev artifacts and
 * assemble the findings into an impact-ordered report. DETERMINISTIC: findings
 * sort by severity (desc) → area order → subjectId, so the same input yields a
 * byte-identical report. Emits DATA only — the nuanced read + overall verdict
 * are the `audit-executor` agent's (Type B). PURE.
 */
export function selfAudit(input: SelfAuditInput): SelfAuditReport {
  const criteria = input.criteria ?? [];
  const validations = input.validations ?? [];
  const labels = input.labels ?? [];

  const findings: SelfAuditFinding[] = [
    ...auditErrorAnalysis(criteria),
    ...auditEvaluatorDesign(criteria),
    ...auditJudgeValidation(validations),
    ...auditUncalibratedJudges(criteria, validations),
    ...auditHumanReview(labels),
    ...auditLabeledData(labels),
    ...auditPipelineHygiene(input),
  ];

  findings.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const area = AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area);
    if (area !== 0) return area;
    return (a.subjectId ?? "").localeCompare(b.subjectId ?? "");
  });

  const problems = findings.filter((f) => f.status === SelfAuditStatus.Problem);
  const areasWithProblems = AREA_ORDER.filter((area) =>
    problems.some((f) => f.area === area),
  );

  return {
    findings,
    areasWithProblems,
    totals: {
      problem: problems.length,
      ok: findings.filter((f) => f.status === SelfAuditStatus.Ok).length,
      cannotDetermine: findings.filter((f) => f.status === SelfAuditStatus.CannotDetermine)
        .length,
      crit: findings.filter((f) => f.severity === SelfAuditSeverity.Crit).length,
      high: findings.filter((f) => f.severity === SelfAuditSeverity.High).length,
    },
  };
}

/** Format a nullable rate for a signal string (deterministic). */
function fmt(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(2);
}
