# Script Index — the data-flow navigation map

> **Why this file exists (W13).** Most recurring report bugs are *forgotten data*: a
> producer runs but its output is never threaded into `runMeta`, or the renderer
> dereferences a field no producer guaranteed → `undefined` in the HTML. This index is
> the single place the orchestrator (and any maintainer) reads to know **what every
> script consumes, produces, and which `runMeta`/render field depends on it.** If you
> add a step, add its row here. The **gates** column is what FAILS LOUD if the data is
> forgotten — never rely on memory; the gate is the enforcement.
>
> Quick listing at runtime: `bash scripts/cli/run.sh --list` (or read this file).

## Run sequence → script → I/O → the field it feeds → the gate that enforces it

> **Form column (REQ-051).** Every operation is exactly one of ①**script /
> code-workflow** · ②**agent-workflow** · ③**hybrid** (legend + integrity rule in
> "Operation forms (REQ-051)" below). ②-form steps (e.g. Step 2, Step 3) produce
> TYPED outputs and are legitimate — a "no script" cell is NOT a coverage gap.

| Step | Form | Script | Consumes | Produces | Threads into `runMeta` / render | Enforced by |
|------|------|--------|----------|----------|----------------------------------|-------------|
| 2 | ②agent-workflow | *(no script)* — `Bash(<cli> scores list)` + LLM classify | platform score samples | **scale type** (`boolean`\|`discrete-1-5`\|…) — TYPED | informs Step 3 `scoreBelow` threshold | AskUserQuestion on ambiguity |
| 3 | ②agent-workflow | *(no script)* — LLM NL→filter reasoning | operator NL query + scale type | **`TraceFilter`** (agentId/time/hasFeedback/scoreBelow) — TYPED | the trace `list` invocation | filter-search-matrix per-platform flags |
| 3a | ①script | `scripts/invocation/parse-brief.ts` | operator brief (string) | `{agent,timeWindow,focus,residual,scopeType,entity}` | `runMeta.operatorInvocation` (verbatim, D2) | parse-brief.test |
| 3.5 | ③hybrid | `scripts/awareness/llm-sample.ts` + `blind-spots.ts` | 5 representative traces | `AwarenessSample`, `BlindSpots` | `runMeta.awarenessSample` · `runMeta.blindSpots` (F2) | completeness-check · wave6-checklist |
| 3.7 | ①script | `scripts/normalize/platforms/{langfuse,local-jsonl,claude-code,codex,otel}.ts` | raw export (array OR streaming NDJSON/gz, W13-D3) | `TraceMetadata[]`, `EntityContext` (deterministic, no LLM) | `diagnosedEntity` · `billedTokens` · trace latency (span-authoritative, W13-D2) · **GROUNDED cache fields** (W18-cache: `cachedInputTokens` · `cacheCreationTokens` · `cacheStatus` `hit`\|`miss`\|`unknown` · `cacheHitRate`) — from cache-token fields ONLY; absent ⇒ `unknown`, NEVER inferred from flat `promptTokens` | findings-contract (entity) · render-contract pass |
| 4 | ①script | `scripts/tier0-scan.ts` | `TraceMetadata[]` | `Tier0Report` (errorSpike/latencySpike/feedbackCluster/estimatedSlots) | signal census candidates | tier0 tests |
| 4.5 | ①script | `scripts/library/match.ts` | Tier0Report + entity | `libraryMatches[]` (3× weight) · double-zero gate | `runMeta.decisions` (if empty) | double-zero fail-loud |
| 5 | ①script | `scripts/slicer.ts` · `scripts/sample/representative.ts` | Tier0Report + metadata | slices · `sample` + `CoverageProof` (worst-weighted, W13-D9) | per-finding `coverageProof` (W12-13) | representative.test |
| 5c | ①script | `scripts/scan/objection.ts` | trace bodies (user-authored text) | `ObjectionScanResult` (`byTrace`, `objectionRate`) — deterministic, NO LLM | **sampling-priority hint only** — NOT a census signal (advisory pre-filter; may corroborate a deep-read finding) | objection.test |
| 5.7 | ①script | `scripts/context/build-diagnosis-context.ts` (CLI: `--entity-context <f> --traces <f> --output <f> [--purpose <text>] [--doc <label>:<path> …]`) | `EntityContext` (Step 3.7) + normalized traces (+ optional source docs) | `diagnosis-context.md` — GROUNDED LENS (Identity · Purpose · FULL system prompt · Tool Inventory · Source Code; provenance-badged), Type A pure (no LLM/clock/random) — EXTRACTED FACT only | analyzer brief `artifacts_in.diagnosis_context` (W18-context, MANDATORY-PRE-READ before fan-out) | build-diagnosis-context.test |
| 6 | ②agent-workflow | analyzer dispatch (`assets/agents/diagnostics-analyzer.md`) | slice + **handover-contract schema** (W13-D7) + `diagnosis-context.md` (W18-context pre-read) | `Finding[]` (`problem` + rank/cost/correctness REQUIRED, W18-problem/W13-D1) | findings | **findings-contract.ts** RESEND if missing (incl. `problem(task-phrased)`) |
| 6.5 | ①script | `scripts/scan/trajectory.ts` (CLI: `--bodies <f> [--out <f>]`) | sampled deep-read trace bodies | `TrajectoryCorroboration[]` (`{signal, evidenceRef}`) — mechanical, deterministic, NO LLM | `SignalCensusContext.corroborations` (R1 evidence floor → PRIMARY eligibility) | trajectory.test |
| 6.5 | ①script | `scripts/library/store.ts` (`foldValidDigests`) over `deep-read-ledger.json` | per-entity cross-run ledger + (analyzerVersion · entityFingerprint · nowMs · ttlMs) | `DeepReadLedgerEntry[]` (still-VALID folded digests) | `SignalCensusContext.foldedDigests` (R2 — re-floored by Block C, never trusted blindly) | ledger.test · store via library.test |
| 7 | ③hybrid | aggregate (LLM dedup) + `scripts/aggregate/sort-findings.ts` (W13) | analyzer Finding[] | deduped + **deterministically sorted** findings | `runMeta.findings` | findings-contract |
| 8.5 | ①script | `scripts/enrich/build-render-input.ts` (+ `rank-remedies.ts`, `signal-census`, heatmap, selectionRules) | findings + EntityContext + wave6 stamps + **`--signal-ctx <f>`** (`SignalCensusContext`, Step 6.5; OPTIONAL — absent ⇒ safe-by-default Tier-0-only census) | `RenderInput` (rank BACKFILLED, signals reconciled; discovered signals evidence-floored, `suspectedPrimaryUnconfirmed` on R7) | the whole render contract + `primarySignal` | **completeness-check render-contract pass (W13-D6)** |
| 8.9 | ①script | `scripts/validate/render-js-syntax.ts` (PR-050) | rendered HTML | parse verdict | — | Step-8.9 gate |
| 9 | ①script | `scripts/report/render.ts` → `assets/templates/report.html.tpl` | `RenderInput` | `report.html` | — | render-js-syntax · escapeHtml/badge guards (W12/W13-A) |
| 9.9 | ①script | `scripts/validate/finalize-gate.ts` + `report-checklist.yaml` (W14) | rendered `report.html` + audience | `{ pass, gaps[] }` (per-gap `section·tier·what·sourceStep·healAction`) | — | **Step 9.9 OUTPUT gate** — CRIT blocks "report done"; backtrace each gap's `sourceStep` (this table) → re-run producer → re-render → re-check (bounded 2 rounds, then escalate loud) |

## Operation forms (REQ-051) — and why "no script" is not a gap

Every pipeline operation is exactly ONE of three forms. The `Form` column above
tags each step; this section is the legend + the integrity rule.

| Form | What it is | Type (PR-019) | Boundary artifact |
|------|-----------|---------------|-------------------|
| ①**script / code-workflow** | 1:1 command→script; deterministic, structured I/O; zero LLM; unit-testable in isolation. | Type A | the script's typed output (e.g. `Tier0Report`, `RenderInput`) |
| ②**agent-workflow** | a command drives the agent through one-or-more steps (LLM reasoning); may point into another workflow. Not unit-testable in isolation. | Type B | the TYPED structure the agent is required to emit (e.g. scale type, `TraceFilter`, `Finding[]`) |
| ③**hybrid** | the agent invokes ①-scripts AND runs LLM loops/calls around them; the script gives deterministic shape, the agent decides when/how + reasons over the result. | Type C | the script's typed output, consumed/reconciled by the agent |

> **Integrity rule — TYPED ARTIFACTS at boundaries, not script-coverage.**
> The skill's correctness invariant is **NOT** "every operation must be a script."
> It is: **every step hands the next step a TYPED artifact**, and a gate
> (`findings-contract` · `completeness-check` render-contract · `finalize-gate`)
> asserts that artifact's shape. A ②agent-workflow op is a first-class, legitimate
> form — it is a gap ONLY if it emits an UNTYPED / unvalidated blob, never merely
> because it has "no script." Do not "fix" a ②-form step by forcing it into a
> script; fix it (if broken) by tightening the typed contract on its output.

**Step 2 (score-scale inference)** and **Step 3 (NL→TraceFilter)** are ②agent-workflow
ops by design — both require LLM judgment (classify an arbitrary platform's scoring
convention; translate operator natural language into a structured filter). Each
produces a **TYPED output** (Step 2 → a scale-type enum; Step 3 → a `TraceFilter`)
that the downstream code-workflow consumes. They are **legitimate, not coverage
gaps** — the absence of a `scripts/*.ts` for them is correct, not a defect.

## Per-platform entity-context entrypoints (REQ-052 / Step 3.7)

All FIVE source platforms expose the same INTERNAL `--out-entity` / `--out-metadata`
transport via `scripts/cli/run.sh` (run.sh only — NOT the product `mutagent` CLI).
`--out-entity` is the AUTHORIZED producer of `entity-context.json` (consumed at
Step 8.5a via the enricher's `--entity-context` flag). ≥1 `--out-*` required;
deterministic — no clock/random/network/LLM. (Form ①script for every platform.)

| Platform | Script | `--in` shape | Entity extractor | CLI flags |
|----------|--------|--------------|------------------|-----------|
| `langfuse` | `platforms/langfuse.ts` | export array OR NDJSON/`.gz` (auto-detect) | `extractLangfuseEntityContext` | `--in --out-metadata --out-entity [--format array-json\|ndjson\|ndjson-gz]` |
| `local-jsonl` | `platforms/local-jsonl.ts` | `.jsonl`/`.ndjson`, one trace/line (bad lines tolerated-but-visible, F-S7) | `extractLocalJsonlEntityContext` | `--in --out-metadata --out-entity` |
| `claude-code` | `platforms/claude-code.ts` | one session `.jsonl` (many event lines → 1 TraceBody) | `extractClaudeCodeEntityContext` (generic) · `buildSkillSelfEntityContext` (self-diag) | `--in [--mode generic\|self-diag] --out-metadata --out-entity [--skill-md --skill-name --scripts-csv --operator-prompt]` |
| `codex` | `platforms/codex.ts` | one Codex rollout session `.jsonl` (many lines → 1 TraceBody) | `extractCodexEntityContext` | `--in --out-metadata --out-entity` |
| `otel` | `platforms/otel.ts` | JSON array of spans for ONE trace (or single span object) | `extractOtelEntityContext` | `--in --out-metadata --out-entity` |

The `claude-code` `--mode self-diag` variant is the skill-typed entity producer for
the report-only self-diagnosis path (orchestrator-protocol Step 12.2). All other rows
produce an agent-typed entity for diagnosing an external agent run.

## The five gates (the durable "never forgotten" enforcement)

1. **`findings-contract.ts`** (Step 7) — TypeBox over Finding/Remedy/Assumption; the required apply-readiness fields (incl. cost/correctness; `rank` is enricher-derived) must be present or the analyzer is RESENT. **W18-problem CONTENT gate:** `problem` is REQUIRED (presence), AND `isTaskPhrasedProblem` RESENDS `problem(task-phrased)` when a present `problem` reads as a task/remedy (leading bare imperative verb from `BANNED_LEADING_IMPERATIVE_VERBS`, or a `should`/`must`/`needs to` modal in its main clause). The fix must live in `remedies`, not the `problem` description. *Producer ↔ contract agreement.*
2. **`completeness-check.ts` render-contract pass** (W13-D6) — asserts the **exact** fields `render.ts` dereferences (sessionId, actionable, failureOrigin.evidence/confidence, remedy fields, the methodology widgets). *Gate ↔ renderer agreement.* "Gate passes but render garbles" is structurally closed. *INPUT side (RenderInput JSON).*
3. **`render-js-syntax.ts`** (PR-050) — every emitted `<script>` must parse. *OUTPUT side (rendered HTML).*
4. **`wave6-checklist.ts`** — the Wave-6 methodology widgets are present/threaded.
5. **`finalize-gate.ts` + `report-checklist.yaml`** (W14, Step 9.9) — per-section completeness of the RENDERED `report.html`: no soft fallback shipped (`RANK n/a`/`cost:n/a`), no `undefined`/`null`/`NaN` in visible prose, no `class="internal"` leak on client, prose (not raw-JSON) entity prompt. CRIT blocks "report done"; gaps backtrace via this table → bounded self-heal. *OUTPUT side (rendered HTML) — the complement to gate 2.*

## The three sources of truth (keep them in agreement)
For any field the report shows: **canonical type** (`scripts/normalize/trace.ts`) ↔ **producer contract** (`references/workflows/handover-contract.md` + `diagnostics-analyzer.md`) ↔ **gate** (above). A field present in only two of the three is the bug class this index + the gates exist to kill. A static audit agent validates exactly this (conformance matrix + data-leak tab) on every run.
