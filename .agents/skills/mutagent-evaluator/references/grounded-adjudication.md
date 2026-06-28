# grounded-adjudication — how a verdict stays bound to its evidence

> **Source:** the GA design review (`mutagent-system/.memory/features/mutagent-evaluator/grounded-adjudication-review.html`, Option 3 · final sign-off).
> **Loaded by:** every judging path — `*discover` (mine), `*build-evals` (judge), `*evaluate` (the headline trajectory judge + gate). Load on demand.
> **Sibling refs:** `error-analysis.md` (mine the criterion) · `write-judge-prompt.md` (build the judge) · `validate-evaluator.md` (calibrate it).
> **PR-locked principles:** `bind-before-judge` · `evidence-proves-claim-not-verdict` · `ground-absence` (`.meta/principles.md`).

A judge is only a judge (EV-051). Grounded Adjudication (GA) is the discipline that keeps that
judge HONEST: it forbids a verdict from resting on a premise that is neither bound to the situation
nor surfaced as an assumption, and it makes the judge ABSTAIN when the inputs cannot decide. GA does
not add a fourth verdict enum and does not change the command surface — it reuses
`OutcomeVerdict.Uncertain` (carrying a typed `blockedBy`) as the indeterminate state and rides the
existing 8-command / 3-subagent roster.

---

## The doctrine line

> **A verdict may never outrun its grounding — every premise it rests on is bound to the situation
> or surfaced as an assumption; when the world is silent, the judge abstains.**

Sourcing secures the **premises**; it never secures the **inference**. Two edges carry the entire
system: the **binding** of the criterion's terms to this situation (BIND), and the **entailment**
from the claim to the verdict (VERIFY). Every other step is hygiene around those two.

---

## The 5 Laws → their guards

Five laws, each enforced by exactly one guard. L1 and L2 carry the system.

| Law | Statement | Enforcing guard |
|-----|-----------|-----------------|
| **L1 Bind** | Every criterion TERM resolves to a grounded referent here. A valid-yet-unbound term ⇒ **indeterminate, not fail**. (Refs check what you *did* cite — not what the criterion *needed*.) | `resolve-ref` on criterion terms |
| **L2 Entail** | Evidence proves the **claim**, never the **verdict**. The claim must *entail* the verdict, not merely relate to it. | `result-verifier` (a MODE of `evaluator`, ≠ judge) |
| **L3 Ground absence** | "X didn't happen" needs a POSITIVE check of the field where X would appear — absence is a finding, not a default. | `lint-grounding` |
| **L4 Grounded ≠ confident** | Groundedness sets the verdict TYPE (pass / fail / indeterminate); confidence is a scalar ON an already-decided verdict. The two are orthogonal. | verdict **schema** (`OutcomeVerdict` + `confidence` + `blockedBy`) |
| **L5 Abstain on silence** | Abstain when the INPUTS cannot decide (underdetermined); decide when only YOU are unsure. | the **ternary** (pass / fail / indeterminate) + the litmus |

### The two switches (where you lose to assumptions)

Each input can be flawless; soundness lives in the edges.

1. **criterion → situation (the binding edge).** The criterion is valid in the abstract, but a term
   it presupposes has no referent here. *Example:* criterion "copy is on-topic with **the
   advertiser's product**"; situation = blank brief ⇒ "the advertiser's product" has NO referent ⇒
   **indeterminate (factual · unbound)**, not a fail.
2. **claim → verdict (the entailment edge · the master switch).** A sourced, verifiable claim proves
   the **claim** — never the **verdict**. *Example:* ref ✓ sourced; claim ✓ "the copy is about tax
   software" (true); verdict ✗ "therefore off-topic" ← the leap. The hidden premise ("tax software ≠
   advertiser's product") is unsourced. The verifier downgrades this to indeterminate.

---

## The verdict lattice

Three verdict types. Indeterminate is `OutcomeVerdict.Uncertain` **REUSED** (not a 4th enum), plus
an optional `blockedBy:{kind,text}`.

| Verdict | When | Routes |
|---------|------|--------|
| **pass** | Entailed by criterion ∧ grounded evidence — every premise stated or sourced. | → CRYSTALLIZE / suite |
| **fail** | Entailed the other way — a grounded defect, no inferential leap. | → LOCALIZE → diagnostics (EV-051) |
| **indeterminate(`blockedBy`)** | Underdetermined by the inputs. Never gates; routes to the calibration loop. | by `blockedBy.kind` (below) |

`blockedBy.kind` decides where the calibration loop routes the block:

| `kind` | Meaning | Routes to |
|--------|---------|-----------|
| `factual-intent` | a fact / intent missing from the trace | **calibrate** — re-ground from the trace |
| `normative` | a value judgment the operator owns | **operator** — ratify the norm |
| `scope` | the criterion does not apply to this route | **re-scope** — narrow / retire / human-verify |

---

## The procedure (the axiom floor)

One criterion × one situation (trace). Run the stages IN ORDER — nothing advances implicitly.

```
BIND → GATHER → lint → CRITIQUE-before-verdict → DECIDE / ABSTAIN → VERIFY
```

1. **BIND** *(L1)* — resolve every criterion TERM to a grounded referent in this situation. Any
   unbound term ⇒ stop here: **indeterminate (factual · unbound referent)**. Do not fail; do not
   improvise a referent.
2. **GATHER** — cite RESOLVABLE refs for the claim AND for any absence claim. A ref is structured
   `{obs, path, value}`: the observation/trace id, the field path, and the EXACT cited value — it
   must re-resolve by whitespace-normalized exact match.
3. **lint (deterministic floor)** — `lint-grounding` checks the cheap, mechanical floor BEFORE any
   judgement: tokens present, every cited ref resolves, code-class rows carry no free-text leap,
   absence claims carry a positive field check *(L3)*. Lint is **fail-new, warn-old** (strictness
   applies to newly minted artifacts; pre-existing ones warn).
4. **CRITIQUE-before-verdict** — write the critique FIRST, then run the **litmus**: name the
   *minimal* premise `P` such that `(criterion ∧ situation ∧ P) ⊢ V`. If every such `P` is grounded
   or inside the deterministic floor → proceed to DECIDE. If some `P` is ungroundable → surface it as
   a TYPED assumption (`factual-intent` / `normative` / `scope`) and emit **indeterminate
   (`blockedBy{kind}`)**.
5. **DECIDE / ABSTAIN** *(L5)* — pass or fail (+ a confidence scalar, L4) when the litmus premises
   hold; ABSTAIN (indeterminate) when the inputs cannot decide.
6. **VERIFY** *(L2)* — an INDEPENDENT pass (`result-verifier`, ≠ the judge, **downgrade-only**) asks
   the single question: *does the claim entail the verdict?* If it finds an inferential leap, it
   downgrades the verdict to **indeterminate (residual assumption)**. It can never upgrade.

Every indeterminate exit (unbound term · ungroundable premise · residual leap) feeds the
**calibration loop**, not the gate.

---

## Observed-eligibility (GA-11 — the diff-discriminate cut)

A criterion is **OBSERVED** only when it actually discriminates: it must fire on a BROKEN trace ∧
NOT fire on a HEALTHY one (`diff-discriminate`). This is the honesty cut that stops a good-practice
guard from being laundered into an "observed" failure.

| Situation | Result |
|-----------|--------|
| fires on broken ∧ not on healthy | **observed** — gate-eligible (cites refs + honest k/n prevalence) |
| no healthy trace available | **graceful single-trace fallback** — diff SKIPPED, honest prevalence, TAGGED; never a hard fail |
| no discriminating diff | **inferred** — kept in the suite as a guard, NOT gate-eligible |

`grounding` is the three-tier honesty ladder: `observed` (a failure was actually seen, with refs +
k/n) · `inferred` (a guard with no observed failure yet) · `hypothesis-pending` (a hypothesis
awaiting evidence, the weakest tier). OBSERVED ⇒ non-empty `refs` ∧ `k > 0` (the evidence-first
gate `parseMinedCriterion` enforces).

---

## The elimination / calibration loop

Indeterminate is not a dead end — it is the on-ramp to calibration, which re-enters ADJUDICATE once
the blocking assumption is grounded, ratified, or verified, or RETIRES the criterion.

```
indeterminate → CALIBRATE → re-enter ADJUDICATE   (or RETIRE)
```

| From CALIBRATE | Guard | To |
|----------------|-------|-----|
| re-ground | the missing fact is found in the trace | → ADJUDICATE (re-enter) |
| operator-ratify | a `normative` assumption is ratified by the operator | → ADJUDICATE (re-enter) |
| re-scope | the criterion is narrowed / scoped out | → ADJUDICATE (re-enter) |
| human-verify | a human verifies the assumption directly | → SUITE (the criterion graduates) |
| retire | persistent human disagreement (assumption-poisoned) | → RETIRE the criterion |

Assumption lifecycle: `hypothesis → unverified → verified` (graduate) **or** `→ eliminated` (the
calibration-loop terminal state: disproven / retired, not merely verified). A criterion whose
blocking assumption is eliminated is re-adjudicable.

---

## The gate (run level) — `fail ▸ incomplete ▸ pass`

The gate is the one intentional behavior delta GA introduces — it kills the latent **false-green**.

- A component is **incomplete** iff a CRIT/HIGH criterion adjudicated **uncertain / indeterminate**
  and no positive path re-grounded it.
- A component **fails** iff a CRIT/HIGH criterion **failed**.
- Otherwise the component **passes**.
- `runVerdict = fail ▸ incomplete ▸ pass` (the run takes the worst component state).

```
component fail        iff ≥1 CRIT/HIGH criterion FAILED
component incomplete  iff (no CRIT/HIGH fail) ∧ ≥1 CRIT/HIGH INDETERMINATE
component pass        otherwise
runVerdict            = fail ▸ incomplete ▸ pass
```

`RunVerdict.Incomplete` is a RUN-level rollup state distinct from the per-criterion
`OutcomeVerdict`. Before GA, a CRIT/HIGH `uncertain` silently PASSED; after GA it surfaces as
`incomplete` — the gate refuses to certify what it could not adjudicate. `*evaluate` may now return
`incomplete`; this is the single caller-visible delta of GA (the 8-command / 3-subagent surface is
otherwise frozen).

### Grandfather rules (won't break existing evals)

1. **missing `grounding` ⇒ inferred** — legacy lightweight criteria default to `inferred`, never
   rejected; the hard gate fires only on `observed`. Coexist, upgrade lazily.
2. **no healthy trace ⇒ graceful** — `*discover` falls back to single-trace + honest prevalence
   (diff skipped, tagged), never a hard fail.
3. **lint: fail-new, warn-old** — strictness applies to newly minted artifacts; pre-existing ones
   warn. No retroactive voiding.

Reusing `uncertain` (not a 4th enum) means the ~17 verdict consumers compile unchanged; the only
intentional behavior delta is **false-green → incomplete** (a fix).

---

## The two invariant corrections

1. **`first_thing_wrong_only` → root-not-symptom (judged).** The old rule conflated DETECTION with
   LOCALIZATION: the first *visible* wrong is often downstream of the real root, and a single-cascade
   assumption drops independent causes. **KEEP** one criterion per ROOT (dedup the cascade). **FIX:**
   trace to the root with JUDGEMENT, not the first symptom — multiple INDEPENDENT roots ⇒ multiple
   criteria; a causal-link claim must be GROUNDED (cite the edge) or SURFACED as an assumption
   (= indeterminate localization); deep recursive-why routes to diagnostics.
2. **code/agent hybrid at the COMMAND level (mirrors diagnostics).** Code-before-judge applies not
   just per-criterion but per-WORKFLOW: a deterministic skeleton, with the LLM only at the leaf where
   judgement is irreducible.

| Side | Steps |
|------|-------|
| **CODE** (deterministic) | sample · `resolve-ref` · `diff-discriminate` · `lint-grounding` · aggregate · gate · code-class criteria |
| **JUDGE** (LLM leaf) | determine · critique · adjudicate · verify · localize · judge-class criteria |

Mirrors diagnostics: slicer / tier0 (code) + analyzers (LLM).

---

## Law → guard quick reference

| Law | Guard | Kind |
|-----|-------|------|
| L1 Bind | `resolve-ref` (criterion terms) | new script (code) |
| L2 Entail | `result-verify` — a MODE of `evaluator`, downgrade-only | new script + judge mode |
| L3 Ground absence | `lint-grounding` | new script (code) |
| L4 Grounded ≠ confident | verdict schema (`OutcomeVerdict` + `confidence` + `blockedBy`) | contract |
| L5 Abstain on silence | the ternary (pass / fail / indeterminate) + litmus | contract + judge |

> GA changes INTERNALS only. The command surface, the subagent roster, and the v1 `*audit` world are
> untouched; `result-verify` is a MODE of the existing `evaluator` cell, not a new registered agent.
