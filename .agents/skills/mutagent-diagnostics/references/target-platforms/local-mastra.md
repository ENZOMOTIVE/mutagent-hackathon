# Local Mastra — Target Platform Reference

> Apply target: Mastra.ai framework running locally (TypeScript/Node.js).
> Target class: `local-code-construct`
> Apply branch: local-code-construct (code edits via BG-worktree PR; lint+typecheck gate required)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-code-construct` |
| Mutability | code edits via BG-worktree PR |
| Isolation | BG-worktree per PR-004; lint+typecheck gate required |

## How Remedies Are Applied

Mastra remedies are **TypeScript code changes** — agent definitions, tool registrations, workflow configs.

1. **BG-worktree isolation (PR-004)**: all changes happen in a separate worktree branch
2. **Read before write (PR-003)**: read the target agent file before proposing edits
3. **Lint + typecheck gate**: `bun run lint && bun run typecheck` must pass on the branch before PR is opened
4. **Idempotent changes (PR-012)**: changes must be safe to apply multiple times
5. **HITL gate (PR-014)**: PR description includes diff summary; user reviews before merge

## Code Targets

| Path | Purpose |
|------|---------|
| `src/mastra/agents/*.ts` | Agent definitions |
| `src/mastra/tools/*.ts` | Tool registrations |
| `src/mastra/workflows/*.ts` | Workflow configurations |
| `mastra.config.ts` | Top-level Mastra config |

## Capability Probing

```bash
# Check Mastra is installed
ls node_modules/@mastra/core 2>/dev/null || bun pm ls | grep mastra

# Check agent definitions
find . -path "*/mastra/agents/*.ts" -ls

# Validate config compiles
bun run typecheck 2>&1 | head -20
```

## Remedy Categories

- **Prompt system change**: edit agent `instructions` or `systemPrompt` in agent definition
- **Tool update**: modify tool schema or handler in `src/mastra/tools/`
- **Workflow step change**: update step order, retry logic, or timeout in workflow definition
- **Model config update**: change `model` field in agent definition

## Lint + Typecheck Gate

For local-code-construct targets, the apply-worker MUST run:
```bash
bun run lint
bun run typecheck
```
Both must exit 0 before the PR is opened. Failures block the PR creation.

## Audit

```json
{
  "targetPlatform": "local-mastra",
  "targetClass": "local-code-construct",
  "remedyType": "agent-definition-patch",
  "branch": "diagnose/mastra-fix-<uuid>",
  "pr": "https://github.com/.../pull/<N>",
  "lintPassed": true,
  "typecheckPassed": true,
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```
