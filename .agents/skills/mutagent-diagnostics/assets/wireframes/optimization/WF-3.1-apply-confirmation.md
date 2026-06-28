# WF-3.1 — Apply Fix Confirmation (HITL Gate)

> HITL confirmation before any apply-worker dispatches a fix.
> ALL apply operations require explicit user confirmation here.
> This is the primary destructive-action gate per PR-014.

## Trigger

User clicks "Accept fix" in WF-2.4 report (and no stale warning — or stale override confirmed).

## Display (local-agent target)

```
┌─────────────────────────────────────────────────────────────────┐
│  Apply Fix — Confirmation Required                              │
│                                                                 │
│  Finding: Tool call timeout causing search failures             │
│  Severity: CRITICAL                                             │
│                                                                 │
│  Proposed change:                                               │
│  ─────────────────────────────────────────────────────────     │
│  File: .mutagentrc (local-claude config)                        │
│  Action: Add key                                                │
│                                                                 │
│  + SEARCH_TIMEOUT=30000                                         │
│                                                                 │
│  ─────────────────────────────────────────────────────────     │
│  Target class: local-agent (config change only, no code edit)   │
│  This change is REVERSIBLE — you can remove the key.           │
│                                                                 │
│  [1] Apply this fix                                             │
│  [2] Copy markdown (apply manually)                             │
│  [3] Dismiss this finding                                       │
│  [4] Cancel                                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Display (local-code-construct target)

```
│  Proposed change:                                               │
│  ─────────────────────────────────────────────────────────     │
│  File: src/agents/search-agent.ts                              │
│  Action: Update system prompt                                   │
│                                                                 │
│  - const timeout = 5000;                                        │
│  + const timeout = parseInt(process.env.SEARCH_TIMEOUT ?? '30000'); │
│                                                                 │
│  ─────────────────────────────────────────────────────────     │
│  Target class: local-code-construct                             │
│  A PR will be opened. Lint + typecheck will run before merge.  │
│  Branch: diagnose/search-timeout-fix-<uuid>                    │
│                                                                 │
│  [1] Open PR with this change                                   │
│  [2] Copy markdown (apply manually)                             │
│  [3] Dismiss                                                    │
│  [4] Cancel                                                     │
```

## Display (remote target)

```
│  Target class: remote (REST API mutation)                       │
│  Action: POST score annotation to Langfuse trace               │
│                                                                 │
│  WARNING: This will mutate a remote resource.                   │
│  Action is idempotent (idempotency key: <uuid>).               │
│                                                                 │
│  [1] Confirm remote mutation                                    │
│  [2] Copy curl command (apply manually)                         │
│  [3] Dismiss                                                    │
│  [4] Cancel                                                     │
```

## On "Apply"

→ Dispatch `diagnostics-apply-worker` with finding + remedy
→ Show WF-3.2 (progress)
