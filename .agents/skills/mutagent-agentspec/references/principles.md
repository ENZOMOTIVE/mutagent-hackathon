# Design Principles — mutagent-agentspec

> Operator-locked rule set. Every change to `mutagent-agentspec` is judged against these.
> 🔒 = operator-LOCKED. Each entry: **Rule** (the law) · `Applies:` (the surfaces it governs) ·
> **Audit** (the yes/no question a reviewer asks). PR-001..PR-019 were authored from the design
> session captured in `mutagent-system/.memory/features/mutagent-agentspec/PRD.md`. PR-020..PR-023
> were added from the **lab-overseer dogfood** (2026-06; the schema 0.1.0→0.2.0 migration). Append new
> principles to this file as waves land — this surface expands over time.
>
> The skill IS the **ADL ① SPEC** stage: a guided interview that captures *what an agent IS*
> (the Definition / interface) and emits a portable, validated `agentspec.yaml`. A later `*build`
> implements it into a target (the implementation). The spec is the single source of truth; the
> implementation cascades one direction (def → impl).

---

#### PR-001 — Definition / Implementation separation  🔒
**Rule:** The `agentspec.yaml` is the **Definition** (the interface — WHAT the agent is, framework-independent). It is the single source of truth. Implementations cascade ONE direction (def → impl): editing the spec and re-running `*build` updates the implementation; the implementation never silently mutates the spec (the only backwards path is the explicit, audited auto-spec-correction in `*improve`, a later wave). Applies: scripts/contract/agentspec.schema.ts (definition vs build vs appendix split), references/workflows/orchestrator-protocol.md. **Audit:** is the spec the SSoT, with impl cascading one-way def→impl?

#### PR-002 — Framework docs fetched-at-build, never copied  🔒
**Rule:** `*build` crawls the pinned framework documentation FRESH (WebFetch) at build time from the roots listed in `references/frameworks/doc-pins.md` + the spec's `appendix.framework_docs`. SDKs churn; a stale local copy of a framework's API would scaffold against an outdated surface. PIN the doc ROOTS; never vendor the doc BODIES into the skill. Applies: references/frameworks/doc-pins.md, assets/agents/agentspec-ai-engineer.md, agentspec.schema.ts (appendix.framework_docs). **Audit:** does the build crawl pinned docs fresh rather than read a vendored copy?

#### PR-003 — Model intent is sacred  🔒
**Rule:** A `model` named in the spec (or a `subagents[].model`) is honored verbatim — no silent swap, no context-optimized routing, no retry-on-failure alternate-model fallback. `thinkingBudget`-style inference intent is operative, not cosmetic. If a target cannot satisfy a model constraint, THROW — never silently re-target. Applies: agentspec.schema.ts (tools.subagents[].model), assets/agents/*.md (inference pin blocks). **Audit:** is every declared model honored verbatim, with a THROW (not a swap) when unsatisfiable?

#### PR-004 — Target-conditional tool binding (revised — was "MCP-first")  🔒 *(dogfood-directed revision)*
**Rule:** The tool-binding preference is resolved **AFTER the framework is known** (`build.target_framework`, asked early per F3), not as a blanket MCP-first rule. Bias the binding to the chosen target's ecosystem:
- **harness targets** (`harness:claude-code` / `harness:codex`) → **CLI-first**: prefer the harness's native CLI tools (`gh` / `git` / framework `cli`) — these runtimes bind CLIs directly and idiomatically.
- **code-frameworks** (langgraph / mastra / pydantic-ai / deepagents) → **MCP / Composio / SDK-first**: prefer an MCP `ref` (the converging portable tool layer), a Composio binding, or the framework's native SDK integration.

`tools.integration[].kind` still spans `cli|saas|mcp`; the interview picks the binding the chosen target favors rather than always reaching for MCP. **Revision note:** PR-004 was originally "blanket MCP-first" and is operator-LOCKED; the operator DIRECTED this change (ADL ① SPEC dogfood F5) — a blanket MCP-first rule mis-bound harness/CLI agents. The minimal, audited revision replaces the blanket rule with a target-conditional preference; no other locked principle is touched. Applies: agentspec.schema.ts (tools.integration), references/workflows/orchestrator-protocol.md (D4 tools interview step). **Audit:** does the interview resolve the tool-binding preference from the chosen target (CLI-first for harnesses, MCP/Composio/SDK for code-frameworks), rather than blanket MCP-first?

#### PR-005 — The target may be a harness  🔒
**Rule:** `build.target_framework` accepts framework targets (mastra · deepagents · pydantic-ai · langgraph) AND HARNESS targets of the form `harness:claude-code` / `harness:codex` / `harness:<other>`. It is therefore typed as a String (with a documented example set), not a closed Union, so harness:* and future targets are expressible without a schema bump. Applies: agentspec.schema.ts (build.target_framework). **Audit:** can `build.target_framework` express a `harness:*` value and a not-yet-enumerated framework?

#### PR-006 — AskUserQuestion is a parent-only interview  🔒
**Rule:** The `*spec` interview runs on the PARENT session (AskUserQuestion on Claude Code; chat-fallback multi-choice elsewhere). Sub-agents cannot ask the operator questions, so the interview is never delegated to one. The parent session IS the domain orchestrator. Applies: references/workflows/orchestrator-protocol.md (FSM), SKILL.md §0. **Audit:** does the interview run on the parent session, never inside a dispatched sub-agent?

#### PR-007 — Lean by design (ship `*spec` before `*build`)  🔒
**Rule:** Ship the SPEC stage fully before the BUILD stage. `*spec` + `*validate-spec` are complete this wave; `*build` + `*eval` are OUTLINED (protocol prose + the two shipped agent contracts) and wired in a later wave. Do not pad the build loop before the spec is solid. Applies: SKILL.md §0.1, references/workflows/orchestrator-protocol.md (`*build`/`*eval` outline sections). **Audit:** is `*spec` fully shipped while `*build`/`*eval` remain outlined-only?

#### PR-008 — All dispatched sub-agents are skill-shipped  🔒
**Rule:** `mutagent-agentspec` dispatches ONLY its OWN sub-agent contracts, shipped in `assets/agents/*.md` and carried in the npm tarball. There is NO dependency on a host/monorepo `architect`, `developer`, `general-purpose`, or `llm-whisperer` agent — those may not exist in a standalone `pnpx @mutagent/agentspec init` environment. Applies: assets/agents/agentspec-ai-engineer.md, assets/agents/agentspec-architect.md, references/workflows/orchestrator-protocol.md. **Audit:** does every dispatched agent resolve to a shipped `assets/agents/*.md`, with zero host-agent references?

#### PR-009 — Explicit-intent transitions (no auto-advance)  🔒
**Rule:** The ADL loop never auto-advances. Helix (the orchestrator) KNOWS the next stage and proactively SUGGESTS it + renders loop position, but every transition (spec→build, build→eval, …) requires explicit operator confirmation. "Auto-orchestrate" means suggest, never auto-run. Applies: references/workflows/orchestrator-protocol.md, meta.loop_state in agentspec.schema.ts. **Audit:** does a stage transition require explicit operator intent rather than firing automatically?

#### PR-010 — Loop-state lives inside the spec  🔒
**Rule:** `meta.loop_state` (`stage`, `last_verdict?`, `updated_at`) lives INSIDE `agentspec.yaml` — the spec IS the subject record. There is no separate registry; a planned (not-yet-built) agent is a first-class trackable subject from spec-time. Helix reads `meta.loop_state.stage` for loop position. Applies: agentspec.schema.ts (meta.loop_state), references/workflows/orchestrator-protocol.md. **Audit:** is loop position read from `meta.loop_state` in the spec, with no external registry?

#### PR-011 — Spec ↔ impl ↔ eval sync triad  🔒
**Rule:** When a spec exists, the Definition, the built implementation, and the eval suite stay in lockstep. An IMPL defect → patch code AND auto-correct the spec (backwards impl→spec patch is a first-class, audited path); a DEFINITION gap → re-spec → `*build`. (Standalone diagnostics with NO spec just patches impl — the triad only applies when a spec exists.) This is OUTLINED this wave; the mechanism lands with `*build`/`*improve`. Applies: references/workflows/orchestrator-protocol.md (`*build`/`*eval` outlines), PRD §H.3. **Audit:** is the triad's auto-spec-correction described as the closure mechanism (not yet built, but specified)?

#### PR-012 — 1-spec ↔ N-versioned-subjects identity anchor  🔒
**Rule:** `meta.spec_id` is the canonical agent identity that survives every version. One active AgentSpec can have N versioned subjects (built impls / evaluator SubjectProfiles / diagnostics EntityContexts); they resolve to the spec by `spec_id` and reconcile against it. Applies: agentspec.schema.ts (meta.spec_id, meta.spec_version), references/principles.md PR-013. **Audit:** is `meta.spec_id` a stable identity anchor independent of version?

#### PR-013 — Backwards-only linking  🔒
**Rule:** The link points BACKWARDS: subjects → spec. The spec is implementation-AGNOSTIC — it does NOT enumerate its impls/subjects. Each downstream artifact (built impl · SubjectProfile · EntityContext) carries `spec_id` and points UP. The schema therefore has NO downstream `links`/`subjects` field by construction. Applies: agentspec.schema.ts (meta has spec_id but no downstream links), scripts/contract/agentspec.schema.test.ts (closed-object rejects a `links` field). **Audit:** does the spec carry NO downstream enumeration of its subjects/impls?

#### PR-014 — System-prompt + persona are first-class spec fields  🔒
**Rule:** `definition.system_prompt` is the ACTUAL operative system prompt the runtime sends (the full text, not a summary), and `definition.persona` (role + verbose persona) is a first-class operative field. They are required, not optional commentary. Applies: agentspec.schema.ts (definition.system_prompt: String required; definition.persona), assets/templates/agentspec.yaml.tpl (a real multi-paragraph prompt). **Audit:** are `system_prompt` + `persona` required, primary operative fields (not summaries)?

#### PR-015 — Verbose descriptions everywhere  🔒
**Rule:** Every tool, context source, job, sub-agent, skill, and trigger in the spec carries a VERBOSE `description` — it is the primary field the implementing LLM reads to understand intent. A terse/empty description defeats the spec. The worked template models verbose descriptions on every entry. Applies: agentspec.schema.ts (description: String on tools/context_sources/jobs/subagents/skills/triggers), assets/templates/agentspec.yaml.tpl. **Audit:** does every tool/source/job/subagent/skill/trigger carry a verbose description?

#### PR-016 — Standardized SOP block  🔒
**Rule:** `definition.sop[]` is a STANDARDIZED operating-procedure block: each entry = `when` (trigger condition) + `context` (what is loaded/required) + `procedure` (the verbose step-by-step) + optional `on_outcome.{success,failure}`. This is how the agent OPERATES, by condition + context — distinct from `modeling` (the decision graph). Applies: agentspec.schema.ts (definition.sop), assets/templates/agentspec.yaml.tpl. **Audit:** does each SOP entry carry when + context + procedure?

#### PR-017 — Agent activation triggers are first-class  🔒
**Rule:** `definition.triggers[]` describes how the DESIGNED agent is ACTIVATED — its inbound event sources (a2a · webhook · schedule · queue · event · mcp · manual). This is a first-class spec field and is DISTINCT from the in-system `*monitor` agent (which re-enters the ADL loop on a SYSTEM event). The designed agent's own inbound events live here, never in `*monitor`. Applies: agentspec.schema.ts (definition.triggers), references/workflows/orchestrator-protocol.md (triggers interview step), PRD §H connection-point CP9. **Audit:** are the designed agent's inbound activation events captured in `definition.triggers`, distinct from `*monitor`?

#### PR-018 — Standalone + symbiosis (zero sibling-skill source refs)  🔒
**Rule:** Every shipped artifact under `.claude/skills/mutagent-agentspec/` is a sealed unit with ZERO source reference to any sibling skill — and in particular NONE to the internal skill-construction skill (internal, not for release; the verifier greps for its registry name and expects empty). The `*eval` handoff to an evaluator is a designed FEATURE mentioned at the doc/protocol level only; it is never a code import. Applies: ALL of `.claude/skills/mutagent-agentspec/**`. **Audit:** does the sibling-skill registry-name grep over the skill tree return empty, and are there zero cross-skill code imports?

#### PR-019 — Eval criteria are append-extensible  🔒
**Rule:** `definition.evals.success_criteria[]` is binary-actionable AND append-extensible across loop iterations. You cannot pre-know every criterion at spec-time; diagnose/discover findings ADD criteria back into the spec, which re-seed the eval suite. The schema therefore models success_criteria as an open, growable array (never a fixed-length tuple). Applies: agentspec.schema.ts (definition.evals.success_criteria: Array), references/workflows/orchestrator-protocol.md (`*eval` outline). **Audit:** can `success_criteria` grow across iterations (modeled as an extensible array)?

#### PR-020 — Scenarios are a first-class eval field  🔒  *(dogfood F1)*
**Rule:** `definition.evals.scenarios[]` captures the SITUATIONS the agent must handle — each `{id, description (the situation), expected_behavior, category?, edge_case?}`. The interview probes explicitly for the HARD / adversarial edge-cases a naive spec forgets; scenarios are the seed material an evaluator turns into eval items. Required key (schema 0.2.0). Origin: lab-overseer's emitted spec carried zero scenarios. Applies: agentspec.schema.ts (ScenarioSchema, definition.evals.scenarios), references/workflows/orchestrator-protocol.md (interview D10), assets/templates/agentspec.yaml.tpl. **Audit:** does the spec enumerate the situations the agent handles, including edge-cases?

#### PR-021 — Dataset categories define the golden eval-suite  🔒  *(dogfood F2)*
**Rule:** `definition.evals.dataset_categories[]` is the dataset DEFINITION the `*eval` stage consumes — each `{id, description (the use-case slice), edge_cases[]}`. The spec SEEDs the evaluator's dataset (seed, don't duplicate — PR-018); it is the by-use-case + edge-case coverage map the golden suite is built from. Required key (0.2.0). Origin: lab-overseer's spec had no dataset definition, so `*eval` had nothing to build from. Applies: agentspec.schema.ts (DatasetCategorySchema, definition.evals.dataset_categories), references/workflows/orchestrator-protocol.md (interview D11). **Audit:** does the spec define the golden eval-suite slices + edge-cases the dataset must cover?

#### PR-022 — Runtime is pinned at spec-time  🔒  *(dogfood F4)*
**Rule:** `build.runtime` (bun · node · deno · python · shell · …) is PINNED at spec-time so `*build` implements ONCE — never pick-a-runtime-then-rebuild. Required key (0.2.0). The Actor builds for that runtime only; the Verifier flags a runtime-rebuild as STEER. Origin: lab-overseer was built in bash then rebuilt in Bun because the runtime was never specified. Applies: agentspec.schema.ts (build.runtime), references/workflows/orchestrator-protocol.md (interview B1), assets/agents/agentspec-ai-engineer.md (Step 2), assets/agents/agentspec-architect.md (pre-flight). **Audit:** is the implementation runtime fixed in the spec before `*build` runs?

#### PR-023 — Build applies provider best-practices, crawled fresh  🔒  *(dogfood F3)*
**Rule:** `*build` applies the model provider's best-practices — chiefly PROMPT-CACHING (static `system_prompt` + tool/skill defs + few-shot in cache-eligible prefixes) — read FRESH from the provider's caching docs (pinned in `references/frameworks/doc-pins.md`), never guessed. Extends PR-002 (fetched-at-build) from framework docs to PROVIDER docs. The Verifier confirms caching was applied; a skipped documented best-practice is a STEER. Origin: lab-overseer's build applied no caching / provider hygiene. Applies: references/frameworks/doc-pins.md (provider caching roots), assets/agents/agentspec-ai-engineer.md (Step 2.5), assets/agents/agentspec-architect.md (pre-flight). **Audit:** does the build crawl + apply provider prompt-caching, verified by the architect?

#### PR-024 — Build-faithfulness gate: TDD-green is not enough  🔒  *(dogfood — sim F-gap)*
**Rule:** A `*build` is GREEN only when the TDD loop passes AND a deterministic **spec→impl coverage gate** passes. TDD proves the code that EXISTS is correct; it is SILENT on whether all the code the spec REQUIRES exists (a dropped tool has no test to fail). Every `definition.tools.code[].id` MUST map to an implementing module carrying `// @implements <tool-id>` AND a referencing test; any `jobs_to_be_done[].backed_by` ref MUST resolve to a declared code tool. The Actor runs the gate as Step 3.5; the Verifier RE-RUNS it independently (Context-Inversion — faithfulness is scripted, never prose-judged). A miss is a STEER naming the tool. Origin: the dogfood sim shipped a scaffold missing the `collect-range` tool with 27 green tests — a green TDD loop did not catch a dropped spec tool. Applies: scripts/verify/spec-impl-coverage.ts (+test), assets/agents/agentspec-ai-engineer.md (Step 3.5 + termination), assets/agents/agentspec-architect.md (scripted pre-flight), references/workflows/orchestrator-protocol.md (`*build` two-gate green), scripts/contract/agentspec.schema.ts (jobs_to_be_done[].backed_by?). **Audit:** is every spec-declared code tool asserted (by a deterministic gate the Verifier re-runs) to have an `@implements` module + a test before a build is green?
