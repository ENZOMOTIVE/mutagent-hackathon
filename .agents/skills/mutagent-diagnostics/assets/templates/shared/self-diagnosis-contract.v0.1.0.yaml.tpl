# self-diagnosis-contract.yaml — FROZEN SCHEMA v0.1.0
# ═════════════════════════════════════════════════════════════════════════════
# This file is the inter-skill CONTRACT. Any skill that wants STRUCTURED
# (rather than open-ended) diagnostic reports about its own behavior ships a
# populated copy of this template at:
#
#     <skill-source-root>/self-diagnosis-contract.yaml
#
# A diagnostic skill (any tool that ingests traces and emits findings) MAY
# look for this file when targeting <skill>. If present → structured report
# per declared criteria. If absent → open-ended pattern-match (status quo).
#
# Schema is FROZEN at v0.1.0. Mid-flight changes FORBIDDEN. New versions ship
# as NEW filenames (self-diagnosis-contract.v0.2.0.yaml.tpl).
# ═════════════════════════════════════════════════════════════════════════════

schema_version: "0.1.0"

# ─── Subject identification ───────────────────────────────────────────────────
skill:
  name: "{{skill_name}}"                  # e.g. mutagent-some-skill (no leading @)
  version: "{{skill_version}}"            # semver
  class: "{{skill_class}}"                # one of: pure-procedural | orchestrator | tool-skill | meta-skill

# ─── 10-CATEGORY SUCCESS CRITERIA (Hybrid decomposition · operator-locked 2026-05-31) ──
#
# The 10 categories cover: Operational / Onboarding / Behavioral / HITL /
# Output / Methodology / Tier-performance / Source-platform health /
# Target-platform health / Maintenance.
#
# Each category contains a `criteria[]` array. Each criterion has:
#   id              — kebab-case stable identifier
#   statement       — binary observable assertion ("X happens")
#   evidence_source — one of: trace | commit | cmd-output | file:line | screenshot
#
# Producer skills evaluate per-criterion against the target's trace and emit
# a result per criterion: pass | fail | not-applicable | pending.
#
# Skills SHOULD declare ≥1 criterion per relevant category and MAY skip
# categories that don't apply to their class (e.g. tool-skill class has no
# HITL gates → leave category present with `criteria: []` and a `notes:` line).
# ─────────────────────────────────────────────────────────────────────────────
success_criteria:

  # ──── 1. OPERATIONAL ────────────────────────────────────────────────────────
  # Install / invoke / runtime / exit hygiene.
  - category: operational
    notes: "install / invoke / runtime detection / exit codes"
    criteria:
      - id: "{{op_criterion_1_id}}"
        statement: "{{op_criterion_1_statement}}"
        evidence_source: "{{op_criterion_1_evidence_source}}"
      # Append additional operational criteria as needed.

  # ──── 2. ONBOARDING ─────────────────────────────────────────────────────────
  # First-time UX / platform detection / config persistence.
  - category: onboarding
    notes: "first-invocation routing / platform detect / config persist"
    criteria:
      - id: "{{on_criterion_1_id}}"
        statement: "{{on_criterion_1_statement}}"
        evidence_source: "{{on_criterion_1_evidence_source}}"

  # ──── 3. BEHAVIORAL / AGENT HANDOFFS ───────────────────────────────────────
  # Dispatch → return / cap-of-5 fan-out / orphan check / sub-agent contracts.
  - category: behavioral
    notes: "agent dispatch + return + cap-of-5 + orphan check"
    criteria:
      - id: "{{bh_criterion_1_id}}"
        statement: "{{bh_criterion_1_statement}}"
        evidence_source: "{{bh_criterion_1_evidence_source}}"

  # ──── 4. HITL GATES ─────────────────────────────────────────────────────────
  # AskUserQuestion fires correctly + clipboard handoff (or platform-fallback).
  - category: hitl
    notes: "AskUserQuestion fires + clipboard handoff + chat-fallback works"
    criteria:
      - id: "{{hi_criterion_1_id}}"
        statement: "{{hi_criterion_1_statement}}"
        evidence_source: "{{hi_criterion_1_evidence_source}}"

  # ──── 5. OUTPUT ─────────────────────────────────────────────────────────────
  # Report schema / template-stamp discipline / payload contracts.
  - category: output
    notes: "output artifacts conform to declared schema; template-stamp not procedural"
    criteria:
      - id: "{{os_criterion_1_id}}"
        statement: "{{os_criterion_1_statement}}"
        evidence_source: "{{os_criterion_1_evidence_source}}"

  # ──── 6. METHODOLOGY HYGIENE ───────────────────────────────────────────────
  # Step 0 census, assumption enumeration, evidence grounding, recursive whys.
  - category: methodology
    notes: "Step 0 census + assumptions + evidence-grounded findings + recursive whys"
    criteria:
      - id: "{{me_criterion_1_id}}"
        statement: "{{me_criterion_1_statement}}"
        evidence_source: "{{me_criterion_1_evidence_source}}"

  # ──── 7. TIER / PERFORMANCE ────────────────────────────────────────────────
  # Tier 0 → LLM gating / budgets / cap-of-5 / relative thresholds (not hardcoded).
  - category: tier-performance
    notes: "Tier 0 scan before LLM + budgets + relative thresholds (no hardcoded ms/token)"
    criteria:
      - id: "{{tp_criterion_1_id}}"
        statement: "{{tp_criterion_1_statement}}"
        evidence_source: "{{tp_criterion_1_evidence_source}}"

  # ──── 8. SOURCE-PLATFORM HEALTH ────────────────────────────────────────────
  # For skills that consume external sources (traces, transcripts, JSONL etc).
  - category: source-platform
    notes: "if skill ingests sources: each source primitive normalizes correctly"
    criteria:
      - id: "{{sp_criterion_1_id}}"
        statement: "{{sp_criterion_1_statement}}"
        evidence_source: "{{sp_criterion_1_evidence_source}}"

  # ──── 9. TARGET-PLATFORM HEALTH ────────────────────────────────────────────
  # For skills that emit changes to external targets (local-agent .md / cloud REST etc).
  - category: target-platform
    notes: "if skill applies changes: each target adapter behaves per contract"
    criteria:
      - id: "{{tg_criterion_1_id}}"
        statement: "{{tg_criterion_1_statement}}"
        evidence_source: "{{tg_criterion_1_evidence_source}}"

  # ──── 10. MAINTENANCE ───────────────────────────────────────────────────────
  # doctor / self-diagnosis / audit emit / version-pin / SKILL.md frontmatter integrity.
  - category: maintenance
    notes: "doctor.ts + audit emit + version pinned + frontmatter intact"
    criteria:
      - id: "{{mt_criterion_1_id}}"
        statement: "{{mt_criterion_1_statement}}"
        evidence_source: "{{mt_criterion_1_evidence_source}}"

# ─── SCENARIO MATRIX ─────────────────────────────────────────────────────────
# Operator-runnable scenarios that exercise the skill end-to-end. A diagnostic
# tool consuming this contract attempts to MATCH trace evidence against each
# scenario's trigger pattern, then evaluates acceptance_gate.
#
# Each scenario:
#   id              — kebab-case unique id (e.g. s1-happy-path, s2-error-edge)
#   trigger         — what kicks the scenario off (CLI invocation / API call / event)
#   expected        — observable end-state (one-line description)
#   acceptance_gate — concrete verification: command exit / metric / predicate / llm-judge
# ─────────────────────────────────────────────────────────────────────────────
scenarios:
  - id: "{{scenario_1_id}}"
    trigger:
      type: "{{scenario_1_trigger_type}}"     # cli | api | event | chat
      payload: "{{scenario_1_trigger_payload}}" # literal invocation string
    expected: "{{scenario_1_expected}}"        # 1-line observable end-state
    acceptance_gate:
      gate_type: "{{scenario_1_gate_type}}"    # command-exit | metric-threshold | predicate | llm-judge
      gate_spec: "{{scenario_1_gate_spec}}"    # type-specific specification

  # Append additional scenarios. Recommended ≥3 (happy / edge / failure-mode).

# ─── TRAJECTORY LOG FORMAT ───────────────────────────────────────────────────
# Append-only log of captured invocations of THIS skill, in a shape that
# downstream diagnostic tools can ingest without transformation.
#
# Each trajectory entry:
#   invocation_id      — UUID stamped at invocation time
#   captured_at        — ISO8601 timestamp
#   scenario_id        — matches a scenarios[].id above OR "freeform"
#   trace_refs         — pointers to the underlying trace evidence
#   diagnostics_ingestable — true = no transformation needed; false = needs adapter
#   summary            — 1-sentence what happened
#   findings_count_by_audience — counts per PRODUCT/META/CORE audience tag
# ─────────────────────────────────────────────────────────────────────────────
trajectory_log_format:
  schema:
    invocation_id: "string (uuid v4)"
    captured_at: "string (ISO8601)"
    scenario_id: "string (matches scenarios[].id) | 'freeform'"
    trace_refs:
      langfuse_session: "string | null"
      playwright_trace: "string (path) | null"
      claude_code_session: "string (jsonl path) | null"
      otel_span: "string (span id) | null"
    diagnostics_ingestable: "boolean"
    summary: "string (≤1 sentence)"
    findings_count_by_audience:
      PRODUCT: "integer ≥0"
      META: "integer ≥0"
      CORE: "integer ≥0"

  # Default landing path. Skill may override to relocate within its source tree
  # but the SHAPE above is fixed (so diagnostic tools can ingest without
  # per-skill adapters).
  default_landing_path: "<skill-feature-dir>/trajectory-log.yaml"

# ─── EVIDENCE LANDING PATHS ─────────────────────────────────────────────────
# Where the producer skill should write structured artifacts when emitting
# a report against this contract.
# ─────────────────────────────────────────────────────────────────────────────
evidence_landing_paths:
  test_report_yaml: "{{landing_test_report_yaml}}"        # default: <skill-feature-dir>/test-report.yaml
  trajectory_log_append_to: "{{landing_trajectory_log}}"  # default: <skill-feature-dir>/trajectory-log.yaml
  llm_judge_results_dir: "{{landing_llm_judge_dir}}"      # default: <skill-feature-dir>/llm-judge-evals/

# ─── AUDIENCE TAG HINTS (optional) ──────────────────────────────────────────
# Guidance for producer skills' audience-tag classifiers (PRODUCT / META / CORE).
# Skill can supply patterns matching its own typical failure origins to help
# the classifier route findings correctly without operator override.
# ─────────────────────────────────────────────────────────────────────────────
audience_tag_hints:
  finding_patterns:
    - pattern: "{{audience_hint_1_pattern}}"          # regex on failureOrigin.where or .what
      default_audience: "{{audience_hint_1_audience}}" # one of: PRODUCT | META | CORE

# ═════════════════════════════════════════════════════════════════════════════
# Schema-freeze invariants (DO NOT VIOLATE)
# ═════════════════════════════════════════════════════════════════════════════
# 1. The 10 categories above are the COMPLETE canonical set for v0.1.0. No
#    skill may add or rename categories within this schema version. New
#    categories require a versioned bump (v0.2.0 — new file).
#
# 2. Each criterion's `evidence_source` MUST be one of the 5 allowed values:
#    trace | commit | cmd-output | file:line | screenshot. No free-form
#    evidence sources.
#
# 3. Each scenario's `gate_type` MUST be one of the 4 allowed values:
#    command-exit | metric-threshold | predicate | llm-judge.
#
# 4. trajectory_log_format.schema is the SHAPE producer skills must emit when
#    appending to a target's trajectory log. Adding fields is forbidden
#    within this version (forward-compat only via versioned bump).
#
# 5. audience tags are the 3 from the established taxonomy: PRODUCT (user-
#    visible behavior), META (methodology / discipline observations), CORE
#    (runtime engine / scripts / sub-agents).
# ═════════════════════════════════════════════════════════════════════════════
