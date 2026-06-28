/**
 * scripts/route-failures.ts — EV-051 route-failures (judge-only handoff).
 * ---------------------------------------------------------------------------
 * "A judge is only a judge." The evaluator FLAGS failures and ROUTES them to
 * diagnostics — it NEVER fixes. This emits a HandoverBundle for the diagnose
 * stage: the failing criteria become the acceptance criteria the downstream
 * diagnose stage must root-cause, and the failing traces/scorecard become the
 * enumerated `inputs` that cross the boundary.
 *
 * Sealed-sibling: the HandoverBundle shape is RE-IMPLEMENTED here (mirroring
 * the orchestrator's handover-contract.ts SHAPE), NEVER imported across the
 * package boundary. This is a one-way EMIT (the evaluator produces it; some
 * diagnose stage consumes it), not a shared frozen contract co-owned by both
 * packages — so it stays in-package rather than escalating to templates/.
 *
 * PURE + deterministic: provenance (produced_by/at) is INJECTED, never a
 * self-read clock, so the same input yields a byte-identical bundle. The
 * bundle is a CLOSED object (additionalProperties:false at every level) so a
 * smuggled undeclared field is caught by validateHandoverBundle.
 */
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  OutcomeVerdict,
  type CriterionFlagValue,
  type OutcomeVerdictValue,
  type VerdictBlock,
} from "./contracts/eval-types.ts";
import { maskedCanonicalJson } from "./mask.ts";

/** FROZEN contract version (in-package mirror; bump only via reviewed migration). */
export const HANDOVER_BUNDLE_VERSION = "0.1.0" as const;

export const AdlStage = {
  Build: "build",
  Evaluate: "evaluate",
  Diagnose: "diagnose",
  Improve: "improve",
  Audit: "audit",
} as const;
export type AdlStageValue = (typeof AdlStage)[keyof typeof AdlStage];

export const SubjectKind = { Skill: "skill", Agent: "agent" } as const;
export type SubjectKindValue = (typeof SubjectKind)[keyof typeof SubjectKind];

export const ArtifactKind = {
  Trace: "trace",
  Dataset: "dataset",
  Verdict: "verdict",
  Scorecard: "scorecard",
  Findings: "findings",
  Report: "report",
  Source: "source",
  Spec: "spec",
  Config: "config",
} as const;
export type ArtifactKindValue = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export const EscalationPolicy = {
  Escalate: "escalate",
  Abort: "abort",
  Proceed: "proceed",
} as const;
export type EscalationPolicyValue =
  (typeof EscalationPolicy)[keyof typeof EscalationPolicy];

// ── TypeBox schemas (closed objects — auditable boundary) ───────────────────
const SubjectSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal(SubjectKind.Skill), Type.Literal(SubjectKind.Agent)]),
    name: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const IntentSchema = Type.Object(
  { command: Type.String({ minLength: 1 }), utterance: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

const ArtifactRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal(ArtifactKind.Trace),
      Type.Literal(ArtifactKind.Dataset),
      Type.Literal(ArtifactKind.Verdict),
      Type.Literal(ArtifactKind.Scorecard),
      Type.Literal(ArtifactKind.Findings),
      Type.Literal(ArtifactKind.Report),
      Type.Literal(ArtifactKind.Source),
      Type.Literal(ArtifactKind.Spec),
      Type.Literal(ArtifactKind.Config),
    ]),
    path: Type.Optional(Type.String({ minLength: 1 })),
    uri: Type.Optional(Type.String({ minLength: 1 })),
    sha: Type.Optional(Type.String({ minLength: 1 })),
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const PartialLoadSchema = Type.Object(
  { path: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ContextPackSchema = Type.Object(
  {
    rules: Type.Array(Type.String()),
    memory: Type.Array(Type.String()),
    partial_loads: Type.Array(PartialLoadSchema),
  },
  { additionalProperties: false },
);

const AcceptanceSchema = Type.Object(
  { goal: Type.String({ minLength: 1 }), criteria: Type.Array(Type.String()) },
  { additionalProperties: false },
);

const ProvenanceSchema = Type.Object(
  { produced_by: Type.String({ minLength: 1 }), produced_at: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const HandoverBundleSchema = Type.Object(
  {
    bundle_version: Type.Literal(HANDOVER_BUNDLE_VERSION),
    adl_stage: Type.Union([
      Type.Literal(AdlStage.Build),
      Type.Literal(AdlStage.Evaluate),
      Type.Literal(AdlStage.Diagnose),
      Type.Literal(AdlStage.Improve),
      Type.Literal(AdlStage.Audit),
    ]),
    subject: SubjectSchema,
    intent: IntentSchema,
    inputs: Type.Array(ArtifactRefSchema),
    context_pack: ContextPackSchema,
    acceptance: AcceptanceSchema,
    provenance: ProvenanceSchema,
    escalation_policy: Type.Union([
      Type.Literal(EscalationPolicy.Escalate),
      Type.Literal(EscalationPolicy.Abort),
      Type.Literal(EscalationPolicy.Proceed),
    ]),
  },
  { additionalProperties: false },
);
export type HandoverBundle = Static<typeof HandoverBundleSchema>;
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

const BundleChecker = TypeCompiler.Compile(HandoverBundleSchema);

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * One routed failure. NOTE: there is deliberately NO `fix`/`remediation`/
 * `patch` field — the evaluator is judge-only. The downstream diagnose stage
 * decides remedies; the evaluator only states WHAT failed and WHY (critique).
 */
export interface FailureRef {
  criterionId: string;
  severity: string;
  flag: CriterionFlagValue;
  traceId: string;
  result: OutcomeVerdictValue;
  critique: string;
  /** GA — set iff `result === uncertain` (indeterminate); types the calibration route. */
  blockedBy?: VerdictBlock;
}

/**
 * GA — partition routed rows by verdict: a true FAIL routes to diagnostics
 * (root-cause it), an INDETERMINATE (`uncertain`) routes to the CALIBRATION loop
 * (re-ground / operator-ratify / re-scope by `blockedBy.kind`) — NEVER to
 * diagnostics, because there is no confirmed defect to root-cause yet. PURE.
 */
export interface RoutingPartition {
  toDiagnostics: FailureRef[];
  toCalibrate: FailureRef[];
}
export function partitionRouting(failures: FailureRef[]): RoutingPartition {
  const toDiagnostics: FailureRef[] = [];
  const toCalibrate: FailureRef[] = [];
  for (const f of failures) {
    if (f.result === OutcomeVerdict.Uncertain) toCalibrate.push(f);
    else if (f.result === OutcomeVerdict.Fail) toDiagnostics.push(f);
    // pass rows never appear in a failure list; ignore defensively.
  }
  return { toDiagnostics, toCalibrate };
}

/** GA — one calibration-loop item for an indeterminate verdict. The route is the
 *  `blockedBy.kind`: factual-intent→re-ground · normative→operator · scope→re-scope. */
export interface CalibrationItem {
  criterionId: string;
  severity: string;
  traceId: string;
  blockedBy: VerdictBlock;
  route: "re-ground" | "operator" | "re-scope";
}
const KIND_ROUTE: Record<string, CalibrationItem["route"]> = {
  "factual-intent": "re-ground",
  normative: "operator",
  scope: "re-scope",
};
export function calibrationItems(failures: FailureRef[]): CalibrationItem[] {
  return partitionRouting(failures).toCalibrate.map((f) => {
    const blockedBy: VerdictBlock = f.blockedBy ?? {
      kind: "factual-intent",
      text: f.critique,
    };
    return {
      criterionId: f.criterionId,
      severity: f.severity,
      traceId: f.traceId,
      blockedBy,
      route: KIND_ROUTE[blockedBy.kind] ?? "re-ground",
    };
  });
}

export interface RouteFailuresInput {
  subject: { kind: SubjectKindValue; name: string; path: string };
  failures: FailureRef[];
  artifacts: ArtifactRef[];
  /** INJECTED provenance — never a self-read clock (determinism). */
  producedBy: string;
  producedAt: string;
  escalationPolicy?: EscalationPolicyValue;
  /** optional curated context that crossed the boundary. */
  contextRules?: string[];
  contextMemory?: string[];
  partialLoads?: { path: string; reason: string }[];
}

/**
 * Build the diagnose-stage HandoverBundle for the routed failures. Judge-only:
 * no remedy is emitted — the failing criteria become the acceptance criteria
 * the diagnose stage must root-cause. PURE + deterministic.
 */
export function routeFailures(input: RouteFailuresInput): HandoverBundle {
  // GA — only true FAILs are root-causable defects. Indeterminates route to the
  // calibration loop (see `calibrationItems`), never into a diagnose handoff.
  const criteria = partitionRouting(input.failures).toDiagnostics.map(
    (f) =>
      `${f.criterionId} [${f.severity}/${f.flag}] FAILED on trace ${f.traceId}: ${f.critique}`,
  );
  return {
    bundle_version: HANDOVER_BUNDLE_VERSION,
    adl_stage: AdlStage.Diagnose,
    subject: { kind: input.subject.kind, name: input.subject.name, path: input.subject.path },
    intent: { command: "*diagnose" },
    inputs: input.artifacts,
    context_pack: {
      rules: input.contextRules ?? [],
      memory: input.contextMemory ?? [],
      partial_loads: input.partialLoads ?? [],
    },
    acceptance: {
      goal:
        "Root-cause the routed eval failures. JUDGE-ONLY handoff: the evaluator " +
        "flags + routes, it does not repair — the diagnose stage owns the " +
        "downstream repair.",
      criteria,
    },
    provenance: { produced_by: input.producedBy, produced_at: input.producedAt },
    escalation_policy: input.escalationPolicy ?? EscalationPolicy.Escalate,
  };
}

/**
 * MASK-ON-HANDOFF (carry). Serialize the handover bundle for EMIT through the
 * byte-identity masker (`mask.ts`): `provenance.produced_at` (an injected
 * timestamp) → `<TS>` and any absolute home path that slipped into an artifact
 * locator → `<ABSPATH>`. RELATIVE artifact paths survive untouched (they are
 * portable, not a leak).
 *
 * WHY: the evaluator's OWN diagnose handoff is itself a run-bundle the data-leak
 * audit inspects. An un-masked `produced_at` + abs home path is exactly the
 * operational leak the audit flags — so the evaluator dogfoods its own audit by
 * masking on emit. It also preserves C-PIN: two runs (or two machines) that
 * differ ONLY in timestamp / home-root serialize to a BYTE-IDENTICAL handoff.
 *
 * The in-memory `routeFailures` bundle keeps its real values (the structured
 * object is unchanged); ONLY the emitted serialization is masked.
 */
export function serializeHandoverBundle(bundle: HandoverBundle): string {
  return maskedCanonicalJson(bundle);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a candidate bundle against the closed contract + the "every
 * artifact has at least one locator (path|uri)" rule TypeBox alone can't
 * express. A smuggled undeclared field fails (additionalProperties:false).
 */
export function validateHandoverBundle(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  if (!BundleChecker.Check(candidate)) {
    for (const e of BundleChecker.Errors(candidate)) {
      errors.push(`${e.path}: ${e.message}`);
    }
    return { ok: false, errors };
  }
  const bundle = candidate as HandoverBundle;
  bundle.inputs.forEach((a, i) => {
    if (a.path === undefined && a.uri === undefined) {
      errors.push(`inputs/${i}: artifact '${a.id}' has neither path nor uri`);
    }
  });
  return { ok: errors.length === 0, errors };
}
