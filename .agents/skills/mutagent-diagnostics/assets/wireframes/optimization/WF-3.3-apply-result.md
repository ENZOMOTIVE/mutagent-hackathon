# WF-3.3 — Apply Result Summary

> Shown after a successful fix application.
> Includes audit trail links and next-step options.

## Display (local-agent success)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✓ Fix Applied                                                  │
│                                                                 │
│  Finding: Tool call timeout causing search failures             │
│  Change: SEARCH_TIMEOUT=30000 added to .mutagentrc             │
│                                                                 │
│  Audit record:                                                  │
│  • .mutagent-diagnostics/audits/audit-2026-05-27T10-45.json    │
│  • .mutagent-diagnostics/audits/audit-2026-05-27T10-45.md      │
│                                                                 │
│  Recommendation: Re-run diagnostics in 24h to verify           │
│  the fix resolved the latency spike.                           │
│                                                                 │
│  [1] Apply another finding                                      │
│  [2] Re-run diagnostics now                                     │
│  [3] Done                                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Display (local-code-construct — PR opened)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✓ PR Opened                                                    │
│                                                                 │
│  Finding: Prompt hallucination on empty product list            │
│  PR: https://github.com/.../pull/1042                          │
│  Branch: diagnose/prompt-fix-a1b2c3d4                          │
│                                                                 │
│  Lint: ✓ passed   Typecheck: ✓ passed                          │
│                                                                 │
│  Audit record:                                                  │
│  • .mutagent-diagnostics/audits/audit-2026-05-27T10-46.json    │
│                                                                 │
│  Next: Review the PR diff, then merge to apply.                │
│                                                                 │
│  [1] Apply another finding                                      │
│  [2] Open PR in browser                                         │
│  [3] Done                                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Display (remote — mutation verified)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✓ Remote Change Applied                                        │
│                                                                 │
│  Action: Score annotation posted to Langfuse                   │
│  Trace: tr_abc123                                              │
│  Score: 0.9 (annotation: "diagnosed-2026-05-27")              │
│  Verified: GET confirms new score present                       │
│                                                                 │
│  Idempotency key: a1b2c3d4-e5f6-... (safe to retry)           │
│                                                                 │
│  Audit: .mutagent-diagnostics/audits/audit-2026-05-27T10-47.json │
│                                                                 │
│  [1] Apply another finding                                      │
│  [2] Done                                                       │
└─────────────────────────────────────────────────────────────────┘
```
