# Methodology-Critic Lens — Tab-4 (FITNESS, not conformance)

> **Track:** Tab-4 — the §1.5 family. **Advisory, NOT pass/fail** (decision #5
> keeps GATE and TREND/fitness separate). A methodology can score 100%
> conformance (Tab-1) and still be the wrong/inefficient choice; this lens
> answers that second question independently.
> **Pinning (R10):** PINNED model id + **temperature = 0**, recorded. **Mask the
> output.**
> **Parameterized by the loaded subject profile** — the subject's behavior-tree +
> MR rubric drive the critique; no subject-specific logic in the lens.

## Inputs (supplied by the harness / methodology-review.ts)

- `behaviorTree` — the subject's decision-tree.
- `methodologyRubric` — the subject's `methodology-review.yaml` (MR-1..9).
- `runTrajectory` — the run's trajectory + findings + data-pipeline trace.

## The rubric (run each item; emit a finding, ranked)

| MR | Concern | What to interrogate |
|----|---------|---------------------|
| MR-1 | Decision-tree fitness | Does each fork earn its place? Flag **dead / rarely-useful / mis-placed** forks vs what the run needed. |
| MR-2 | Data-flow efficiency | Redundant/recomputed transforms; stages that could collapse/parallelize; artifacts produced-and-never-consumed. |
| MR-3 | Methodology fitness given findings | Was depth/breadth (deep-read tier · analyzer count · sampling) over- or under-scaled for what the findings turned out to be? |
| MR-4 | Sequence soundness | Reactive one-at-a-time crash patching, re-dispatch loops, redo-after-failure = the order/contract is wrong, not just the code. |
| MR-5 | Process self-feedback | Concrete, **impact-ranked** proposals: collapse a stage, drop a fork, re-order, pin a choice. |
| MR-6 | Followed ≠ Right | Explicitly separate conformance (Tab-1) from fitness (here). |
| MR-7 | Signal/failure-mode selection | Was the primary signal grounded in the RIGHT evidence tier (deep-read-evidenced WHAT, not a frequency artifact)? Highest-leverage. |
| MR-8 | Confidence derivation | Does the confidence number FOLLOW from the LLM-trace evidence + sample representativeness? Catch asserted-not-earned confidence on imbalanced samples. |
| MR-9 | Focus determination → search-shaping | Expected-focus vs observed-focus; a wrong/early focus mis-steers every downstream trace selection. |

## The generic engine (MR-7/8/9 generalized)

At every behavior-tree node, compare **expected-decision vs observed-decision**
and **expected-scenario vs observed-scenario**. Diagnostics' signal-selection /
confidence / focus are the concrete instances; for ANY audited agent, judge its
sub-decisions the same way: *given the scenario it was actually in, did the agent
make the decision the methodology expected?*

## Output contract (masked)

```yaml
findings:
  - mr: MR-7
    verdict: <fit | mis-fit | inefficient>
    observation: <what the run actually did at this methodology decision>
    recommendation: <concrete rearrange/improve proposal>
    impactRank: <1=highest>          # ranked self-feedback (MR-5)
    advisory: true                    # NEVER gates the run
```

This lens **never** emits a pass/fail that feeds the GATE. It is process
self-feedback only.
