# Local Cloud Agent SDK — Target Platform Reference

> Apply target: Agent code built on a cloud provider's agent SDK (Anthropic, OpenAI, Google, etc.) running locally.
> Target class: `local-code-construct`
> Apply branch: local-code-construct (code edits via BG-worktree PR; lint+typecheck gate required)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-code-construct` |
| Mutability | code edits via BG-worktree PR |
| Isolation | BG-worktree per PR-004; lint+typecheck gate required |

## Supported SDKs

| SDK | Package | Trace Source |
|-----|---------|-------------|
| Anthropic Claude SDK | `@anthropic-ai/sdk` | `claude-code-transcripts` or OTel |
| OpenAI Agents SDK | `openai` | OTel or Langfuse |
| Google Genkit | `@genkit-ai/core` | OTel |
| LangChain/LangGraph | `langchain` | Langfuse or OTel |
| mutagent SDK | `@mutagent/sdk` | Langfuse (direct) |

## How Remedies Are Applied

Agent SDK remedies are **TypeScript/JavaScript code changes** — system prompts, tool schemas, retry configs, model settings.

1. **BG-worktree isolation (PR-004)**: all changes happen in a separate worktree branch
2. **Read before write (PR-003)**: read the target agent source file before proposing edits
3. **Lint + typecheck gate**: `bun run lint && bun run typecheck` must pass before PR
4. **Idempotent changes (PR-012)**: changes must be safe to apply multiple times
5. **HITL gate (PR-014)**: PR includes diff summary; user reviews before merge

## Code Targets

Depends on SDK, but typically:

| Pattern | Purpose |
|---------|---------|
| `new Anthropic.Claude({ systemPrompt: '...' })` | System prompt |
| `model: 'claude-opus-4-5'` | Model selection |
| `tools: [...]` | Tool definitions |
| `maxTokens: N` | Budget setting |

## Capability Probing

```bash
# Check SDK installed
ls node_modules/@anthropic-ai/sdk 2>/dev/null
ls node_modules/openai 2>/dev/null

# Find agent entry points
grep -r "new Anthropic\|new OpenAI\|createAgent\|Agent(" src/ --include="*.ts" -l

# Typecheck
bun run typecheck 2>&1 | head -20
```

## Remedy Categories

- **System prompt edit**: update `systemPrompt` or `instructions` field
- **Model change**: update `model` field (requires explicit operator sign-off per memory `feedback_provider_change_explicit_approval`)
- **Tool schema fix**: update tool input schema or description
- **Retry / timeout config**: update `maxRetries`, `timeout`, `maxTokens` fields
- **Temperature / sampling**: update `temperature` or sampling parameters

## Lint + Typecheck Gate

For local-code-construct targets, the apply-worker MUST run:
```bash
bun run lint
bun run typecheck
```
Both must exit 0. Failures block PR creation.

## Audit

```json
{
  "targetPlatform": "local-cloud-agent-sdk",
  "targetClass": "local-code-construct",
  "remedyType": "system-prompt-patch",
  "sdk": "anthropic",
  "branch": "diagnose/sdk-fix-<uuid>",
  "pr": "https://github.com/.../pull/<N>",
  "lintPassed": true,
  "typecheckPassed": true,
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```
