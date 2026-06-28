# mutagent-diagnostics — Skill Bundle

> **Audience: skill maintainers working inside this bundle.**
> For the end-user / install guide see the package-level
> [`mutagent-system/mutagent-diagnostics/README.md`](../../../README.md).

---

## What lives here

This directory is the skill bundle — the self-contained artifact published to GitHub Packages
as `@mutagent/diagnostics`. It is structured as an [agentskills.io](https://agentskills.io)
compliant skill, installable into any Claude Code, Codex, Cursor, or OpenCode session via
`pnpx @mutagent/diagnostics init`.

The canonical spec is `SKILL.md` (§0-§9, incl. §3.1 gold-standard report shape + §3.2 structured
contract mode). Everything else in this bundle is referenced from it.

---

## Bundle layout

```
mutagent-diagnostics/          ← this directory
│
├── SKILL.md                   ← operational contract §0-§9 (≤500 lines per PR-007)
├── .npmignore                 ← strips internal/ + *.test.ts on publish
│
├── scripts/                   ← Type A: pure bun scripts (deterministic, no agent reasoning)
│   ├── tier0-scan.ts          ← static scan — free cost gate before LLM (PR-001)
│   ├── tier0-scan.test.ts     ← unit tests [stripped on publish]
│   ├── slicer.ts              ← dynamic-cluster slicing, cap-of-5 (PR-005, PR-017)
│   ├── stale-detector.ts      ← hash compare before any write (PR-011)
│   ├── cli/
│   │   ├── init.ts            ← pnpx entrypoint + runtime detection (PR-021)
│   │   ├── install-agents.ts  ← idempotent agent .md installer
│   │   └── run.sh             ← bun → pnpm → npm → npx fallback (R-014-A)
│   ├── config/
│   │   ├── schema.ts          ← TypeBox schema — single source of truth (PR-009)
│   │   ├── load.ts            ← YAML parse + env-ref resolution
│   │   └── validate.ts        ← typed validation errors
│   ├── fetch/
│   │   ├── langfuse.ts        ← Langfuse trace fetch + filter
│   │   ├── claude-code-transcripts.sh  ← transcript discovery (bash, R-014-A)
│   │   └── assemble-meta.ts   ← meta-context assembly
│   ├── normalize/
│   │   ├── trace.ts           ← canonical types + EntityContext/SizedText/ToolInventoryEntry/Assumption (Wave-5)
│   │   └── platforms/         ← per-platform shape mappers (PR-016)
│   │       └── entity-context.ts ← shared deterministic EntityContext extractors (Wave-5 R1.7, no LLM)
│   ├── enrich/
│   │   └── build-render-input.ts ← Wave-5 R1.4 enricher → fully-populated RenderInput (Step 8.5, fail-loud)
│   ├── contract/
│   │   └── types.ts           ← TypeBox SelfDiagnosisContract schema (Wave-4 structured-report mode)
│   ├── report/
│   │   ├── render.ts          ← enriched RenderInput → gold-standard multi-tab HTML (PR-014/PR-029)
│   │   └── persist-selections.ts ← persist operator copy-back selections from the HITL gate
│   ├── lint/
│   │   └── template-inline-js.ts  ← R-007-B: reject TS in HTML <script> blocks
│   ├── setup/
│   │   ├── detect.ts          ← config presence + completeness check (§0)
│   │   └── reconfigure.ts     ← re-onboarding handler
│   ├── tier0/
│   │   ├── langfuse.ts        ← Langfuse-specific tier-0 patterns
│   │   └── claude-code.ts     ← Claude Code-specific tier-0 patterns
│   ├── validate/              ← finding shape validators
│   └── self-diagnostics/      ← [INTERNAL] probe.ts · dispatch.ts
│
├── assets/
│   ├── agents/
│   │   ├── diagnostics-analyzer.md      ← Type B: pure_subagent_executor
│   │   │                                   dispatched by parent at Step 6
│   │   └── diagnostics-apply-worker.md  ← Type B: isolation=worktree
│   │                                       dispatched by parent at Step 11
│   ├── templates/                       ← interpolated at runtime (shipped to users)
│   │   ├── report.html.tpl              ← gold-standard multi-tab report template (DO NOT add TS logic)
│   │   ├── config.yaml.tpl              ← onboarding config skeleton
│   │   ├── pr-body.md.tpl               ← apply PR description
│   │   ├── audit.json.tpl               ← structured audit trail (PR-013)
│   │   └── audit.md.tpl                 ← human-readable audit trail (PR-013)
│   └── wireframes/                      ← picker-UX wireframe prompts
│       ├── onboarding/                  ← WF-1.x onboarding flows
│       ├── diagnostics/                 ← WF-2.x diagnostics flows
│       └── optimization/                ← WF-3.x optimization flows
│
├── references/                ← load-on-demand docs (not pre-loaded in SKILL.md)
│   ├── reference.md           ← entry point + architecture + full dependency graph
│   ├── principles.md          ← PR-001..PR-043 — the audit surface for every PR
│   ├── operator-feedback-log.md ← append-only operator feedback on the report shape (Wave-5 R1.6)
│   ├── config.md              ← full config schema with doc strings
│   ├── operation-inventory.md ← Type A/B/C classification of every operation
│   ├── adapter-strategy.md    ← adapter Q1-Q6 locked decisions
│   ├── filter-search-matrix.md← per-platform Filter/Search coverage matrix
│   ├── harness-knowledge.md   ← platform knowledge table (expandable)
│   ├── onboarding-decisions.yaml ← phase decisions log
│   ├── open-questions.md      ← OQ-1..OQ-10 all resolved
│   ├── workflows/
│   │   ├── onboarding.md      ← 8-phase onboarding procedure
│   │   ├── orchestrator-protocol.md ← inline protocol (parent session = orchestrator)
│   │   ├── diagnostics.md     ← full diagnostic procedure + NL→filter translation
│   │   ├── apply-dispatch.md  ← apply mechanic per target class
│   │   ├── apply-pr-comment-format.md ← PR-023 Diagnostic Apply PR Comment format
│   │   ├── rca.md             ← RCA procedure + 3-dim taxonomy (WHAT/WHY/WHERE)
│   │   └── schedule-prep.md   ← wiring scheduling post-v0.1
│   ├── source-platforms/      ← CLI fetch + filter examples per platform
│   ├── target-platforms/      ← apply recipe + hyperlinks per target type
│   └── internal/
│       └── self-diagnostics.md ← [INTERNAL] PR-022 self-RCA playbook
│
├── examples/
│   └── sample-findings.json   ← example RCA output for reference
│
└── internal/                  ← [stripped on publish via .npmignore]
    └── templates/review/
        ├── README.md           ← decision tree for choosing a template
        ├── _brand-shell.html   ← empty branded scaffold (all primitives)
        ├── iteration-template.html  ← rich multi-phase approval
        ├── review-template.html     ← per-section lock-in + clipboard export
        ├── status-template.html     ← scroll-layout progress dashboard
        └── skill-overview-template.html ← 9-tab SKILL.md walkthrough
```

---

## Key invariants for contributors

| Principle | Rule |
|-----------|------|
| **PR-001** | `tier0-scan.ts` must run before any LLM call |
| **PR-004** | `diagnostics-apply-worker.md` must always use a git worktree; never edit operator's checkout |
| **PR-007** | `SKILL.md` must stay under 500 lines |
| **PR-009** | Config shape is owned by `scripts/config/schema.ts` (TypeBox); do not define it elsewhere |
| **PR-014** | `report.html.tpl` is the primary review surface; do not add destructive-action gates to the HTML itself |
| **PR-029** | The gold-standard report IS the product surface — `render.ts` panel functions must keep matching the `report.html.tpl` structure (CSS-class contract); template-stamp over procedural rendering |
| **R1 §9.3** | Fail-loud render contract — `render.ts` AND `build-render-input.ts` REFUSE (throw) when ≥3 of 4 internal shapes (`diagnosedEntity` / `bigStat` / `hourlyHeatmap` / `signalCensus`) are missing; never call the renderer on raw findings — always run the Step 8.5 enricher first |
| **R1.7** | Every normalizer emits a deterministic `EntityContext` at ingest (no LLM); the operator never hand-fills the entity card. Fields > 1 KB render as collapsed `ExpandableSection`; system prompt always collapsed (PII) |
| **R-014-A** | `.sh` scripts invoked via `exec bash`; no TS runtime required for shell operations |

---

## Orchestrator architecture

The orchestrator is **NOT a sub-agent** — it is the parent coding-agent session following
`references/workflows/orchestrator-protocol.md` inline.

Sub-agents are only the leaf workers:
- `diagnostics-analyzer.md` — dispatched per cluster (Step 6)
- `diagnostics-apply-worker.md` — spawned at the apply gate (Step 11)

This design exists because sub-agents in Claude Code/Codex cannot dispatch further sub-agents
or invoke `AskUserQuestion` — the parent session retains those capabilities.

---

## Publish

```bash
# Verify .npmignore correctly strips internal/
npm pack --dry-run | grep internal   # should be empty

# Lint + typecheck
bun run lint && bun run typecheck

# Test scripts
bun test ./.claude/skills/mutagent-diagnostics/scripts/
```

Registry: GitHub Packages (restricted). Not published to public npmjs.org.
Version: see `../../package.json` (`metadata.version` in SKILL.md frontmatter mirrors it).

---

## Brand tokens

All internal review templates share the MUTAGENT brand (from `internal/templates/review/`):

```css
--p: #a78bfa;   /* primary purple */
--c: #06b6d4;   /* cyan secondary */
--g: #10b981;   /* status green   */
--y: #f59e0b;   /* status yellow  */
--r: #ef4444;   /* status red     */
--m: #f0abfc;   /* magenta accents */
```

Logotype gradient: `linear-gradient(135deg, #a78bfa 0%, #06b6d4 100%)`.
Fonts: Space Grotesk (display) + IBM Plex Mono (code). Mermaid dark theme.

---

> For end-user documentation, see the package-level README at
> [`mutagent-system/mutagent-diagnostics/README.md`](../../../README.md).
