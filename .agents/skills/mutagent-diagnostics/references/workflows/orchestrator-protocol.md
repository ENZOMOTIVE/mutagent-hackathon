# Orchestrator Protocol — Inline Procedure for the Parent Session

> **Authority**: SKILL.md §0 (Setup Detection), PR-022 (Self-Diagnostics [INTERNAL])
>
> **Why this file exists**: Claude Code sub-agents cannot dispatch other sub-agents
> (Agent tool) or invoke AskUserQuestion. Coordinator-class orchestration therefore
> MUST run in the parent session — the one that invoked the skill. This protocol
> is loaded inline by the parent session after §0 detects a complete config.
>
> **Operator voice-stamp T1**: "The Diagnostic skill must perform the Orchestrator
> protocols. Sub-Agents probably cannot dispatch Sub-Agents. That's why they also
> cannot do AskUserQuestion. To keep it on the main session, we probably need to
> use the skill." — explicit endorsement of this inline approach.
>
> Loaded when: `scripts/setup/detect.ts` returns `state: "complete"` AND the caller
> is NOT in `--reconfigure` mode.

---

> **⚠ Wave-6 methodology is MANDATORY.** All Wave-6 scripts (`scripts/invocation/parse-brief.ts`,
> `scripts/awareness/*`, `scripts/library/match.ts`, `scripts/sample/caps.ts`,
> `scripts/sample/deep-read-gate.ts`) MUST be invoked at the steps where they appear below
> (Steps 3a, 3.5, 4.5, 5.5, and the Step 6 pre-gate) unless a documented exemption applies
> (see `references/workflows/rca.md` Gate Exemption Taxonomy). Skipping a Wave-6 script with
> inline prose reasoning is a protocol violation — the deep-read gate in particular HARD-REFUSES.

---

<!-- TODO: P3 cross-platform capability probe — see iter-10 tab ⑥
     Step 0 below is reserved for the boot probe that verifies Agent + AskUserQuestion
     capabilities are available in the current runtime before proceeding.
     P3 (DEFERRED) will implement cross-platform detection:
     - Claude Code: Agent + AskUserQuestion native
     - Codex: Task + chat-choice fallback
     - Cursor/generic: capability-based probe + cannot-orchestrate sentinel
     Until P3 lands, proceed assuming parent session has Agent + AskUserQuestion available.
-->

## Step 0 — Capability Check [P3 TODO]

*(Boot probe DEFERRED — see TODO comment above. For now: assume parent session has
Agent dispatch + AskUserQuestion available. If Agent dispatch fails at runtime,
surface the error and halt with guidance to use Claude Code.)*

## Step 1 — Config Detection

```bash
Bash("scripts/cli/run.sh scripts/setup/detect.ts")
```

Expect `state: "complete"`. If partial or missing, halt and route to
`references/workflows/onboarding.md`.

Check `InitDescriptor.agentsBoundary`:
- `"missing"` → display install instruction + halt
- `"pending-restart"` → display restart instruction + halt
- `"invalid"` → display re-install instruction + halt
- `"ready"` → proceed

> **W9-10 (lean onboarding):** Phase-5b agent install is non-blocking. `scripts/cli/init.ts`
> owns agent install (`pnpx … init` installs skill + agents). Onboarding's Phase 5b only
> checks / offers install if agents are missing — it never mandates it. See
> `references/workflows/onboarding.md` Phase 5b. Do NOT edit onboarding.md here; B5 owns it.

## Step 2 — Score-Scale Auto-Discovery (iter-8)

Before any score-based filter, probe the platform's scoring scale:

```bash
Bash("<source-cli> scores list --limit 100 --json")
```

Classify scale type:
- `boolean` — negative = `false`/`0`/`"down"`
- `discrete-1-5` — negative = ≤ 2 (below midpoint 3)
- `discrete-1-10` — negative = ≤ 4 (below midpoint 5)
- `continuous-0-1` — negative = < 0.5
- `categorical` — ask operator to specify

Cache: `.mutagent-diagnostics/cache/scale-{platform}.json`. Re-probe weekly.

If ambiguous: AskUserQuestion for clarification.

## Step 3 — NL → TraceFilter Translation

The operator provides natural language. Translate:

```
Operator: "diagnose all sessions with negative feedback last week for the search-agent"

Parent session reasons:
  agentId: "search-agent"
  startTime: 7daysAgo
  hasFeedback: true
  scoreBelow: <from scale probe>

CLI invocation:
  Bash("<source-cli> traces list --agent-id search-agent --from 7daysAgo --has-feedback
       --score-below {threshold} --json > /tmp/mutagent-traces.json")
```

Reference: `references/filter-search-matrix.md` for per-platform CLI flags.

### I-011: Multi-Q AskUserQuestion batch for ambiguous queries

**When the NL query forks into 3+ distinct filter interpretations**, use a SINGLE
multi-question `AskUserQuestion` call — NOT separate sequential questions. Batch all
forks in one call per `feedback_ask_user_question_with_previews`:

> Rule: every option MUST attach a concrete `preview` block (CLI invocation, filter JSON,
> or expected trace count estimate). Short labels alone are too vague to pick from.

**Example multi-Q AskUserQuestion** for "diagnose the bad sessions from last week":

```
AskUserQuestion({
  questions: [
    {
      question: "Which time window? (last week is ambiguous — platform timezone may differ)",
      header: "Time range",
      multiSelect: false,
      options: [
        {
          label: "Last 7 calendar days",
          description: "From 2026-05-23 00:00 UTC to now",
          preview: '--from 2026-05-23T00:00:00Z --to now'
        },
        {
          label: "Last Mon–Sun week",
          description: "Calendar week 2026-05-19 to 2026-05-25",
          preview: '--from 2026-05-19T00:00:00Z --to 2026-05-26T00:00:00Z'
        },
        {
          label: "Last 48 hours (incident window)",
          description: "Focused on the most recent activity",
          preview: '--from 2026-05-28T00:00:00Z --to now'
        }
      ]
    },
    {
      question: "Which signal should be primary? (determines slicing strategy)",
      header: "Signal type",
      multiSelect: false,
      options: [
        {
          label: "Negative feedback only",
          description: "Only traces with explicit user thumbs-down or score < threshold",
          preview: '--has-feedback --score-below 0.4'
        },
        {
          label: "All negative signals",
          description: "Feedback + errors + high latency (broader coverage)",
          preview: '--has-feedback --has-error --latency-above 10000'
        },
        {
          label: "Low-score traces only",
          description: "Score-filtered, no feedback required",
          preview: '--score-below 0.4'
        }
      ]
    },
    {
      question: "Scope to a specific agent?",
      header: "Agent scope",
      multiSelect: false,
      options: [
        {
          label: "All agents",
          description: "No agent filter — full session scope",
          preview: '(no --agent-id flag)'
        },
        {
          label: "search-agent only",
          description: "Scope to the search agent (TraceFilter.skillAgentScope)",
          preview: '--agent-id search-agent'
        },
        {
          label: "orchestrator + analyzers",
          description: "The diagnostics skill's own agent set",
          preview: '--agent-id diagnostics-orchestrator,diagnostics-analyzer'
        }
      ]
    }
  ]
})
```

> **Design note**: batching all 3 forks into a single AskUserQuestion reduces round-trips.
> The operator sees all ambiguities at once and resolves them in one interaction instead of
> 3 sequential questions. This is the multi-Q AskUserQuestion pattern from
> `feedback_ask_user_question_with_previews`.

**Simple query (no fork)**: if the query has exactly ONE clear interpretation, proceed
directly to CLI invocation without AskUserQuestion. Only batch-ask when genuine ambiguity exists.

**Default filter with confirmation**: if the query is partially clear, propose a default
filter and use a single-question AskUserQuestion with a preview block showing the exact CLI
invocation. Do NOT use prose questions — always attach the `preview` block.

## Step 3a — Parse Brief + Scope Resolution (Wave-6 R2.6, D2, W11-06/07 — MANDATORY)

Before reasoning about the filter inline, parse the operator's verbatim brief
through the published parser — do NOT free-parse:

```bash
Bash("scripts/cli/run.sh scripts/invocation/parse-brief.ts \"<verbatim operator brief>\"")
# → { agent?, timeWindow?, focus?, residual, scopeType: 'skill'|'agent'|null, entity? }
```

Store the verbatim brief in `runMeta.operatorInvocation` (D2). Use the parsed
fields (`agent`, `timeWindow`, `focus`) to build the TraceFilter in Step 3. If
`residual` is non-empty AND materially affects the filter, surface to operator
via a single AskUserQuestion.

### W11-07: Scope picker (skill vs agent)

After parse-brief completes, determine the diagnostic scope using this decision tree:

| Case | Action |
|---|---|
| `scopeType` is non-null ("skill" or "agent") | Use `scopeType` directly — no AskUserQuestion |
| `scopeType` is null AND operator provides no further context | AskUserQuestion: skill vs agent vs all-traces (see scope-model.md) |

**AskUserQuestion scope picker template** (only when scopeType is null):

```
AskUserQuestion({
  questions: [{
    question: "What are you diagnosing?",
    header: "Diagnostic scope",
    multiSelect: false,
    options: [
      {
        label: "A skill (e.g. mutagent-diagnostics)",
        description: "Diagnose a skill's own operational traces",
        preview: "scope: skill — uses skill identity from config.agents[]"
      },
      {
        label: "An agent (e.g. search-agent, orchestrator)",
        description: "Diagnose a named agent's runtime traces",
        preview: "scope: agent — uses agent identity from config.agents[]"
      },
      {
        label: "All traces (no scope filter)",
        description: "Run across all traces without scoping to a named entity",
        preview: "scope: all-traces — escape hatch; no identity resolution"
      }
    ]
  }]
})
```

### W11-07: Agent identity resolution

After scope is determined and entity is known (from `parsed.entity` or the scope picker answer):

1. Look up `entity` in `config.agents[]` via `resolveEntityIdentity(entity, config.agents)`.
2. If a match is found, annotate `EntityContext.identity` with the resolved pointers.
3. The identity pointers drive platform-specific trace fetching (Langfuse `traceName`/`tags`,
   OTel `serviceName`/`resourceAttrs`).
4. If no match: proceed with name-based trace matching (existing behavior — no change).

Full model: `references/workflows/scope-model.md`.

## Step 3.5 — Awareness Layer (Wave-6 R2.2, W11-05 — MANDATORY unless priors)

BEFORE the Step 4 primary-signal pick, run the awareness mini-sample + blind-spot
scan so the slicing strategy is grounded in observed evidence, not assumptions:

```bash
# B2-fix (verified against each script's import.meta.main argv parser):
#  • llm-sample.ts reads its trace metadata via the REQUIRED --metadata flag (NOT a
#    positional path) and the sample size via --size <n> (NOT a positional --n).
#  • blind-spots.ts reads the awareness-surfaced signals via the REQUIRED --findings
#    flag (a JSON array STRING or a file path); the optional --awareness-fired marks
#    a fresh run vs a prior-based skip.
Bash("scripts/cli/run.sh scripts/awareness/llm-sample.ts --metadata /tmp/traces-meta.json --size 5 --output /tmp/awareness-sample.json")
Bash("scripts/cli/run.sh scripts/awareness/blind-spots.ts --findings '[\"signal-a\",\"signal-b\"]' --awareness-fired true --output /tmp/blind-spots.json")
```

- `llm-sample.ts` — 5-trace LLM mini-sample. `--metadata` is required; `--size`
  defaults to the awareness sample size when omitted. **Skip ONLY on confirmed
  priors** (a prior library match for this entity, see Step 4.5). The Block-B
  cascade (expanded discovery + ledger-subtracted reserve) activates only when
  `--run-id` is also passed (optionally with `--entity <name>` for the
  ledger-subtraction marginal-reads path — see Step 6.5).
- `blind-spots.ts` — emits the blind-spot table consumed by Methodology Step 1.5
  in the rendered report. `--findings` is the awareness-surfaced signal list (JSON
  array string or path); pass `--awareness-fired false` on a prior-based skip.

### F2 (UI-1op) — ASSIGN the producer output into runMeta (MANDATORY, not just a witness)

The witness stamp below proves awareness RAN; it does NOT carry the producer output
into the report. The awareness mini-sample + blind-spot table are LLM/runtime-produced
(the `findings`/`discoveredSignals` come from the analyzer agent's LLM pass — the
deterministic enricher CANNOT recompute them). They reach the Methodology tab ONLY
when the orchestrator assigns them into `findings.runMeta` BEFORE the Step 8.5 enricher
call. The enricher PRESERVES `runMeta.awarenessSample` / `runMeta.blindSpots` verbatim
on its passthrough (it never drops them), but it never invents them.

After running awareness (and BEFORE building `/tmp/findings.json` for Step 8.5), assign:

```ts
// awarenessSample: package the selected traces + the analyzer-surfaced signals
// (LLM output) with an injected timestamp via buildAwarenessSample().
findings.runMeta.awarenessSample = buildAwarenessSample(
  selectedTraces,          // from selectAwarenessTraces() (deterministic)
  discoveredSignals,       // from the analyzer agent's LLM mini-sample pass
  awarenessFiredAtIso      // injected ISO timestamp
);

// blindSpots: the Tier-0-measurable-vs-blind-spot taxonomy table.
findings.runMeta.blindSpots = buildBlindSpots({
  awarenessFindings: discoveredSignals,
  awarenessFired: true,
}).rows;
```

On a **prior-based SKIP** (Step 4.5 match), assign the placeholder instead so the
Methodology renders the explicit "library priors exist; awareness skipped" panel:

```ts
findings.runMeta.blindSpots = buildBlindSpots({ awarenessFindings: [], awarenessFired: false }).rows;
// (leave awarenessSample undefined — the renderer's SKIP placeholder handles it)
```

> A bare witness stamp with no `runMeta.awarenessSample` / `runMeta.blindSpots`
> assignment is the F2 regression: the renderer sees `undefined` and emits the SKIP
> placeholder even though awareness ran. The assignment above is what makes the
> anti-tunnel-vision proof VISIBLE (Wave-6 awareness methodology, PR-036).

### W11-05: Awareness witness stamp (MANDATORY)

After running or consciously skipping awareness, write the awareness-witness stamp:

```bash
# Fresh run — awareness ran:
writeAwarenessWitnessStamp(reportDir, { isFreshRun: true, awarenessRan: true })

# Prior-based skip (confirmed library match from Step 4.5):
writeAwarenessWitnessStamp(reportDir, {
  isFreshRun: false,
  awarenessRan: false,
  exemptionReason: "library prior exists for this entity (Step 4.5 match)"
})
```

The Step 8.9 checklist (wave6-checklist.ts) reads this stamp and HARD-FAILS
(regardless of isClientReport) if isFreshRun=true + awarenessRan=false +
no exemptionReason. This makes "awareness ran" enforceable, not just documented.

## Step 3.7 — Normalize (MANDATORY precondition — PRD-MP-01)

Source bodies MUST flow through the per-platform normalizer
(`scripts/normalize/platforms/<platform>.ts`) before any downstream pipeline
step. Inline `jq`/`sed`/`awk` pre-mapping is **FORBIDDEN** except as a
documented exemption accompanied by:

```
TODO(skill-maintainer): patch <normalizer> to handle <shape>
```

The normalizer produces THREE artifacts the downstream pipeline depends on:

1. **`traces-metadata.json`** (`TraceMetadata[]`) — consumed by Tier-0 +
   slicer (Step 4 / Step 5).
2. **`entity-context.json`** (`EntityContext`) — consumed by the enricher at
   Step 8.5a via `--entity-context`. This is the ONLY authorized producer;
   the enricher must NEVER synthesize `diagnosedEntity` from inline heuristics.
3. **Optional bodies cache** — pre-fetched trace bodies for the analyzer
   fetch-bodies step (Step 6).

### Per-platform extractor table

| Source format | Normalizer | Entity-context extractor |
|---|---|---|
| `langfuse-export` | `platforms/langfuse.ts` | `extractLangfuseEntityContext` |
| `local-jsonl` | `platforms/local-jsonl.ts` | `extractLocalJsonlEntityContext` |
| `claude-code` | `platforms/claude-code.ts` | `extractClaudeCodeEntityContext` |
| `codex` | `platforms/codex.ts` | `extractCodexEntityContext` |
| `otel` | `platforms/otel.ts` | `extractOtelEntityContext` |

### W12-11 (OP-8) — run the normalizer via its INTERNAL CLI transport

The langfuse normalizer exposes an `import.meta.main` transport (INTERNAL —
run.sh only, NOT the product `mutagent` CLI). Step 3.7 produces BOTH downstream
artifacts in a single deterministic call — no inline `jq`/`bun -e` hand-wiring:

```bash
Bash("scripts/cli/run.sh scripts/normalize/platforms/langfuse.ts \
  --in /tmp/raw-langfuse-export.json \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")
```

- `--in` — the raw langfuse-export JSON array.
- `--out-metadata` — `TraceMetadata[]` (Tier-0 + slicer input).
- `--out-entity` — the `EntityContext` (consumed verbatim at Step 8.5a).

This is the AUTHORIZED producer of `entity-context.json`. Because the extractor
is now runnable, `diagnosedEntity` is never hand-wired and never silently
dropped (the root cause of OP-7).

### REQ-052 — every source platform has a runnable `--out-entity` transport

All FIVE source platforms now expose the same INTERNAL `import.meta.main`
transport (run.sh only — NOT the product `mutagent` CLI). Each takes `--in` and
writes `--out-entity` (the `EntityContext`) and/or `--out-metadata`
(`TraceMetadata[]`); ≥1 `--out-*` is required. All are deterministic — no
clock/random/network/LLM. Use the exact invocation for the configured
`source.platform`:

```bash
# langfuse — raw export array OR streaming NDJSON/NDJSON-gz (format auto-detected; --format overrides)
Bash("scripts/cli/run.sh scripts/normalize/platforms/langfuse.ts \
  --in /tmp/raw-langfuse-export.json \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")

# local-jsonl — one trace per line (.jsonl/.ndjson); bad lines tolerated-but-visible (F-S7, count to stderr)
Bash("scripts/cli/run.sh scripts/normalize/platforms/local-jsonl.ts \
  --in /tmp/traces.jsonl \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")

# claude-code — one session .jsonl (many event lines → one TraceBody); generic agent entity (default mode)
Bash("scripts/cli/run.sh scripts/normalize/platforms/claude-code.ts \
  --in /tmp/session.jsonl \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")
#   (self-diag variant — skill-typed entity — is Step 12.2: add --mode self-diag --skill-md <SKILL.md>)

# codex — one Codex rollout session .jsonl (many event lines → one TraceBody)
Bash("scripts/cli/run.sh scripts/normalize/platforms/codex.ts \
  --in /tmp/session.jsonl \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")

# otel — JSON array of spans for ONE trace (or a single span object)
Bash("scripts/cli/run.sh scripts/normalize/platforms/otel.ts \
  --in /tmp/spans.json \
  --out-metadata /tmp/traces-metadata.json \
  --out-entity /tmp/entity-context.json")
```

The `--out-entity` artifact is consumed verbatim at Step 8.5a via the enricher's
`--entity-context` flag. No platform needs inline `bun -e` / `jq` glue (banned by
R-SELF-03-c). The claude-code transport additionally supports `--mode self-diag`
for the report-only self-diagnosis path (Step 12.2).

Cross-reference: Wave-5 R1.7 / APPENDIX-A §A.2 — "diagnosedEntity must come
from the normalizer's EntityContext". Step 8.5a (below) is the downstream
consumer.

## Step 4 — Tier 0 Static Scan (PR-001 — MANDATORY before LLM)

```bash
Bash("scripts/cli/run.sh scripts/tier0-scan.ts /tmp/mutagent-traces.json > /tmp/tier0-out.json")
```

**Do NOT call analyzers until Tier 0 completes.**

Tier 0 output: `hasErrorSpike`, `hasLatencySpike`, `hasFeedbackCluster`,
`estimatedSlots`, `slicingStrategy`.

## Step 4.5 — Library-First Match (Wave-6 R2.3 — Best-Effort Prior Consult)

> **W9-02**: Header changed MANDATORY → "Best-Effort Prior Consult". An empty library
> is valid — proceed fresh + log `runMeta.decisions`. The deep-read gate (Step 6 pre-gate)
> is UNTOUCHED: empty library → no `priorSignalsRef` → HARD-REQUIRED deep-read (PR-035
> cross-ref). De-mandate does NOT relax the deep-read floor.
>
> Pre-flight caps (`scripts/sample/caps.ts`) run at Step 5.5 BEFORE any Step-5b
> override; Step 4.5 cannot bypass them.

Before slicing, consult the diagnostics library for confirmed priors on this
entity and merge them into the Tier-0 report (library priors weighted 3×):

```bash
Bash("scripts/cli/run.sh scripts/library/match.ts /tmp/tier0-out.json --entity <name>")
# → merges library priors (3× weight) into the Tier-0 report's libraryMatches[]
```

A confirmed library prior here is what authorizes skipping the Step 3.5
`llm-sample.ts` mini-sample.

**GUARD (W9-02):** Mandate library-match BEFORE dispatch. If both `priors==0`
AND `llmReads==0`, FAIL-LOUD — this is the double-zero anti-laziness gate.
Empty library alone is fine (proceed fresh); double-zero is not.

```yaml
# Step Spec (W9-04)
stage:
  id: step-4.5-library-match
  gate: { mandatory: false }          # W9-02 de-mandate — empty library is valid
  inputs:  { tier0_report: /tmp/tier0-out.json, entity_name: "{name}" }
  run:     "scripts/cli/run.sh scripts/library/match.ts /tmp/tier0-out.json --entity {name}"
  outputs: { library_matches: "libraryMatches[]  # 3x weighted; may be empty" }
  on_result:
    matches_present: { action: merge-priors-3x, side_effect: "authorizes reducing (NOT skipping) the deep-read floor" }
    matches_empty:   { action: proceed-fresh, route: step-5,
                       # W13-C (D-5): canonical decision shape is {step, choice, rationale, timestamp}
                       # (scripts/normalize/trace.ts RunMeta.decisions) — NOT {stepId, decision, reason}.
                       log: { target: runMeta.decisions, record: { step: "4.5-library-match", choice: "proceed-fresh (0 priors)", rationale: "library returned no matches for this entity" } } }
  on_fail: { action: skip-and-log, route: step-5 }
# Step 6 deep-read pre-gate is the mandatory:true exemplar:
#   gate: { mandatory: true }; on_fail: { action: HARD-REFUSE, route: "exemption (rca.md) OR halt+ask" }
# W9-02 GUARD: library de-mandate does NOT touch deep-read-gate.ts. Empty library =>
#   no priorSignalsRef => deep-read HARD-REQUIRED (PR-035 cross-ref).
```

## Step 5 — Dynamic-Cluster Slicing (PR-017)

```bash
Bash("scripts/cli/run.sh scripts/slicer.ts /tmp/tier0-out.json /tmp/mutagent-traces.json --cap 5
     > /tmp/slice-plan.json")
```

Slice plan: array of `{ sliceId, traceIds[], scope }` objects, capped at 5 slices.

## Step 5b — Slicer-Override Decision (PRD-MP-02)

After the slicer emits its plan, evaluate the override predicate:

**Predicate:** `slice-plan.rationale` starts with
`"Window-based slicing (no a-priori signal)"` **AND**
`parsedInvocation.focus` (from Step 3a) is non-null.

When the predicate fires:

1. Switch sampling strategy to `representative.ts` 4-bucket sample
   (worst · median · best · random, 15-floor, worst-weighted) instead
   of the window plan.
2. Record the override in `runMeta`:
   ```json
   {
     "samplingOverride": {
       "from": "window-based",
       "to": "representative-sample",
       "reason": "focus=<parsedInvocation.focus>"
     }
   }
   ```
3. The Methodology tab Decisions row MUST surface this override.

**When focus is null**: keep the slicer's window plan unchanged.
Window-based slicing is the correct fallback for unfocused exploratory runs.

> **B4 consumer-boundary shape note (verified against `scripts/sample/representative.ts`).**
> When the override fires, `representative.ts` returns a `BucketSample` whose
> `selected` is a `BucketAssignment[]` — each element is the OBJECT
> `{ traceId, bucket, badness }` (e.g. `{ traceId: "tr-…", bucket: "worst", badness: 0.82 }`),
> **NOT** a bare trace-id string. Any Step-5b/6 consumer that needs the id must read
> `assignment.traceId` (e.g. `sample.selected.map(a => a.traceId)`); treating an element
> as a string yields `undefined` ids downstream. (`bucket` ∈ worst·median·best·random;
> `badness` is the deterministic per-trace score, surfaced for the determinism proof.)

> Earning evidence: F-SD-3 — a prior diagnostic run overrode the
> 5×390-window plan with hand-rolled `jq` with no protocol home for
> the decision.

## Step 5.5 — Caps (Wave-6 D1 — first-to-trip stop)

Evaluate the configured caps before dispatch; the first cap to trip halts further
sampling/dispatch:

```bash
Bash("scripts/cli/run.sh scripts/sample/caps.ts --config <caps>")
```

Inactive caps (e.g. cost cap, default OFF per D1) are skipped.

> **Operator override (PR-048):** the max-trace ceiling defaults to `min(N, 1000)`. To let a
> run read beyond 1000 traces, pass `--max-trace <N>` (operator-explicit only, never auto) — it
> raises the active `max_trace_count` ceiling on command and threads into `computeCeiling(N, override)`
> at the Step 6 escalation loop.

## Step 5.7 — Build Diagnosis-Context Lens (W18-context — MANDATORY before analyzer fan-out)

> **⚠ Runs BEFORE the Step 6 analyzer fan-out.** Each analyzer MANDATORY-PRE-READs the
> `diagnosis-context.md` this step produces (see Step 6 dispatch). Build it once per run;
> every parallel analyzer reads the same lens.

**WHY.** An analyzer that starts blind searches the traces with no factual baseline for
"what IS this thing?" — it can confabulate a failure mode that contradicts the entity's
own system prompt / tools / source. The diagnosis-context is a GROUNDED LENS (name · scope
· model · purpose · FULL system prompt · tools · source code when accessible) the analyzer
reads + understands FIRST, so every finding corroborates against extracted fact, not a
guess. It is **EXTRACTED FACT ONLY** — no inferred/derived claims, no "prompt is uncached",
no "latency caused by X". The analyzer corroborates whatever it is handed, so an unverified
hint becomes a self-fulfilling error (grounding contract — PR-018, now also PR-055
"Ground cost/cache + intent, never infer" in `.meta/design-principles.md`).

Build it with the deterministic (no-LLM) assembler. It consumes the `entity-context.json`
produced at Step 3.7 + the normalized traces, and writes `diagnosis-context.md`:

```bash
# Verified against scripts/context/build-diagnosis-context.ts import.meta.main:
#   REQUIRED: --entity-context <f>  --traces <f>  --output <diagnosis-context.md>
#   OPTIONAL: --purpose <text>      (operator-stated lens; labeled "operator-stated", never trace-derived)
#   OPTIONAL: --doc <label>:<path>  (REPEATABLE — embeds a source file VERBATIM; the codeAccess case)
Bash("scripts/cli/run.sh scripts/context/build-diagnosis-context.ts \
  --entity-context /tmp/entity-context.json \
  --traces /tmp/normalized-traces.json \
  --output /tmp/diagnosis-context.md \
  [--purpose \"<operator-stated purpose>\"] \
  [--doc SKILL.md:.claude/skills/mutagent-diagnostics/SKILL.md] \
  [--doc references/principles.md:.claude/skills/mutagent-diagnostics/references/principles.md]")
```

- `--entity-context` / `--traces` / `--output` are **REQUIRED** — the script exits non-zero
  (usage message) if any is missing.
- `--purpose` is OPTIONAL — when supplied it renders under the `## Purpose
  _(provenance: operator-stated)_` section, explicitly labeled stated-intent, NOT a
  trace-verified fact. Omit it and the section records "no operator-stated purpose supplied".
- `--doc <label>:<path>` is OPTIONAL + **REPEATABLE** (split on the FIRST colon — the label is
  the leading token). Each file is read + PII-sanitized + embedded VERBATIM under `## Source
  Code _(provenance: source-code)_`. Supply the entity's own source (skill → SKILL.md + key
  references; agent → the agent definition) for the codeAccess case; omit entirely for the
  no-codeAccess client case (the FULL extracted system prompt is then the primary ground truth).

The script is **Type A — Pure** (no LLM, no clock, no random): same inputs ⇒ byte-identical
`diagnosis-context.md`. The rendered sections, in fixed order, are: **Identity → Purpose →
System Prompt (FULL, untruncated) → Tool Inventory → Source Code**, each carrying a provenance
badge (`trace-extracted` · `source-code` · `operator-stated`) so every fact is traceable to
its origin. Anything that cannot be grounded is **OMITTED** — there is deliberately no field
for inferred/derived claims.

## Step 6 — Parallel Analyzer Dispatch (PR-005 — cap ≤ 5)

### Step 6 pre-gate — Deep-Read Gate (Wave-6 R2.1 — MANDATORY before dispatch)

BEFORE dispatching ANY analyzer, run the deep-read gate:

```bash
Bash("scripts/cli/run.sh scripts/sample/deep-read-gate.ts ...")
```

The gate may **HARD-REFUSE** (e.g. zero LLM reads with no prior signals). On
refusal, either route to a documented exemption (see `references/workflows/rca.md`
Gate Exemption Taxonomy) or HALT and ASK the operator. **Never** bypass the gate
with inline prose reasoning.

```yaml
# Step Spec — Step 6 deep-read pre-gate (W9-04)
stage:
  id: step-6-deep-read-gate
  gate: { mandatory: true }
  inputs:  { slice_plan: /tmp/slice-plan.json, caps_config: "<caps>" }
  run:     "scripts/cli/run.sh scripts/sample/deep-read-gate.ts ..."
  outputs: { verdict: "DeepReadGateVerdict  # {allow, tooThin, coverageWarning}" }
  on_fail: { action: HARD-REFUSE, route: "exemption (rca.md Gate Exemption Taxonomy) OR halt+ask" }
# mandatory:false exemplar is Step 4.5 above.
```

> **Too-thin guard (W9-07 / PR-048):** when `verdict.tooThin === true` (population ≥ 1000
> AND `llmReadCount < 100`), surface the `coverageWarning` banner in the rendered report.
> This is a warning, NOT a refusal — the escalation loop below remediates it.

### Step 6 — Trace-Hungry Escalation Loop (W9-09 — PR-048)

After the deep-read gate passes, execute the tiered escalation loop using B1 symbols
(`ESCALATION_RUNGS`, `computeCeiling`, `timeBudgetForTier`, `buildBatchSample`,
`isSufficient` from `scripts/sample/caps.ts` + `scripts/sample/representative.ts`):

```
# DEFAULT ceiling = min(population, 1000). OPERATOR OVERRIDE (--max-trace <N>): pass it as the
# 2nd arg to RAISE the ceiling ABOVE 1000 ON COMMAND (operator-explicit only, never auto).
ceiling = computeCeiling(population, maxTraceOverride?)   # min(population, override ?? 1000)

# ESCALATION_RUNGS = [50, 100, 250, 500, 1000] — DIP→RAMP. The leading 50 is the cheap DIP
# first probe: sip 50 traces, then ramp through 100·250·500·1000 only if evidence stays thin.
for tier in ESCALATION_RUNGS where tier <= ceiling:
  batch = buildBatchSample(population, tier)   # worst-weighted; reuses representative.ts buckets
  LLM-read the batch traces
  update findings + append confirmed patterns to library/tier0 detectable-pattern set
  record batches[] entry in runMeta.deepRead

  if isSufficient(proof, newFailureCategoriesInLastBatch):
    stopReason = "evidence-sufficient"; break
  if elapsed >= timeBudgetForTier(tier):   # per-tier {50:300,100:600,250:900,500:1200,1000:1800}
    stopReason = "time-budget"; break

else:
  stopReason = "ceiling-reached"

# Small stacks: N < 50 (the dip first-rung) => single representative sample at floor 15..N; no forced escalation.
# Anti-laziness (R-AL-2): population >= 1000 AND llmReadCount < 100 => FLAG / refuse.
```

Record outcome in `runMeta.deepRead`:
```json
{
  "deepRead": {
    "population": <N>,
    "tierReached": <tier>,
    "llmReadCount": <count>,
    "coverageConfidence": "high|medium|low",
    "stopReason": "evidence-sufficient|ceiling-reached|time-budget",
    "batches": [{ "tier": 100, "newFailureCategories": 3, "coverageConfidence": "low" }, ...]
  }
}
```

See `scripts/normalize/trace.ts` (`RunMeta.deepRead`) for the type definition landed by B1.

### Step 6 — Analyzer Dispatch via Handover Contract (W9-01)

For each slice in `slice-plan.json`, render the `analyzer_dispatch` YAML block from
`references/workflows/handover-contract.md` (fill all `{templated}` fields) and dispatch:

```
Agent(
  subagent_type: "diagnostics-analyzer",
  run_in_background: true,
  prompt: |
    <rendered analyzer_dispatch YAML from references/workflows/handover-contract.md>
)
```

The handover contract replaces freeform per-run prompts. Every parallel analyzer
in a run receives the SAME structured brief — no drift.

**W18-context — MANDATORY PRE-READ of `diagnosis-context.md` (every analyzer, before trace analysis).**
The analyzer brief MUST carry the `diagnosis-context.md` path built at Step 5.7, and the
analyzer's FIRST step is to **read + understand the diagnosis context to set its failure-mode
lens BEFORE analyzing traces.** This is non-optional: an analyzer that starts blind can surface
a failure mode that contradicts the entity's own (extracted) system prompt / tools / source.
The lens is extracted FACT only — the analyzer corroborates against it; it must NEVER seed or
corroborate an UNVERIFIED hint from it (there are no hints in it by construction). See
`references/workflows/handover-contract.md` (`artifacts_in.diagnosis_context`) for the brief
field and `assets/agents/diagnostics-analyzer.md` (Step 0 — read+understand) for the analyzer's
pre-read step.

**W18-cache — cache-status detection rule (NEVER infer "uncached").** When an analyzer reasons
about prompt-caching, cost, or token volume, the cache state comes ONLY from the grounded
cache-token fields on each trace (`cacheStatus` ∈ `hit`|`miss`|`unknown`, derived from
`cachedInputTokens` / `cacheCreationTokens`; `cacheHitRate` populated only when cache fields
were present). Rules:
- `cacheStatus` **absent / `"unknown"`** ⇒ report cache state as **UNKNOWN**, NEVER as
  "uncached". Absence of a cache-token field is NOT evidence of no caching.
- **NEVER infer** caching (or its absence) from a flat `promptTokens` value or byte sizes.
  The motivating miss: a client agent's caching was active ~89%, but a byte-size inference
  reported "uncached → 408M billed tokens". `miss` is a GROUNDED no-cache-read (cache fields
  present, nothing served) and is distinct from `unknown` — never collapse the two.

See `scripts/normalize/trace.ts` (`cacheStatus` / `cachedInputTokens` / `cacheCreationTokens`
/ `cacheHitRate` + the `CacheStatus` type) for the field definitions.

**W13-C (Variance, RC-LLM-PIN) — pin model + temperature on every analyzer dispatch.**
Unpinned model/temperature was the DOMINANT inter-run variance lever (the same traces
produced different findings each run). Every analyzer (and the orchestrator's own RCA
reasoning at Step 8) MUST run under the pinned inference envelope declared in
`assets/agents/diagnostics-analyzer.md` frontmatter (`inference:`):
- `temperature: 0` — PINNED unconditionally (deterministic sampling, host-agnostic);
- `model` — explicit DEFAULT pin (`claude-sonnet-4-6`), configurable per dispatch.

Honoring `feedback_model_intent_sacred`: this DECLARES intent — no silent swap, no
context-optimized routing, no retry-on-failure alternate-model fallback. If the
orchestrator overrides `model` for a run, the override MUST be explicit and logged to
`runMeta.decisions` (`step: "6-dispatch"`, the chosen model named in `rationale`).
Never re-target implicitly; if the pinned model cannot satisfy a constraint, THROW.

**Remedy-field contract (W12-08, PR-052 proposed + W13-C D-1 — enforced at Step 7.1).** Every
remedy the analyzer returns MUST:
- **link to a target** — `applyTarget` is HARD-required (a code location, or per
  target platform the agent prompt / agent definition) — plus `targetClass`;
- **focus on an origin** — `rationale`, `whyWorks`, `applyInstructions` (≥1) all
  required, and the finding carries ≥1 structured `assumption`;
- **declare cost + correctness** — `cost` and `correctness` are REQUIRED
  categoricals (`low|medium|high`). They drive the renderer's header badges AND the
  deterministic `rank` derivation (see Step 8). The analyzer does NOT emit `rank` —
  it is enricher-derived (`scripts/enrich/rank-remedies.ts`); any emitted rank is
  overwritten.
- **cite the source when findable** — emit a real `diff` (Before/After) when the
  source is accessible; ELSE set `diffStatus ∈ {source-unavailable,
  origin-unknown}`. NEVER fabricate a diff (honors `feedback_model_intent_sacred`).

These are the same fields `findings-contract.ts` rejects at Step 7.1; emitting them
up front avoids a RESEND round-trip.

**Never dispatch more than 5 analyzers in parallel.** Log dispatched count.

### Step 6 — Single-shot vs fan-out decision rule (PRD-MP-03)

Before dispatching, determine analyzer count using these criteria in order:

| Criterion | Rule | Preferred count |
|---|---|---|
| (a) slicer rationale = `"window-based-no-signal"` AND focus supplied | Step 5b override fired | **1** (single-shot on the representative sample) |
| (b) All slices share identical scope (no signal variance across slices) | Fan-out adds no coverage | **1** |
| (c) Sample size ≤ 30 traces total | Single analyzer fits in one context window | **1** |
| (d) 30 < sample ≤ 50 | Parallel re-read divergence improves coverage | **2** |
| (e) Default (> 50, diverse slices) | Dispatch up to min(sliceCount, 5) | **min(sliceCount, 5)** |

Record the choice in `runMeta`:
```json
{
  "dispatch": {
    "analyzerCount": 1,
    "reason": "criterion (b): all slices share identical scope",
    "slicesUsed": ["slice-0", "slice-1"]
  }
}
```

Single-shot runs MUST cite which criterion fired. The Methodology tab Decisions
row surfaces `runMeta.dispatch`.

**If Agent tool dispatch fails at runtime** (subagent_type not registered):
fall back to `subagent_type: "general-purpose"` with the content of
`assets/agents/diagnostics-analyzer.md` inlined as the system prompt body.
Log `fallback_used: true` in `run-meta.json`.

After dispatch, use Monitor tool to await completion:
```
Monitor: until test -f /tmp/findings-all.json; do sleep 2; done
```

**Do NOT** use `Bash("sleep N && cat <file>")` — hits harness Blocked:sleep guard.

## Step 6.5 — Selection-Hub Context Assembly (Wave-17 — `SignalCensusContext`)

After deep-read produces the sampled trace bodies + the analyzer `Finding[]`, the
orchestrator assembles the **`SignalCensusContext`** that turns deep-read-DISCOVERED
signals into FIRST-CLASS, evidence-floored census candidates. This is the seam that
makes the Wave-17 selection flow run end-to-end: the context is built HERE and passed
to the enricher (Step 8.5) via `--signal-ctx`. Absent → safe-by-default (the enricher
runs the legacy Tier-0-only census; any discovered signals stay
*suspected-unconfirmed*, never silently crowned).

The context object (consumed by `buildSignalCensus` in
`scripts/enrich/build-render-input.ts`) has THREE optional fields, each from a distinct
deterministic source:

```ts
interface SignalCensusContext {
  corroborations?: TrajectoryCorroboration[]; // R1 evidence floor (mechanical)
  foldedDigests?:  DeepReadLedgerEntry[];      // R2 cross-run ledger (re-floored)
  sampledCount?:   number;                     // R6 honest prevalence denominator
}
```

**(a) `corroborations` — mechanical trajectory scan (R1 evidence floor).**
Run the trajectory CLI over the sampled deep-read bodies. It is a pure, deterministic
tool-call sequence analyzer (NO LLM, no clock, no random):

```bash
# Verified against scripts/scan/trajectory.ts import.meta.main:
#   --bodies <traceBodies.json> is REQUIRED (a single TraceBody OR a TraceBody[]).
#   --out <path> is OPTIONAL — corroborations are written there, else to stdout.
Bash("scripts/cli/run.sh scripts/scan/trajectory.ts --bodies /tmp/sampled-bodies.json --out /tmp/corroborations.json")
# → TrajectoryCorroboration[]  ([{ signal, evidenceRef }, …])
```

Each corroboration pairs a coarse WHY-style `signal` (`loop/latency` · `tool-misuse` ·
`handoff-loss` · `prompt-underspec`, per the LOCKED `PATTERN_SIGNAL_MAP`) with an
`evidenceRef` pointing at the concrete trace span(s) (`trace:<id>#msg[i,j,…]`). A
discovered signal is promoted to **PRIMARY only if** a corroboration maps to its WHAT
**and** the `evidenceRef` resolves — LLM assertion alone never reaches PRIMARY (it is
capped at SECONDARY). This is the **evidence-cited floor**: mechanical trajectory
corroboration, not the analyzer's say-so, is what earns PRIMARY.

**(b) `foldedDigests` — cross-run ledger fold (R2).**
Compute the still-VALID cross-run deep-read digests for the diagnosed entity:

```ts
// scripts/library/store.ts — fold the per-entity deep-read-ledger.json down to the
// entries that are still valid (analyzerVersion + entityFingerprint + TTL match).
const foldedDigests = foldValidDigests(entityName, {
  analyzerVersion,        // bump invalidates prior digests
  entityFingerprint,      // entity changed under it → invalid
  nowMs: Date.now(),      // injected clock (deterministic in tests)
  // ttlMs defaults to DEEP_READ_LEDGER_TTL_MS (~30d)
});
```

A folded digest is **re-admitted as a discovered candidate but MUST re-pass the SAME
evidence floor** (its `evidenceRef` must still resolve + corroborate) — the ledger
carries version-stamped digests + validity only; it NEVER decides promotion. This is
how a discovered signal seen on a PRIOR run can re-surface without being trusted blindly.

**(c) `sampledCount` — honest prevalence denominator (R6).**
The count of traces actually deep-read this run. A discovered primary's census measure
reads *"seen in k/n sampled"* against THIS `n` — never a fabricated corpus rate over the
full window. Defaults to the window total when absent (best-effort).

**Assemble + thread.** The orchestrator writes the assembled object to a temp file and
passes it to the enricher at Step 8.5:

```json
// /tmp/signal-ctx.json
{
  "corroborations": [ { "signal": "tool-misuse", "evidenceRef": "trace:tr-7#msg[4,5]" } ],
  "foldedDigests":  [ /* DeepReadLedgerEntry[] from foldValidDigests */ ],
  "sampledCount":   18
}
```

> **Selection-flow summary (Wave-17).** Tier-0 is now a **pre-filter** (cheap candidate
> surfacing + the `objection.ts` objection-scan as a sampling-priority hint), NOT the
> arbiter of PRIMARY. The hub: **objection-scan + ledger-subtraction sampling** narrow
> *where to look*; **mandatory discovery** (deep-read) surfaces WHAT; the **evidence-cited
> floor** (mechanical trajectory corroboration) gates promotion; ranking is
> **impact-dominant** for discovered signals (impact first, prevalence tiebreak, default
> impact ≥ 2 so a fresh discovery never loses to latency-spike on a tie); prevalence is
> **honest k/n** over the sampled denominator. When the top discovered signal can't clear
> the floor, the enricher emits `suspectedPrimaryUnconfirmed` (R7) so the report shows
> *"suspected primary — unconfirmed"* instead of crowning a cheap signal.

## Step 7 — Aggregate + Deduplicate Findings

Collect all analyzer output files. Deduplicate by
`(traceId, failureOrigin.what + why + where)`. Cluster correlated findings
across analyzers. Merge into a single findings array.

**W13-C (Variance) — deterministic aggregate sort.** Parallel analyzers complete in
nondeterministic order, so the merged array's order drifted run-to-run even when the
content converged. After dedup, order the array with the deterministic sort so the
aggregate (and all downstream order: render, dedup-key emission, byte-identity) is
reproducible:

```bash
# Sort the deduped findings into a stable, content-addressed order (Type A pure script).
bun scripts/cli/run.sh scripts/aggregate/sort-findings.ts /tmp/findings-all.json /tmp/findings-all.json
```

This is a SORT, not a dedup — R-SI-1 (no new dedup script) is not engaged; dedup stays
in-memory in the orchestrator. The sort key is severity → confidence → failureOrigin
tuple (what·why·where) → findingId (see `scripts/aggregate/sort-findings.ts`).

### Step 7.1 — Findings-Contract Gate (W12-07 — post-aggregate, pre-RCA — MANDATORY)

Before the RCA layer (Step 8), validate the aggregated findings array against the
findings contract. This makes the CC-09 force-emit field set (was prose-only in
`handover-contract.md` → `required_remedy_fields`) executable, so a field-loss can
never reach the renderer.

```bash
# Write the merged findings array to a temp file, then validate.
bun scripts/cli/run.sh scripts/validate/findings-contract.ts /tmp/findings-all.json
```

- **Exit 0** → every finding satisfies the contract → proceed to Step 8 (RCA).
- **Exit 1** → the validator prints one machine-readable directive per offending
  finding on stdout, of the form:

  ```
  RESEND <findingId> with <comma-separated missing fields>
  ```

  Remedy-level misses are qualified as `remedy:<remedyId>.<field>` so the analyzer
  knows where to look. For each directive, **re-dispatch the analyzer for that
  finding's slice** (handover-contract `on_missing_field`: `max_redispatch: 2`,
  then `drop with marker INCOMPLETE_FIELDS`). Record each redispatch in
  `runMeta.redispatches[]` and `runMeta.decisions[]` (`step: "7.1-redispatch"`).

Required fields enforced (W12-08, PR-052 proposed + W13-C D-1):
- **Remedy:** `applyTarget` (HARD-required — every remedy links to a target),
  `targetClass`, `rationale`, `whyWorks`, `applyInstructions` (≥1), `cost`,
  `correctness` (both `low|medium|high`), and exactly one of `diff` (when source
  findable) **or** `diffStatus ∈ {source-unavailable, origin-unknown}` — NEVER a
  fabricated diff. (`rank` is enricher-derived, NOT gate-checked — see Step 8.)
- **Finding:** `findingId`, `actionable`, `failureOrigin`, `whyChain`,
  `sourceTraceIds`, `referenceIds`, `audience`, and ≥1 structured `assumption`.

The renderer therefore never has to crash on a malformed finding — the contract
catches it upstream here.

## Step 8 — RCA Layer (PR-002, PR-018, PR-020)

> **W13-C (Variance, RC-LLM-PIN):** the orchestrator's RCA reasoning here runs under
> the SAME pinned inference envelope as the analyzers (`temperature: 0`, explicit
> default `model`; see Step 6 dispatch). Clustering (15→N) is unpinned LLM judgment
> otherwise — pinning it makes the RCA layer reproducible. Model-intent-sacred:
> declare the pin, never silently swap.

For each finding cluster:

1. **WHAT** (wrong-output | missing-output | loop | latency-spike | cost-overshoot
   | format-violation | hallucination | user-complaint | low-score | missing-context)
2. **WHY** (prompt-underspec | prompt-overspec | tool-misuse | tool-missing
   | context-overflow | provider-limit | data-staleness | handoff-loss | dependency-failure)
3. **WHERE** (system-prompt | tool-definition | agent-config | routing-config
   | upstream-data | provider-side | harness-side | user-input)
4. **Recursive whys**: keep asking "why" until `isOrigin: true`. No fixed depth.
5. **Evidence**: every claim cites a specific trace message index, file:line, or tool call ID.
6. **Remedies**: ranked by cost × correctness. W13-C (D-1): this ranking is now
   implemented in code — the Step 8.5 enricher derives `remedy.rank` deterministically
   from the analyzer's `cost` + `correctness` categoricals via
   `scripts/enrich/rank-remedies.ts` (lower rank = higher priority; correctness
   dominates cost; ties broken by `remedyId`). The analyzer does NOT supply `rank`;
   deriving it removes an agent-discretion variance source and guarantees the
   renderer's RANK badge is never `undefined`.

Full taxonomy: `references/workflows/rca.md`.

## Step 8.5a — Build EntityContext (PRD-MP-04 — sub-step BEFORE enricher)

`entity-context.json` is produced at Step 3.7 by the normalizer's INTERNAL CLI
transport (W12-11 / OP-8). It is consumed DIRECTLY by the enricher via the
`--entity-context` flag — there is NO inline `bun -e` injection step. The
inline-glue hand-wiring (banned by R-SELF-03-c) that previously rebuilt the
FindingsInput envelope here was the root cause of OP-7 (silent `diagnosedEntity`
drop) and is removed:

```bash
# entity-context.json was already produced at Step 3.7 via:
#   run.sh scripts/normalize/platforms/langfuse.ts --in … --out-entity /tmp/entity-context.json
# Pass it straight to the enricher (Step 8.5) — the enricher's --entity-context
# flag takes precedence over findings.entities[0] (override + warn).
```

The enricher call at Step 8.5 therefore includes:

```
--entity-context /tmp/entity-context.json
```

### Per-platform extractor invocation (via the normalizer CLI transport)

| Source format | Step 3.7 transport call |
|---|---|
| `langfuse-export` | `run.sh scripts/normalize/platforms/langfuse.ts --in … --out-entity …` |
| `local-jsonl` | `extractLocalJsonlEntityContext(lines)` (via normalizer entrypoint) |
| `claude-code` | `extractClaudeCodeEntityContext(sessions)` (via normalizer entrypoint) |
| `codex` | `extractCodexEntityContext(sessions)` (via normalizer entrypoint) |
| `otel` | `extractOtelEntityContext(spans)` (via normalizer entrypoint) |

**Cross-references:**
- Step 3.7 (PRD-MP-01 / W12-11) — the authorized producer of `entity-context.json`
- Wave-5 R1.7 — "`diagnosedEntity` must come from the normalizer's EntityContext"
- PRD-CC-10 — `--entity-context` CLI flag (landed) — preferred over inline inject

> The operator NEVER hand-fills `diagnosedEntity`. It is derived deterministically
> from local normalizer output (no LLM, no network), produced by a single run.sh
> call at Step 3.7.

## Step 8.5 — Build Render Input (MANDATORY — Wave-5 R1.4/R1.5)

The renderer is **fail-loud**: it REFUSES (throws) when ≥3 of the 4 internal
render shapes (`diagnosedEntity` / `bigStat` / `hourlyHeatmap` / `signalCensus`)
are missing (R1 §9.3). The whole Wave-5 regression was the pipeline handing the
renderer a starved input that silently degraded to placeholders. **Never call the
renderer directly on raw findings.** Run the deterministic enricher first.

```bash
Bash("scripts/cli/run.sh scripts/enrich/build-render-input.ts \
     --tier0 /tmp/tier0.json \
     --slice-plan /tmp/slice-plan.json \
     --findings /tmp/findings.json \
     --metadata /tmp/trace-metadata.json \
     --output /tmp/render-input.json \
     --generated-at <ISO8601> \
     --signal-ctx /tmp/signal-ctx.json")
```

> **Wave-17 selection wiring (`--signal-ctx`, verified OPTIONAL in the parser).** Pass the
> `SignalCensusContext` assembled at **Step 6.5** so deep-read-discovered signals become
> first-class, evidence-floored census candidates. **Absent → safe-by-default**: the
> enricher runs the legacy Tier-0-only census and discovered signals stay
> *suspected-unconfirmed* (never crowned). `--signal-ctx` is additive (Zone-1.5) — existing
> callers/tests that omit it are byte-unaffected.
> (`--self-diag --skill-entity <path>` remain the self-diagnosis pairing — see Step 12.2.)

The enricher (`scripts/enrich/build-render-input.ts`) is **deterministic +
idempotent** (no network, no LLM, no random; the only clock value is the injected
`--generated-at`). It:

- aggregates `hourlyHeatmap` (24-cell grid) from per-trace `startTime` + `latencyMs`;
- computes `bigStat` (latency p50/p95/max, cost, traces, errors);
- builds `signalCensus` via the PR-049 5-step reconciled process (failure-validity gate → impact×prevalence → deep-read corroboration → ONE `runMeta.primarySignal`) + `scanFunnel` (4-stage: total → Tier-0 → sample N → deep-read 6/N with honest sample denominator);
- normalizes legacy free-text `assumptions` → structured `Assumption[]` (R1.3);
- **pulls `diagnosedEntity` FROM the normalizer's `EntityContext`** (R1.7,
  APPENDIX-A §A.2 — extracted at ingest in Step 4, NOT synthesized here). The
  orchestrator threads the normalizer's EntityContext through to the enricher;
  the operator never hand-fills `diagnosedEntity`.

**Self-diag (PR-022):** when `config.self_diagnostics.enabled`, pass the
self-diag option so the enricher forces `isMetaReport:true`, `audience:internal`,
a `[INTERNAL]` sessionId prefix, and the skill-typed EntityContext (built from the
skill's own SKILL.md + `scripts/` via `buildSkillSelfEntityContext`).

### F4 — CODIFIED runMeta methodology-widget threading (MANDATORY — not per-run-manual)

Six Methodology widgets must be threaded into the report. The threading is CODIFIED
here (not ad-hoc per run) so it can never silently regress. BEFORE assembling
`/tmp/findings.json` for the enricher call above, populate `findings.runMeta`:

| Widget field | Source | Who computes |
|---|---|---|
| `selectionRules` | impact×prevalence census scoring | **enricher** (F1, deterministic — do NOT pre-assign) |
| `signalSelectionTrace` | the signal-selection decision path | **enricher** (F1, deterministic — do NOT pre-assign) |
| `tierBreakdown` | the tier-coverage output / `wave6/*.json` stamp | **orchestrator** — assign from the stamp |
| `awarenessSample` | `buildAwarenessSample()` (Step 3.5) | **orchestrator** — assign (F2) |
| `blindSpots` | `buildBlindSpots().rows` (Step 3.5) | **orchestrator** — assign (F2) |
| per-finding `coverageProof` | the representative sampler (W12-13, Block A) | **already attached** upstream — thread, do NOT redo |

The enricher PRESERVES every `findings.runMeta` field on its passthrough (the
`...findings.runMeta` spread is unconditional — widget fields are never dropped, even
on a no-primary run) and ADDS only the two it can derive deterministically
(`selectionRules` + `signalSelectionTrace`). The orchestrator-assigned widgets
(`tierBreakdown` / `awarenessSample` / `blindSpots`) are upstream/LLM-produced and the
enricher NEVER recomputes them.

```ts
// Assign the tier-coverage breakdown from the sampler / wave6 stamp.
findings.runMeta.tierBreakdown = tierCoverageFromStamp;   // [{ tier, count, color? }]
// awarenessSample + blindSpots are assigned at Step 3.5 (see F2 above).
// coverageProof is already on each finding (W12-13) — passes through untouched.
```

> Regression proof (TASK-R24-1): run 210635 threaded NOTHING → 0 `<svg>`, widget
> fields MISSING in render-input runMeta → generic-fallback Methodology. run 194421
> threaded by hand → 1 `<svg>`, widgets rendered. The renderer was correct both times
> (`renderTierPie` returns `""` when `tierBreakdown` is absent); the bug was the
> missing CODIFIED threading step. This table is that step.

## Step 8.9 — Pre-Render Completeness Gate (PRD-SO-06 + W9-08)

Before rendering, run BOTH the Wave-6 checklist AND the completeness-check (W9-08).
A missing RunMeta, unfilled template section, or invalid Finding MUST fail loud —
never emit partial HTML.

**W9-08 completeness check** (B4 creates `scripts/validate/completeness-check.ts`):

```bash
# B2-fix (verified against import.meta.main): the default mode takes the
# RenderInput as a POSITIONAL argument (argv[0]) — NOT a --render-input flag.
Bash("scripts/cli/run.sh scripts/validate/completeness-check.ts /tmp/render-input.json")
# → exits 1 with missing-field list if RunMeta fields absent, sections empty,
#   template placeholders unfilled, or any Finding fails TypeBox validation.
# → assert isMetaReport => audience=internal (self-diag invariant)
#
# The SAME script also exposes a PRE-ENRICHER mode (distinct flag-driven entrypoint)
# that gates findings.runMeta BEFORE Step 8.5 — run it after Step 3.5 threading:
#   scripts/cli/run.sh scripts/validate/completeness-check.ts --pre-enricher \
#        --findings /tmp/findings.json [--checklist <report-checklist.yaml>]
#   → exit 0 = all orchestrator-threaded F4 widgets present; exit 1 = unthreaded list.
```

**W13-C (D-6): the completeness gate also asserts the renderer's EXACT dereference
contract** — not just RunMeta/section presence. It checks the fields render.ts
interpolates without a guard, so a gate-pass GUARANTEES a render-success (closing the
"gate passes but render crashes/garbles" gap that produced the D-1 `undefined` badges):
- top-level `sessionId` (render does `sessionId.toUpperCase()`);
- per-finding `actionable` is a string (render does `actionable.slice()`);
- per-finding `failureOrigin.evidence` + `failureOrigin.confidence`;
- per-remedy `rank` (number, enricher-derived) + `cost` + `correctness` (`low|medium|high`).
All gaps are reported at once (fail-loud with the full missing list).

**Wave-6 checklist gate** (PRD-SO-06 — verify each mandatory script emitted its stamp):

```bash
Bash("scripts/cli/run.sh scripts/validate/wave6-checklist.ts \
     --report-dir /tmp/report-dir \
     [--accept-exemptions <id>...]")
# → { ok: boolean, missing: string[], exemptions: string[] }
```

The checker reads `<report-dir>/wave6/<step>.json` for the steps:
`parse-brief` · `awareness-sample` · `blind-spots` · `library-match` ·
`caps-result` · `deep-read-gate` · `awareness-witness` (W11-05).

**W11-05 extra rule**: if the `awareness-witness` stamp declares
`isFreshRun=true + awarenessRan=false + no exemptionReason`, the checklist
HARD-FAILS regardless of `isClientReport`. This is non-bypassable.

| Report type | Gate behavior |
|---|---|
| Internal / self-diag | **Warn-only** — log missing steps, continue |
| Client (operator paid LLM tokens) | **Hard-fail** — HALT and AskUserQuestion before rendering |

When a step was skipped under a documented exemption, pass its id via
`--accept-exemptions`. The exemption MUST be recorded in `runMeta`:

```json
{
  "exemptions": [
    {
      "stepId": "awareness-sample",
      "reason": "library prior exists for this entity",
      "declaredBy": "Step 3.5 conditional skip rule"
    }
  ]
}
```

See `references/workflows/rca.md` Gate Exemption Taxonomy for valid exemption
reasons. `writeWave6Stamp` (exported from `scripts/validate/wave6-checklist.ts`)
is called by each Wave-6 script at completion to produce its stamp file.

**W12-02 inline-JS syntax gate** (propose **PR-050** — render-js-syntax.ts).
The completeness and Wave-6 gates above validate DATA shape; they cannot catch
interactivity-breaking JavaScript. A single asymmetric-escape in an emitted
template literal (W12-01: `/\r?\\n/` emitting a literal-CR regex) produces a
`SyntaxError` that silently kills the live-preview IIFE — check/uncheck + Copy
go dead while every data gate still passes. This gate runs on the RENDERED HTML
emitted by **Step 9** and is a HARD blocker before the report is opened/handed
back:

```bash
# Run AFTER Step 9 emits the HTML, BEFORE the report is opened or handed off.
Bash("scripts/cli/run.sh scripts/validate/render-js-syntax.ts \
     /tmp/report-dir/report.html")
# → parses every executable inline <script> body via new Function (no execution);
#   exits 1 with the offending script index + snippet on any SyntaxError,
#   exits 0 when all inline JS parses.
```

Skips non-executable scripts (external `src=`, `application/ld+json`,
`text/plain` payload bundles). **Non-bypassable** for all report types — a
report whose inline JS does not parse is broken for the operator regardless of
audience (the copy-back HITL surface is the skill's primary approval channel,
PR-014).

## Step 9 — Render HTML Report

Render the **enriched** input from Step 8.5 (NOT raw findings):

```bash
Bash("scripts/cli/run.sh scripts/report/render.ts --findings /tmp/render-input.json
     --audience <AUDIENCE>
     --output .mutagent-diagnostics/reports/{sessionId}/report.html")
```

**W13-D — `<AUDIENCE>` resolution (MANDATORY).** Compute the effective audience
deterministically via `resolveEffectiveAudience` (`scripts/config/schema.ts`) —
precedence, highest first:

1. an **explicit** operator `--audience` flag for THIS run (the operator typed it), else
2. `config.default_audience` (read from `.mutagent-diagnostics/config.yaml`; a fresh
   `init` writes `client`), else
3. the schema fallback `"internal"` (renderer's own argv default — only reached when
   neither config nor flag is present).

A fresh init therefore makes the **effective default `client`** (client-stripped
report). Pass the resolved value to `--audience`. When the operator gave no explicit
flag AND no config exists, OMIT the flag and let the renderer fall back to `internal`.

> **PR-022 invariant (non-bypassable):** for a self-diagnosis render
> (`isMetaReport:true`), the audience is ALWAYS `internal` — it overrides both the
> flag and `config.default_audience`. The enricher already forces `audience:internal`
> (Step 8.5) and the renderer hard-refuses `--audience client` on a meta report, so a
> self-diag run is never client. `resolveEffectiveAudience({ isMetaReport: true, … })`
> returns `internal` for this reason — call it with `isMetaReport` set so the
> orchestrator never even builds an `--audience client` invocation for self-diag.

Template defaults to `assets/templates/report.html.tpl` (or `default.html` pre-P4).

## Step 9.9 — Finalization Gate + Bounded Self-Heal (W14 — MANDATORY)

> **⚠ MANDATORY — non-bypassable, like the Step 6 deep-read pre-gate and Step 3.7
> normalize precondition.** This step runs AFTER Step 9 renders `report.html` and
> BEFORE any "report is done / rendered / open it" declaration — including Step 9.5
> (auto-open) and Step 10 (HITL handback). The orchestrator MUST NOT open, hand back,
> or describe the report as done until this gate is **CRIT-clean**.

**WHY this exists.** Step 8.9's completeness-check gates the **INPUT** (the
`RenderInput` JSON — the fields `render.ts` will dereference). This step gates the
**OUTPUT** — the rendered HTML the operator actually reads. It catches the
output-only bug class the input gate structurally cannot see: a soft render fallback
that shipped (`RANK n/a`, `cost:n/a`, `correct:n/a`), a literal `undefined`/`null`/`NaN`
that reached visible prose, a raw-JSON entity prompt (`{"prompt":`), or a
`class="internal"` node that survived the client strip (a leak). Deterministic,
no LLM, no spend — runs every render (operator decision: DOM/regex/string only).

**The producer + gate.** Checklist: `scripts/validate/report-checklist.yaml`
(one row per section: `require`/`forbid`/`tier`/`okEmpty`/`source`/`heal`). Gate:
`scripts/validate/finalize-gate.ts` → `{ pass, gaps[] }`, each gap carrying
`section · tier · what · sourceStep · healAction`. CRIT gaps ⇒ `pass=false`
(block "done"); WARN gaps ⇒ reported, `pass` stays true (stamp a banner).

> **Backtrace table:** `references/script-index.md` maps every section → its producer
> step → the gate that enforces it. Each checklist row's `source` is the producer to
> re-run; each `heal` is the re-run action. Step 9.9's self-heal loop is driven by
> these two columns — never by memory.

### The loop (precise — operator decision 3 + 4)

```text
1. Render → report.html                       (Step 9)
2. Run finalize-gate.ts on the RENDERED HTML:
     Bash("scripts/cli/run.sh scripts/validate/finalize-gate.ts \
          --report .mutagent-diagnostics/reports/${SID}/report.html \
          --audience <effective-audience-from-Step-9>")
   → exit 0 = CRIT-clean (may carry WARN gaps); exit 1 = ≥1 CRIT gap (block done).
3. IF CRIT gaps: for EACH gap, backtrace via its `sourceStep` (the script-index.md
   map) → re-run that producer/step → re-build the render input (Step 8.5) →
   re-render (Step 9) → re-run the gate (Step 9.9).
     ► BOUNDED: at most **2 self-heal rounds**. (round counter starts at 0; after the
       2nd failed re-check, STOP — do NOT attempt a 3rd.)
4. IF still CRIT-failing after the bound → **ESCALATE LOUD** to the operator:
   surface the unrecoverable section(s) + `sourceStep` + every heal action tried +
   the residual gap list. Do NOT declare done. Do NOT silently emit the report.
   (Use AskUserQuestion — the operator decides: accept-with-defect / abort / manual fix.)
5. WARN gaps (CRIT-clean) → emit the report WITH a visible
   "⚠ incomplete: <sections>" banner; report status as "rendered with N gaps."
6. ONLY when the gate is CRIT-clean may the orchestrator proceed to Step 9.5
   (auto-open) / Step 10 (handback) and declare the report done/rendered.
```

**Non-negotiable invariants** (operator decision 3): NEVER infinite-loop (hard cap = 2
rounds), NEVER silently emit a CRIT-incomplete report, ALWAYS escalate loud when the
bound is exhausted. The bound + escalate path is what makes "self-heal" safe — it is a
bounded retry with a loud failure mode, never an unbounded repair loop.

### Audience resolution

Pass the SAME effective audience computed at Step 9 (`resolveEffectiveAudience`,
see Step 9 W13-D). `--audience client` activates the internal-leak CRIT row
(`global-client-no-internal`) + exempts the Methodology sub-section rows (the whole
tab is node-stripped on client). `--audience internal` exempts the leak row and
arms the `loud-missing-widget` CRIT checks (a widget whose data was never threaded
into `runMeta` renders a loud marker — itself a forgotten-data tell).

### Relationship to the other rendered-HTML gates

Step 8.9's **render-js-syntax.ts** (W12-02 / PR-050) and this **finalize-gate.ts**
both run on the Step-9 RENDERED HTML and both block the open/handback. They are
complementary: render-js-syntax validates that inline JS *parses* (interactivity);
finalize-gate validates that section *data landed* (completeness). Run render-js-syntax
first (a broken IIFE makes the copy-back surface dead), then finalize-gate.

## Step 9.5 — Auto-Open Rendered Report (MANDATORY)

> **GATED BY Step 9.9.** Do NOT open until the finalization gate (Step 9.9) is
> CRIT-clean. Opening a CRIT-incomplete report violates the "never silently emit"
> invariant — the auto-open IS the "report is done, look at it" signal.

PR-014 declares the HTML report the **primary HITL surface**. After Step 9 writes
the HTML, the orchestrator opens it BEFORE prompting for copy-back — the operator
should never have to click a file path.

```bash
REPORT_PATH=".mutagent-diagnostics/reports/${SID}/report.html"
case "$(uname -s)" in
  Darwin)  Bash("open \"$REPORT_PATH\"") ;;
  Linux)   Bash("xdg-open \"$REPORT_PATH\" 2>/dev/null || printf 'file://%s\\n' \"$PWD/$REPORT_PATH\"") ;;
  MINGW*|MSYS*|CYGWIN*) Bash("start \"\" \"$REPORT_PATH\"") ;;
  *)       Bash("printf 'file://%s\\n' \"$PWD/$REPORT_PATH\"") ;;
esac
```

`$MUTAGENT_DIAG_HEADLESS=1` short-circuits the open and prints the `file://` URL only
(SSH-remote / CI / scripted runs).

## Step 10 — HITL Review Gate (PR-014)

Emit to operator:

```
Diagnostic report ready at: .mutagent-diagnostics/reports/{session}/report.html

Open the HTML in your browser, review the gold-standard report (Methodology · Overview · per-finding · Decisions), pick remedies using
the "Copy back markdown" buttons, and paste the markdown payload back into this chat.
That paste IS the approval signal.
```

**AskUserQuestion does NOT fire at this step.** Wait for operator to paste markdown.

## Step 11.0 — Report-Only Short-Circuit (PRD-SO-04)

Check `config.target.platform` before entering the apply flow:

```typescript
if (config.target.platform === 'report-only') {
  runMeta.applySkipped = { reason: 'config target = report-only' };
  // persist runMeta, then HALT — do NOT proceed to Step 11
  return;
}
```

When `platform === 'report-only'`:
- Skip the AskUserQuestion apply-confirmation gate entirely.
- Log `runMeta.applySkipped: { reason: 'config target = report-only' }`.
- Halt after Step 10 HITL review — the report is the deliverable.
- The Methodology tab Decisions row surfaces `applySkipped`.

When `platform` is any other value (e.g., `local-agent`, `local-code-construct`,
`remote`): fall through to the standard Step 11 parse-and-apply gate.

## Step 11 — Parse Copy-Back + Apply Gate

Parse the pasted markdown payload. Extract approved remedy IDs + finding references.
Validate each `remedyId` exists in the findings JSON.

Then AskUserQuestion for the final destructive-action gate:

```
AskUserQuestion: "Spawn BG agent on worktree to apply {N} approved remedies?"
Options:
  - Confirm — spawn BG worktree apply (opens PR per target, no changes to your branch)
  - Dry-run preview first (show exact diffs before committing)
  - Cancel
```

On confirm: dispatch `diagnostics-apply-worker` with `isolation: worktree`:

```
Agent(
  subagent_type: "diagnostics-apply-worker",
  run_in_background: true,
  worktree: true,
  prompt_includes: [approved_remedies, target_spec from config.yaml, diagnosed_at_hash]
)
```

Reference: `references/workflows/apply-dispatch.md`.

## Step 12 — Self-Diagnostics Check [INTERNAL] (PR-022) — REPORT-ONLY

> **Integration status: WIRED.** This step *is* the "Orchestrator integration:
> self-diagnostics check in `orchestrator-protocol.md`" item tracked in
> `references/internal/self-diagnostics.md` → §v0.1 Scope. The 2-line stub it
> replaced (probe + dispatch with no consumer) is gone; the full report-only
> sub-pipeline is described below. (The maintainer of `self-diagnostics.md` may
> now tick that scope checkbox — that file is owned there, not here.)

Self-diagnostics is **skill-maintainer-only, on-demand only, and REPORT-ONLY**:
it surfaces a meta-report about the diagnostics workflow itself and STOPS. It
**never** dispatches an apply-worker, never opens a PR, never mutates anything.
The host runtime being diagnosed is the current Claude Code session (the skill
diagnosing ITSELF), so the source platform is always `claude-code`.

Gate: only runs when `config.yaml: self_diagnostics.enabled == true` (default
`false` — explicit opt-in, see `references/internal/self-diagnostics.md`).

### 12.1 — Probe + dispatch descriptor

```bash
Bash("scripts/cli/run.sh scripts/self-diagnostics/probe.ts")     # detect host runtime
Bash("scripts/cli/run.sh scripts/self-diagnostics/dispatch.ts")  # write pending.json descriptor
```

`probe.ts` resolves the Claude Code session JSONL dir; `dispatch.ts` writes the
`SelfDiagnosticsDispatchDescriptor` to
`.mutagent-diagnostics/self-diagnostics/pending.json` (gitignored).

### 12.2 — Build the SKILL-typed EntityContext (self-diag entity)

The normalizer's claude-code transport runs in `--mode self-diag` to emit a
**skill-typed** `EntityContext` (`entityType:"skill"`, `codeAccess:true`) built
from the skill's own `SKILL.md` + script filenames, via
`buildSkillSelfEntityContext` (deterministic, no LLM):

```bash
Bash("scripts/cli/run.sh scripts/normalize/platforms/claude-code.ts \
  --in /tmp/self-session.jsonl \
  --mode self-diag \
  --skill-md .claude/skills/mutagent-diagnostics/SKILL.md \
  --skill-name mutagent-diagnostics \
  --out-entity /tmp/self-entity-context.json")
```

- `--mode self-diag` — selects `buildSkillSelfEntityContext` over the default
  generic agent extractor. REQUIRES `--skill-md` when `--out-entity` is set.
- `--out-entity` — the skill-typed `EntityContext`, fed to the enricher at
  Step 12.3 via `--skill-entity`.
- (Optional: `--scripts-csv <a.ts,b.ts>` seeds the tool inventory from script
  filenames; `--operator-prompt <text>` supplies the invocation input sample.)

### 12.3 — Enrich with `--self-diag` (flips on the meta-report invariants)

Pass the Step 12.2 skill-typed entity to the enricher via the **paired**
`--self-diag --skill-entity <path>` flags (SD-3). **`--self-diag` is what flips
the enricher into meta-report mode** — it forces `isMetaReport:true`,
`audience:internal`, an `[INTERNAL]` sessionId prefix, and cluster-grouped layout
(see `references/internal/self-diagnostics.md` → "Self-Diagnosis Report Mode").
`--skill-entity` supplies the skill-typed `EntityContext` that the self-diag path
renders as the diagnosed entity:

```bash
Bash("scripts/cli/run.sh scripts/enrich/build-render-input.ts \
  --tier0 /tmp/tier0-out.json \
  --slice-plan /tmp/slice-plan.json \
  --findings /tmp/findings.json \
  --metadata /tmp/traces-metadata.json \
  --self-diag \
  --skill-entity /tmp/self-entity-context.json \
  --output /tmp/render-input.json")
```

- `--self-diag` + `--skill-entity` are **paired and fail-loud**: each REQUIRES the
  other (the enricher exits non-zero if only one is supplied). Neither is useful
  alone — `--skill-entity` without `--self-diag` loads an entity the enricher
  would ignore; `--self-diag` without `--skill-entity` has no skill entity to
  render.
- **`--entity-context` is the WRONG flag here** — it supplies a *generic* entity
  for a normal client diagnosis and does NOT touch the self-diag gate (it never
  sets `isMetaReport`). The meta-report invariants come from `--self-diag` only.

### 12.4 — Render the meta-report + STOP

```bash
Bash("scripts/cli/run.sh scripts/report/render.ts /tmp/render-input.json")
```

`render.ts` REFUSES `--audience client` when `isMetaReport:true` (PR-022). The
meta-report HTML is the deliverable. **No Step 11 apply gate fires for
self-diag** — `target.platform` is effectively `report-only`, so the pipeline
HALTS at the rendered report. Maintainer reviews; nothing is applied.

Reference: `references/internal/self-diagnostics.md`.

---

## Script Execution Discipline (R-SELF-03-c — MANDATORY)

**Never inline Python heredocs or multi-line shell scripts in Bash() calls.**

Always call a published script via `scripts/cli/run.sh`:

```bash
# CORRECT
Bash("scripts/cli/run.sh scripts/fetch/claude-code-transcripts.sh --hours 24")
Bash("scripts/cli/run.sh scripts/tier0-scan.ts /tmp/traces.json")

# BANNED
Bash("python3 << 'EOF'\nimport json\n...\nEOF")
```

## Monitor Tool Compliance (R-SELF-12-a)

**Never** use `Bash("sleep N && cat <file>")`.
**Use** Monitor tool with `until` loop:

```
Monitor: until test -f /tmp/findings.json; do sleep 2; done
```

## Branch Hygiene (PR-004)

Never apply fixes directly to the operator's checked-out branch.
All local applies happen in an isolated git worktree (`diagnostics-apply-worker`).
PRs are the delivery mechanism.

## Design Principles in Effect

- PR-001: Tier 0 before LLM (Step 4 above)
- PR-002: RCA layer mandatory (Step 8)
- PR-004: Branch hygiene (Step 11)
- PR-005: Cap-of-5 on parallel analyzers (Step 6)
- PR-014: HITL via HTML + markdown copy-back (Step 10)
- PR-017: Dynamic-cluster slicing (Step 5)
- PR-018: Evidence-grounded RCA (Step 8)
- PR-019: Scripts vs agent ops — see `references/operation-inventory.md`
- PR-020: Recursive whys to failure origin (Step 8)
- PR-022: Self-diagnostics [INTERNAL] (Step 12)
- PR-023: Clipboard payloads = self-contained actionable plans (PR-023)
- PR-035: Deep-read gate mandatory (Step 6 pre-gate)
- PR-037: Library-first match + class memory (Step 4.5); best-effort — empty library proceeds fresh
- PR-040: Operator-driven single-arg invocation (Step 3a parse-brief)
- PR-043: Methodology decision-logging (Steps 5b · 6 · 8.9 · 11.0)
- PR-044: Normalize before analyze — Step 3.7 MANDATORY (Step 3.7)
- PR-048: Trace hungriness — tiered deep-read scales with population (Step 6 escalation loop)
- W18-context: Grounded diagnosis-context lens built before fan-out; analyzer MANDATORY-PRE-READ (Step 5.7 + Step 6 dispatch). Landed principles: PR-054 (problem-statement-format) + PR-055 (ground-dont-infer) in `.meta/design-principles.md` (proposals archived at `.memory/features/mutagent-diagnostics/PROPOSED/archive/`).
- W18-cache: Grounded cache detection — `cacheStatus` field only; absent ⇒ UNKNOWN, never "uncached"; never infer from flat `promptTokens` (Step 6 dispatch cache rule)
