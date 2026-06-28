# mutagent-diagnostics — Reference Entry Point

> Load this first. It provides the full architecture diagram, dependency graph, and TOC for all reference docs.

## Architecture DAG

> The Orchestrator is **NOT a sub-agent** — it is the parent coding-agent session following
> `references/workflows/orchestrator-protocol.md` inline (PR-024; the retired
> `diagnostics-orchestrator.md` is archived). The only sub-agents are the leaf workers
> (analyzer + apply-worker).

```mermaid
flowchart TD
  USER[Operator in coding agent] -->|invoke| SKILL[mutagent-diagnostics SKILL.md]
  SKILL -->|§0 setup detect| DETECT{config present?}
  DETECT -->|NO| ONB[Onboarding — references/workflows/onboarding.md]
  DETECT -->|YES| ORCH[Orchestrator — parent session\nreferences/workflows/orchestrator-protocol.md]
  ONB --> CFG[config.yaml + .mutagentrc]
  CFG --> SKILL
  ORCH -->|Bash CLI / file read| SRC[Source Platform — references/source-platforms/]
  ORCH -->|bun tier0-scan.ts| TIER0[Tier 0 SCRIPT — scripts/tier0-scan.ts]
  ORCH -->|normalize + extract EntityContext| NORM[Normalizers — scripts/normalize/platforms/*.ts\n+ entity-context.ts R1.7]
  TIER0 -->|bun slicer.ts| SLICE[Slicer SCRIPT — scripts/slicer.ts]
  ORCH -->|Agent dispatch| ANL[N Analyzers ≤5 — assets/agents/diagnostics-analyzer.md]
  ANL --> ORCH
  ORCH -->|LLM RCA reasoning| TL[RCA Layer — references/workflows/rca.md]
  TL -->|Step 8.5: bun build-render-input.ts| ENRICH[Enricher — scripts/enrich/build-render-input.ts\ndeterministic · fail-loud]
  NORM -->|EntityContext| ENRICH
  ENRICH -->|bun render.ts| REPORT[report.html — assets/templates/report.html.tpl\ngold-standard multi-tab]
  REPORT --> COPY{Operator pastes copy-back markdown}
  COPY -->|approved| APPLY[Apply Worker BG — assets/agents/diagnostics-apply-worker.md]
  APPLY -->|git+gh| LOCAL[Local Target — references/target-platforms/]
  APPLY -->|curl PUT| REMOTE[Remote Target — references/target-platforms/cloud-rest.md]
```

## Dependency Graph

```mermaid
flowchart LR
  SKILL[SKILL.md] --> RF[reference.md]
  SKILL --> RW0[workflows/orchestrator-protocol.md\nStep 8.5 = build render input]
  SKILL --> RW1[workflows/onboarding.md]
  SKILL --> RW2[workflows/diagnostics.md]
  SKILL --> RW3[workflows/apply-dispatch.md]
  SKILL --> RW4[workflows/rca.md]
  SKILL --> RP[principles.md]
  SKILL --> RFL[operator-feedback-log.md]
  SKILL --> ROP[operation-inventory.md]
  SKILL --> RAS[adapter-strategy.md]
  SKILL --> RFS[filter-search-matrix.md]
  SKILL --> RHK[harness-knowledge.md]
  SKILL --> RC[config.md]
  SKILL --> ROQ[open-questions.md]
  SKILL --> AG2[agents/diagnostics-analyzer.md]
  SKILL --> AG3[agents/diagnostics-apply-worker.md]

  RW1 --> RS[source-platforms/*.md]
  RW1 --> RT[target-platforms/*.md]
  RW0 --> RW2
  RW0 --> RW4
  RW2 --> RW4
  RW2 --> RS
  RW3 --> RT

  RS -.->|hyperlinks| EXT1[Upstream platform docs]
  RT -.->|hyperlinks| EXT2[Upstream platform docs]

  AG2 --> RW2
  AG3 --> RW3

  T0[scripts/tier0-scan.ts] --> NT[scripts/normalize/trace.ts]
  SL[scripts/slicer.ts] --> NT
  EC[scripts/normalize/platforms/entity-context.ts] --> NT
  EN[scripts/enrich/build-render-input.ts] --> NT
  EN --> RR
  RR[scripts/report/render.ts] --> RHT[assets/templates/report.html.tpl]
  CT[scripts/contract/types.ts] --> RR
  CL[scripts/config/load.ts] --> CS[scripts/config/schema.ts]
  CV[scripts/config/validate.ts] --> CS
  SD[scripts/setup/detect.ts] --> CL
  SD --> CV
  NPL[scripts/normalize/platforms/*.ts] --> NT
  NPL --> EC
```

## Table of Contents

| Reference | Purpose |
|-----------|---------|
| `overview.md` | **Entry point for new users** — What/when/quick-start/glossary (PRD-SO-01) |
| `principles.md` | 53 Design Principles — PR-001 to PR-053 |
| `operator-feedback-log.md` | Append-only operator feedback on the report shape (Wave-5 R1.6) — the durable WHY behind the gold-standard renderer |
| `operation-inventory.md` | Type A/B/C operation classification |
| `adapter-strategy.md` | Adapter Q1-Q6 locked decisions |
| `filter-search-matrix.md` | Per-platform Filter/Search coverage matrix |
| `harness-knowledge.md` | Platform Knowledge Table (expandable) |
| `config.md` | Config schema with doc strings |
| `open-questions.md` | OQ-1..OQ-10 all resolved |
| `workflows/onboarding.md` | 8-phase onboarding procedure |
| `workflows/orchestrator-protocol.md` | Inline orchestrator protocol (parent session); Step 8.5 builds the render input via the enricher |
| `workflows/diagnostics.md` | Full diagnostic procedure + NL→filter |
| `workflows/apply-dispatch.md` | Apply mechanic (local-agent/code-construct/remote) |
| `workflows/rca.md` | RCA layer procedure + 3-dim taxonomy |
| `workflows/verification-methodology.md` | Background Investigator finding false-positive audit (5 tiers + AuditVerdict + per-source cache-detection); on-demand, improvable |
| `workflows/rendering-anatomy.md` | Canonical per-finding + per-remedy panel anatomy (PRD-CC-12) |
| `workflows/schedule-prep.md` | How to wire scheduling post-v0.1 |
| `source-platforms/langfuse.md` | Langfuse CLI fetch + filter examples |
| `source-platforms/otel.md` | OpenTelemetry OTLP pull + queries |
| `source-platforms/local-jsonl.md` | Local JSONL file read patterns |
| `source-platforms/claude-code-transcripts.md` | Claude Code session transcript format |
| `source-platforms/codex-transcripts.md` | Codex session transcript format |
| `target-platforms/local-claude.md` | .claude/agents/*.md apply recipe |
| `target-platforms/local-codex.md` | .codex/agents/*.md apply recipe |
| `target-platforms/local-cursor.md` | Cursor agent dir apply |
| `target-platforms/local-opencode.md` | OpenCode agent dir apply |
| `target-platforms/local-mastra.md` | Mastra code-construct apply |
| `target-platforms/local-cloud-agent-sdk.md` | Cloud Agent SDK apply |
| `target-platforms/cloud-rest.md` | REST PUT with idempotency |
| `internal/self-diagnostics.md` | [INTERNAL] PR-022 self-diagnostics playbook |
