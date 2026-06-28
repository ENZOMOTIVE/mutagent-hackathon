# mutagent-agentspec — Orchestrator Protocol

> The runtime FSM for `mutagent-agentspec`. The **parent session IS the domain orchestrator** — it
> runs the `*spec` interview itself and does **NOT** dispatch a coordinator sub-agent (PR-006). On
> Claude Code the interview uses **AskUserQuestion**; elsewhere it uses a chat-based multi-choice
> fallback. `*build` and `*eval` are **OUTLINED only** this wave (lean by design, PR-007).

---

## Star-command resolution contract (verbatim)

When you encounter a `*<name>` token:
1. **RESERVED** — `*` marks a command. NOT prose, NOT a file path, NOT an external shortcut.
   `*command` = THIS skill's semantic map (internal). Never improvise.
2. **RESOLVE** — look up `<name>` in the `commands:` block in `SKILL.md §0.1`. Not found ⇒ ERROR +
   ask the operator. NEVER guess.
3. **BINDING** — read `kind:` + `binds:`:
   - `kind: script` ⇒ `binds:` a relative script path ⇒ CALL the script via `scripts/cli/run.sh`.
     Do NOT re-implement it in prose.
   - `kind: agent-chain` ⇒ `binds:` a workflow file#section ⇒ load + run the steps in order.
   - `kind: hybrid` ⇒ `binds:` both ⇒ call script(s) for deterministic parts, reason for the rest.
4. **PRE-GATE** — load any `pre_gate.loads:`.
5. **EXECUTE** — run the steps IN ORDER. Invent nothing.
6. `purpose:` / `impact:` explain WHY (not executed). Steps MAY reference other `*commands`.

---

## `*spec` — the guided interview FSM (parent session, full)

**Goal:** walk the operator through the `agentspec.yaml` Definition + Build, emit the spec, and gate
it with `*validate-spec`. The interview is parent-only (AskUserQuestion cannot run inside a
sub-agent, PR-006). Every fork is an AskUserQuestion (Claude Code) or a chat multi-choice
(elsewhere) — never a bare inline prose ask. Capture VERBOSE descriptions on every entry (PR-015) —
the description is the primary field the implementing LLM reads.

The FSM walks the blocks in order. State accumulates into the in-progress spec object; the operator
may revise an earlier answer at any point (the spec is the working record).

> **FRAMEWORK-BEFORE-TOOLING ordering (dogfood F3).** The implementation **target** (`build.target_framework`,
> the **B0** step) is chosen **EARLY — before `context_sources` (D3) and `tools` (D4)** — because the chosen
> framework/ecosystem SCOPES how each tool binds (an MCP ref vs a CLI vs a framework-native SDK call) and
> which integration idioms/language are even available (F12). Asking tools first and the target second forced
> a re-think of every tool binding once the target landed. The FSM therefore runs **D0 → D1 → D2 → B0 → D3 →
> D4 → D5 → …**: identity + persona + jobs first (they INFORM the target recommendation), then the target,
> then the framework-scoped tooling questions. The remaining Build steps (B1 runtime, B2 eval-framework) and
> the Appendix/Meta phases follow as before.

### Phase D — DEFINITION (the interface — WHAT the agent is)

| # | State | Captures | Schema target |
|---|---|---|---|
| D0 | **identity** | name · version · description · kind (agent\|skill\|composite). INFER `kind` from the description and PROPOSE it (F2 — see below); do NOT cold-ask. | `definition.identity` |
| D1 | **persona + system_prompt** | role · verbose persona; then the ACTUAL operative system prompt (full text, not a summary, PR-014) | `definition.persona`, `definition.system_prompt` |
| D2 | **jobs_to_be_done** | per job: id · verbose what+why description · expected_output | `definition.jobs_to_be_done[]` |
| **B0** | **target_framework** *(asked HERE — framework-before-tooling, F3)* | the implementation target — a framework (mastra\|deepagents\|pydantic-ai\|langgraph) OR a harness (`harness:claude-code`\|`harness:codex`\|`harness:<other>`) OR a future target (String, PR-005). RECOMMEND one from the Definition so far (D0–D2). Chosen NOW because it scopes D3/D4 tool binding + ecosystem idioms. | `build.target_framework` |
| D3 | **context_sources** | per source: id · kind (api\|saas\|internal-service\|mcp\|cli) · verbose description · where_from · optional auth_ref. Bind in the chosen target's idiom (B0 is already known). | `definition.context_sources[]` |
| D4 | **tools** | four buckets — integration (cli\|saas\|mcp, **binding preference resolved by the chosen target** per the revised PR-004 — see below) · code (lang+sandbox) · skills · subagents (verbose, optional tools/model honored verbatim per PR-003). Every entry carries a verbose description (PR-015). **Tooling matches the target's language/ecosystem (F12).** | `definition.tools.{integration,code,skills,subagents}` |
| D5 | **agent_type** | conversational \| automation \| orchestrator. INFER from the description + jobs and PROPOSE it (F2 — see below); do NOT cold-ask. | `definition.agent_type` |
| D6 | **triggers** | per trigger: id · kind (a2a\|webhook\|schedule\|queue\|event\|mcp\|manual) · verbose description · optional config. These are the DESIGNED agent's inbound activation events — DISTINCT from the in-system `*monitor` (PR-017). | `definition.triggers[]` |
| D7 | **modeling** | decision_graph (state · nodes · edges{from,to,condition?}) LangGraph-aligned + freeform workflows | `definition.modeling` |
| D8 | **sop** | per entry: id · when (trigger condition) · context (what is loaded/required) · verbose procedure · optional on_outcome{success,failure} (PR-016) | `definition.sop[]` |
| D9 | **evals · success_criteria** | per criterion: id · binary-actionable criterion · type (llm-judge\|code-check) · goal. Append-extensible — you cannot pre-know them all (PR-019). | `definition.evals.success_criteria[]` |
| D10 | **evals · scenarios** | the SITUATIONS the agent must handle — per scenario: id · verbose description (the situation) · expected_behavior · optional category · optional `edge_case` flag. Probe explicitly for the HARD / adversarial cases a naive spec forgets (dogfood F1). | `definition.evals.scenarios[]` |
| D11 | **evals · dataset_categories** | the GOLDEN eval-suite slices the `*eval` dataset must cover — per category: id · verbose description (the use-case slice) · `edge_cases[]`. This is the dataset DEFINITION handed to the evaluator (seed, don't duplicate, PR-018; dogfood F2). | `definition.evals.dataset_categories[]` |

#### INFER → PROPOSE → CONFIRM — `identity.kind` (D0) + `agent_type` (D5) (dogfood F2)

> **Don't cold-ask the obvious.** The operator described the agent in D0–D2; both `identity.kind` and
> `definition.agent_type` are usually DERIVABLE from that description + the jobs. So the interview
> **INFERS** the value, **PROPOSES** it as the pre-selected default in the AskUserQuestion (Claude Code) /
> chat multi-choice (elsewhere), and lets the operator **CONFIRM or CORRECT** — it never presents the
> bare enum with no recommendation. A cold "is this conversational, automation, or orchestrator?" wastes
> the operator's attention on a call the description already answers.

**`definition.agent_type` inference map** (ship this exact mapping — propose the matching value, with the
gloss as the rationale shown to the operator):

| The description sounds like… | PROPOSE `agent_type` | Gloss (the WHY shown to the operator) |
|---|---|---|
| a chatbot / customer-facing assistant / support agent / conversational helper | `conversational` | a back-and-forth dialog agent |
| an orchestrator / router / coordinator that delegates to other agents | `orchestrator` | an **a2a-router** — routes agents-to-agents |
| an automation / pipeline / end-to-end job that runs without a human turn | `automation` | a **one-shot end-to-end** run |

**`definition.identity.kind` inference** (D0): INFER `agent` for a standalone autonomous agent, `skill` for
a reusable capability invoked by a host runtime, `composite` for a multi-part agent-of-agents; PROPOSE the
inferred value, operator confirms/corrects.

**Mechanism (both D0 and D5):** read the D0 `description` (+ D2 jobs for D5); pick the best-matching row;
PROPOSE that value as the DEFAULT option with the gloss as its preview/rationale; the operator confirms it
or picks another. On a low-confidence inference, still propose the best guess but flag it as a guess.

### Phase B — BUILD (the implementation target — a guided choice)

> **B0 (`target_framework`) is asked EARLY — during Phase D, right after D2 (jobs) and before D3/D4
> (context + tools)** — per the framework-before-tooling ordering (F3). It is listed here too for the
> schema-target map, but in the live FSM it has already been captured by the time these rows run. B1
> (runtime) and B2 (eval-framework) are asked in their Phase-B position as before.

| # | State | Captures | Schema target |
|---|---|---|---|
| B0 | **target_framework** *(captured early in Phase D — see D-table; restated here for the schema map)* | the implementation target — a framework (mastra\|deepagents\|pydantic-ai\|langgraph) OR a harness (`harness:claude-code`\|`harness:codex`\|`harness:<other>`) OR a future target (String, PR-005). RECOMMEND one from the Definition (e.g. langgraph for a declarative graph; harness:* for a coding-agent skill). | `build.target_framework` |
| B1 | **runtime** | the execution runtime the implementation targets (bun\|node\|deno\|python\|shell\|…) — PIN it at spec-time so `*build` implements ONCE (no bash→Bun rebuild, dogfood F4). RECOMMEND from the target: harness:claude-code → bun/node; langgraph/pydantic-ai → python. | `build.runtime` |
| B2 | **target_eval_framework** | mutagent-evaluator \| export:vitest\|promptfoo\|braintrust | `build.target_eval_framework` |

#### D4 tool-binding — target-conditional, NOT blanket MCP-first (dogfood F5, revised PR-004)

> By D4 the target is already chosen (B0, asked early per F3), so resolve each tool's binding preference
> FROM the target rather than always reaching for MCP. This is the operator-directed revision of PR-004
> (see `references/principles.md` PR-004):
>
> - **harness target** (`harness:claude-code` / `harness:codex`) → **CLI-first**. Prefer the native CLI
>   tools the harness binds directly (`gh` / `git` / a framework `cli`); use `tools.integration[].kind: cli`.
> - **code-framework target** (langgraph / mastra / pydantic-ai / deepagents) → **MCP / Composio / SDK-first**.
>   Prefer an MCP `ref` (the portable tool layer), a Composio binding, or the framework's native SDK
>   integration; use `kind: mcp` (or `saas` for a Composio/SDK binding) as appropriate.
>
> Propose the target-favored binding for each integration tool; the operator may override per-tool.

#### D4 tooling matches the target's LANGUAGE / ecosystem (dogfood F12)

> Once the target is chosen (B0), bias every tool / integration / SDK choice to that ecosystem's
> idioms and LANGUAGE — don't propose a cross-language tool the target can't bind natively. Examples:
>
> - **TS framework** (mastra / TS harness) → the **TypeScript** ecosystem: prefer the **Vercel AI SDK**,
>   TS-native MCP clients, and `npm`/`bun` packages. Pin `build.runtime` to bun/node (F4).
> - **Python framework** (langgraph / pydantic-ai / deepagents) → the **Python** ecosystem: prefer the
>   provider Python SDKs, `pip`-installable integrations, and Python MCP clients. Pin `build.runtime` to python.
> - **harness target** → the harness's own tool surface + the language its skills/agents are authored in.
>
> The chosen target's language is the constraint; propose tools idiomatic to it, not a generic best-of-breed
> from another stack. This keeps the binding implementable at `*build` without a language bridge.

### Phase A — APPENDIX (pinned references)

| # | State | Captures | Schema target |
|---|---|---|---|
| A0 | **framework_docs** | pin the doc roots for the chosen target (seed from `references/frameworks/doc-pins.md`; the operator may add/override). Crawled FRESH at `*build` (PR-002). | `appendix.framework_docs` |
| A1 | **references** | decisions · glossary · operator notes | `appendix.references` |

### Phase M — META (identity anchor + loop position) — set by the skill, confirmed by the operator

| # | State | Captures | Schema target |
|---|---|---|---|
| M0 | **spec_id + spec_version** | a stable `spec_id` (survives every version, PR-012) + the spec_version | `meta.spec_id`, `meta.spec_version` |
| M1 | **loop_state** | `stage: spec` at emit-time + an injected `updated_at`; `last_verdict` omitted until the loop runs (PR-010). NO downstream links — the spec is implementation-agnostic (PR-013). | `meta.loop_state` |

### Phase E — EMIT + GATE

1. Assemble the accumulated state into a single `agentspec.yaml` at a conventional path (so `*sync`
   can index the new marker — see the cold-start note below).
2. Run `*validate-spec <path>` (`scripts/validate/validate-spec.ts`). On FAIL, surface the
   field-pathed errors, return to the offending phase, fix, re-emit, re-gate. On PASS, the spec is
   the validated Definition + a trackable subject (a planned, not-yet-built agent is first-class
   from spec-time, PR-010).
3. SUGGEST the next stage (`*build`) — but NEVER auto-advance. The transition needs explicit
   operator intent (PR-009).

> **Cold-start note (PR-010).** `*spec` writes `agentspec.yaml` with `meta.loop_state` — the spec IS
> the subject record. There is no separate registry; Helix reads `meta.loop_state.stage` for loop
> position and `*sync` learns to index the new marker. This closes the cold-start gap where the
> indexer only ever saw BUILT artifacts.

---

## `*spec-from-impl` — BROWNFIELD: reverse-generate a spec from an existing implementation

> **Greenfield is not the only path (dogfood F10).** When an agent ALREADY EXISTS in code but has no
> `agentspec.yaml`, the operator should not have to hand-author the spec from scratch. `*spec-from-impl`
> ADOPTS the existing implementation: it READS the impl + its environment/integration surface, REVERSE-
> GENERATES a draft `agentspec.yaml`, and VALIDATES it — yielding a first-class, trackable Definition for
> an agent that was built before the ADL loop existed. This is a **generic, subject-agnostic** capability:
> it inspects WHATEVER implementation it is pointed at; it carries NO connector-specific or app-specific
> logic.

**Inputs:** a path (or repo) to the existing implementation, optionally its env/config surface
(`.env(.example)`, framework config, manifest/package files, MCP/tool registrations).

**Flow (parent-session, same interview discipline as `*spec`):**

1. **Read the implementation.** Inspect the source: the system prompt / persona text, the tools and
   integrations it wires, the context sources it reads, any sub-agents it dispatches, its activation
   surface (entrypoints / handlers / triggers), and its env/integration surface (env vars, config,
   MCP/tool registrations). Read files in full — do not guess from filenames.
2. **Reverse-map onto the Definition.** Project what you read onto the `definition` blocks: derive
   `persona` + `system_prompt` (use the impl's operative text VERBATIM, PR-014), `jobs_to_be_done`,
   `context_sources`, `tools` (the four buckets, from the wired integrations/CLIs/MCP/sub-agents),
   `agent_type` (INFER + PROPOSE per F2), `triggers` (from the entrypoints/handlers), `modeling` + `sop`
   (from the control flow), and seed `evals` (success_criteria + scenarios + dataset_categories) from the
   jobs + observed behavior. INFER the `build.target_framework` + `build.runtime` from the impl's actual
   framework + runtime (it is already known — this is the one case where the target is OBSERVED, not chosen).
3. **CONFIRM the draft with the operator.** Surface every INFERRED field as a proposal (AskUserQuestion /
   chat fallback) — the operator confirms or corrects. A reverse-generated draft is a proposal, never a
   silent fact; the operator owns the final Definition (the same parent-session, propose-don't-assume
   discipline as `*spec`).
4. **Emit + GATE.** Write `agentspec.yaml` (with `meta.loop_state.stage: spec`) and run `*validate-spec`.
   On FAIL, surface the field-pathed errors, fix the offending block, re-emit, re-gate. On PASS, the
   adopted spec is a trackable Definition — `*build` re-running against it now cascade-updates the impl
   (def → impl, PR-001), bringing the pre-existing agent into the ADL loop.

> **Scope (subject-agnostic).** `*spec-from-impl` reads an arbitrary implementation surface; it does NOT
> embed any per-connector / per-app logic. It is the generic brownfield-adoption capability only.

---

## `*validate-spec` — the schema gate (script)

`kind: script` · `binds: scripts/validate/validate-spec.ts`. Reads a YAML spec path, parses it,
validates against the frozen `agentspec.v0.1.0` contract (`scripts/contract/agentspec.schema.ts`),
prints field-pathed errors + exits non-zero on failure, or `[validate-spec] PASS` + exit 0 on
success. The worked template (`assets/templates/agentspec.yaml.tpl`) is asserted valid by the
test suite — copy it as a starting point.

---

## `*build` — implement the spec into the target (OUTLINED — Wave-2)

> Lean by design (PR-007): the contract + the two shipped sub-agents land THIS wave; the full build
> loop is wired in Wave-2.

**Shape:** dispatch the two SHIPPED sub-agents (PR-008 — no host-agent dependency):
- **`agentspec-ai-engineer`** (Actor, `assets/agents/agentspec-ai-engineer.md`) — reads the validated
  spec, builds for the pinned `build.runtime` (F4 — no pick-then-rebuild), crawls the pinned Appendix
  docs FRESH (PR-002), **plans the target repo hierarchy per the framework's conventions BEFORE
  scaffolding (dogfood H6 — directory layout + entry points + config files, emitted in the build
  report; never lay files out ad-hoc)**, scaffolds the implementation in the target framework/harness
  honoring model intent verbatim (PR-003), and runs a TDD loop (test-first → lint → typecheck →
  build → test; never `--no-verify`).
- **`agentspec-architect`** (Verifier, `assets/agents/agentspec-architect.md`) — Context-Inversion
  reviewer: pre-flight probes + a verdict PROCEED | STEER | ABORT; read-only, never writes source.

**Build best-practices (dogfood F3).** The Actor applies the provider/framework best-practices it
reads from the FRESH-crawled docs — chiefly **prompt-caching**: structure the build so the static
`system_prompt` + tool/skill definitions + any few-shot context sit in cache-eligible prefixes per
the target provider's caching guidance, so the built agent is cost- and latency-efficient. The
Verifier's pre-flight checks that caching (and any other crawled best-practice) was actually applied,
not skipped.

**Build-faithfulness gate (PR-024).** TDD-green is necessary but NOT sufficient: it proves the code
that exists passes, never that all the code the spec requires exists (a dropped tool has no test to
fail). So a build is **GREEN only when the TDD loop passes AND the coverage gate passes**. The Actor
marks each implementing module `// @implements <tool-id>` and runs
`scripts/verify/spec-impl-coverage.ts` as Step 3.5; the Verifier **re-runs the same gate independently**
(Context-Inversion) in its pre-flight. Every `definition.tools.code[].id` must map to an `@implements`
module + a referencing test; a miss is a STEER naming the tool. This is the deterministic, code-checked
faithfulness gate — it catches the dropped-tool case a narrative review (and a green TDD loop) misses.

HITL + BG-worktree isolation + read-before-write. The def→impl **cascade** (spec edit → targeted
re-build) and the harness-target emission shape are Wave-2 careful-design items. Editing the spec
and re-running `*build` cascade-updates the implementation, one direction (def → impl, PR-001).

---

## `*eval` — eval-driven development handoff (OUTLINED — Wave-3)

> A designed FEATURE at the doc/protocol level only — never a code import (PR-018). `mutagent-agentspec`
> does NOT depend on an evaluator skill to run standalone.

**Shape:** hand the built agent + its `definition.evals.success_criteria` to an evaluator (the ADL
EVALUATE stage) for eval-driven development. The spec's success_criteria SEED the evaluator's
eval-matrix (link, don't duplicate). When composed via Helix, `*eval` routes to the evaluator
skill; standalone, agentspec emits the eval criteria + (optionally) a thin self-contained eval stub.
The triad (spec ↔ impl ↔ eval) stays in lockstep with auto-spec-correction (PR-011) — the mechanism
lands with this stage.

---

## Loop position + transitions (PR-009)

The orchestrator KNOWS the next stage and proactively SUGGESTS it + renders loop position (read from
`meta.loop_state.stage`), but EVERY transition needs explicit operator confirmation. "Auto-orchestrate"
means suggest, never auto-run. Never auto-advance through a gate.
