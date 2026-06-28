# WF-1.1 — Welcome / Entry Point

> Phase 1 of onboarding: detect setup state and route user.
> Rendered as: numbered chat options (chat-multi-choice) or AskUserQuestion (Claude Code)

## Trigger

User runs: `pnpx @mutagent/diagnostics init`

## Setup State Detection

`scripts/setup/detect.ts` runs first:

```
SetupState = "missing" | "partial" | "complete"
```

## Route Matrix

| State | Route |
|-------|-------|
| `missing` | → WF-1.2 (source platform picker) |
| `partial` | → WF-1.7 (resume partial setup) |
| `complete` | → WF-1.8 (run diagnostics now?) |

## Display (State = "missing")

```
┌─────────────────────────────────────────────────────────────┐
│  mutagent-diagnostics — Setup                               │
│                                                             │
│  Welcome! Let's configure diagnostics for your AI agents.   │
│                                                             │
│  This will take about 5 minutes.                            │
│                                                             │
│  [1] Get started → (detect source platform)                 │
│  [2] Show what will be configured                           │
│  [3] Exit                                                   │
└─────────────────────────────────────────────────────────────┘
```

## Display (State = "partial")

```
┌─────────────────────────────────────────────────────────────┐
│  mutagent-diagnostics — Resume Setup                        │
│                                                             │
│  Partial config found. Missing fields:                      │
│  • target.platform                                          │
│  • ask_tool.runtime                                         │
│                                                             │
│  [1] Resume setup                                           │
│  [2] Start over (backup existing config)                    │
│  [3] Exit                                                   │
└─────────────────────────────────────────────────────────────┘
```

## Display (State = "complete")

→ Skip to WF-1.8
