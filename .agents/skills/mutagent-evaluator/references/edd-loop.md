# edd-loop — the ADL ③ IMPROVE / Eval-Driven-Development loop (F18 + F19)

> **Loaded by:** the evaluator `improve` mode (`assets/agents/evaluator.md#mode-improve`). Load on demand.
> **Backed by:** `scripts/edd/variance-gate.ts` (F19) · `scripts/edd/change-request.ts` (F18) ·
> `scripts/edd/edd-types.ts` + `schemas/edd-change-request.schema.yaml` (the contract).
> **Sibling refs:** `grounded-adjudication.md` (every ask is grounded) · `validate-evaluator.md` (trust the judge first).

The IMPROVE stage closes the **PR-011 spec↔impl↔eval triad**. A judge that only reports is half a
loop; EDD drives the subject to **full green** while the evaluator stays **judge-only (EV-051)** — it
**REQUESTS** the `agentspec-ai-engineer` to amend the Agent/AgentSpec and **re-evals**, but never
patches the subject itself.

---

## The two doctrine lines

> **F19 — VARIANCE FIRST.** *Stabilize per-case variance (run each case ~N times, default 5, until the
> verdict stops flapping) BEFORE measuring accuracy over the full dataset. Without stabilizing
> variance first, accuracy over big samples is wasted.*

> **F18 — EDD CLOSURE.** *The evaluator localizes WHERE a fix belongs (agentspec vs impl), REQUESTS
> the ai-engineer to amend it (over SendMessage, grounded), and re-evals what is amended — looping to
> full green or a bounded STOP. The evaluator never patches; the engineer never judges.*

---

## F19 — the variance-first gate

After the initial `*build` + `*evaluate`, the loop's FIRST phase is **variance**, not accuracy:

1. **repeat-N** — run each case the SAME way N times (default `DEFAULT_REPEAT_N = 5`). Collect a
   `CaseVarianceObservation { caseId, criterionId, verdicts[], trajectories? }` per case.
2. **gate** — `evaluateVarianceGate(observations)`:
   - per-case spread via the already-shipped `evalScoreVariance` (EV-054) — NO new variance math.
   - a case is **stable** iff `variance ≤ maxVariance` (default 0) **AND** it was sampled ≥ `repeatN`
     (under-sampling never reads as stable — you cannot certify a spread you did not measure).
   - the **gate passes** iff EVERY case is stable. An empty case set FAILS (nothing measured).
3. **order** — `nextPhaseAfterVariance(current, gate)` advances `build`/`variance` → `accuracy` ONLY
   when the gate passed; otherwise it stays in `variance`. `assertVarianceStableBeforeAccuracy(gate)`
   **THROWS** if accuracy is attempted on a flapping suite — the hard guard for the doctrine line.

Only once variance is stable does the **accuracy** phase run the suite over the full dataset.

| Knob | Default | Meaning |
|------|---------|---------|
| `repeatN` | 5 | reruns per case before the spread is certifiable |
| `maxVariance` | 0 | per-case eval-score variance ceiling (0 = byte-identical verdict) |

A looser `maxVariance` (e.g. `0.05`) admits a single `uncertain` among passes without flapping the
gate — set it per subject when an occasional principled abstain is acceptable.

---

## F18 — the change-request contract + the loop

When a case fails (in EITHER phase), the evaluator builds a **grounded** change-request and hands it
off — it does not patch:

```
evaluator  --(EddChangeRequest)-->  agentspec-ai-engineer      # SendMessage
agentspec-ai-engineer --(ChangeRequestResponse)--> evaluator   # amended | rejected
evaluator  re-evaluates (from the variance phase)  →  loop
```

> **User-facing terminology (dogfood H1).** `EddChangeRequest` / `ChangeRequestResponse` are INTERNAL
> type names — NEVER surface them to the operator. In Helix's prose the loop reads as plain language:
> "the evaluator sends the engineer **a fix request** with the failing cases; the engineer **amends
> and replies**." Show the outcome, never the symbol (INTERNALS UNDER THE HOOD).

- **`EddChangeRequest`** (`buildChangeRequest` + `validateChangeRequest`): `swing`, `subject`,
  `remedyTarget ∈ {agentspec, impl}`, `failingCases[]` (each with the verbatim `critique` + **≥1**
  `ref{obs,path,value}` — an ungrounded ask fails loud, GA-1), `proposedRemedy` (a HYPOTHESIS).
  - **`agentspec`** = the DEFINITION is wrong → the engineer edits `agentspec.yaml` and **re-runs
    `*build`** so def→impl cascades.
  - **`impl`** = a wiring / build-faithfulness defect that does NOT change the spec.
- **`ChangeRequestResponse`** (`validateChangeResponse`): `amended` (→ `reEvalWarranted` ⇒ re-eval
  from the variance phase) or `rejected` (with a mandatory `note` — never re-eval an unchanged
  subject). There is no "trust me, skip re-eval" path: an amend ALWAYS triggers a fresh swing.

### The bounded terminator (afkloop-legal — NEVER infinite)

`decideEddLoop(state, budget)` reads ONLY observable, injected state
`{ phase, swing, varianceStable, accuracyMet, elapsedMs, noImprovementStreak }` and decides
**success-first**:

| Check | Condition | Result |
|-------|-----------|--------|
| 1 | `varianceStable && accuracyMet` | **DONE** (`full-green`) |
| 2 | `swing ≥ maxSwings` | **STOPPED** (`max-swings`) + convergence delta |
| 3 | `elapsedMs ≥ maxWallclockMs` | **STOPPED** (`max-wallclock`) |
| 4 | `noImprovementStreak ≥ noImprovementStreakLimit` | **STOPPED** (`no-improvement-streak`) |
| else | — | CONTINUE (variance phase until stable, then accuracy) |

Defaults (`DEFAULT_EDD_LOOP_BUDGET`): `maxSwings 6` · `maxWallclockMs 30min` ·
`noImprovementStreakLimit 2`. `elapsedMs` is **injected** (the caller measures wall-clock; the
controller never reads a clock) → the decision is PURE + deterministic (C-PIN).

---

## Assumed eval-runner interface (the clean seam — REBUILD nothing)

The EVAL engine (dataset build · the eval runner · Path A/B) is built **in parallel** (sibling
worktree). The `improve` mode is **additive**: it orchestrates the LOOP around the runner and assumes
this interface — it does not re-implement it.

```
// the runner the improve mode CONSUMES (owned by the eval engine, e.g. run-evaluate.ts):
runOnce(caseIds: string[]) -> Array<{
  caseId: string;
  criterionId: string;
  verdict: "pass" | "fail" | "uncertain";   // OutcomeVerdict
  trajectory: string[];                       // ordered tool names (for trajectory spread)
}>
```

- **repeat-N** = `runOnce` called N times over the SAME `caseIds`; the per-rerun verdicts feed
  `CaseVarianceObservation.verdicts[]` (+ `trajectories[]`) → `evaluateVarianceGate`.
- **accuracy** = `runOnce` over the FULL dataset → per-case verdicts → an accuracy ratio vs target.
- the runner is **C-PIN** (pinned model + temperature 0). The improve mode adds **no** provider call.

If the sibling runner exposes a different shape, adapt at the seam (map its result into
`CaseVarianceObservation` / the accuracy ratio) — keep the gate + loop modules untouched. The gate
(`variance-gate.ts`) + the loop (`change-request.ts`) are PURE and runner-agnostic by design.

---

## Boundaries

- **Judge-only (EV-051):** the evaluator REQUESTS + re-evals; the `agentspec-ai-engineer` is the ONE
  agent allowed to amend the Agent/AgentSpec. Fixables + infra-class still route to diagnostics.
- **Variance-first (F19):** accuracy is never measured before the variance gate passes (assert-guarded).
- **Bounded (F18):** every loop path terminates within the budget; STOP reports the convergence delta.
- **Lockstep (PR-011):** the request names the locus, the engineer cascades def→impl, the re-eval
  re-grounds the verdict on the amended subject — spec + impl + eval move together.
