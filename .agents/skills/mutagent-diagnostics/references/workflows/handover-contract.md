# Analyzer Dispatch Handover Contract

> **Authority**: W9-01 (PR-ND-1). Canonical for the analyzer INPUT envelope.
> On conflict between this file and an agent `operation_contract:` field, this file
> wins for inputs.
>
> **Who fills it**: the orchestrator (parent session), once per analyzer spawn
> (Step 6 of `orchestrator-protocol.md`). The same structured contract is rendered
> for EVERY parallel analyzer in a run — no ad-hoc prompts.
>
> **Audience**: CORE (internal — analyzer input wiring).

---

## `analyzer_dispatch` schema (v1.0)

```yaml
analyzer_dispatch:
  schema_version: "1.0"
  run_id: "{run_id}"                 # shared across all slices of one run; artifact-namespace root
  audience: "PRODUCT | META | CORE"  # propagated onto every finding (PR-033)

  slice:                             # one per spawned analyzer
    slice_id: "{slice_id}"
    trace_ids: ["{id}", "..."]       # non-empty; on empty => on_missing_field.empty_slice
  scope:
    has_error: true|false
    has_feedback: true|false
    is_primary_signal: true|false
    focus: "{parsedInvocation.focus | null}"

  artifacts_in:                      # explicit, not implied
    platform_reference: "references/source-platforms/{platform}.md"   # REQUIRED
    pattern_library:    "references/workflows/rca.md#pattern-library"  # REQUIRED (Tier 1/2)
    library_priors:     "{libraryMatches[] | null}"   # null on fresh entity (W9-02 best-effort)
    # W18-context: the GROUNDED LENS the analyzer MANDATORY-PRE-READs (its Step 0) BEFORE any
    # trace analysis. Built deterministically at orchestrator Step 5.7
    # (scripts/context/build-diagnosis-context.ts). The analyzer reads + understands it to set
    # its failure-mode lens, then corroborates findings against extracted FACT (name · scope ·
    # model · purpose · FULL system prompt · tools · source code). It carries NO hints to seed.
    diagnosis_context:  "/tmp/diagnosis-context.md"   # REQUIRED — analyzer pre-reads before analyzing

  required_finding_fields:           # analyzer self-validates BEFORE return
    # B1-fix: `assumptions` is a FINDING-level requirement — the gate
    # (scripts/validate/findings-contract.ts) rejects any finding without
    # ≥1 structured Assumption (AssumptionSchema). It was previously listed only on
    # `required_remedy_fields` (remedy-level) + narrated in the field map below,
    # while this SSoT list omitted it. Kept in lockstep with the gate.
    # W18-problem: `problem` is a FINDING-level requirement — the gate's
    # REQUIRED_FINDING_FIELDS includes it, AND the W18-gate (isTaskPhrasedProblem) RESENDS
    # `problem(task-phrased)` when a present `problem` reads as a task/remedy. See the Finding
    # schema + "Problem statement format" in diagnostics-analyzer.md / rca.md.
    [findingId, actionable, problem, failureOrigin, whyChain, sourceTraceIds, referenceIds, audience, assumptions]
  required_remedy_fields:            # CC-09 / W12-08 / W13-C force-emit set — non-null each
    # applyTarget HARD-required (every remedy links to a target); plus exactly one
    # of diff (when source findable) OR diffStatus ∈ {source-unavailable,
    # origin-unknown} — NEVER a fabricated diff (PR-052 proposed).
    # W13-C (D-1): cost + correctness REQUIRED (low|medium|high) — they feed the
    # renderer's header badges AND the enricher's deterministic rank derivation.
    # `rank` is NOT listed: it is enricher-DERIVED from cost × correctness (§8 /
    # scripts/enrich/rank-remedies.ts), never analyzer-supplied.
    [applyTarget, targetClass, rationale, whyWorks, applyInstructions, assumptions, cost, correctness, diff-or-diffStatus]

  artifacts_out:
    evidence_file: ".mutagent-diagnostics/{run_id}/evidence/{slice_id}.md"
    schema: "Finding[]"
  dedup_key: [traceId, "failureOrigin.what", "failureOrigin.why", "failureOrigin.where"]
  # W9-01: dedup is performed in-memory by the orchestrator at Step 7 (aggregate+deduplicate).
  # NO new dedup script is created (R-SI-1).

  file_access:
    reads:  ["references/**", "{trace-cli stdout}", "/tmp/tier0-out.json"]
    writes: [".mutagent-diagnostics/{run_id}/evidence/{slice_id}.md"]   # no writes outside namespace

  on_missing_field:
    action: "RESEND finding {findingId} with missing fields: {list}"
    max_redispatch: 2                # CC-09: after 2 failures, drop
    on_exhaustion: "drop with marker INCOMPLETE_FIELDS; log runMeta.decisions"
  on_missing_field.empty_slice: { action: "skip slice; log {sliceId, reason} to runMeta.decisions" }
  budget:
    # Per-analyzer slice read is bounded by the run-level tier (see orchestrator-protocol.md Step 6
    # escalation loop); time_cap_seconds may scale with tier (operator sub-decision).
    time_cap_seconds: 240
    on_cap_exceed: "emit partial findings with note (partial-emit, NOT reject)"
```

---

## Usage notes

- `run_id` is the session-scoped identifier; all artifact paths under
  `.mutagent-diagnostics/{run_id}/` share it.
- `library_priors` is `null` when the class-memory library returns no matches for
  this entity. Per PR-037 best-effort clause: empty library is valid — proceed fresh,
  no gate fires (W9-02).
- The `dedup_key` tuple `[traceId, failureOrigin.what, failureOrigin.why, failureOrigin.where]`
  is applied in-memory by the orchestrator at Step 7. No separate script.
- `required_finding_fields` and `required_remedy_fields` are the SINGLE source of
  truth. The analyzer `operation_contract:` mirrors them — not the other way round.

---

## Output schema — Finding / Remedy / Assumption (W13-C, D-7)

> **Why this section exists**: `required_*_fields` above lists field NAMES only.
> A names-only contract under-specifies the shapes — analyzers emitted boolean
> `actionable`, `status:"hypothesis"` with no `basis`, etc., and the Step-7.1 gate
> correctly rejected them. This section pins the TYPES + ENUMS + a worked example so
> the analyzer can produce contract-valid output on the first pass.
>
> **Authority**: these shapes MIRROR the canonical TypeScript interfaces in
> `scripts/normalize/trace.ts` and the runtime TypeBox schemas in
> `scripts/validate/findings-contract.ts`. On any drift, those files win.

### Enums (closed value sets)

```yaml
WhatCategory:  [wrong-output, missing-output, loop, latency-spike, cost-overshoot,
                format-violation, hallucination, user-complaint, low-score, missing-context]
WhyCategory:   [prompt-underspec, prompt-overspec, tool-misuse, tool-missing,
                context-overflow, provider-limit, data-staleness, handoff-loss, dependency-failure]
WhereCategory: [system-prompt, tool-definition, agent-config, routing-config,
                upstream-data, provider-side, harness-side, user-input]
Confidence:    [high, medium, low]
CostScale:     [low, medium, high]          # Remedy.cost
CorrectnessScale: [low, medium, high]       # Remedy.correctness
AssumptionStatus: [verified, unverified, hypothesis-pending]
TargetClass:   [local-agent-md, local-code-construct, cloud-rest]
DiffStatus:    [source-unavailable, origin-unknown]
```

### `FailureOrigin` (object — REQUIRED on every finding)

```jsonc
{
  "what":         "<WhatCategory>",     // REQUIRED enum
  "why":          "<WhyCategory>",      // REQUIRED enum
  "where":        "<WhereCategory>",    // REQUIRED enum
  "evidence":     "string (non-empty)", // REQUIRED — file:line, trace msg slice, or code pointer
  "whatHappened": "string (non-empty)", // REQUIRED (F-EV1) — plain-words narration of the event
                                        //   in the cited trace; companion to `evidence` (the pointer).
                                        //   e.g. "compose called the model 6x serially before returning"
  "example":      "string",             // OPTIONAL (F-EV1) — verbatim excerpt from the trace body
                                        //   illustrating whatHappened; PII-sanitized by the consumer before emit
  "confidence":   "<Confidence>"        // REQUIRED enum
}
```

> **F-EV1 evidence-narration (required going forward).** `whatHappened` tells the
> operator WHAT happened in plain words; `evidence` stays as the WHERE (file:line /
> trace-message pointer / code pointer). The optional `example` carries a verbatim
> illustrative quote. Same two fields apply to every `WhyChainEntry` below.

### `Assumption` (object — finding carries ≥1)

```jsonc
{
  "text":   "string (non-empty, one objective sentence)", // REQUIRED
  "status": "<AssumptionStatus>",  // REQUIRED enum — NOT "hypothesis"; use "hypothesis-pending"
  "basis":  "string (non-empty)"   // REQUIRED — the evidence basis OR the source still required
}
```

### `Remedy` (object — finding carries ≥1; analyzer-emitted fields)

```jsonc
{
  "remedyId":          "string (non-empty)",       // REQUIRED
  "title":             "string (non-empty)",       // REQUIRED
  "applyTarget":       "string (non-empty)",        // REQUIRED — file/construct the remedy edits
  "targetClass":       "<TargetClass>",             // REQUIRED enum
  "rationale":         "string (non-empty)",        // REQUIRED — comparative (why this finding is real)
  "whyWorks":          "string (non-empty)",        // REQUIRED — causal (why the fix resolves it)
  "applyInstructions": ["string", "..."],           // REQUIRED — ≥1 ordered step
  "cost":              "<CostScale>",               // REQUIRED enum (W13-C, D-1)
  "correctness":       "<CorrectnessScale>",        // REQUIRED enum (W13-C, D-1)
  // exactly ONE of the following two (never both, never neither — never a fabricated diff):
  "diff":       { "before": "string", "after": "string" }, // when source is findable
  "diffStatus": "<DiffStatus>"                              // else — explicit absence marker
  // NOTE: `rank` is NOT emitted by the analyzer — the enricher derives it from
  // cost × correctness (scripts/enrich/rank-remedies.ts). Any emitted rank is overwritten.
}
```

### `Finding` (top-level object the analyzer emits)

```jsonc
{
  "findingId":     "string (non-empty)",          // REQUIRED — "F-{sliceId}-{n}"
  "actionable":    "string (non-empty SUMMARY)",  // REQUIRED — a STRING, not a boolean
  "problem":       "string (non-empty DESCRIPTION)", // REQUIRED (W18-problem) — "<subject> <observed
                                                   //   behavior> — <quantified impact + evidence>".
                                                   //   A DESCRIPTION, NOT a task: no leading imperative
                                                   //   verb; fix lives only in remedies. The W18-gate
                                                   //   RESENDS problem(task-phrased) on violation.
  "failureOrigin": { /* FailureOrigin */ },        // REQUIRED
  "whyChain":      [{ "why": "string", "evidence": "string", "whatHappened": "string", "isOrigin": true }], // REQUIRED ≥1 (whatHappened REQUIRED per F-EV1; optional "example")
  "assumptions":   [{ /* Assumption */ }],          // REQUIRED ≥1 structured entry
  "remedies":      [{ /* Remedy */ }],              // REQUIRED ≥1
  "sourceTraceIds":["string", "..."],               // REQUIRED ≥1
  "referenceIds":  { "traceId": "string", "sessionId": "string", "findingId": "string" }, // REQUIRED
  "audience":      "PRODUCT | META | CORE"          // REQUIRED — set by dispatcher, propagated
}
```

### Worked example (contract-valid)

```json
{
  "findingId": "F-slice-0-1",
  "actionable": "The compose tool issues 6 sequential model calls per draft, dominating p95 latency.",
  "problem": "The compose tool issues 6 sequential model calls per draft — 4.2s p95, 3.1× the 1.4s session median, on 12/40 traces.",
  "failureOrigin": {
    "what": "latency-spike",
    "why": "tool-misuse",
    "where": "tool-definition",
    "evidence": "trace tr_001 msgs 4-15: compose-tool called 6x serially before return",
    "whatHappened": "the compose tool fired one model call per section, six in a row, before returning the draft",
    "example": "compose-tool → model.call(section=1) … model.call(section=6) → return",
    "confidence": "high"
  },
  "whyChain": [
    { "why": "compose issues one model call per section", "evidence": "tr_001 msgs 4-15", "whatHappened": "each section triggered its own sequential model call instead of one batched call" },
    { "why": "no batching guard in the tool definition", "evidence": "agent-def compose-tool spec", "whatHappened": "the tool spec had no batch/parallelism cap, so the calls ran serially", "isOrigin": true }
  ],
  "assumptions": [
    { "text": "Section count drives the call count.", "status": "verified", "basis": "Confirmed across 40 sampled traces (msgs 4-15)." }
  ],
  "remedies": [
    {
      "remedyId": "R-slice-0-1-a",
      "title": "Batch the compose model calls",
      "applyTarget": "scripts/tools/compose.ts:42",
      "targetClass": "local-code-construct",
      "rationale": "Sequential per-section calls are the dominant latency sink; batching addresses the root cause directly.",
      "whyWorks": "A single batched call removes the serial round-trips, so latency scales with one request not N.",
      "applyInstructions": ["Open compose.ts", "Collect sections then issue one batched call", "Re-run the suite"],
      "cost": "low",
      "correctness": "high",
      "diff": { "before": "for (s of sections) await model(s)", "after": "await model(sections)" }
    }
  ],
  "sourceTraceIds": ["tr_001"],
  "referenceIds": { "traceId": "tr_001", "sessionId": "s_xyz", "findingId": "F-slice-0-1" },
  "audience": "PRODUCT"
}
```
