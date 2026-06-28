# WF-1.8 — First Run Prompt

> Phase 8 of onboarding: offer to run diagnostics immediately after setup.
> Prev: WF-1.7 (or WF-1.1 if setup already complete)

## Display (After Fresh Setup)

```
┌─────────────────────────────────────────────────────────────┐
│  Step 7 of 7 — Setup Complete                               │
│                                                             │
│  ✓ config.yaml written                                      │
│  ✓ Connection validated                                     │
│  ✓ .mutagent-diagnostics/ initialized                       │
│                                                             │
│  Run diagnostics now?                                       │
│                                                             │
│  [1] Yes, run diagnostics now                               │
│  [2] No, I'll run it manually later                         │
│                                                             │
│  To run manually: say "run diagnostics" or "diagnose my     │
│  agents" in your AI coding session, or:                     │
│  pnpx @mutagent/diagnostics run                             │
└─────────────────────────────────────────────────────────────┘
```

## Display (Already Set Up)

```
┌─────────────────────────────────────────────────────────────┐
│  mutagent-diagnostics — Ready                               │
│                                                             │
│  Config: ✓ valid                                            │
│  Source: langfuse (connected)                               │
│  Target: local-claude                                       │
│                                                             │
│  [1] Run diagnostics now                                    │
│  [2] Reconfigure                                            │
│  [3] Exit                                                   │
└─────────────────────────────────────────────────────────────┘
```

## On "Run Now"

→ Trigger diagnostics orchestrator (equivalent to `pnpx @mutagent/diagnostics run`)
→ Jump to WF-2.1 (diagnostics entry point)

## On "Run Later"

```
  To run diagnostics:
  
  • In your AI coding session: say "run diagnostics on my agents"
  • From CLI: pnpx @mutagent/diagnostics run
  
  Config saved at: ./config.yaml
  
  Done!
```
