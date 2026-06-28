# Verification Methodology — Background Investigator (finding false-positive audit)

> Audience: CORE. Sits beside [`rca.md`](rca.md) and [`handover-contract.md`](handover-contract.md).
> Status: **documentation, on-demand**. This wave it is invoked manually for a one-shot audit of a
> finished report. It is written to be **repeatable and improvable** — a future orchestrator step can
> consume it verbatim (see "Future wiring" at the end). It does NOT edit `references/principles.md`
> (operator-LOCKED); it only PROPOSES.

## 0. Why this exists

The producer-side gates enforce **shape, not truth**: `findings-contract.ts` checks fields are
present and well-formed, the problem-statement format gate rejects task-phrasing, and the Wave-18
analyzer rule "[Never infer cache/cost — read the field](../../assets/agents/diagnostics-analyzer.md)"
forces cache *detection* to come from real token fields. None of those re-validate that a finding's
**asserted mechanism** is consistent with the grounded evidence. A finding can be perfectly shaped,
honestly hedged in its assumptions, and still ship a **false positive** because its `failureOrigin`
or `whyChain` states — *as fact* — a mechanism that the trace data does not confirm.

The Background Investigator is the **independent, evidence-first audit pass** that closes that gap. It
re-derives each finding's claims from the raw trace evidence and the run's `diagnosis-context.md`,
and assigns a verdict. It is fed **raw data, never the orchestrator's conclusions** (peer-verification
discipline): seeding it with the hypothesis it is meant to test would make it corroborate the error.

## 1. Equipment (what the investigator must read FIRST)

Before auditing a single finding, the investigator reads, in order:

1. **`diagnosis-context.md`** — the run's grounded lens (entity identity · operator-stated purpose ·
   FULL untruncated system prompt · tool inventory · source code when accessible). This is the same
   Step-5.7 artifact the analyzers pre-read; it is how the investigator gets "full skill knowledge"
   of *what the entity was supposed to do*, so it can tell intended behavior from a real deviation.
2. **This methodology** — the five tiers + the verdict rubric.
3. **The per-source cache-detection reference** (§5) + the relevant
   [`references/source-platforms/<platform>.md`](../source-platforms/) — so it knows *where cache
   tokens live for this platform* and where a *false* `cacheStatus="unknown"` can arise.
4. **The raw evidence** — the sampled trace bodies and per-slice evidence files the findings cite,
   plus the run's mechanical artifacts (trajectory corroborations, the `wave6/*.json` methodology
   stamps, tier-0 output). These are the ground truth a citation is checked against.

If a required pointer's raw source is **not retained** (e.g. trace bodies were not persisted), the
investigator marks the affected citation **"unresolvable — needs raw-trace re-fetch"**. It never
guesses, and never upgrades an unresolvable citation to "confirmed".

## 2. The verdict — `AuditVerdict`

Each finding (and, where relevant, each remedy) gets one or more verdict rows:

```
AuditVerdict = {
  findingId: string
  remedyId?: string
  verdict: "CONFIRMED" | "DOWNGRADE" | "RETRACT"
  tier: "citation-truth" | "mechanism-consistency" | "corroboration-alignment"
       | "assumption-integrity" | "prevalence-honesty"
  reason: string              // plain-words why, ≤2 sentences
  contradictingEvidence: string  // the exact field/pointer that contradicts (e.g. "tr_7c1 cacheStatus=unknown")
  caveat?: string             // REQUIRED when verdict=DOWNGRADE — the SECONDARY caveat to render
}
```

A finding's overall disposition is the **most severe** verdict across its rows
(`RETRACT` > `DOWNGRADE` > `CONFIRMED`).

## 3. Handling rubric (operator-chosen: retract fabricated, downgrade unconfirmed)

| Condition | Verdict | Report effect |
|---|---|---|
| A **load-bearing** citation is fabricated or unresolvable, OR the origin claim is contradicted outright by the grounded evidence | **RETRACT** | Finding removed from the active set **with a visible ledger note** (Methodology tab) — never silent-dropped. |
| Finding is **plausible** but a load-bearing claim rests on an **unverified / unknown** mechanism (e.g. cache state unknown), or the WHAT/WHY is LLM-asserted-only with no mechanical corroboration, or a prevalence figure is inflated | **DOWNGRADE** | Severity capped to **SECONDARY**; the `caveat` is rendered; any "RECOMMENDED / RANK-1" emphasis on the dependent remedy is removed. |
| Claims dereference cleanly and are consistent with grounded fields | **CONFIRMED** | No change. |

**Visible, never silent** (Wave-17 discipline): a RETRACT writes a ledger note; a DOWNGRADE writes a
caveat. The operator can always see *what the audit changed and why*.

## 4. The five audit tiers

Run cheapest-first; a single finding may collect verdicts from several tiers.

### (i) Citation-truth resolution
For every `failureOrigin.evidence` and every `whyChain[].evidence` pointer (`trace-id#msg[range]`,
`file:line`, or a named run artifact), dereference it against the real trace body / source in
`diagnosis-context.md`. The dereferenced content must **support** the paired `whatHappened`.
- Unresolvable **load-bearing** pointer → **RETRACT** (or "unresolvable — needs raw-trace re-fetch"
  when the raw source simply was not retained; flag, do not retract on absence alone).
- Resolves but **does not support** the narration → **DOWNGRADE**.

### (ii) Mechanism-consistency — *priority tier: the caching class*
Flag any `failureOrigin` / `whyChain` step that asserts a **mechanism contradicted by a grounded
field**. The caching specialization (the motivating class):

> A **cache-dependent mechanism** asserted as fact — "the static prefix is re-sent / re-processed
> every step", "uncached", "no caching benefit", "per-step token re-pay" — while the grounded
> `cacheStatus` for the finding's `sourceTraceIds` is **`unknown`** or **`miss`-claimed-as-`off`**,
> **OR** while an `assumptions[]` entry about caching is **`unverified` / `hypothesis-pending`**.

→ **DOWNGRADE** to SECONDARY with caveat: *"cache state UNKNOWN — mechanism unverified; the rising
per-step latency may be the growing transcript, not the static prefix."* If the **entire** finding
rests on the uncached premise, escalate toward RETRACT.

This is the consistency check the analyzer's detection rule cannot make about itself: detection says
*"read the field, don't infer"*; the investigator says *"and don't ASSERT a mechanism the field
leaves unknown."*

### (iii) Corroboration alignment
A **PRIMARY** finding's `failureOrigin.what` / `why` must resolve against the run's mechanical
trajectory corroborations (retry-loop → loop/latency · tool-error → tool-misuse · abandoned-call →
handoff-loss · oscillation → prompt-underspec). LLM-asserted-only, with no mechanical corroboration
→ **DOWNGRADE** to SECONDARY (surface the same evidence-floor reason the enricher would).

### (iv) Assumption-status integrity
A load-bearing claim in `problem` / `failureOrigin` / `whyChain` cannot rest on an assumption marked
`unverified` / `hypothesis-pending` while being stated **declaratively as fact**. The contradiction
between a confident origin and its own hedged assumption → **DOWNGRADE**. (The caching FP is the
common instance of this general rule.)

### (v) Prevalence honesty
Any `k/n`, "N traces", or "X% of the population" claim is checked against `sourceTraceIds.length` and
the sampled denominator (`sampledCount`). A figure larger than the evidence supports → **DOWNGRADE**
with the corrected `seen in k/n sampled` in the caveat.

## 5. Per-source cache-detection reference

"Different ways depending on the trace source." Where cache tokens live, and where a **false**
`cacheStatus="unknown"` (which then licenses a caching FP under tier ii) can arise:

| Source | Where the cache signal lives | Easy-to-miss / false-`unknown` risk |
|---|---|---|
| **Langfuse** | per-GENERATION `usageDetails.input_cached_tokens` (cache read), `cache_creation_input_tokens` (cache write); Anthropic-shape `usage.cache_read_input_tokens` / `cache_creation_input_tokens`; flattened top-level aliases | Cache tokens on a **non-doGenerate** GENERATION span, or at **trace-level** `usageDetails`, are not seen if only leaf `doGenerate` spans are scanned. A flat export that omitted `usageDetails` ⇒ genuine `unknown` (do not read it as "uncached"). |
| **OTel** | span attrs `gen_ai.usage.cache_read_input_tokens` / `input_cached_tokens`, `gen_ai.usage.cache_creation_input_tokens`, `llm.usage.*` variants | Vendor-specific attribute names (`anthropic.*`, `bedrock.*`) and **baggage**-propagated usage are not in the standard key set ⇒ `unknown`. |
| **Claude-Code / Codex / local-JSONL** | no native cache-token reporting in the transcript format | `cacheStatus` is **always `unknown` / absent**. *Every* cache or per-step-cost claim on these sources is a hypothesis — tier (ii) downgrades any that are asserted as fact. |

Cross-reference: the analyzer's "Never infer cache/cost — read the field (W18-cache)" section is the
**detection** rule; this table tells the investigator where detection can legitimately fail to a
`unknown`, so it can tell *"unknown because the field was absent"* (a real hypothesis) from
*"unknown because the normalizer didn't look in the right place"* (flag for a normalizer follow-up).

## 6. Worked example (synthetic)

> **Finding F-syn-lat-2** (PRIMARY, RANK-1 RECOMMENDED remedy).
> `problem`: *"The agent runs ~6 serial reasoning calls per trace; per-step latency climbs from 2.2s
> to 5.6s because the 18k-token system prompt is re-sent and re-processed on every step."*
> `failureOrigin.whyChain[origin]`: *"system prompt re-sent every step inflates per-step cost."*
> `assumptions[]`: *"Rising per-step latency reflects growing input, not throttling — UNVERIFIED;
> `input_cached_tokens` not present in the export so caching state could not be confirmed."*
> Source platform: Langfuse export; `cacheStatus = "unknown"` for all source traces.

**Audit:**
- Tier (ii) mechanism-consistency: origin asserts "re-sent **and re-processed** every step" *as fact*
  → but re-*processing* only holds if the prefix is **uncached**, and `cacheStatus="unknown"`.
  `contradictingEvidence: "all sourceTraceIds cacheStatus=unknown; caching assumption UNVERIFIED"`.
- Tier (iv) assumption-integrity: the same assumption block marks caching unverified while the origin
  states it declaratively.

**Verdict:** `DOWNGRADE`, tier `mechanism-consistency`,
`caveat: "cache state UNKNOWN — the prefix may already be cached (~typical for static system
prompts); rising per-step latency may be the growing transcript, not prefix re-processing. Confirm
input_cached_tokens on live traces before prioritizing a prefix-caching fix."` → severity SECONDARY,
RANK-1/RECOMMENDED emphasis removed from the "enforce prompt caching" remedy. The *other* legitimate
driver (serial-chain depth) is unaffected and stays.

## 7. Future wiring (improve-loop)

This methodology is built to be promoted from on-demand to in-pipeline without rewrite:
- A `diagnostics-investigator` agent (sibling of `diagnostics-analyzer`) would take the inputs in §1
  and emit `AuditVerdict[]`.
- An orchestrator **Step 7.5** (post-`findings-contract`, pre-RCA) would run it and apply §3:
  DOWNGRADE → SECONDARY + caveat (reuse the enricher's existing SECONDARY caveat surface);
  RETRACT → remove + `RunMeta.decisions[]` ledger note.
- A deterministic backstop (`cache-consistency.ts`) could front-run tier (ii) for free.

To **improve** the methodology: when a new false-positive class is observed, add a tier (or a cue to
an existing tier) here with a synthetic worked example, the same way §4(ii) was seeded from the
prompt-caching class. Keep cues conservative — match explicit mechanism tokens, never any bare
mention of the topic — so the audit never manufactures its own false positives.
