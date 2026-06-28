/**
 * scripts/contract/types.ts
 * TypeScript types + TypeBox validation schema for self-diagnosis-contract.yaml.
 * Type A — Pure Script (type definitions + schema — no I/O side effects)
 *
 * PR-009 (single-source-of-truth): TypeBox schema co-located with interface.
 * Validates at parse time; fail-loud on schema mismatch.
 *
 * The contract is an OPT-IN structured-report surface. Targets that declare
 * self-diagnosis-contract.yaml at their root get structured 10-category reports;
 * targets without one get the open-ended pattern-match report (status quo).
 */

import { Type } from "@sinclair/typebox";
import type { SuccessCriteriaCategory } from "../normalize/trace.ts";

// ── Schema primitives ────────────────────────────────────────────────────────

const SuccessCriteriaCategorySchema = Type.Union([
  Type.Literal("operational"),
  Type.Literal("onboarding"),
  Type.Literal("behavioral"),
  Type.Literal("hitl"),
  Type.Literal("output"),
  Type.Literal("methodology"),
  Type.Literal("tier-performance"),
  Type.Literal("source-platform"),
  Type.Literal("target-platform"),
  Type.Literal("maintenance"),
]);

const EvidenceSourceSchema = Type.Union([
  Type.Literal("trace"),
  Type.Literal("commit"),
  Type.Literal("cmd-output"),
  Type.Literal("file:line"),
  Type.Literal("screenshot"),
]);

const CriterionSchema = Type.Object({
  id: Type.String(),
  statement: Type.String(),
  evidence_source: EvidenceSourceSchema,
});

const SuccessCriteriaEntrySchema = Type.Object({
  category: SuccessCriteriaCategorySchema,
  notes: Type.Optional(Type.String()),
  criteria: Type.Array(CriterionSchema),
});

const TriggerTypeSchema = Type.Union([
  Type.Literal("cli"),
  Type.Literal("api"),
  Type.Literal("event"),
  Type.Literal("chat"),
]);

const GateTypeSchema = Type.Union([
  Type.Literal("command-exit"),
  Type.Literal("metric-threshold"),
  Type.Literal("predicate"),
  Type.Literal("llm-judge"),
]);

const ScenarioSchema = Type.Object({
  id: Type.String(),
  trigger: Type.Object({
    type: TriggerTypeSchema,
    payload: Type.String(),
  }),
  expected: Type.String(),
  acceptance_gate: Type.Object({
    gate_type: GateTypeSchema,
    gate_spec: Type.String(),
  }),
});

const TrajectoryLogFormatSchema = Type.Object({
  schema: Type.Record(Type.String(), Type.Unknown()),
  default_landing_path: Type.String(),
});

const EvidenceLandingPathsSchema = Type.Object({
  test_report_yaml: Type.String(),
  trajectory_log_append_to: Type.String(),
  llm_judge_results_dir: Type.String(),
});

const AudienceTagHintSchema = Type.Object({
  finding_patterns: Type.Array(
    Type.Object({
      pattern: Type.String(),
      default_audience: Type.Union([
        Type.Literal("PRODUCT"),
        Type.Literal("META"),
        Type.Literal("CORE"),
      ]),
    })
  ),
});

const SkillClassSchema = Type.Union([
  Type.Literal("pure-procedural"),
  Type.Literal("orchestrator"),
  Type.Literal("tool-skill"),
  Type.Literal("meta-skill"),
]);

// ── Root schema ──────────────────────────────────────────────────────────────

export const SelfDiagnosisContractSchema = Type.Object({
  schema_version: Type.Literal("0.1.0"),
  skill: Type.Object({
    name: Type.String(),
    version: Type.String(),
    class: SkillClassSchema,
  }),
  success_criteria: Type.Array(SuccessCriteriaEntrySchema),
  scenarios: Type.Array(ScenarioSchema),
  trajectory_log_format: TrajectoryLogFormatSchema,
  evidence_landing_paths: EvidenceLandingPathsSchema,
  audience_tag_hints: Type.Optional(AudienceTagHintSchema),
});

// ── TypeScript interfaces ────────────────────────────────────────────────────

export interface SelfDiagnosisContract {
  schema_version: "0.1.0";
  skill: {
    name: string;
    version: string;
    class: "pure-procedural" | "orchestrator" | "tool-skill" | "meta-skill";
  };
  success_criteria: Array<{
    category: SuccessCriteriaCategory;
    notes?: string;
    criteria: Array<{
      id: string;
      statement: string;
      evidence_source: "trace" | "commit" | "cmd-output" | "file:line" | "screenshot";
    }>;
  }>;
  scenarios: Array<{
    id: string;
    trigger: { type: "cli" | "api" | "event" | "chat"; payload: string };
    expected: string;
    acceptance_gate: {
      gate_type: "command-exit" | "metric-threshold" | "predicate" | "llm-judge";
      gate_spec: string;
    };
  }>;
  trajectory_log_format: { schema: Record<string, unknown>; default_landing_path: string };
  evidence_landing_paths: {
    test_report_yaml: string;
    trajectory_log_append_to: string;
    llm_judge_results_dir: string;
  };
  audience_tag_hints?: {
    finding_patterns: Array<{
      pattern: string;
      default_audience: "PRODUCT" | "META" | "CORE";
    }>;
  };
}

