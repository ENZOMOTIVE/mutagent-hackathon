# generate-synthetic-data — bootstrap an eval dataset by dimension-based tuple generation

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/generate-synthetic-data/SKILL.md`.
> **Loaded by:** `*build-dataset` (EV-046), LLM steps executed by `assets/agents/dataset-builder.md`. Load on demand.
> **Sibling refs:** `error-analysis.md` (mine the criteria) · `build-review-interface.md` (label the traces) · `validate-evaluator.md` (calibrate the judge).

Create diverse, realistic test inputs that cover a subject's FAILURE space — for bootstrapping an
eval dataset when real traces are sparse, or for stress-testing a specific failure hypothesis. Do
NOT use when you already have 100+ representative real traces (use `sample-traces.ts` stratified
sampling instead), or when the task is collecting production logs.

## How this maps onto the evaluator (the 3-way Hybrid, EV-046)

`*build-dataset` is a **Hybrid** op with three pieces — keep them separated (operation-inventory):

| Piece | Type | Who | What |
|-------|------|-----|------|
| **Seed interview** (~10 tuples) | HITL gate | `AskUserQuestion` / chat fallback | The user confirms the seed tuples are realistic. The user's domain knowledge is what makes synthetic data trustworthy. |
| **Tuple gen → NL query → quality filter** | LLM-only | `assets/agents/dataset-builder.md` (host-runtime, NO provider key) | Steps 1·3·4·5 below — the reasoning. Lives in the agent def, NEVER in a script. |
| **Cartesian expand · dedup · schema · append** | Code-only | `scripts/build-dataset.ts` | The deterministic shape (Step 2 mechanics + Step 5 dedup gate). Holds NO prompt prose. |

**Subject-agnostic (EV-002/EV-049):** dimensions + their values come from the subject profile
(`subjects/<name>/`) + the seed interview, NEVER hard-coded into the engine. The same `*build-dataset`
runs on any subject.

## Core process

### Step 1 — Define dimensions (target failures, not arbitrary variation)
Dimensions are axes of variation specific to the subject. Choose them where failures are EXPECTED
(known failure-prone areas, existing feedback, hypotheses from traces). Start with **3**; add a
dimension only when initial traces reveal a failure pattern along a new axis.

```
Dimension 1: [Name] — [what it captures]
  Values: [value_a, value_b, value_c, …]
Dimension 2: …
Dimension 3: …
```

### Step 2 — Draft ~10–20 seed tuples WITH the user (HITL gate)
A tuple is one combination of dimension values = one specific test case. Present the seed tuples and
iterate until the user confirms they reflect realistic scenarios. This is the human-in-the-loop seed
gate; the user knows which combinations actually occur and which are unrealistic.

```
(Dim1: value, Dim2: value, Dim3: value)
```

### Step 3 — Generate more tuples with the LLM (dataset-builder)
Prompt for N more `(dim1, dim2, dim3)` combinations for the subject — avoid duplicates, vary values
across dimensions. **Tuple generation is a SEPARATE step from query generation** (combining them
produces repetitive phrasing).

### Step 4 — Convert each tuple to a natural-language query (dataset-builder)
A separate prompt per tuple: "given these dimension values, write a realistic query a user might
enter, reflecting the persona/scenario." Seed it with one hand-written example.

### Step 5 — Filter for quality (dataset-builder proposes · build-dataset dedups)
Discard + regenerate when phrasing is awkward/unrealistic, content doesn't match the tuple's intent,
or queries are too similar. Optional: rate realism 1–5, discard < 3. The **near-duplicate dedup is
deterministic** (`build-dataset.ts`); the realism judgment is the agent's.

### Step 6 — Run queries through the subject (OUT OF SCOPE here)
Running the generated queries through the subject pipeline to capture full traces is the SUBJECT's
harness, not the evaluator's. `*build-dataset` produces the dataset (queries + tuples + provenance);
the dataset is appended to the living suite via `living-suite.ts` (EV-053). **Target ~100
high-quality diverse cases** — the rough saturation heuristic.

## Sampling real data instead (when you have it)
Don't sample randomly. Use stratified sampling (`sample-traces.ts`): identify high-variance
dimensions → assign labels → sample from each group. Use synthetic data only to fill gaps in
underrepresented query types.

## Anti-patterns
- **Unstructured generation** ("give me test queries") → generic, repetitive, happy-path examples.
- **Single-step generation** (tuples + queries in one prompt) → less diverse than the two-step split.
- **Arbitrary dimensions** that don't target failure-prone regions → wasted test budget.
- **Skipping the user's tuple review** → no way to judge whether LLM tuples are realistic.
- **Synthetic data when no one can judge realism**, or for complex domain-specific content
  (legal/medical) or low-resource dialects → use real data instead.
- **Hard-coding a subject's dimensions into a script** — they belong in the subject profile (EV-002).
