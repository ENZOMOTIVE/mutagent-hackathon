# eval-audit — audit an eval pipeline (incl. the evaluator's OWN) for trustworthiness

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/eval-audit/SKILL.md`
> (S16 six-area diagnostic) + its meta-skill framing (S17 — *eval-of-the-eval*).
> **Loaded by:** `*audit` / `*self-audit` (the eval-of-the-eval mode, EV-055). Load on demand.
> **Sibling refs:** `error-analysis.md` (Area 1) · `write-judge-prompt.md` (Area 2) ·
> `validate-evaluator.md` (Area 3) · `build-review-interface.md` (Area 4) ·
> `generate-synthetic-data.md` (Area 5).
> **On-demand only:** this audit NEVER auto-fires — no cron, no monitor, no cadence
> (`feedback_self_diagnostics_on_demand_only`). The operator invokes it explicitly.

Inspect an LLM eval pipeline and produce a **prioritized list of problems**, each linked to a
concrete fix. Use it when inheriting an eval system, when unsure whether evals are trustworthy, or —
the **meta-skill (S17)** — to point the evaluator at **its own** eval-development artifacts:
*are my judges validated? is my dataset balanced? are my criteria binary + actionable? is my suite
living?* That eval-of-the-eval is `*self-audit` (EV-055), built on the existing `*audit` surface +
the `*validate` stats (it REUSES them — it does not rebuild a second auditor).

## The six diagnostic areas (S16)

Work each area: inspect the actual artifacts, decide whether the problem exists, record a finding if
it does. **Order findings by impact** — most impactful first. Each area maps onto a surface this
skill already ships, so the audit is concrete, never a generic checklist.

### 1. Error Analysis — were criteria MINED from real ✓/✗ traces, or brainstormed?

**Check:** Was systematic error analysis done on real (or synthetic) traces, with *observed*
failure categories — not generic labels borrowed from research ("helpfulness", "coherence",
"hallucination score")?

**Problem if missing/brainstormed:** evaluators built without error analysis measure generic
qualities instead of actual failure modes — they score well on paper and miss real problems.
**Fix:** `error-analysis.md` (`*discover`): mine emergent BINARY ACTIONABLE categories from the
✓/✗ split; if no traces exist, `generate-synthetic-data.md` first.
**Self-audit signal:** a discovered criterion with **no `sourceTraceIds`** (no trace-grounded
evidence) is a brainstormed-not-observed smell — flag it.

### 2. Evaluator Design — binary? failure-mode-specific? code where possible?

**Check:** Are evaluators **binary pass/fail** (not Likert 1-5 / letter grades / un-thresholded
scores)? Does each LLM judge target **exactly one** failure mode (not "is this helpful?")? Are
**code-based checks** used for objectively-checkable criteria (format, schema, keyword,
constraint)? Are similarity metrics (ROUGE / BERTScore / cosine) kept OUT of generation-quality
scoring?

**Problem if not:** Likert scales can't be calibrated; holistic judges produce unactionable
verdicts; LLM judges on objective criteria waste tokens and add noise; similarity metrics measure
surface overlap, not correctness.
**Fix:** `write-judge-prompt.md` (`*build-evals`) — binary, one-failure-mode, critique-before-verdict;
**code before judge** (SKILL §8). The criterion class (`objective→code · subjective→judge · hybrid`,
SKILL §9) IS this routing.
**Self-audit signal:** a criterion whose verdict space is not `{Pass, Fail}` (ordinal / >2 values),
or an `objective`-class criterion routed to an LLM judge instead of a code-check — flag it.

### 3. Judge Validation — validated vs human labels, with TPR/TNR + a clean split?

**Check:** Are LLM judges validated against human labels (confusion matrix, **TPR/TNR** — not raw
accuracy / percent-agreement / Cohen's κ)? Is there a disjoint **train/dev/test** split (few-shot
examples NOT drawn from the measurement set)?

**Problem if not:** an unvalidated judge may silently miss failures or flag passing traces; raw
accuracy hides this under class imbalance (always-"Pass" scores 90% when 90% pass, catches zero
fails); dev/test-as-few-shot leaks and inflates alignment.
**Fix:** `validate-evaluator.md` (`*validate`, EV-044) — TPR/TNR, test-once, Rogan-Gladen
correction, bootstrap CI; `<MIN_LABELS` stays `unvalidated`+bias-corrected (never blocks).
**Self-audit signal:** a judge whose `ValidationResult` is **`unvalidated`**, or whose TPR/TNR is
**below `TARGET_TPR`/`TARGET_TNR` (0.9)**, or a split that is not disjoint — flag it (this REUSES
the `*validate` stats, it does not re-run validation).

### 4. Human Review Process — domain experts, full traces, natural rendering?

**Check:** Are domain experts (not generic annotators) labeling? Do reviewers see the **full trace**
(input · intermediate steps · tool calls · retrieved context · output), not just the final output?
Is data rendered **naturally** (markdown rendered, code highlighted, tables as tables) — not raw
JSON in spreadsheet cells?

**Problem if not:** general annotators catch formatting errors but miss domain failures; output-only
review hides WHERE the pipeline broke; raw formats make reviewers parse instead of judge.
**Fix:** `build-review-interface.md` (`*review`, EV-045) — one full trace/screen, native render,
Pass/Fail/Defer. **Autonomy caveat:** in an afkloop run no human labels in-browser; the UI is built +
DOM-smoke-tested and surfaced as an artifact.
**Self-audit signal:** **zero `HumanLabel`s** feeding `*validate` (so no judge CAN be validated), or
a review surface that renders only final outputs — flag it.

### 5. Labeled Data — enough, and balanced?

**Check:** Is there enough labeled data — ~100 traces for error-analysis saturation, **~50 Pass +
~50 Fail** for reliable TPR/TNR? Are sampling strategies used to find informative traces (random +
clustering + outlier + classification + feedback)?

**Problem if insufficient/skewed:** small or class-imbalanced sets produce unreliable rates and wide
CIs; a Fail-starved set can't measure TNR.
**Fix:** the five sampling strategies in `error-analysis.md` + `sample-traces.ts` (EV-052) selectors;
`generate-synthetic-data.md` (`*build-dataset`, EV-046) cartesian-expand with **deterministic
near-dup removal** to supplement; `*derive-dataset` (EV-047) distills a living set from labeled ✓/✗.
**Self-audit signal:** a dataset with **fewer than `MIN_PER_CLASS` Pass or Fail** cases, or with
near-duplicate cases that `build-dataset`'s Jaccard drop should have removed — flag it.

### 6. Pipeline Hygiene — re-run after change, evaluators maintained?

**Check:** Is error analysis re-run after significant changes (model switch, prompt rewrite, new
feature, incident)? Are judges periodically re-validated and datasets refreshed — a **living** suite,
not set-and-forget?

**Problem if stale:** failure modes shift after pipeline changes; evaluators built for the old
pipeline miss new failure types; judges degrade silently.
**Fix:** the **living-suite** invariant (EV-053) — `appendOnly` + `assertMonotonicGrowth`: a living
artifact NEVER shrinks and grows as the subject evolves; re-validate on any model change (C-PIN
forces it).
**Self-audit signal:** a suite that **shrank** (monotonic-growth violation), or a pinned `judgeModel`
that changed with **no subsequent re-validation** — flag it.

## No eval infrastructure

If the subject has no eval artifacts (no traces, no evaluators, no labeled data):
1. Start with `error-analysis.md` (`*discover`) on a sample of real traces.
2. If no production data exists, `generate-synthetic-data.md` (`*build-dataset`) to create inputs,
   run them through the subject, then apply error analysis to the resulting traces.
3. Do **not** build evaluators / judges / dashboards before error analysis is complete.

## Report format

Findings ordered by impact. For each:

```
### [Problem Title]
**Status:** Problem exists | OK | Cannot determine
[1-2 sentences — the specific problem found in THIS pipeline, not generic advice]
**Fix:** [concrete action → the *command / reference / skill that addresses it]
```

Group under the six areas; omit areas with no problems. For `*self-audit` the "subject" IS the
evaluator's own eval-dev output, and the report is the eval-of-the-eval.

## How `*self-audit` (EV-055) reuses the existing surfaces — austerity

The eval-of-the-eval is NOT a second auditor. The **deterministic** Area checks (2 binary-shape,
3 TPR/TNR-threshold, 5 balance/redundancy, 6 monotonicity, plus the Area-1/4 grounding/label
counts) are pure code in `scripts/self-audit.ts` (Type A — emits **finding DATA**, no verdict prose,
no LLM). The **nuanced** judgments that genuinely need reasoning — *is this criterion actionable or
merely generic? does this judge prompt truly target one failure mode?* — are dispatched to the
`audit-executor` agent (`*self-audit` mode, host-runtime, **NO provider key / NO Gemini**), exactly
like every other Type-B judging op. The score it consumes (TPR/TNR, balance, monotonicity) comes
straight from `*validate` + the living-suite provenance — reused, never recomputed.

## Anti-patterns

- Running the audit as a checklist without inspecting the actual artifacts.
- Reporting generic advice disconnected from what was found in THIS pipeline.
- Recommending evaluators before error analysis is complete.
- Using an LLM judge for a failure a code-check can handle.
- Treating the audit as one-time — re-audit after significant changes (Area 6 applies to the
  evaluator itself).
- Wiring `*self-audit` to a cron / monitor / cadence — it is on-demand only, ships dormant.
