# write-judge-prompt — design a binary LLM-as-judge for one criterion

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/write-judge-prompt/SKILL.md`.
> **Loaded by:** `*build-evals` (EV-043), executed by `assets/agents/evaluator.md` (`#mode-judge-criterion`; the trajectory axis loads it too). Load on demand.
> **Sibling refs:** `error-analysis.md` (mine the criterion) · `validate-evaluator.md` (calibrate the judge) · `grounded-adjudication.md` (the GA doctrine: bind · gather refs · typed assumptions · abstain · verify).

Design ONE binary Pass/Fail LLM-as-judge for ONE failure mode. Each judge checks exactly one thing.
Use a judge ONLY for criteria a code-based check cannot handle — exhaust code-based options first
(many "subjective" criteria reduce to keyword / regex / API checks once you understand the domain).

## Prerequisites

- Error analysis complete; the failure mode is identified (`*discover`).
- Human-labeled traces for this mode (≥20 Pass + ≥20 Fail).
- A code-based evaluator genuinely cannot check it.

## The 4 components (every judge prompt has exactly these)

### 1. Task and evaluation criterion
State what the judge evaluates — ONE failure mode per judge. Not "evaluate whether the email is
good", not "rate quality 1-5". E.g. *"You are an evaluator assessing whether the agent respected the
outbound-guard: when `<outbound_guard>` is present and the event is non-critical, it must NOT send."*

### 2. Pass/Fail definitions
Strictly **binary** — no Likert, no letter grades, no partial credit. Define exactly what
constitutes Pass and Fail, drawn from the error-analysis failure-mode description. List concrete
FAIL examples (e.g. "sent a routine nudge while `consecutive_outbound=11` and guard=CRITICAL").

### 3. Few-shot examples
Include labeled Pass + Fail examples — at least one clear Pass, one clear Fail, and one **borderline**
case (borderline teaches the most nuance).
- **Draw ONLY from the TRAIN split** (10-20% of labeled data set aside for this). Any example used
  in the prompt MUST be excluded from dev/test — using dev/test examples is **data leakage**.
- 2-4 examples is typical; performance plateaus after 4-8.

### 4. Structured output — critique BEFORE verdict
Enforce schema (provider `response_format` / tool definitions; or specify the JSON schema inline).
The output puts the **critique first, verdict second** — this forces the judge to articulate its
assessment before committing. Under Grounded Adjudication the verdict is **ternary** and carries the
structured grounding it rests on:

```json
{
  "critique": "string — detailed assessment vs the criterion, citing concrete evidence from the trace",
  "refs": [{ "obs": "trace/observation id", "path": "field path", "value": "EXACT cited value" }],
  "assumptions": [{ "text": "premise the trace did not establish", "kind": "factual-intent | normative | scope", "status": "hypothesis" }],
  "result": "pass | fail | uncertain",
  "confidence": 0.0,
  "blockedBy": { "kind": "factual-intent | normative | scope", "text": "the unbound term / ungroundable premise" }
}
```

- `result` is **ternary**: `pass` · `fail` · `uncertain`. `uncertain` (carrying a `blockedBy`) IS
  the **indeterminate** state — it reuses `OutcomeVerdict.Uncertain`, **not** a 4th enum value.
- `blockedBy` is REQUIRED whenever `result === "uncertain"` (an `uncertain` with no `blockedBy` is an
  unrouted abstain — `lint-grounding` flags it).
- `refs` are STRUCTURED + **re-resolvable** (`scripts/resolve-ref.ts` re-resolves each by
  whitespace-normalized EXACT value match); cite one for the claim AND for any absence.

Critiques must be detailed, not terse — the critiques in your few-shot examples set the bar for the
detail the judge produces.

## Grounded Adjudication — bind, gather, abstain, verify

> Full doctrine in `references/grounded-adjudication.md` (the 5 Laws · the verdict lattice · the two
> switches). The load-bearing additions for every judge prompt:

- **BIND before you judge (L1).** Before rendering a verdict, every **TERM** the criterion
  presupposes must resolve to a grounded referent IN THIS situation
  (`scripts/resolve-ref.ts` `bindCriterionTerms` / `bindBeforeJudge`). An **unbound term** (a
  referent the situation never established — e.g. *"on-topic with the advertiser's product"* over a
  **blank brief**) ⇒ `result: uncertain` + `blockedBy: {kind: "factual-intent"}` — **ABSTAIN, never
  fail.** A valid-yet-unbound criterion is not a defect of the trajectory. Refs check what you DID
  cite; binding checks what the criterion NEEDED.
- **GATHER grounded evidence (L2/L3).** Cite a structured `ref {obs, path, value}` for the claim AND
  for any **absence** claim ("did not" / "never" / "no X" needs a positive field check, never
  inferred from silence).
- **The litmus.** State the **minimal premise P** such that `criterion ∧ situation ∧ P ⊢ V`. If P is
  fully grounded (or in the deterministic floor), DECIDE. If P is ungroundable, **surface it as a
  TYPED assumption** (`factual-intent` · `normative` · `scope`) and abstain (`uncertain` +
  `blockedBy`). The leap from "claim is true" to "therefore fail" is exactly where the assumption
  hides — a sourced claim proves the **claim**, never the **verdict**.
- **Abstain on silence (L5).** `uncertain` when the **inputs** can't decide (indeterminate, routes
  to the calibration loop) — not merely when YOU are unsure. Decide when the world establishes the
  premises and only you were uncertain.
- **The verdict is independently VERIFIED (L2 / GA-5).** After you decide, a DISTINCT reviewer
  (`#mode-verify` — never the judge that decided; `scripts/result-verify.ts`) re-resolves your refs
  and checks claim ⊨ verdict. On a dead ref or an inferential leap it **downgrades**
  `pass/fail → uncertain(blockedBy)` — **downgrade-only**; it never flips `pass↔fail` and never
  fixes (EV-051).

## Choosing what to pass to the judge

Feed only what the judge needs — for long inputs, the relevant snippet, not the whole document:

| Failure mode | What the judge needs |
|--------------|----------------------|
| Tone mismatch | Client persona + generated message |
| Answer faithfulness | Retrieved context + generated answer |
| Instruction following | System-prompt rules + generated response |
| Tool-call justification | Conversation history + tool call + tool result |
| **Outbound-guard compliance (sample C1)** | Input prompt (guard + event) + tool trajectory + response |
| **Goal-attainment (sample C2)** | Input event + full trajectory + outputs |

## Model selection + C-PIN

Start with the most capable model available (the same model as the main task works — the judge does
a narrower task); optimize cost later, once alignment is confirmed. **Pin the model id + temperature=0**
and record both on the scorecard (C-PIN) so reruns are byte-identical; re-validate on any model change.
In this skill the judge call mirrors the proven `@langchain/google-genai` shape (lazy import, temp 0,
model = `config.models.default`/`--model`, THROW on missing creds — model-intent-sacred).

## Anti-patterns

- **Vague criteria** ("is this helpful?") — target a specific observable failure mode.
- **Holistic judge for the whole trace** — produces unactionable verdicts. One judge, one criterion.
- **No few-shot examples** — the model won't know what counts as a failure in your application.
- **Dev/test examples as few-shot** — data leakage.
- **Likert scales** — scores that sound precise but can't be calibrated; binary forces a clear
  decision boundary. Capture severity via MULTIPLE binary judges, not one ordinal scale.
- **Skipping validation** — measure alignment with `validate-evaluator.md` before trusting the judge.
- **Judges for specification failures without fixing the prompt first** — if the prompt never asked
  for the behavior, that's a fix (route to diagnostics), not an eval.
