# WF-1.6 — Config Review + Write

> Phase 6 of onboarding: review generated config and confirm write.
> Prev: WF-1.5 | Next: WF-1.7 (or WF-1.8 on first run)

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  Step 5 of 7 — Review Configuration                         │
│                                                             │
│  Here's what will be written to config.yaml:               │
│                                                             │
│  source:                                                    │
│    platform: "langfuse"                                     │
│    config: {}                                               │
│                                                             │
│  target:                                                    │
│    platform: "local-claude"                                 │
│    config: {}                                               │
│                                                             │
│  filters:                                                   │
│    time_window:                                             │
│      from: "7daysAgo"                                       │
│      to: "now"                                              │
│    limit: 100                                               │
│                                                             │
│  ask_tool:                                                  │
│    runtime: "claude-code"                                   │
│                                                             │
│  schedule:                                                  │
│    mode: "on-demand"                                        │
│                                                             │
│  self_diagnostics:                                          │
│    enabled: false                                           │
│                                                             │
│  [1] Write config and continue                              │
│  [2] Go back to change a setting                            │
│  [3] Exit without saving                                    │
└─────────────────────────────────────────────────────────────┘
```

## On Confirm

1. Write `config.yaml` from template (using `assets/templates/config.yaml.tpl`)
2. Run `scripts/config/validate.ts` on written file
3. If validation fails → show error + offer fix
4. If validation passes → advance to WF-1.7

## Validation Display

```
  Writing config.yaml... ✓
  Validating... ✓ Config is valid

  [1] Continue to next step
```
