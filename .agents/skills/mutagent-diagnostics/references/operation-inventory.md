# Operation Inventory — Type A/B/C Classification

> Per PR-019. Every operation is exactly one type. No overlap.
> Used as the audit surface for code review of new contributions.

## Classification Rules

- **Type A — Pure Script**: deterministic logic, structured I/O. Written in TypeScript, invoked via `Bash("scripts/cli/run.sh scripts/<name>.ts ...")`. Zero LLM calls. Testable in isolation.
- **Type B — Agent Operation**: uses agent's native tools (Bash for external CLI, Agent for sub-dispatch, AskUserQuestion/equivalent for HITL, Read/Edit/Write for files). LLM reasoning. Cannot be unit tested in isolation.
- **Type C — Hybrid**: agent invokes a Type A script, passes structured input, reads structured output. Script provides deterministic shape; agent decides when/how to invoke it.

---

## Type A — Pure Scripts (9 scripts, 2 self-diagnostics)

| Op | File | Why script |
|----|------|-----------|
| Tier 0 static scan | `scripts/tier0-scan.ts` | Deterministic pattern matching + signal counts |
| Trace slicing | `scripts/slicer.ts` | Deterministic math + cap-of-5 clustering |
| Config load | `scripts/config/load.ts` | YAML parse + env lookup |
| Config schema | `scripts/config/schema.ts` | TypeBox type definitions |
| Config validation | `scripts/config/validate.ts` | Schema validation + typed errors |
| Trace normalization | `scripts/normalize/platforms/*.ts` | Platform JSON → canonical shape |
| Setup detection | `scripts/setup/detect.ts` | File reads + state checks |
| Stale-target hash compare | `scripts/stale-detector.ts` | Pure hash compare |
| HTML report render | `scripts/report/render.ts` | Template + data → HTML |
| [INTERNAL] Host probe | `scripts/self-diagnostics/probe.ts` | Env + fs probing |
| [INTERNAL] Self-dispatch | `scripts/self-diagnostics/dispatch.ts` | Descriptor file write |

---

## Type B — Agent Operations (12 items)

| Op | Agent action |
|----|-------------|
| Sub-agent dispatch | `Agent({subagent_type: 'diagnostics-analyzer', run_in_background: true})` |
| Trace fetch from source | `Bash(<cli> traces list ...)` per per-platform reference doc |
| Score-scale probe | `Bash(<cli> scores list --json)` + LLM classification |
| NL → TraceFilter translation | LLM reasoning over operator query |
| Cross-analyzer dedup | LLM reasoning over collected findings |
| RCA (3-dim WHAT/WHY/WHERE) | LLM reasoning per finding |
| Recursive whys | LLM reasoning (PR-020) |
| Remedy ranking | LLM judgment (cost × correctness) |
| HITL approval gate | `AskUserQuestion` / chat-fallback |
| BG-worktree apply | `Bash(git worktree + commit + push + gh pr create)` |
| REST apply | `Bash(curl GET + PUT)` with idempotency-key |
| CLI install check | `Bash(which <cli>)` + prompt (PR-021) |

---

## Type C — Hybrid (orchestrator invoking scripts)

| Op | Pattern |
|----|---------|
| Orchestrator invoking tier0 | Agent calls `Bash(scripts/cli/run.sh scripts/tier0-scan.ts ...)` → reads structured JSON output |
| Orchestrator invoking slicer | Agent calls `Bash(scripts/cli/run.sh scripts/slicer.ts ...)` → reads slice plan JSON |
| Apply-worker invoking stale-detector | Agent calls `Bash(scripts/cli/run.sh scripts/stale-detector.ts ...)` → reads freshness result |
| Orchestrator invoking report render | Agent calls `Bash(scripts/cli/run.sh scripts/report/render.ts ...)` → reads report.html path |
| Init invoking setup/detect | Agent calls `Bash(scripts/cli/run.sh scripts/setup/detect.ts)` → routes based on SetupState |
