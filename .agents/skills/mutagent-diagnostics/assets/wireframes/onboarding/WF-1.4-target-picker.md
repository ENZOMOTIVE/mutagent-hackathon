# WF-1.4 — Target Platform Picker

> Phase 4 of onboarding: pick the apply target.
> Prev: WF-1.3 | Next: WF-1.5

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  Step 3 of 7 — Where should fixes be applied?               │
│                                                             │
│  Target class:                                              │
│                                                             │
│  LOCAL AGENTS (config changes only, HITL review)           │
│  [1] Claude Code     (skills + settings)                    │
│  [2] Codex CLI       (config.toml)                          │
│  [3] Cursor          (.cursorrules + settings)              │
│  [4] OpenCode        (opencode.json)                        │
│                                                             │
│  LOCAL CODE CONSTRUCTS (code edits via PR, lint gate)       │
│  [5] Mastra.ai       (TypeScript agents)                    │
│  [6] Cloud Agent SDK (Anthropic / OpenAI / Google / etc.)   │
│                                                             │
│  REMOTE (REST API mutations, HITL always required)          │
│  [7] Cloud REST      (Langfuse annotations, remote config)  │
│                                                             │
│  [8] Skip for now                                           │
└─────────────────────────────────────────────────────────────┘
```

## On Selection

| Choice | Target Platform | Target Class |
|--------|-----------------|--------------|
| 1 | local-claude | local-agent |
| 2 | local-codex | local-agent |
| 3 | local-cursor | local-agent |
| 4 | local-opencode | local-agent |
| 5 | local-mastra | local-code-construct |
| 6 | local-cloud-agent-sdk | local-code-construct |
| 7 | cloud-rest | remote |
| 8 | null | null |

## Target Class Explanation (shown inline)

- **local-agent**: reads config, proposes changes, you apply them (safe)
- **local-code-construct**: opens a PR branch, lint+typecheck gate before any merge
- **remote**: read-before-write, idempotent mutations, HITL confirmation for every change
