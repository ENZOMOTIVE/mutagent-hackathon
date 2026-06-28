# RCA Layer — Root Cause Analysis Procedure

> Renamed from "Translation Layer" (operator iter-6 T6).
> 3-dimensional WHAT/WHY/WHERE taxonomy + recursive whys until failure origin.

## Step 0 Construct scope

**I-021 + I-030: Mandatory before any hypothesis or signal enumeration.**

Define the scope of the diagnostic run BEFORE generating any hypothesis:

1. **What is IN scope**: specify agent IDs, time window, platforms, session range, or `TraceFilter.skillAgentScope` entries.
2. **What is OUT of scope**: explicitly name what will NOT be analyzed (e.g., dependent services, pre-existing flakiness, traces older than N days).
3. **Sampling strategy**: if more traces exist than the LLM budget allows, document how the sample was drawn (e.g., "top-N by negative score", "stratified by error rate", "random seed 42"). Populate `RunMeta.samplingStrategy` for the Methodology tab renderer.
4. **Scope filter expression**: record the filter as `RunMeta.scopeFilter` (freeform, e.g., `"agentId=search-agent, last 7d, hasFeedback=true"`).

> **Why this matters**: Scope discipline prevents false attributions. A finding that is "out of scope" for this session is NOT a finding — it belongs to a separate diagnostic run. Without an explicit scope boundary, analysts overgeneralize from a sample.

**I-030 Scope/Sampling methodology** — practitioners completing `run-meta.json`:
- `totalTraces`: total traces in the platform matching the query (pre-sampling)
- `tier0ScannedCount`: how many were seen by tier-0 static scan
- `llmReadCount`: how many were sent to LLM analyzers
- `scopeFilter`: human-readable filter expression (copied from Step 3 NL→TraceFilter translation)
- `samplingStrategy`: e.g., `"top-20 by negative normalizedScore"` or `"stratified: 5 per error type"`
- `decisions`: log key choices (model, threshold, excluded platforms, session limits)

> **PR-043 — Methodology decision-logging**: every methodology decision made
> during the run (slicer override, dispatch count, exemption, apply-skip) MUST
> be recorded in the corresponding `runMeta` append-only field. See
> `references/principles.md` PR-043 and `references/workflows/orchestrator-protocol.md`
> Steps 5b · 6 · 8.9 · 11.0 for the full field map. Silent skips are a protocol
> violation — reproducibility depends on this trail.

---

## Step 0 Signal census

**I-031 (PR-028 earn-keep + PR-049): Enumerate ALL signals BEFORE generating any hypothesis; select primary by the reconciled process.**

After scope is established, run a complete signal census using the PR-049 5-step detect+select process:

1. Execute `scripts/tier0-scan.ts` on the scoped trace set.
2. Record every signal type present: errors, feedback clusters, low-score traces, high-latency traces, API exhaustion, skill-behavior-deviation counts.
3. **Failure-validity gate** — rule out benign observability artifacts (e.g. `low-tagging-rate`) before scoring. Ruled-out signals appear in the census with a "ruled out — benign" label.
4. **Impact×prevalence scoring** — score = impact × (matchCount / total). Never use raw frequency alone as the primacy criterion.
5. **Deep-read corroboration** — after LLM analysis, reconcile with `findings[0].failureOrigin.what`. The LLM-found primary confirms or overrides the static rank. Emit ONE `runMeta.primarySignal` driving census·heatmap·funnel.
6. Only AFTER the full census + primary selection is documented, proceed to hypothesis generation.

> **Principle PR-028**: No diagnosis without signal census first. The census ensures all signal types are considered, even if most are subsequently dismissed.
>
> **Principle PR-049**: Primary signal MUST be selected by the reconciled 5-step process (failure-validity gate → impact×prevalence → deep-read corroboration). Never a frequency artifact.

**Anti-pattern** (PR-028 + PR-049 violation): "I see lots of `low-tagging-rate` patterns so the problem is X" — `low-tagging-rate` is a benign observability artifact, not a failure WHAT; it is ruled out by step 3 above. Check feedback, score, latency signals first.

---

## Flow

```
Feedback OR Issue (raw from trace)
  ↓
Step 0: Construct scope (I-021 — what's in/out, sampling strategy, RunMeta fields)
  ↓
Step 0: Signal census (I-031 — enumerate ALL signals before any hypothesis; PR-028)
  ↓
Clustered Feedback + Issues (cross-actor dedup + cluster correlation)
  ↓
Root Cause Analysis
  - 3-dim WHAT/WHY/WHERE + evidences + reference IDs
  - Read-definition discipline (I-022) + Assumption enumeration (I-023)
  ↓
Remedy Chain (ranked by cost × correctness — each = failureOrigin + before/after diff)
  ↓
HTML Report (gold-standard multi-tab presentation — Methodology · Overview · per-finding (one tab per finding) · Decisions; built via the Step 8.5 enricher)
```

## Taxonomy

### WHAT (symptom) — 10 categories

| Category | Looks like |
|----------|-----------|
| `wrong-output` | Agent returned incorrect answer (factually, structurally, or semantically) |
| `missing-output` | Agent returned empty / refused / gave up |
| `loop` | Agent repeated the same operation N times without progress |
| `latency-spike` | Trace took dramatically longer than baseline |
| `cost-overshoot` | Trace consumed more tokens / dollars than budget |
| `format-violation` | Output didn't match expected schema (JSON parse fail, wrong shape) |
| `hallucination` | Agent invented a fact / cited non-existent source |
| `user-complaint` | Embedded user feedback expressed dissatisfaction |
| `low-score` | Score signal below threshold (after scale auto-discovery) |
| `missing-context` | Agent lacked needed context — missing tools, OR tools/data exist but stale, OR empty results |

### WHY (root cause type) — 9 categories

| Category | Looks like |
|----------|-----------|
| `prompt-underspec` | Agent did X because the prompt didn't tell it not to |
| `prompt-overspec` | Prompt contradicts itself; agent picked wrong arm |
| `tool-misuse` | Right tool, wrong args / wrong order |
| `tool-missing` | Needed a tool that wasn't available |
| `context-overflow` | Truncation / summarization cut required information |
| `provider-limit` | Model refused / quota / rate limit / safety filter |
| `data-staleness` | Agent used stale info; needed refresh |
| `handoff-loss` | Multi-agent flow lost context between handoffs |
| `dependency-failure` | Upstream service / API / DB failed |

### WHERE (origin location) — 8 categories

| Category | Looks like |
|----------|-----------|
| `system-prompt` | The agent's system prompt (e.g., `.claude/agents/<id>.md:34`) |
| `tool-definition` | Tool schema / description / parameter spec |
| `agent-config` | Model selection, temperature, max-tokens, thinkingBudget |
| `routing-config` | How requests get routed to this agent vs another |
| `upstream-data` | Input data shape / quality (RAG index, DB row, etc.) |
| `provider-side` | LLM provider behavior (model deprecated, rate limited, safety-filtered) |
| `harness-side` | Coding-agent runtime (Claude Code, Codex) — context window, tool injection bugs |
| `user-input` | Ambiguous or out-of-scope user prompt |

## Recursive Why-Chain

No fixed depth. Keep asking "why" until failure origin is identified.

Rules:
1. Each `why` entry must have a corresponding `evidence` pointer (trace message index, file:line, code pointer)
2. `isOrigin: true` marks the deepest causal level — the fix lives here
3. Never stop at "the agent made an error" — that's a symptom, not an origin

Example:
```
WHY: Agent re-called search_docs 11x
  evidence: tr_abc msg 4-15
WHY: Results not deduplicated
  evidence: tool-call outputs identical across calls
WHY: No dedup instruction in prompt  ← ORIGIN
  evidence: .claude/agents/search-agent.md:34
```

## Finding shape

```typescript
{
  findingId: "F-001",
  actionable: "Agent re-called search_docs 11x in trace tr_abc",
  // W18-problem: REQUIRED descriptive problem statement (see "Problem statement" below).
  problem: "Agent re-called search_docs 11× with identical args on 1/40 traces — 11 wasted tool round-trips, no new context gained (tr_abc msgs 4-15).",
  failureOrigin: {
    what: "loop",
    why: "prompt-underspec",
    where: "system-prompt",
    evidence: ".claude/agents/search-agent.md:34 — no dedup directive",
    confidence: "high"
  },
  whyChain: [
    { why: "Agent re-called search_docs 11x", evidence: "tr_abc msg 4-15" },
    { why: "Results not deduplicated", evidence: "tool-call outputs identical" },
    { why: "No dedup instruction in prompt", evidence: "system_prompt:34", isOrigin: true }
  ],
  remedies: [
    {
      remedyId: "R-001",
      title: "Add dedup instruction to system prompt",
      failureOrigin: { what: "loop", why: "prompt-underspec", where: "system-prompt" },
      diff: {
        before: "You are a search assistant. Answer questions.",
        after: "You are a search assistant. Answer questions. Deduplicate tool-call results — if a tool returns identical output to a previous call, do not call it again."
      },
      cost: "low",
      correctness: "high",
      rank: 1
    }
  ],
  sourceTraceIds: ["tr_abc"],
  referenceIds: { traceId: "tr_abc", sessionId: "s_xyz", findingId: "F-001" }
}
```

## Problem statement (W18-problem)

**Every Finding carries a REQUIRED `problem` field** — the descriptive PRIMARY block of the
finding panel (rendered at the TOP, before Evidence / why-chain / remedies). It DESCRIBES the
failure and its measured impact; it is **NOT a task**.

**Format** (canonical in `scripts/normalize/trace.ts` `Finding.problem`):

```
<subject> <observed behavior, declarative> — <quantified impact + evidence> [— scope: N/total traces]
```

Describes WHAT is wrong and HOW BAD — not what to do about it. **The fix lives ONLY in
`remedies`.** A `problem` that LEADS with a bare imperative verb (`make · use · cap · add ·
reduce · switch · replace · enable · fix · consider · try · avoid · ensure · implement ·
increase · decrease · move · remove · update · set`) or uses a prescriptive modal (`should` /
`must` / `needs to`) in its main clause is REJECTED by the W18-gate (`isTaskPhrasedProblem` in
`scripts/validate/findings-contract.ts` → `RESEND <findingId> with problem(task-phrased)`).

**Transform — task phrasing → descriptive phrasing** (generic draft-tool example):

| | Statement |
|---|---|
| ❌ task-phrased (rejected) | `Make the draft tool faster — use a smaller model.` |
| ✅ descriptive (accepted) | `The draft tool takes 4.2s p95 — 3.1× the 1.4s session median — on 12/40 traces.` |

The transform: strip the imperative verb + the embedded fix; lead with the subject; state the
observed behavior declaratively; quantify the impact with trace evidence. The remedy ("use a
smaller model" / batch the calls / …) moves to `remedies` where it belongs. A subject-first,
past-tense observation is always safe (e.g. "throughput reduced to 12 req/s" leads with the
subject `throughput`, not a bare verb — never flagged).

## Cache / cost detection — read the field, never infer (W18-cache)

When a Finding touches prompt-caching, cost, or token volume, cache state comes ONLY from the
grounded cache-token fields on the trace (`scripts/normalize/trace.ts`): `cacheStatus` ∈
`hit` | `miss` | `unknown` (derived from `cachedInputTokens` / `cacheCreationTokens`);
`cacheHitRate` populated ONLY when the cache fields were present.

1. `cacheStatus` **absent or `"unknown"`** ⇒ report cache state as **UNKNOWN**, NEVER as
   "uncached". Absence of a cache-token field is NOT evidence of no caching.
2. **NEVER infer** caching (or its absence) from a flat `promptTokens` value or byte sizes —
   that inference is the motivating miss (caching active ~89%, but a byte-size guess reported
   "uncached → 408M billed tokens").
3. `miss` (cache fields present, nothing served) is a GROUNDED no-read — distinct from
   `unknown`. Never collapse "we don't know" into "no caching happened".

> **Corollary to the Evidence bar (I-032 / PR-018):** a cache/cost claim is observable evidence
> ONLY when it reads the cache-token field. An inferred uncached assumption is NOT evidence — a
> `cost-overshoot` Finding built on it is a hypothesis, not a confirmed finding.

## Remedy ranking criteria

| Axis | Description |
|------|-------------|
| cost | low / medium / high (code changes required, risk of regression, operator effort) |
| correctness | low / medium / high (confidence this fixes the failure origin) |
| rank | 1 = highest priority (low cost + high correctness) |

Always provide at least one remedy per finding. Prefer low-cost high-correctness options at rank 1.

## Read-definition discipline

**I-022: Every Finding MUST cite the source that defines the deviation.**

Before marking any Finding as confirmed:
1. **Locate the authoritative definition**: the rule, spec, or contract that the observed behavior violates. This is a file path + line number (e.g., `references/workflows/rca.md:34`) or an explicit design principle (e.g., PR-028).
2. **Quote or cite the relevant passage**: don't paraphrase from memory — read the actual source file.
3. **Tag unverified claims**: if you believe a rule exists but haven't read the source yet, mark the Finding with tag `hypothesis-pending-source` and do NOT finalize it.

**Anti-patterns** (I-022 violations):
- "The agent should have done X" — without citing where X is specified
- "According to PR-028, ..." — without reading `references/principles.md` to confirm the principle's text
- Citing training-data recollections instead of reading the actual repo file

> **Why**: Misremembered or stale rules are a common source of false findings. The read-definition discipline forces evidence from the current codebase, not from memory.

---

## Assumption enumeration

**I-023 (PR-024 + PR-030 earn-keep): Enumerate all assumptions before finalizing any Finding.**

Before writing `Finding.assumptions[]`, enumerate:
1. **Domain facts assumed true** but not verified from trace evidence (e.g., "the tool was available", "rate limits were not hit during this window").
2. **Preconditions assumed met** (e.g., "upstream data was fresh", "the agent had the correct model").
3. **Causal claims**: every link in the why-chain that is inferred (not directly observed) should be listed as an assumption until evidence is found.

**Format**: each entry in `Finding.assumptions[]` is a structured `Assumption` object — `{ text, status, basis }` (canonical type in `scripts/normalize/trace.ts`). `text` = the assumption as a single declarative sentence; `status` ∈ `"verified" | "unverified" | "hypothesis-pending"` (drives the renderer pill); `basis` = the evidence the status rests on, or the source still required.

**Examples**:
```json
"assumptions": [
  { "text": "Tool timeout is the primary cause of empty results", "status": "hypothesis-pending", "basis": "search.ts timeout config not yet read" },
  { "text": "No existing retry-cap exists in the tool definition", "status": "unverified", "basis": "tool definition not inspected" },
  { "text": "The session ran in production (not staging)", "status": "verified", "basis": "env=prod in trace metadata" }
]
```

> **Minimum bar**: the assumptions array MUST NOT be empty on any confirmed Finding. An empty array means either (a) the analyst didn't enumerate, or (b) the finding has zero unverified claims — document the latter explicitly with a single entry `{ "text": "all claims directly evidenced", "status": "verified", "basis": "every why-chain link observed in the trace" }`.

---

## Assumption explicitness

**I-023 (PR-030): Making assumptions explicit is load-bearing for remedy correctness.**

The assumptions array is not a formality — it is the primary mechanism for catching overconfident findings. Concrete rules:

1. **No assumption → no diagnosis**: If you can't enumerate any assumptions for a Finding, you either have a trivially-obvious bug (rare) or you haven't thought hard enough about what you're asserting.
2. **hypothesis-pending-source items block finalization**: A Finding tagged with `hypothesis-pending-source` entries is a DRAFT, not a confirmed finding. It cannot be promoted to the approved remedy set.
3. **Reviewers check the assumptions array first**: When reviewing a Finding, the first question is "are the assumptions warranted?" not "is the remedy correct?". A correct remedy built on a false assumption is worse than no remedy.

---

## Evidence bar

**I-032 (PR-018): Every Finding MUST carry observable evidence before diagnosis.**

PR-018 (Evidence-Grounded RCA) defines the minimum evidence bar:
1. **Observable in the trace**: the evidence must be a specific message index, tool call output, file:line pointer, or metric value — NOT an inference from absence.
2. **Cited in `failureOrigin.evidence`**: the `evidence` field is MANDATORY on every `FailureOrigin`. Empty evidence string = invalid Finding.
3. **Each why-chain entry must cite evidence**: `WhyChainEntry.evidence` is required. "because that's how it works" is not evidence.

**Anti-patterns** (PR-018 violations):
- `"evidence": "agent clearly looped"` ← "clearly" is a judgment, not a pointer
- `"evidence": ""` ← empty (invalid)
- `"evidence": "expected behavior from training"` ← memory, not observable trace data

> **Corollary to I-031 Signal Census**: Evidence must be gathered FROM the trace batch, not invented from domain intuition. If you can't find the evidence in the signal census output, the Finding is a hypothesis, not a confirmed finding — keep the `hypothesis-pending-source` tag.

---

## Known failure patterns (Tier 1 fast-path)

Patterns detected by `scripts/tier0-scan.ts` or Tier 1 of the analyzer:

| Pattern ID | Name | Detection | WHAT mapping |
|------------|------|-----------|-------------|
| P-001 | error-spike | > 20% error rate in trace batch | `wrong-output` |
| P-002 | latency-spike | > 10% traces with P99 > 10s | `latency-spike` |
| P-003 | feedback-cluster | > 5% feedback-bearing traces | `user-complaint` / `low-score` |
| P-004 | tool-loop | same tool called ≥3× with identical args | `loop` |
| P-005 | empty-output | agent output = empty / null / refusal | `missing-output` |
| P-006 | format-fail | JSON.parse of structured output fails | `format-violation` |
| P-007 | token-cap | total_tokens near model limit | `cost-overshoot` |

> **PR-048 cross-ref (W9-09 — Trace Hungriness):** the pattern library above accumulates
> confirmed patterns per escalation batch (Step 6 loop). Each rung appends newly confirmed
> patterns from that batch's LLM reads so the library grows with each tier. A run's
> detectable-pattern set after tier 1000 is materially richer than after tier 100.
> See `references/principles.md` PR-048 and `references/workflows/orchestrator-protocol.md`
> Step 6 escalation loop.
