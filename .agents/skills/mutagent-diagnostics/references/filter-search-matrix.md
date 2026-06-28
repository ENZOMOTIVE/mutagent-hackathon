# Filter/Search Coverage Matrix

> Master Matrix — per-platform support for each filter/search dimension.
> Ships with the skill. Updated by PRs when platform support changes.
> For unknown platforms: runtime CLI docs lookup (see adapter-strategy.md Q6).

## Dimension definitions

| Dimension | What it filters/searches |
|-----------|-------------------------|
| by agent ID | Traces from a specific agent identifier |
| by session ID | A specific session/trace ID |
| by time window | Traces in a time range |
| by score | Traces with score above/below threshold |
| has feedback | Traces with any attached feedback |
| has error | Traces containing error events |
| latency P99 | Traces with high latency |
| by route / trace name | Traces with a specific operation name |
| by tag | Traces with specific labels/tags |
| by skill | Traces where a specific skill was triggered |
| Search: full-text | Content-level search in trace messages |
| Search: semantic | Semantic similarity search |

---

## Coverage Matrix

| Dimension | Langfuse | OTel | local-jsonl | claude-code | codex |
|-----------|----------|------|-------------|-------------|-------|
| by agent ID | `--agent-id` CLI flag | `span.attr[gen_ai.agent.id]` | post-filter on `agentId` field | filename pattern or content grep | grep `agent_type` field in rollout JSONL |
| by session ID | `--session-id` CLI flag | `trace_id` | post-filter on `sessionId` field | filename = session-id | filename = session-id in `~/.codex/sessions/` |
| by time window | `--from` / `--to` CLI flags | span `startTime` / `endTime` | post-filter on `startTime` timestamp | file `mtime` (`find -newer`, `-newer`) | file `mtime` in `~/.codex/sessions/` |
| by score | `--score-below` / `--score-above` flags | partial — depends on emitter | if `score` field present | limited — only `/feedback` thumbs (discrete boolean) | limited — check rollout for custom score field |
| has feedback | `--has-feedback` flag | partial — depends on emitter | if `hasFeedback` field present | limited — check for `/feedback` approval events | via `approval` events in rollout JSONL |
| has error | `--has-error` flag | `span.status.code == 2 (ERROR)` | post-filter on `hasError` field | grep `isError: true` in tool_result events | grep `error` events in rollout JSONL |
| latency P99 | native aggregation | compute from span `duration` | compute from `startTime`/`endTime` | derive from event timestamps | derive from event timestamps in rollout |
| by route / trace name | `--name` flag | span `name` field | partial — if `route` field present | n/a (single-route per session) | n/a (single-thread) |
| by tag | `--tag` flag | `span.attr[tags]` | partial — if `tags` field present | n/a | n/a |
| by skill | via tag/metadata (`--tag skill:<name>`) | via `span.attr[skill]` | grep `skill` metadata field | grep `Skill` tool calls in JSONL | grep skill invocations in rollout events |
| Search: full-text | partial — via SDK filter, not CLI | no — post-fetch grep required | grep over jsonl lines | grep over session jsonl lines | grep over rollout jsonl lines |
| Search: semantic | no | no | no | no | no |

---

## Lookup strategy

### Known platforms (Langfuse, OTel, local-jsonl, claude-code, codex)

Use the Master Matrix above. Reference doc for each platform has concrete CLI examples.

### Unknown / custom platforms

Agent does **runtime CLI docs lookup**:
1. `Bash("<cli> --help")` — read help text
2. `WebFetch(upstream-docs-url)` — fetch from the URL in `references/source-platforms/<name>.md`
3. Reason over help text → map dimensions to CLI flags

If mapping is ambiguous, surface to operator via AskUserQuestion.

---

## Notes

- **Semantic search**: not supported on any platform in v0.1. Post-v0.1 consideration.
- **Codex score support**: Codex doesn't ship a feedback primitive natively. Check `codex-rs/rollout/src/lib.rs` for custom score fields if the operator's Codex build includes them.
- **Claude Code score**: limited to `/feedback` approval (thumbs-up/down boolean). Scale type = `boolean`. Negative = `false`/`"down"`.
