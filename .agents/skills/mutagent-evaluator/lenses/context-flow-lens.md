# Context-Flow Lens — generic pinned-judge prompt (EV-028 / EV-029)

> **Track:** Data-Leak Tab — the **context-flow** dimension (agent context-flow,
> not data-pipeline). Scores over the deterministic **flow-graph** (EV-032) +
> **expected-flow** (EV-037), never the raw trace.
> **Pinning (R10):** PINNED model id + **temperature = 0**, recorded. **Mask the
> output.** Two audits on one flow-graph ⇒ byte-identical verdict.
> **Parameterized by the loaded subject profile** — flow/slot/tool names come
> from the flow-graph + expected-flow, NOT from any subject constant in the lens.

## Purpose

Judge an AGENT's context-flow for two leak families — the same `LEAK_SCHEMA`
SHAPE the data-pipeline dimensions use (`locus` C2C/UI · `cls` A/B ·
`formalStructure`), new producers:

- **EV-028 — tool-result threading.** A tool result produced at step N that is
  NEVER threaded into a later consumer's context (an `unthreadedOutput` in the
  flow-graph). Is the dropped result one the downstream step NEEDED? → leak
  (`locus: C2C`, `cls: B` producer-not-threaded). Or was it legitimately unused
  (a side-effect / log) → NOT a leak.
- **EV-029 — sub-agent handoff completeness.** A `lossyHandoff` (an expected-flow
  edge ABSENT from the actual graph): the dispatch brief did not carry the
  context the expected-flow says the child sub-agent needs. A child that runs
  without the context it required → leak (`locus: C2C`, `cls: B`). The
  expected-flow is the source of truth for "what the child NEEDED".

> This lens generalizes the v1 data-pipeline SHAPE to agent context-flow — it
> does NOT rebuild the engine. `flow-graph.ts` makes producers/consumers/edges
> EXPLICIT; `expected-flow` supplies the diff target; THIS lens adjudicates.

## Inputs (supplied by the harness, deterministic)

- `flowGraph` — the EV-032 graph for the trace under audit (`nodes` with
  produces/consumes slots · `edges` threaded handoffs · `unthreadedOutputs`).
- `expectedFlow` — the EV-037 spec (`dispatchToolNames` · expected `edges` ·
  `expectedUiSlots`).
- `candidates` — the deterministic `contextFlowCandidates` bundle
  (`unthreadedOutputs` = EV-028 candidates · `lossyHandoffs` = EV-029 candidates).
  These are CANDIDATES — the lens decides which are TRUE leaks + their severity.

## Method

1. **Threading (EV-028).** For EACH `candidates.unthreadedOutputs[]`
   `{node, name, slot}`: read the producing observation's output slot + the
   downstream steps. Decide: was this slot's value REQUIRED by a later step that
   silently re-derived it, guessed, or proceeded without it? → leak. Or a
   legitimate side-effect with no consumer → not a leak. Ground the verdict in
   the specific producer/consumer node names — never speculate.
2. **Handoff completeness (EV-029).** For EACH `candidates.lossyHandoffs[]`
   `{fromTool, toTool, slot?}`: confirm the expected producer→consumer threading
   is genuinely absent in `flowGraph.edges` (not merely renamed). A dispatch that
   handed a child an INCOMPLETE brief (the expected context never threaded) →
   leak. Cite the dispatch node + the missing slot.
3. **Severity.** HIGH when the dropped/incomplete context changes the agent's
   action (a wrong send, a hallucinated value, a child that acts on stale
   context). MED/LOW when cosmetic or recoverable. `formalStructure`: `exists`
   when a schema/contract for the handoff is defined but unenforced; `partial`
   when fields are optional; `none` when no handoff contract exists.
4. **No candidates → no leaks.** A fully-threaded, expectation-meeting graph
   returns an empty `leaks` array (the audit is allowed to find nothing).

## Output contract (masked, schema-validated → `LEAK_SCHEMA`, dimension="context-flow")

Emit ONE `LEAK_SCHEMA` leak per CONFIRMED context-flow leak:

```yaml
dimension: context-flow
summary: <one-line verdict on the headline context-flow leaks>
leaks:
  - id: CF-1                      # CF-n
    title: <unthreaded result | lossy handoff — named>
    locus: C2C                    # context lost between steps/components
    cls: B                        # producer not run / not threaded
    producer: <the node name that should have threaded it>
    whyNotProduced: <dropped result | incomplete dispatch brief>
    formalStructure: none|partial|exists
    severity: HIGH|MED|LOW
    whatsLost: <the slot/context + the downstream step that needed it>
    evidence: <flow-graph node ids + slot, e.g. "n3.draft unthreaded; n7 sendMessage proceeded without it">
```

**Never fabricate.** If a candidate turns out to be legitimately unused
(side-effect, log, terminal output), DO NOT emit a leak for it — say so in
`summary`. The flow-graph is the ground truth; cite node ids + slot names from it.
