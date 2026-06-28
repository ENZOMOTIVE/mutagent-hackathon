# WF-3.4 — Apply Failure Recovery

> Shown when the apply-worker fails for any reason.
> Failure modes: lint gate, typecheck gate, remote 4xx/5xx, git conflict.

## Display (lint gate failure)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Apply Failed — Lint Gate                                     │
│                                                                 │
│  The proposed code change introduces a lint error.              │
│  PR was NOT opened (gate enforced per PR-006).                  │
│                                                                 │
│  Error:                                                         │
│  src/agents/search-agent.ts:12:3                               │
│  '@typescript-eslint/no-explicit-any': Unexpected any type      │
│                                                                 │
│  Options:                                                       │
│  [1] Copy the change as markdown (apply manually + fix lint)    │
│  [2] Skip this finding for now                                  │
│  [3] Report a bug in mutagent-diagnostics                      │
└─────────────────────────────────────────────────────────────────┘
```

## Display (typecheck failure)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Apply Failed — TypeScript Error                              │
│                                                                 │
│  src/agents/search-agent.ts(14,5): error TS2345:               │
│  Argument of type 'string | undefined' is not assignable...    │
│                                                                 │
│  [1] Copy change as markdown                                    │
│  [2] Skip this finding                                          │
│  [3] Report a bug                                               │
└─────────────────────────────────────────────────────────────────┘
```

## Display (remote 4xx)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Remote Mutation Failed                                       │
│                                                                 │
│  HTTP 401 Unauthorized                                          │
│  Check LANGFUSE_SECRET_KEY in .mutagentrc                      │
│                                                                 │
│  The operation is SAFE to retry — idempotency key preserved:   │
│  a1b2c3d4-e5f6-...                                             │
│                                                                 │
│  [1] Retry (after fixing credentials)                           │
│  [2] Cancel                                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Display (git conflict)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Apply Failed — Git Conflict                                  │
│                                                                 │
│  The target file has conflicting changes on the base branch.    │
│  The worktree branch was cleaned up.                           │
│                                                                 │
│  [1] Copy change as markdown (apply manually after resolving)   │
│  [2] Skip this finding                                          │
└─────────────────────────────────────────────────────────────────┘
```

## Audit on Failure

All failures are recorded in audit.json with `status: "failed"` and `errorDetail`. No partial audits.
