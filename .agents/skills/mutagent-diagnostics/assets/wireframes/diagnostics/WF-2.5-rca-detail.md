# WF-2.5 — RCA Detail Expansion

> Expanded view of root cause analysis for a single finding.
> Shown when user clicks "expand" on a finding card in WF-2.4.

## Display (Expanded Finding Card)

```
┌─────────────────────────────────────────────────────────────────┐
│  ▼ [CRITICAL] Tool call timeout causing search failures         │
│                                                                 │
│  WHAT: tool-timeout   WHY: env-config   WHERE: tool-invocation  │
│                                                                 │
│  Evidence (8 traces)                                            │
│  ──────────────────────────────────────────────────────────     │
│  tr_abc123  2026-05-27 10:05  duration: 47.2s  error: timeout   │
│  tr_abc124  2026-05-27 10:08  duration: 46.9s  error: timeout   │
│  tr_abc125  2026-05-27 10:11  duration: 45.1s  error: timeout   │
│  (+ 5 more)                                                     │
│                                                                 │
│  Root Cause Chain                                               │
│  ──────────────────────────────────────────────────────────     │
│  Why 1: Tool call `search` exceeded timeout limit               │
│         Evidence: "Error: ETIMEDOUT after 5000ms"               │
│                                                                 │
│  Why 2: Default timeout is 5s; search API requires 15–30s      │
│         Evidence: search API docs, observed latency p50=18s     │
│                                                                 │
│  Why 3: SEARCH_TIMEOUT env var not set in .mutagentrc          │
│         Evidence: env probe shows SEARCH_TIMEOUT undefined      │
│                                                                 │
│  Origin: Missing env configuration (env-config class)           │
│                                                                 │
│  Remedy                                                         │
│  ──────────────────────────────────────────────────────────     │
│  Type: config-patch                                             │
│  Target: local-claude (local-agent class)                       │
│  Action: Add SEARCH_TIMEOUT=30000 to .mutagentrc               │
│                                                                 │
│  [ Copy markdown ]  [ Accept fix ]  [ Dismiss ]                 │
└─────────────────────────────────────────────────────────────────┘
```

## RCA Chain Rules (from references/workflows/rca.md)

- No fixed depth — recurse until the ORIGIN is reached (a WHY that has no further cause)
- Every WHY node must cite evidence from the trace (not inference)
- Origin must map to one of the 8 WHERE categories

## Finding JSON Shape (shown on demand via "Copy JSON")

```json
{
  "id": "f-001",
  "severity": "critical",
  "what": "tool-timeout",
  "why": "env-config",
  "where": "tool-invocation",
  "summary": "Tool call timeout causing search failures",
  "evidence": [...],
  "whyChain": [
    { "depth": 1, "reason": "...", "evidence": "..." },
    { "depth": 2, "reason": "...", "evidence": "..." },
    { "depth": 3, "reason": "...", "evidence": "..." }
  ],
  "origin": { "depth": 3, "reason": "...", "evidence": "..." },
  "remedy": { ... }
}
```
