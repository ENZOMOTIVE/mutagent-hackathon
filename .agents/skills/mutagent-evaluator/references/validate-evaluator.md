# validate-evaluator — calibrate a judge against human labels

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/validate-evaluator/SKILL.md`.
> **Loaded by:** `*validate` (EV-043 trust layer; W2). Load on demand.
> **Sibling refs:** `write-judge-prompt.md` (build the judge) · `error-analysis.md` (mine the criterion) · `grounded-adjudication.md` (the GA doctrine: bind · gather refs · typed assumptions · abstain · verify).
> Use for **LLM judges only**. Code-based evaluators are deterministic — test them with unit tests.

A judge is not trustworthy until it ALIGNS with human judgment. Calibrate it with data splits,
TPR/TNR, and bias correction before reporting any of its verdicts.

> **GA — the verdict is ternary.** Under Grounded Adjudication a judge may emit `pass`, `fail`, OR
> `indeterminate` (the `uncertain` + `blockedBy` abstain). **TPR/TNR are computed over DECIDED
> verdicts only — `indeterminate` rows are EXCLUDED from the confusion matrix** (an abstain is not a
> wrong answer; folding it in would punish honest abstention and corrupt the bias correction). The
> indeterminate rows are instead tracked separately as **assumption agreement** (Step 3a) — does the
> human agree the situation was genuinely underdetermined? A judge that abstains where the human
> would decide is a calibration signal, not a TPR/TNR miss.

## The 8-step calibration

### Step 1 — Create disjoint data splits

| Split | Size | Purpose | Rules |
|-------|------|---------|-------|
| **Train** | 10-20% (~10-20) | Few-shot source for the judge prompt | Clear-cut cases only; used directly in the prompt |
| **Dev** | 40-45% (~40-45) | Iterative refinement | Never in the prompt; evaluate against repeatedly |
| **Test** | 40-45% (~40-45) | Final unbiased measurement | Do NOT look at during development; used ONCE |

Target 30-50 examples of EACH class (Pass + Fail) across dev+test. Use **balanced** splits even if
real prevalence is skewed — you need enough Fail examples to measure TNR reliably.

### Step 2 — Run the judge on the dev set
Run on every dev example; compare predictions to human labels. **Partition the predictions first:**
DECIDED (`pass` / `fail`) feed the confusion matrix (Step 3); INDETERMINATE (`uncertain` +
`blockedBy`) are set aside for assumption agreement (Step 3a) and are NOT counted as Pass or Fail.

### Step 3 — Measure TPR and TNR (not accuracy) — over DECIDED verdicts only

```
# denominators/numerators range over DECIDED verdicts only — indeterminate EXCLUDED
TPR = (judge Pass AND human Pass) / (human Pass, judge decided)     # true positive rate
TNR = (judge Fail AND human Fail) / (human Fail, judge decided)     # true negative rate
```

Use TPR/TNR — they map directly to the bias-correction formula. With class imbalance, raw accuracy
is misleading. Cohen's Kappa is for human-vs-human agreement, not judge-vs-ground-truth.
**Indeterminate verdicts are excluded** — an abstain is neither a Pass nor a Fail, so it never
enters the matrix (counting it as either would punish honest abstention and bias `theta_hat`).

### Step 3a — Track assumption agreement (the indeterminate rows · GA)

The set-aside `indeterminate` verdicts get their OWN agreement metric — does the human agree the
situation was genuinely **underdetermined** (the criterion's term was unbound, or a premise was
ungroundable)?

```
assumption-agreement = (judge indeterminate AND human "underdetermined") / (judge indeterminate)
```

- **High agreement** → the judge abstains where it should; the criterion needs calibration
  (re-ground the fact / ratify the normative call / re-scope), not a judge fix. Route the blocking
  assumption by its `kind` (`factual-intent` → re-ground · `normative` → operator · `scope` → skip).
- **Low agreement** (judge abstains where the human decides) → the judge is over-abstaining; tighten
  BIND or the Pass/Fail defs so it can decide on the evidence present.
- Also surface, per `blockedBy.kind`, how many indeterminates each typed assumption produced — that
  is the calibration-loop work queue.

### Step 4 — Inspect EVERY disagreement

| Type | Judge | Human | Fix |
|------|-------|-------|-----|
| **False Pass** | Pass | Fail | Judge too lenient → strengthen Fail definitions / add edge-case examples |
| **False Fail** | Fail | Pass | Judge too strict → clarify Pass definitions / adjust examples |
| **Over-abstain** | indeterminate | decided | Judge abstains where the human decides → tighten BIND / Pass-Fail defs (Step 3a) — NOT a TPR/TNR miss |
| **Under-abstain** | decided | underdetermined | Judge decided where the situation was underdetermined → the unbound term should have abstained (an inferential leap the verifier should have caught) |

### Step 5 — Iterate to target
Refine prompt → re-run on dev → repeat until stable. **Target TPR > 90% AND TNR > 90%**
(minimum acceptable 80%/80%). If both low → more capable model. If both plateau → decompose the
criterion into smaller atomic checks. If labels seem inconsistent → re-examine the human labels.

### Step 6 — Final measurement on the test set (ONCE)
Run the judge **exactly once** on the held-out test set; record final TPR/TNR. Do NOT iterate after
seeing test results — go back to step 4 with new dev data if needed.

### Step 7 — Estimate true success rate (Rogan-Gladen correction)
Raw judge scores on unlabeled production data are biased. Correct for known judge error:

```
theta_hat = (p_obs + TNR - 1) / (TPR + TNR - 1)
```

- `p_obs` = fraction of unlabeled traces the judge scored Pass · `TPR`/`TNR` from the test set.
- Clip to [0,1]. **Invalid when `TPR + TNR - 1` ≈ 0** (judge is no better than random).
- *Example:* TPR=0.92, TNR=0.88, p_obs=0.80 → (0.80+0.88−1)/(0.92+0.88−1) = 0.68/0.80 = **0.85**
  (true rate ~85%, not the raw 80%).

### Step 8 — Confidence interval
A point estimate alone is not enough. Compute a **bootstrap 95% CI** (resample test labels+preds,
recompute theta_hat per resample, take the 2.5/97.5 percentiles). Or use `judgy`
(`estimate_success_rate`). Report the range so stakeholders know how much to trust the number.

## Practical guidance

- **Pin exact model versions** (dated snapshot id, not a floating alias) — providers update silently
  (C-PIN). **Re-validate** after a prompt change, a model switch, or when production CIs widen.
- ~100 labeled examples (50 Pass / 50 Fail); below ~60 the CIs get wide.
- **One trusted domain expert** is the most efficient labeling path; else two annotators on 20-50
  traces, resolve disagreements first.
- **Improving TPR narrows the CI more than improving TNR** — the correction divides by `(TPR+TNR−1)`,
  so a low TPR shrinks the denominator and amplifies error into wide CIs.

## Anti-patterns

- **Assuming judges "just work" without validation.**
- **Raw accuracy / percent agreement** instead of TPR/TNR (misleading under imbalance).
- **Dev/test examples as few-shot** — data leakage.
- **Reporting dev-set performance as final accuracy** — dev numbers are optimistic; the test set
  gives the unbiased estimate.
- **Raw judge rates without Rogan-Gladen correction** when reporting an aggregate pass rate.
- **Point estimates without a confidence interval** — an 85% corrected rate could be 78-92% on a
  small test set.
- **Folding `indeterminate` into TPR/TNR** — an abstain is not a wrong answer; counting it as a
  Pass or Fail punishes honest abstention and corrupts `theta_hat`. Exclude it from the matrix; track
  it as assumption agreement (Step 3a).
