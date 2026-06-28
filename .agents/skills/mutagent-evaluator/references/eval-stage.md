# `*eval` — the ADL EVAL-stage flow

> Source: the ADL lifecycle (SPEC → BUILD → **EVAL**). Load on demand.
> Drives `*eval` (the entry), and is the shared contract `*build-dataset` /
> `*build-evals` / `*evaluate` follow. PARENT-SESSION ONLY (AskUserQuestion).

The EVAL stage turns a freshly-`*build`-ed agent + its **agentspec** into a
trustworthy eval suite and runs it to a GATE verdict. It is the evaluator's ADL
entry-point: after `*build` hands over the built agent and the agentspec, `*eval`
interactively derives the dataset + the eval suite FROM the spec, lets the user
pick the eval ENGINE, and streams wireframe cards the whole way.

This file is the operational glue; the deep mechanics live in the existing
spine (`error-analysis.md` · `write-judge-prompt.md` · `validate-evaluator.md` ·
`generate-synthetic-data.md`). It adds the ADL-specific findings F7–F22.

---

## Inputs (from `*build`)

| Input | Shape | Used for |
|-------|-------|----------|
| the built agent | a target-framework impl (e.g. a Mastra/TS agent) OR a harness agent | the eval SUBJECT |
| `agentspec.definition.evals` | `{ success_criteria[], scenarios[], dataset_categories[] }` | dataset materialization (F8) + criteria |
| `agentspec.build` | `{ target_framework, runtime, target_eval_framework }` | the target-conditional engine fork (F9) |

The skill is **standalone** — it NEVER imports the agentspec schema. It consumes
a MINIMAL local slice (`scripts/contracts/agentspec-evals.ts` ·
`scripts/contracts/eval-engine.ts EngineTargetInput`) the caller maps from the
agentspec. No cross-skill import.

---

## Step 0 — interactive offer (F15)

After `*build`, OFFER the two derivations (AskUserQuestion, parent session only):

1. **`*build-dataset`** — materialize + grow the golden dataset from the spec.
2. **`*build-evals`** — build the eval suite (and pick the engine).

Let the user run either/both. They are independent; `*evaluate` consumes both.

**Dataset gate (dogfood H5).** `*evaluate` REQUIRES a materialized dataset. If `*build-evals` runs
(or `*evaluate` is invoked) with no dataset present, do NOT dead-end — auto-route to `*build-dataset`
(interactive) first, then resume. Never leave the user with an eval suite and nothing to run it on.

---

## Step 0.5 — Ground in what the agent DOES, first (dogfood H2)

BEFORE asking ANY eval-config question (engine, runtime, models), surface the SUBJECT: read the
agent's `jobs_to_be_done` + `scenarios` + `success_criteria` from the spec and CONFIRM with the user
which use-cases matter for this eval. Understand what the agent does and what "good" means for it
BEFORE scoping the eval target — never lead with framework/runtime config. The confirmed use-cases
scope everything downstream (dataset categories, judge criteria, the engine fork below).

---

## Step 1 — the ENGINE FORK (F7 / F9 / F14)

`*build-evals` (and the eval-impl half of `*eval`) MUST ASK the eval
implementation MODE before building anything. Use
`scripts/eval-engine.ts chooseEvalEngineOptions(target)`:

| Engine | What | Dependency (SURFACED up front) | Portable? |
|--------|------|--------------------------------|-----------|
| **Path A `native-matrix`** | mutagent native eval-matrix + LLM-judge SUB-AGENTS | **needs a Claude-Code host** to spawn judges; on a CODE-framework target ALSO needs the built agent to **emit logs/traces to a known sink** for the judge to read | NO |
| **Path B `code-written`** | evals in the target's OWN language (bun/TS): code-checks + LLM-judge via SDK + criteria checks | none — runs WITHOUT Claude Code | YES |

**Target-conditional (F9).** A code FRAMEWORK target (mastra · langgraph ·
pydantic-ai) offers BOTH engines; a `harness:*` target (`harness:claude-code`,
`harness:codex`) is **native-only** (no target language to write portable evals
into) — `assertEngineMatchesTarget` THROWS on `code-written` + harness.

**Surface the dependency BEFORE the choice (F7).** Each menu option carries
`requiresClaudeCode` + `requiresLogSink` + `portable` — render them in the
AskUserQuestion preview so a user is NEVER silently "stuck with the matrix".

**F14 — don't trap non-CC users.** `code-written` is the *recommended default*
for a code framework. It compiles via `scripts/codegen-evals.ts codegenEvalSuite`
to a self-contained suite source the user runs directly; the only LLM path is
THEIR provider SDK (`judgeViaSdk`), never a CC sub-agent.

`resolveEvalEngine(choice, target)` → the `EvalEnginePlan` (`engine` ·
`requiresClaudeCode` · `requiresLogSink` · `outputSink` · `rationale`). The plan's
`outputSink` is always a discoverable path (the "outputs land in a discoverable
sink" success-gate).

**Don't over-ask the judge model (dogfood H4).** When the user has already chosen a HOST runtime
(Path A / Claude-Code host), DO NOT ask which judge model to use — default the judge to **Opus** (the
general judge; other models may be unavailable). Derive the judge from prior answers; only ask what
isn't already implied by the runtime choice. Collapse the eval-config chain to the minimal
un-inferable set — never re-prompt for something a previous answer already determined.

> **Native-on-a-code-framework requires the log sink (F9).** If the user picks
> Path A for a Mastra/TS target, the built agent MUST emit logs/traces to
> `plan.outputSink` (CC session transcripts or a declared log file) so the judge
> sub-agents have something to read. Confirm this is wired before dispatching
> judges — otherwise the matrix has no input.

---

## Step 2 — MATERIALIZE the dataset (F8)

`*build-dataset` MATERIALIZES real items, not just definitions. Use
`scripts/materialize-dataset.ts`:

- `materializeFromAgentspec(evals)` → ≥1 REAL `DatasetCase` per `dataset_category`
  + one per declared `edge_case` (flagged `edge_case: "true"`). The base item
  derives from a category-tagged scenario when present, else the category
  description ("seed, don't duplicate").
- `materializeToDataset(subject, evals, existing?)` → a schema-valid `Dataset`,
  merged MONOTONICALLY (re-materializing adds no duplicates; version bumps).

These seeds are then handed to the `dataset-builder` agent for synthetic
expansion (`generate-synthetic-data.md`); `build-dataset.ts` dedup/merge dedups
any overlap. **Success gate:** a dataset with ≥1 real item per category incl.
edge-cases.

---

## Step 3 — STREAM wireframe cards (F13 / F16 / F22)

Stream PROGRESS as wireframe cards for BOTH `*build-dataset` and `*build-evals`
(`scripts/render-build-cards.ts`):

- `renderBuildDatasetProgressCard` / `renderBuildEvalsProgressCard` — phase +
  progress bar + counters, emitted per phase (F13/F16).
- After each, emit the VERBOSE entity card (F22): `renderDatasetEntityCard`
  (per-category breakdown · version · sink) · `renderEvalsEntityCard` (engine ·
  SURFACED CC/log-sink dependency · criteria).

---

## Step 4 — RUN + the SCORECARD DASHBOARD (F20)

`*evaluate` runs the suite vs the target:

- **Path A** — the existing `run-evaluate.ts` spine (PREP → dispatch
  `#mode-judge-trajectory` → aggregate → GATE).
- **Path B** — run the `codegen-evals.ts` suite (no Claude Code) and read back its
  scorecard JSON from `plan.outputSink`.

Either way, render the result as a DASHBOARD wireframe, NOT a flat dump:
`renderScorecardDashboard` — gate banner + per-criterion pass/fail BAR +
pass/fail/indeterminate split + variance + sample count (F20). (The 5-tab HTML
eval-report `render-eval-report.ts` is the rich artifact; the dashboard is the
terminal at-a-glance.)

---

## Success gates (the EVAL-stage definition of done)

- a dataset with **≥1 real item per category (incl. edge-cases)** — F8.
- the eval suite **runs and emits a scorecard dashboard** — F20.
- the **engine matches the target** (target-conditional gate) — F9.
- **Path B works without Claude Code** — F14.
- **outputs land in a discoverable sink** (`plan.outputSink`).

## Boundaries (held from the spine)

- **Judge-only, never fix (EV-051)** — flag + route failures to diagnostics.
- **Reviewer ≠ executor** — never grade a run the evaluator produced.
- **C-PIN** — pinned judge model + temp 0; masked scorecard byte-identical.
- **Standalone** — ships its own agents; no host architect/developer dependency.
- **Relative paths only** — every sink/path resolves relative to the installed
  `.claude/skills/mutagent-evaluator/` layout (a fresh install lives in a
  DIFFERENT repo); NO absolute `/Users/...` paths anywhere.
