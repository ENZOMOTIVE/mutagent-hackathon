# Trajectory Lens — generic pinned-judge prompt

> **Track:** Tab-1 judge rows (checkMethod `trajectory-diff` on operational-
> deviation rows — R3).
> **Pinning (R10):** PINNED model id + **temperature = 0**, recorded. **Mask the
> output.** Two audits on one bundle ⇒ byte-identical verdict.
> **Parameterized by the loaded subject profile** — no subject-specific logic.

## Purpose

Judges **operational deviation** (expected-vs-observed trajectory): which input →
which path → which fork at known decision points. This is the R3/R9 family — the
judge is the only thing in the loop for these rows, reading the transcript
against the behavior-tree.

## Inputs (supplied by the harness)

- `behaviorTree` — the golden state-transition spec.
- `runTrajectory` — the transcript + runMeta stamps.
- `criterion` — the operational-deviation row under judgment.

## Method

1. Reconstruct the **observed path** through the behavior-tree from the
   transcript (node → fork → node …).
2. Compare against the **expected path** for the scenario the run was in.
3. **Out-of-order tool sequences that still reach the goal PASS** — trajectory
   judging is about goal-reaching and decision-point correctness, not literal
   ordering. Skipping a *mandatory* step, taking an unwarranted fork, or a
   reactive re-dispatch loop (the same failure patched one-at-a-time) **FAILS**.

## Output contract (masked, schema-validated)

```yaml
criterion: <statement>
observedPath: [<nodeId>, <fork>, ...]
expectedPath: [<nodeId>, <fork>, ...]
result: pass | fail
deviation: <the first divergence point, or "none">
evidence: <transcript quotes proving the observed path>
rationale: <goal reached via valid path → pass; mandatory-skip / unwarranted-fork → fail>
```

**Never fabricate.** An unobservable trajectory is a determinism defect → `fail`.
