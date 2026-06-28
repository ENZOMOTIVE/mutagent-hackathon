# Decision Lens — generic pinned-judge prompt

> **Track:** Tab-1 judge rows (checkMethod `trajectory-diff` on decision nodes).
> **Pinning (decision #10 / R10):** run at a PINNED model id + **temperature = 0**.
> Record the resolved model id + temperature into the scorecard. **Mask the
> output** (runId / timestamps / abs-paths) so two audits on one bundle produce a
> byte-identical verdict.
> **Parameterized by the loaded subject profile** — this lens ships ZERO subject-
> specific logic; the behavior-tree supplies the expected decisions.

## Inputs (supplied by the harness)

- `behaviorTree` — the subject's `behavior-tree.yaml` (the golden behavioral spec).
- `runTrajectory` — the run-bundle's transcript / runMeta / evidence.
- `node` — the single decision node under judgment (one row per node-scenario).

## The generic comparison (specific ↔ generic)

At the given behavior-tree node, determine **which scenario the agent was
actually in** (match the run's tier-0 signals + brief state against each
scenario's `when`). Then compare:

1. **expected-scenario vs observed-scenario** — did the agent correctly identify
   the situation it was in?
2. **expected-decision vs observed-decision** — given the scenario it was
   actually in, did the agent make the decision the methodology expected
   (`expectedDecision`) and take the expected fork (`expectedFork`)?

A decision that reaches the goal via an out-of-order-but-valid path **PASSES**
(trajectory judging rewards goal-reaching, not rote path-matching). A decision
that takes a fork the scenario did not warrant **FAILS**.

## Output contract (masked, schema-validated)

```yaml
nodeId: <string>
observedScenario: <scenarioId | "unmatched">
expectedDecision: <verbatim from the node>
observedDecision: <what the agent actually did, quoted from the transcript>
result: pass | fail
evidence: <transcript quote / runMeta field proving the observed decision>
rationale: <why pass/fail — cite the scenario's rationale>
```

**Never fabricate a verdict.** If the transcript does not contain enough to
identify the observed decision, return `result: fail` with
`observedScenario: unmatched` and an evidence note — an unobservable decision is
a determinism defect, not a pass.
