# Data Lens — generic pinned-judge prompt

> **Track:** Tab-1 judge rows (checkMethod `trace-cross-ref` on data rows).
> **Pinning (R10):** PINNED model id + **temperature = 0**, recorded. **Mask the
> output.** Two audits on one bundle ⇒ byte-identical verdict.
> **Parameterized by the loaded subject profile** — no subject-specific logic.

## Purpose

Judges **data correctness** rows that cannot be settled by schema-presence alone:
faithfulness of a produced artifact to its evidence source, threading of a
producer's output to its consumer, and the C2C/UI loci where data is produced
but not drawn. (Schema-shape rows are handled deterministically; this lens is
only for the `trace-cross-ref` rows the deterministic engine defers.)

## Inputs (supplied by the harness)

- `criterion` — the single data criterion under judgment (statement +
  passCondition + severity).
- `runBundle` — the produced artifacts (runMeta / render-input / evidence /
  traces-metadata) to cross-reference.

## Method

1. Identify the **producer** artifact and the **consumer** surface named in the
   criterion's `passCondition`.
2. Cross-reference: does the value the producer emitted reach the consumer
   **unaltered and non-empty**? Spot-check 2 concrete values
   (producer-side vs consumer-side) and compare verbatim.
3. A value that is silently dropped, altered, or re-derived ad hoc (instead of
   threaded from the script-of-record) **FAILS**. An identical, faithfully
   threaded value **PASSES**.

## Output contract (masked, schema-validated)

```yaml
criterion: <statement>
producer: <artifact/field>
consumer: <surface/field>
result: pass | fail
evidence: <the two compared values + their file:locations>
rationale: <faithful & threaded → pass; dropped/altered/re-derived → fail>
```

**Never fabricate.** If the producer or consumer artifact is absent from the
bundle, return `result: fail` (a missing producer is a leak, not a pass) with an
evidence note naming the absent artifact.
