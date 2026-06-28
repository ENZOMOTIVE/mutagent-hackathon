# Orchestrator Protocol — Parent-Session Dispatch FSM (agent-dispatch)

> **Authority**: SKILL.md §0 (Setup) + §0.1 (`*commands`) + §5 (agents). This is the
> inline procedure the PARENT SESSION runs once `*discover` / `*build-evals` /
> `*evaluate` is invoked under the DEFAULT **agent-dispatch** substrate.
>
> **Why this file exists.** Claude Code leaf subagents cannot dispatch other
> subagents (the `Agent` tool) or invoke `AskUserQuestion`. Coordinator-class
> orchestration therefore MUST run in the PARENT SESSION — the one that invoked
> the skill. The evaluator's judging is performed BY an Evaluator agent on the
> host runtime, mass-dispatched for throughput (the SHAPE diagnostics uses,
> mirrored here — never source-referenced; sealed-sibling).
>
> **Operator correction (2026-06-19).** "Use Claude Code itself to discover, not
> gemini. Evaluator functions must be performed with an Evaluator agent,
> mass-dispatched when needed. Make the Evaluator Skill's Dispatch patterns
> similar to Diagnostics for highest throughput." → agent-dispatch is the
> DEFAULT; the in-house Gemini judge is an OPTIONAL substrate (§ Fallback).

---

## The model in one line

`PREP (deterministic script → task-spec files) → DISPATCH (parent fans out leaf
subagents MASS-PARALLEL on the host runtime → they write verdict files) →
AGGREGATE (deterministic script reads the verdict files → labels / scorecard)`.

The LLM verdict NEVER comes from a script calling a provider. It comes from
parent-session-dispatched `evaluator` subagents (discover / judge modes) reasoning
on the HOST runtime, written to verdict FILES. The scripts only PREP (emit the exact
prompts to judge) and AGGREGATE (read the verdicts back). See
`scripts/agent-dispatch.ts` (the transport) + `scripts/prep-tasks.ts` (PREP).

### The verdict-file contract (every dispatched subagent honors it)

- A PREP task-spec is `<key>.task.json` where `key = promptHash(system, user)`
  (FNV-1a, `scripts/agent-dispatch.ts`). It carries the EXACT `{system, user}`
  prompt the subagent must reason over, the `verdictFile` it must write, and the
  pinned `{model, temperature: 0}` envelope (C-PIN; model-intent-sacred).
- The subagent writes `<key>.verdict.json` = a **critique-before-verdict** JSON
  string: `{ "critique": "<reasoning first>", "result": "pass"|"fail"|"uncertain",
  "confidence": <0..1> }`. The critique is written BEFORE the result. Binary
  only — no Likert. `uncertain` ONLY when the trace genuinely lacks the evidence;
  it is NEVER silently coerced to pass/fail.
- AGGREGATE re-derives `key` from the prompt alone and reads the verdict file —
  so PREP and AGGREGATE need no shared mutable state. A missing verdict file is
  **fail-loud** (the JudgeInvoke throws): it means the parent skipped dispatch,
  never a fabricated pass.

---

## Throughput / concurrency model (MASS-PARALLEL — no hardcoded 5)

Dispatch leaf subagents **mass-parallel** for throughput. The REAL bound is the
host harness's own concurrency cap (how many `Agent` calls it runs at once); the
protocol does NOT hardcode a number. Practically:

- Fan out as wide as the work-list allows (one subagent per trace-batch for
  `*discover`; one per `(criterion × trace-slice)` for `*build-evals`/`*evaluate`),
  and let the harness schedule them under its cap. Excess dispatches queue and
  drain as slots free — coverage is complete, only the in-flight count is bounded.
- Batch sizing: keep each subagent's slice within a single context window
  (a trace-batch of deep-readable size; a criterion's eval-slice). Prefer MORE,
  SMALLER subagents over few large ones — that maximizes parallel drain and keeps
  each verdict grounded.
- Identical prompts dedupe by content key (PREP emits one task per unique
  `(system, user)`), so redundant judging units never re-dispatch.
- Record the dispatched count + the observed concurrency in the run scratchpad
  (`runMeta.dispatch`). Do NOT silently cap coverage — if a work-list is trimmed,
  `log()` what was dropped.

> **Dispatch-recursion rule.** Leaf subagents (the `evaluator` cell, any mode)
> CANNOT themselves dispatch subagents or call `AskUserQuestion`. Only THIS
> top-level parent session fans them out. A dogfood / re-run that needs the
> fan-out must therefore run from a TOP-LEVEL parent session, not from inside a
> subagent.

---

## Step 0 — Setup detection

```bash
Bash("scripts/cli/run.sh scripts/profile-subject.ts --detect")
```

Expect a complete subject (EV-049) + a resolved substrate (EV-050). If missing,
route to onboarding (subject auto-gen + substrate fork — SKILL.md §0). Under the
DEFAULT substrate (`agent-dispatch`) no provider key is needed; the host runtime
is the judge. (In-house substrate → see § Fallback.)

Resolve the pinned envelope ONCE for the whole run (C-PIN): `model` from
`--model` ?? `config.models.default` (else REFUSE — model-intent-sacred),
`temperature: 0`. Every PREP task carries it; every subagent honors it.

---

## Step 1 — `*discover` (EV-041/042/052) — fan out `evaluator` (#mode-discover)

The determiner labels (EV-042) have NO label dependency, so this stage runs first.

1. **Sample + slice (PREP-A).** Balanced ✓/✗ sampling (`scripts/sample-traces.ts`,
   EV-052) → trace batches. For each trace emit a determiner task-spec:
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/prep.ts --stage determiner \
         --traces /tmp/sample.ndjson --task-dir .mutagent-evaluator/<run>/tasks/discover \
         --model <pinned> ")
   ```
   (`scripts/prep-tasks.ts` `prepDeterminerTasks` — one `<key>.task.json` per trace.)

2. **Dispatch `evaluator` (#mode-discover) MASS-PARALLEL** — one subagent per trace-BATCH:
   ```
   Agent(
     subagent_type: "evaluator",
     run_in_background: true,
     prompt: |
       Run #mode-discover (the evaluator's discover mode; unit.kind="discover").
       Read your assigned task-spec files in <tasks/discover>. For each, reason
       on the host runtime under the pinned envelope (temp 0). Determine the
       outcome (EV-042 — "inaction can be success"; a guard-hold is a PASS), note
       the FIRST thing that went wrong, and cluster into emergent BINARY
       ACTIONABLE categories. Write each <key>.verdict.json (critique-before-
       verdict) into <verdicts/discover>, and your mining report per batch.
   )
   ```
   Pre-read for the agent: `references/error-analysis.md` + the `subjects/<name>/`
   profile. Fan out as wide as the batch list; the harness cap bounds in-flight.

3. **Collect + AGGREGATE-A.** Await the verdict files (use the `Monitor` tool with
   an `until` test-`-f` loop — NEVER `Bash("sleep N && cat")`). Then:
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/aggregate.ts --stage discover \
         --annotations-dir .mutagent-evaluator/<run>/discover \
         --out /tmp/criteria.json")
   ```
   The dispatched evaluator (discover mode) writes BOTH the per-trace determiner verdict files
   AND a `TraceAnnotation[]` mining report per batch into `<run>/discover`. AGGREGATE
   reads the annotation files and mines criteria (`scripts/discover-criteria.ts`
   `deriveCriteria`): one binary criterion per emergent category, per-category
   failure rates, **flag fixable-vs-eval-worthy** (fixables route to
   diagnostics, EV-051 — never judged), saturation stop.

---

## Step 2 (DEFAULT) — `*evaluate` — fan out `evaluator` (#mode-judge-trajectory, per-TRAJECTORY)

The **headline judging cell**. Score each trajectory against the WHOLE eval matrix (the criteria
set — bridged from v1 `subjects/<name>/eval-matrix.yaml` or the `*discover` output). One Judge Agent
per trajectory, MASS-PARALLEL — high throughput across many sessions.

1. **PREP — one matrix packet per trajectory** (`scripts/matrix-judge.ts buildMatrixPacket` →
   `writeMatrixPacket`): assemble `{subject, trajectoryId, criteria[] (the whole matrix),
   trajectory[], transcript[], pin}` per trajectory into the run's packet dir. Pure DATA — no
   prompt, no LLM.
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/prep.ts --stage matrix \
         --traces /tmp/sample.ndjson --criteria /tmp/matrix.json \
         --task-dir .mutagent-evaluator/<run>/packets --model <pinned>")
   ```

2. **Dispatch `evaluator` (#mode-judge-trajectory) MASS-PARALLEL** — one subagent per trajectory:
   ```
   Agent(
     subagent_type: "evaluator",
     run_in_background: true,
     prompt: |
       Run judge/trajectory (#mode-judge-trajectory; input is a *.packet.json).
       Read your assigned <trajectory_key>.packet.json. Score EVERY criterion in its matrix for
       THIS trajectory on the host runtime, pinned (temp 0, C-PIN). Critique BEFORE verdict; binary
       (inaction-can-be-success for goal/restraint criteria); judge-only. Write
       <trajectory_key>.verdict.json (a MatrixVerdictFile) into <verdicts/eval>.
   )
   ```
   Pre-read for the agent: `references/write-judge-prompt.md`. The judging RUBRIC lives in the agent
   def — the script never builds a prompt. Fan out one per trajectory; harness cap bounds in-flight.

3. **Collect + AGGREGATE** (`Monitor` until the verdict files exist):
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/aggregate.ts --stage evaluate \
         --traces /tmp/sample.ndjson --criteria /tmp/matrix.json \
         --verdict-dir .mutagent-evaluator/<run>/verdicts/eval \
         --out .mutagent-evaluator/<run>/scorecard.json")
   ```
   `cli/aggregate.ts` (→ `scripts/matrix-judge.ts aggregateMatrixScorecard`) reads the
   per-trajectory `MatrixVerdictFile`s, folds each criterion across trajectories (binary: PASS iff
   all pass; any fail → fail; else uncertain), and rolls up the severity-gated **GATE** +
   per-trajectory **variance** (`evaluate.ts`) → route failures to diagnostics (EV-051).

## Step 2b (ALTERNATE) — `*build-evals` + per-CRITERION `*evaluate` — fan out `evaluator` (#mode-judge-criterion)

The alternate fan-out axis: one judge per CRITERION across a trace-slice (vs one judge per
trajectory across the whole matrix). Use when you want criterion-parallel judging or are building a
per-criterion judge suite. Now the determiner labels are REAL, so the judge few-shot (TRAIN split)
can be built.

1. **PREP-B — emit judge task-specs.** Replay the pipeline with the capturing
   judge so the emitted judge prompts are byte-identical to AGGREGATE's:
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/prep.ts --stage judge \
         --traces /tmp/sample.ndjson --criteria /tmp/criteria.json \
         --verdict-dir .mutagent-evaluator/<run>/verdicts/discover \
         --task-dir .mutagent-evaluator/<run>/tasks/eval --model <pinned>")
   ```
   (`scripts/prep-tasks.ts` `prepJudgeTasks` — one `<key>.task.json` per
   `(criterion × subject-trace)`; few-shot from the TRAIN split ONLY — leakage
   guard throws otherwise.)

2. **Dispatch `evaluator` (#mode-judge-criterion) MASS-PARALLEL** — one subagent per `(criterion × trace-slice)`:
   ```
   Agent(
     subagent_type: "evaluator",
     run_in_background: true,
     prompt: |
       Run judge/criterion (#mode-judge-criterion; unit.axis="criterion"; input is a *.task.json).
       Read your assigned task-spec files in <tasks/eval>. For each, run the ONE
       binary+confidence judge over the slice on the host runtime, pinned (temp 0,
       C-PIN). Critique BEFORE verdict; binary only; never fabricate evidence;
       never fix the subject (judge-only, EV-051). Write each <key>.verdict.json
       into <verdicts/eval>.
   )
   ```
   Pre-read for the agent: `references/write-judge-prompt.md` (the 4-component
   contract). Fan out per judging unit; harness cap bounds in-flight.

3. **Collect + AGGREGATE-B.** Await the verdict files (`Monitor` until present),
   then roll up the per-criterion alternate via the dogfood aggregate entrypoint:
   ```bash
   Bash("scripts/cli/run.sh scripts/cli/dogfood.ts \
         --traces /tmp/sample.ndjson --criteria /tmp/criteria.json \
         --substrate agent-dispatch --verdict-dir .mutagent-evaluator/<run>/verdicts/eval \
         --model <pinned> --out .mutagent-evaluator/<run>/scorecard.json")
   ```
   AGGREGATE runs `scripts/run-pipeline.ts` with the agent-dispatch judge (reads
   every verdict file) → per-criterion binary+confidence → **severity-gated GATE**
   (EV-048) + **agent-variance** view → **route failures** to diagnostics
   (EV-051; fixables + any non-pass eval-worthy verdicts, judge-only).

> **AGGREGATE readiness.** Before rollup, `scripts/agent-dispatch.ts`
> `missingVerdictKeys(verdictDir, specs)` must be empty — every dispatched
> judging unit has a collected verdict. A non-empty list means a subagent failed
> or was skipped → re-dispatch that slice, do NOT roll up a partial suite silently.

---

## Step 3 — Report

Emit the verdict + scorecard (SKILL.md §3.1). The scorecard is deterministic given
the pinned envelope + the collected verdict files (`mask.ts` strips run-id /
timestamps / abs-paths → byte-identical reruns, C-PIN). Failures are ROUTED to
`mutagent-diagnostics` (EV-051) — the evaluator never fixes.

---

## Fallback — the OPTIONAL in-house substrate (EV-050)

When the run is configured `substrate: in-house` (e.g. a CI / code-based export
context that wants a provider call instead of host dispatch), the same PREP/
AGGREGATE cores run, but the judge seam is `createInHouseJudge`
(`scripts/judge-provider.ts`, `@langchain/google-genai`, temp 0, THROW on missing
creds) — see `scripts/cli/dogfood.ts`. This is KEPT but is NOT the default. If
`Agent` dispatch is unavailable in the host runtime, surface that + offer the
in-house substrate explicitly (model-intent-sacred: no silent provider swap).

## Monitor compliance

When awaiting verdict files, USE the `Monitor` tool with an `until` loop:
```
Monitor: until test -f <verdicts>/<key>.verdict.json; do sleep 2; done
```
DO NOT `Bash("sleep N && cat …")` — it hits the harness `Blocked: sleep` guard.
