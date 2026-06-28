# mutagent-diagnostics — Overview

> **PRD-SO-01** · First reading for new users. This is the primer; `SKILL.md` is the
> manifest. Load `references/reference.md` next for the full architecture + dependency graph.

---

## What this skill does

`mutagent-diagnostics` is a diagnostics-on-tap skill for AI agents. Given access to your
agent traces (from Langfuse, OpenTelemetry, local JSONL, Claude Code transcripts, or Codex
transcripts), the skill runs a full RCA cycle and produces a gold-standard HTML report
covering every detected failure with ranked remedies, a two-rationale remedy card, a feedback
block grounded in operator chat and trace scores, and a copy-back markdown bundle you can
hand straight to an apply agent.

The skill operates as an inline orchestrator running inside your coding-agent session. It
dispatches up to five parallel Analyzer sub-agents, aggregates their structured findings,
enriches them deterministically, and renders the result. No external server, no subscription,
no separate process — the skill IS the orchestrator.

On first invocation the skill detects whether a config exists. If not, it walks you through
an eight-phase onboarding: source platform, target platform, ASK tool, schedule mode, and
trigger rules. Subsequent invocations go straight to the diagnostic pipeline.

---

## When to use it

| Trigger | Example | Outcome |
|---------|---------|---------|
| A user reported an agent failure | "my sample-email-agent returned wrong data" | Full RCA with WHAT/WHY/WHERE taxonomy, ranked remedies |
| Trace score dropped | Langfuse score fell below 0.6 | Cost-scoped analysis; coverage-proofed findings |
| You shipped a change and want a pre-release check | Before merging a prompt update | Structured findings vs declared success criteria (contract mode) |
| You suspect methodology drift in your diagnostics skill | Skill maintainer running self-diag | `[INTERNAL]` META-audience report; `--self-diag` flag |
| You want a neutral survey of the last 24h | No specific complaint | Window-based slicer; exploratory open-ended report |

**When NOT to use it:**
- Real-time alerting — the skill produces a point-in-time report, not a streaming monitor.
- Replacing your observability platform — the skill reads FROM your platform, not instead of it.
- Scheduling automated runs — v0.1 is on-demand only; see `references/workflows/schedule-prep.md`.

---

## Quick-start (5-minute onboarding)

### Step 1 — Install (one-time)

```bash
pnpx @mutagent/diagnostics init
```

This detects your runtime, copies required templates, and launches the onboarding wizard.

### Step 2 — Run the wizard

The onboarding wizard asks four questions:

1. **Source platform** — where your traces live (Langfuse / OTel / local JSONL / Claude Code / Codex).
2. **Target platform** — where your agent definitions live (e.g., `.claude/agents/` for Claude Code agents; `cloud-rest` for remote agents; `report-only` to skip apply entirely).
3. **ASK tool** — auto-detected from your runtime.
4. **Trigger rules** — which traces qualify for diagnosis (e.g., `score_below: 0.6`).

Config is saved to `<project>/.mutagent-diagnostics/config.yaml`. Secrets (API keys) live in
`<project>/.mutagentrc` (gitignored).

### Step 3 — Diagnose

In your coding-agent chat:

```
/mutagent-diagnostics
```

Or with a brief:

```
/mutagent-diagnostics "diagnose sample-email-agent focus on cost loops last 24h"
```

The brief is parsed into `{ agent, timeWindow, focus, residual }` by
`scripts/invocation/parse-brief.ts`. A `focus` directive activates Guided mode (the Guided
tab replaces Overview). No focus means a neutral survey.

### Step 4 — Review the report

The skill opens an HTML report in your browser. The report has four tab types:

- **Methodology [INTERNAL]** — how the diagnosis was run (orchestrator trace, decisions log).
- **Overview** — entity card, 6-tile big-stat row, 24h latency heatmap, findings table.
- **F-NNN tabs** — one per finding: severity badge, taxonomy chips, problem, evidence,
  why-chain, assumptions, coverage proof, ranked remedies.
- **Decisions** — live-preview markdown bundle; check remedies, add notes, click Copy.

### Step 5 — Apply

Paste the copied markdown bundle into your coding-agent chat. The apply worker spawns a
background agent on an isolated worktree, makes the changes, and opens a PR.

---

## Anatomy of a diagnostic report

For the full panel-by-panel anatomy — every block in the issue card, every element in the
remedy card, the live-preview mechanics — see:

```
references/workflows/rendering-anatomy.md
```

Key elements per finding panel:

| Block | Location | Notes |
|-------|----------|-------|
| Severity badge | Top-left | CRIT / HIGH / MED / INFO |
| Taxonomy chips | Below title | WHAT · WHY · WHERE · APPLY · AUDIENCE |
| Feedback block | Between Problem and Evidence | Color-coded by source (chat=cyan, score=yellow, external=purple). Only appears when `feedbackSources[]` is populated. |
| Why-chain | Below evidence | Causal steps; deepest marked `isOrigin: true` |
| Assumptions | Below why-chain | Verified / unverified / hypothesis-pending pills |
| Coverage proof | Below assumptions | 4-dim widget (latency, score, temporal, tool-trajectory); low confidence shows yellow banner |
| Remedy card | Per remedy | Two-rationale blocks (purple Why + cyan WhyWorks); diff grid; apply plan + instructions; notes textarea |

---

## What the skill does NOT do

- **Does not monitor continuously.** It runs on-demand or on a schedule you configure.
- **Does not auto-apply without approval.** Every apply goes through a HITL copy-back gate.
- **Does not hallucinate entity data.** The entity card is populated deterministically from
  trace metadata and your config — no LLM is involved in entity extraction.
- **Does not reveal PII.** The system prompt field in the entity card is always collapsed
  (explicit click to view) regardless of size.
- **Does not run self-diagnostics automatically.** `self_diagnostics.enabled` defaults to
  false; enabling it is a skill-maintainer opt-in.
- **Does not cross-reference other skills.** Each skill is a sealed unit.

---

## Glossary

| Term | Definition |
|------|------------|
| **Tier-0** | Static pattern scan (`scripts/tier0-scan.ts`) — runs BEFORE any LLM call to bound token cost. Measures cheap signals (latency distribution, error counts, score thresholds). |
| **RCA** | Root Cause Analysis — the 3-dimensional `(WHAT, WHY, WHERE)` failure taxonomy produced by the Analyzer agents. See `references/workflows/rca.md`. |
| **EntityContext** | Auto-extracted agent descriptor: name, model, system prompt, tool inventory with per-tool stats, input sample. Populated deterministically by the source-platform normalizer — no LLM. |
| **applyTarget** | The symbolic reference to the agent definition the remedy should be applied to (e.g., `.claude/agents/search-agent.md` for a local Claude agent). Declared by the Analyzer; rendered in the remedy meta strip. |
| **rationale** | The comparative remedy rationale block — WHY this remedy over alternatives (purple). Always visible, never collapsible. |
| **whyWorks** | The causal mechanism block — HOW the fix closes the failure (cyan). Always visible, never collapsible. |
| **coverageProof** | 4-dimensional sampling audit: for each of latency, score, temporal, and tool-trajectory, what fraction of the population buckets did the sample cover? Confidence mapped to high/med/low via 90/70 thresholds. |
| **Wave-6 methodology** | The diagnostic methodology layer (R2.1–R2.6 + D1/D2): mandatory LLM deep-read gate, awareness mini-sample, representative 4-bucket sampler, class-memory library, blind-spots taxonomy, and coverage proof. |
| **report-only** | A `target.platform` value that skips the apply gate entirely. Useful for read-only environments or when you want a report without committing to any changes. |
| **feedbackSources** | Structured list of operator feedback linked to a finding: chat messages (`chat`), Langfuse trace scores (`trace-score`), or external feedback platform entries (`external`). |

---

## Further reading (progressive disclosure)

| Doc | When to read |
|-----|-------------|
| `references/reference.md` | Full architecture DAG + complete TOC |
| `references/workflows/orchestrator-protocol.md` | The step-by-step diagnostic run procedure |
| `references/workflows/onboarding.md` | Onboarding phase-by-phase detail |
| `references/workflows/rca.md` | RCA taxonomy + finding shape |
| `references/workflows/rendering-anatomy.md` | Canonical per-finding + per-remedy anatomy |
| `references/principles.md` | 53 design principles (PR-001..PR-053) — the audit surface |
| `references/config.md` | Full config schema with doc strings and examples |
| `SKILL.md` | The manifest: §0 setup detection, §3 architecture, §4 bill of materials |
