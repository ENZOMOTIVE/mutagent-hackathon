# Framework Doc Pins

> **PR-002 — fetched at build, never copied.** These are the CANONICAL documentation ROOTS the
> `*build` agent (`agentspec-ai-engineer`) crawls FRESH (WebFetch) at build time for the chosen
> `build.target_framework`. SDKs churn — never vendor the doc BODIES into this skill. PIN the roots
> here (and per-spec in `appendix.framework_docs`); crawl them live when building.

## Pinned roots (per target)

| Target | `llms.txt` / index root | Reference root | Notes |
|---|---|---|---|
| `mastra` | `https://mastra.ai/llms.txt` | `https://mastra.ai/reference/agents/agent` | TS-native agent framework. |
| `deepagents` | `https://reference.langchain.com/python/deepagents/` | `github.com/langchain-ai/deepagents` | LangChain deep-agents. |
| `pydantic-ai` | `https://ai.pydantic.dev/llms-full.txt` | `https://ai.pydantic.dev/api/agent/` | `llms.txt` intermittently drops the Agent section → use the HTML `api/agent/` fallback. |
| `langgraph` | `https://docs.langchain.com/llms.txt` | `https://docs.langchain.com/oss/python/langgraph/graph-api` | Docs moved to `docs.langchain.com`; only fully-declarative graph target. |

## Provider best-practices (dogfood F3 — crawl + apply at build)

The `*build` agent also crawls the chosen MODEL PROVIDER's best-practice docs and applies them to the
scaffold — chiefly **prompt-caching** (cache the static `system_prompt` + tool/skill defs + few-shot
prefixes). Pin the provider's caching root for whichever provider the spec's models target; crawl it
FRESH (PR-002) — never guess the caching API.

| Provider | Prompt/context caching root | Notes |
|---|---|---|
| Anthropic | `https://docs.claude.com/en/docs/build-with-claude/prompt-caching` | `cache_control` breakpoints; cache the long static prefix. |
| OpenAI | `https://platform.openai.com/docs/guides/prompt-caching` | Automatic for long prompts; order static content first. |
| Google (Gemini) | `https://ai.google.dev/gemini-api/docs/caching` | Explicit context caching for repeated large prefixes. |

The `agentspec-architect` Verifier confirms the caching (and any other crawled best-practice) was
actually applied to the scaffold — a skipped, documented best-practice is a STEER.

## Harness targets

`build.target_framework` may also be a HARNESS of the form `harness:<x>` (PR-005), e.g.
`harness:claude-code` or `harness:codex`. Harness targets emit a skill/agent definition for the
named coding-agent runtime rather than a framework SDK scaffold. Harness-target doc pins + the
emission shape are a Wave-2 `*build` concern (careful-design item) — they are NOT enumerated here
yet, by design (lean, PR-007).

## How a pin is used (PR-002)

1. The spec's `appendix.framework_docs[target]` carries the spec-specific pin list (it may add to or
   override the canonical roots above).
2. At `*build`, `agentspec-ai-engineer` runs `*crawl-docs` → WebFetch each pinned root FRESH.
3. If a pin is dead/moved, the Actor escalates rather than scaffolding against a stale local copy.
4. The `agentspec-architect` Verifier confirms every framework API the scaffold uses appears in the
   crawled docs; an unpinned/guessed API is a STEER.

## Maintenance

When an upstream framework moves its docs, update the pinned root HERE (and note the move). Do NOT
add a vendored copy of the doc body — the whole point of pinning is to crawl fresh.
