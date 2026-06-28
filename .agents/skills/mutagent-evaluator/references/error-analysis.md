# error-analysis — mine emergent eval criteria from traces

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/error-analysis/SKILL.md`.
> **Loaded by:** `*discover` (EV-041/042/052). Load on demand.
> **Sibling refs:** `write-judge-prompt.md` (build the judge) · `validate-evaluator.md` (calibrate it) · `grounded-adjudication.md` (the GA doctrine: bind · gather refs · typed assumptions · abstain · verify).

The foundation of every eval suite: read traces, judge ✓/✗, and let failure CATEGORIES emerge —
never start from a pre-defined list. The categories that emerge ARE the binary actionable criteria
`*build-evals` turns into judges.

## The 7-step process

1. **Collect ~100 representative traces.** Capture the FULL trace: input event, every intermediate
   LLM call, tool uses, retrieved docs, reasoning, final output. ~100 is roughly where new traces
   stop revealing new KINDS of failure (system-complexity dependent).
2. **Read each trace → judge Pass/Fail → trace the failure to its ROOT.** This is `*discover`'s
   determine-outcome step (EV-042). Run the **3 detection lenses** (below) to surface candidate
   failures, then apply **root-not-symptom**: trace each Fail to its ROOT with judgement — NOT the
   first visible symptom (the first wrong is often downstream of the real root). Write observations
   **grounded by a structured ref** `{obs, path, value}`, not explanations ("SQL missed the budget
   constraint @ obs `a1b2/tool.input.query`", not "the model probably didn't understand"); ground
   every ABSENCE claim ("did not", "never", "no X") with a positive field check, never inferred from
   silence. **Critical rule (sample):** "inaction can be success" — never use "took an action /
   called a tool" as a Pass proxy. A guard-hold (the agent correctly does NOT send) is a Pass.
3. **Group failures into 5-10 categories** after the first 30-50 traces (don't wait for all 100 —
   early grouping sharpens what to look for). Split notes with different root causes; group notes
   with the same one. Each category gets a clear name + one-sentence definition. LLM-assisted
   clustering is allowed ONLY after 30-50 human-reviewed traces — and always re-review the groupings
   (LLMs cluster by surface similarity).
4. **Label every trace** against the categories — one binary column per category.
5. **Compute failure rates** (`category_failures / total`); sort descending. The most frequent
   category is where to focus first.
6. **Decide what to do about each failure (S4 — fix-vs-eval-worthy):**
   - **Can we just fix it?** Prompt never asked for the behavior → add the instruction. Tool missing
     → add the tool. Engineering bug → fix the code. If a clear fix resolves it, do that FIRST.
   - **Is an evaluator worth the cost?** Only for failures that PERSIST after fixing AND that the
     user will iterate on repeatedly (frequency × business impact). Critical requirements (safety,
     compliance) warrant a judge as a regression guard even after fixing.
   - **In this skill (EV-051): we never fix.** The evaluator FLAGS fixable-vs-eval-worthy and ROUTES
     the fixable + infra-class failures to `mutagent-diagnostics` (e.g. sample C4 dead-channel
     `account_number_unavailable` → WHY=`dependency-failure`, WHERE=`provider-side`). It builds
     judges only for the genuinely eval-worthy behavioral criteria.
   - Prefer **code-based checks** (regex / parsing / schema / tool-output flags) for anything
     objective; reserve LLM judges for true judgment calls.
7. **Iterate** — expect 2-3 rounds. Merge overlapping categories, split too-broad ones, clarify
   definitions, re-label.

## The 3 detection lenses (make them explicit)

Determination is not a single undifferentiated read — surface candidate failures through **three
named lenses**, and tag which lens each candidate fired on (this is what later becomes the
criterion's `dimension` / `class`):

| Lens | What it catches | Typical disposition |
|------|-----------------|---------------------|
| **drift / off-path** | The agent left the intended ROUTE — wrong tool, wrong order, answered a different question, ignored a constraint. A judgement call. | → **judge**-class behavioral criterion |
| **tool-output failure** | A tool errored, timed out, or returned unusable/empty output the agent then mis-used. | → often **code**/fixable → route to diagnostics |
| **missing-context** | A referent the agent NEEDED was never supplied (blank brief, dropped field, unresolved variable). This is the **BIND** detector — a term with no referent. | → typed **factual-intent** assumption; situation is indeterminate, not a fail |

The lenses are detectors, not categories — the same trace can fire more than one. Categories still
EMERGE from what fires (step 3); the lenses only make sure you LOOK in all three places.

## root-not-symptom (REPLACES first_thing_wrong_only)

The old `first_thing_wrong_only` rule conflated **detection** with **localization** — the first
*visible* wrong is frequently downstream of the real root, and its single-cascade assumption silently
drops independent causes. The corrected invariant:

- **KEEP:** one criterion per **ROOT** — dedup the cascade (don't mint a criterion per downstream
  symptom of the same root).
- **FIX:** trace to the root with **judgement**, not the first symptom.
- **Multiple INDEPENDENT roots ⇒ multiple criteria** (the cascade assumption is dropped).
- A **causal-link claim** (root → symptom) must be **GROUNDED** — cite the edge with a ref — OR
  surfaced as a **typed assumption**, which makes the localization **INDETERMINATE** (not a fail).
- **Deep recursive-why → route to `mutagent-diagnostics`.** The evaluator LOCALIZES (locus: prompt ·
  tool · context · skill); it does not run full root-cause analysis.

## Stopping criterion (saturation)

Stop when new traces stop revealing new KINDS of failure — roughly ~100 reviewed with no new failure
type in the last ~20. Exact number depends on system complexity.

## Trace sampling strategies (EV-052 — the 5)

When production volume is high, use a MIX — never a single angle:

| Strategy | When | Method |
|----------|------|--------|
| **Random** | Default starting point | Sample uniformly from recent traces |
| **Outlier** | Surface unusual behavior | Sort by length / latency / tool-call count; review extremes |
| **Failure-driven** | After guardrail violations / complaints | Prioritize flagged traces |
| **Uncertainty** | When automated judges exist | Focus where judges disagree or have low confidence |
| **Stratified** | Ensure coverage across segments | Sample within each dimension (query type, segment, feature) |

Aim for a balanced ✓/✗ split (~50/50) so the criteria are mined from BOTH success and failure modes.

## Worked example — sample-email-agent (the dogfood)

The sample export carried **0 scores / 0 tags on all 1946 traces** — no label column to shortcut to,
so determine-outcome (EV-042) had to deep-read every trace. Emergent categories (the 8 candidate
criteria): C1 outbound-guard compliance · C2 goal-attainment · C3 manager-override honored · C4
send-failure recovery · C5 channel discipline · C6 draft→send integrity · C7 escalation
appropriateness · C8 memory hygiene. C4 + dead-channel were flagged fixable/infra → routed to
diagnostics, NOT judged. C1/C2/C3/C7 are eval-worthy behavioral judgments → judges built.

## Anti-patterns

- **Brainstorming categories before reading traces.** Read first; categorize what you find.
- **Starting with pre-defined categories.** A fixed list causes confirmation bias.
- **Generic scores as categories** ("hallucination score", "helpfulness score") — not grounded in
  the application's actual failure modes.
- **Building evaluators before fixing obvious problems** (prompt gaps, missing tools, bugs).
- **Treating error analysis as one-time.** Re-run after every significant change.
