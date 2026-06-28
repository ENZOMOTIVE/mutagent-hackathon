# WF-3.2 — Apply Progress

> Shown while `diagnostics-apply-worker` executes the fix.
> Different displays by target class.

## Display (local-agent — config patch)

```
┌─────────────────────────────────────────────────────────────────┐
│  Applying fix...                                                │
│                                                                 │
│  [1/3] Reading current config...               ████████ done   │
│  [2/3] Applying patch...                       ████████ done   │
│  [3/3] Verifying change...                     ████░░░░        │
│                                                                 │
│  Target: .mutagentrc (local-claude)                            │
└─────────────────────────────────────────────────────────────────┘
```

## Display (local-code-construct — PR flow)

```
┌─────────────────────────────────────────────────────────────────┐
│  Opening fix PR...                                              │
│                                                                 │
│  [1/5] Creating worktree branch...             ████████ done   │
│  [2/5] Applying code change...                 ████████ done   │
│  [3/5] Running lint...                         ████████ done   │
│  [4/5] Running typecheck...                    ████████ done   │
│  [5/5] Opening PR...                           ████░░░░        │
│                                                                 │
│  Branch: diagnose/search-timeout-fix-a1b2c3d4                 │
└─────────────────────────────────────────────────────────────────┘
```

## Lint / Typecheck Failure Display

```
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Lint failed — fix required before PR can be opened           │
│                                                                 │
│  Error: src/agents/search-agent.ts:12:3                        │
│  Unexpected any. Specify a different type.                      │
│                                                                 │
│  [1] Fix lint error and retry                                   │
│  [2] Copy change for manual application                         │
│  [3] Abort                                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Display (remote — REST mutation)

```
┌─────────────────────────────────────────────────────────────────┐
│  Applying remote change...                                      │
│                                                                 │
│  [1/3] Reading current state (GET)...          ████████ done   │
│  [2/3] Applying mutation (PATCH)...            ████████ done   │
│  [3/3] Verifying applied state (GET)...        ████████ done   │
│                                                                 │
│  Idempotency key: a1b2c3d4-e5f6-...                           │
└─────────────────────────────────────────────────────────────────┘
```

→ On success: WF-3.3 (result summary)
→ On failure: WF-3.4 (failure recovery)
