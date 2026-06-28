# Evaluator Methodology — distilled determinism-control reference

> **Taken IN (distilled), not referenced on disk.** This is the generic
> methodology + determinism-control vocabulary the evaluator operates by,
> distilled from the Variance & Operational Behavioral Deviance Reduction
> Operational Manual + the mdiag-master-audit lens. The evaluator does NOT read
> any file under `.mutagent-diagnostics/audits/` at runtime — everything it needs
> is here.
>
> **NDA:** synthetic identifiers only. No production dataset is named.

---

## 0. The 6-stage Agent-Outcome Evaluation backbone

> The human evaluation flow as the **backbone**; Grounded Adjudication as the
> Adjudicate core; the binary code/judge suite-construction kept; the calibration
> loop wrapping it. Each stage declares whether it is **code** (deterministic) or
> **judge** (LLM leaf) — the same code/agent-hybrid split Diagnostics uses
> (slicer/tier-0 = code · analyzers = LLM). See `grounded-adjudication.md` for the
> full doctrine (the 5 Laws, the verdict lattice, the two switches).

A **scenario = an intent ROUTE** the agent handles on its decision tree (system
prompt + skills). A human judges *per route*: establish the frame, read the
trajectory, detect the three failure kinds, adjudicate, root-cause, crystallize.

| # | Stage | code/judge | What it does |
|---|-------|-----------|--------------|
| ① | **CONTEXT** | judge | Establish the frame: the harness model (sysprompt · tools · skills · decision tree) + the INPUT's intent ROUTE → its intended success condition. The BIND target. |
| ② | **TRAJECTORY** | code | Parse the tool / decision sequence the agent actually took (deterministic). |
| ③ | **DETECT** | mixed | The 3 lenses — **drift/off-path** (judge) · **tool-output failure** (code/fixable) · **missing-context** (BIND / code). Emit candidate signals (≥0). |
| ④ | **ADJUDICATE** | judge (guard) | Grounded Adjudication: **BIND · GATHER · CRITIQUE · DECIDE/ABSTAIN · VERIFY** → `pass · fail · indeterminate`. The core. |
| ⑤ | **LOCALIZE** | judge | On a fail: **root-not-symptom** (§3a) — causal chain + locus (prompt · tool · context · skill). Deep RCA → diagnostics. |
| ⑥ | **CRYSTALLIZE** | judge→code | Turn each root into a binary, actionable **CODE | JUDGE** criterion → the expanding eval suite + dataset. |

### Transition conditions (every edge has a guard — nothing advances implicitly)

| From | Transition condition (guard) | To |
|------|------------------------------|----|
| CONTEXT | route resolved ∧ route-intent bound | TRAJECTORY |
| CONTEXT | route unresolvable / no intent | → CALIBRATE (indeterminate · scope) |
| TRAJECTORY | parsed (deterministic) | DETECT |
| DETECT | candidate signals emitted (≥0) | ADJUDICATE |
| ADJUDICATE | **pass** ∧ verifier confirms claim ⊨ verdict | CRYSTALLIZE |
| ADJUDICATE | **fail** ∧ verifier confirms claim ⊨ verdict | LOCALIZE |
| ADJUDICATE | unbound term ∨ ungroundable premise ∨ residual leap | → CALIBRATE (indeterminate) |
| LOCALIZE | root found ∧ causal edge grounded | CRYSTALLIZE |
| LOCALIZE | causal edge ungroundable | → CALIBRATE (indeterminate localization) |
| LOCALIZE | deep recursive-why required | ⤳ diagnostics (handoff) + continue |
| CRYSTALLIZE | binary ∧ actionable ∧ observed (broken∧¬healthy diff ✓) | SUITE (gate-eligible) |
| CRYSTALLIZE | no diff discriminate / single-trace | SUITE as **inferred** (guard, not gate) |
| CALIBRATE | re-ground (fact found) ∨ normative ratified by operator | → ADJUDICATE (re-enter) |
| CALIBRATE | human verifies the assumption | SUITE (criterion graduates) |
| CALIBRATE | persistent human disagreement | RETIRE (assumption-poisoned) |
| SUITE | all criteria adjudicated | GATE → **fail ▸ incomplete ▸ pass** |

**Indeterminate is not a dead end** — it is the on-ramp to the calibration loop,
which re-enters ADJUDICATE once the blocking assumption is grounded, ratified, or
verified, or retires the criterion. Reusing `OutcomeVerdict.Uncertain` (+ a typed
`blockedBy`) IS the indeterminate state — **not** a 4th enum value.

---

## 1. MECE scope model (root-cause locus, not symptom site)

Every defect/criterion is assigned to **exactly one** scope by the **locus of the
root cause**, not where the symptom appears:

- **COMMAND** — a code bug or a missing runnable code deliverable. Fix = a code
  change (guard, reorder, new script, schema loader). Locus = a `.ts` file (or a
  script that should exist). Owner = engineer.
- **SKILL** — a missing, ambiguous, or under-specified **specification**:
  protocol prose, a contract document, a schema description, or a mandate that a
  script be called. Fix = author/tighten the spec.
- **AGENT** — runtime **behavior**: a discretionary judgment, improvisation,
  hand-shaping, protocol deviation, or reactive fix. Fix via **cure-the-twin** —
  an AGENT deviance is cured by landing its SKILL/COMMAND twin (removing the
  ambiguity/bug that forced the improvisation).

**three-locus spawn:** a single root cause spawns **at most one** COMMAND + one
SKILL + one AGENT defect.

---

## 2. Three-dimension MECE coverage per component

Every component is graded on three dimensions (omit a dimension only when it has
no checkable surface there — never to pad):

- **operation-correctness** — sequence right + each op did its job (R1).
- **data-correctness** — input AND output contracts per component (R2).
- **operational-deviation** — expected-vs-observed trajectory (R3).

---

## 3. Severity by variance-impact (not code size)

- **CRIT** — flips a headline/primary signal, crashes render, blocks the
  deliverable, OR is a dominant inter-run variance driver (missing model/temp
  pin, cwd/config-root unpinned, latency short-circuit, OOM ingest).
- **HIGH** — materially changes sample composition / finding count / coverage
  honesty.
- **MED / LOW** — interpretation / capability / escalation gaps.

---

## 3a. root-not-symptom (the LOCALIZE invariant · GA)

The localization stage (⑤) obeys **root-not-symptom**, which REPLACES the prior
`first_thing_wrong_only` rule (it conflated detection with localization — the first
*visible* wrong is usually downstream of the real root, and its single-cascade
assumption silently drops independent causes):

- **KEEP** one criterion per **ROOT** — dedup the cascade (matches §1's "locus of
  the root cause, not where the symptom appears").
- **FIX** — trace to the root with **judgement**, not the first symptom.
- **Multiple INDEPENDENT roots ⇒ multiple criteria** (the cascade assumption is
  dropped).
- A **causal-link claim** (root → symptom) must be **GROUNDED** (cite the edge via a
  ref) OR surfaced as a **typed assumption** → an **INDETERMINATE localization** (not
  a fail).
- **Deep recursive-why → `mutagent-diagnostics`.** The evaluator localizes (locus:
  prompt · tool · context · skill); it does not run full RCA.

See `references/error-analysis.md` (the 3 detection lenses + root-not-symptom) and
`grounded-adjudication.md` (the doctrine).

---

## 4. Determinism-control vocabulary

Every remedy is framed as the specific **Determinism Control** that converts an
improvised/stochastic path into a reproducible one:

| Control | Converts |
|---------|----------|
| **C-SCRIPT** | improvisation → a MANDATED runnable script (streaming ingest, assemble-runmeta, …). |
| **C-SCHEMA** | guessing → FULL types/enums/examples embedded in the contract. |
| **C-GATE** | a partial gate → one that covers the FULL dereference surface and fails-loud ONCE with all gaps. |
| **C-GUARD** | a throw-on-absence → an undefined/shape guard in code. |
| **C-PIN** | a stochastic/environmental variable → pinned AND recorded into runMeta (model id, temperature = 0, seed, runId-namespace, configRoot, injected `--generated-at`). Honors **model-intent-sacred**: no silent swaps. |

**Class taxonomy** (8): `code-bug` · `missing-determinism` · `schema-contract-gap`
· `gate-coverage-gap` · `capability-gap` · `skill-forced-improvisation` ·
`agent-discretion` · `reactive-improvisation`.

**Named root causes (RC-\*):** RC-INGEST · RC-ENV · RC-LLM-PIN · RC-RUNMETA ·
RC-LATENCY · RC-SCHEMA · RC-SAMPLE · RC-GATE · RC-CONFIG. The **dominant triads**
twin-coupling enforces are RC-INGEST / RC-ENV / RC-LLM-PIN / RC-RUNMETA.

**Variance Mechanism** — the per-defect statement of HOW the gap causes two runs
to diverge (the causal chain from gap → divergence). Mandatory per criterion.

---

## 5. Byte-identity masking contract

"Byte-identical across runs" is only testable **AFTER masking** the declared
injected fields. Run the pipeline twice on byte-identical source (back-to-back,
then a second machine), mask `runId` / timestamps / abs-paths (the **versioned
masking set**, `scripts/mask.ts`), then diff each artifact. The **variance
score** = count of differing scorecard dimensions — that number (not vibes) is
the determinism signal.

---

## 6. The re-audit + 15-dimension determinism scorecard

Re-auditing measures variance reduction over time against a **fixed** scorecard.
Two layers:

- **Per-defect verification** — every tracked defect carries an explicit,
  executable pass condition ("run 3× → byte-identical artifact"; "the gate fails
  listing all gaps in one pass, fixed input passes"; "two runs → same findingId
  set"). A fix is verified only when its stated criterion passes against HEAD.
- **Whole-run scorecard** — the fixed 15 dimensions (headline latency p50,
  render crashes, gate fail-loud completeness, (n, analyzerCount), primary
  signal, finding-id set, remedy ranking, slice plan, sampling buckets, coverage
  confidence, tier-0 signals, entity identity, caps firstToTrip, awareness-fire,
  heatmap cells). Each has a Measure + a per-Phase Target; a run-pair is scored
  by masked diff per dimension. See `scripts/variance-compare.ts`.

---

## 7. Two-track rollup + twin-coupling

- **Track-1 GATE** — binary, severity-gated. Component PASS iff 0 CRIT/HIGH
  fail. Run PASS iff all components pass. Advisory.
- **Track-2 TREND** — the 15-dim variance score, SEPARATE, never merged.
- **Twin-coupling (inner → outer)** — the agent is graded on its OWN behavior
  first; inner-OK ⇒ functional even if the skill-link is defective (defect →
  SKILL scope). Coupling enforced only on the dominant triads (RC-INGEST / ENV /
  LLM-PIN / RUNMETA).

---

## 8. Reviewer ≠ executor; coordinator ≠ executor

The audit never grades a run it produced. The variance **coordinator** (who
compares the two variants) is a role distinct from the audit **executors**. The
audit itself obeys C-PIN so it is as deterministic as the thing it audits.
