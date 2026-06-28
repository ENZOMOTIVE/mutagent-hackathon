# WF-1.5 — ASK Tool Selection

> Phase 5 of onboarding: configure the HITL interaction mode.
> Prev: WF-1.4 | Next: WF-1.6

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  Step 4 of 7 — How should I ask you questions?              │
│                                                             │
│  When diagnostics finds an issue and wants your input,      │
│  how do you want to respond?                                │
│                                                             │
│  [1] Claude Code (AskUserQuestion)                          │
│      Best if you're running this from Claude Code           │
│                                                             │
│  [2] Chat multi-choice                                      │
│      Numbered options in the conversation                   │
│      Works everywhere: terminal, CLI, any chat              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Auto-Detection

Before showing this screen, check if running in Claude Code:
- `process.env.CLAUDE_CODE_ENTRYPOINT` set → suggest [1] (Claude Code)
- Otherwise → suggest [2] (chat-multi-choice)

## On Selection

| Choice | `ask_tool.runtime` |
|--------|--------------------|
| 1 | `claude-code` |
| 2 | `chat-multi-choice` |

## Context Note

The ASK tool selection affects:
- Destructive-action gates: `AskUserQuestion` in Claude Code vs numbered prompt in chat
- HTML report copy-back: auto-paste to conversation (Claude Code) vs manual copy prompt (chat)
- No functional difference for read-only diagnostics — only matters at apply time
