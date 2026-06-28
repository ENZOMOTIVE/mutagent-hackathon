# WF-2.2 — Tier-0 Scan Progress

> Displayed while tier-0-scan.ts runs (CODE-FIRST pre-LLM analysis).
> This runs before any LLM call — fast, deterministic.

## Display (In Progress)

```
┌─────────────────────────────────────────────────────────────┐
│  Running diagnostics...                                     │
│                                                             │
│  [1/4] Fetching traces from langfuse...        ████░░ 62%  │
│  [2/4] Tier-0 scan (pre-LLM)...               ░░░░░░  0%  │
│  [3/4] Deep analysis (LLM)...                 pending      │
│  [4/4] Rendering report...                    pending      │
│                                                             │
│  Fetched 73 trace metadata records                         │
└─────────────────────────────────────────────────────────────┘
```

## Display (After Tier-0 Scan)

```
┌─────────────────────────────────────────────────────────────┐
│  Running diagnostics...                                     │
│                                                             │
│  [1/4] Fetching traces...                     ████████ done │
│  [2/4] Tier-0 scan (pre-LLM)...               ████████ done │
│  [3/4] Deep analysis (LLM)...                 ████░░░░  55%│
│  [4/4] Rendering report...                    pending      │
│                                                             │
│  Tier-0 findings:                                           │
│  • Error spike: 12 errors in last 2h (threshold: 3)        │
│  • Latency spike: p95 = 45s (threshold: 15s)               │
│  • Analyzing 4 trace clusters (cap: 5)                     │
└─────────────────────────────────────────────────────────────┘
```

## Tier-0 Pattern Summary (shown after step 2)

| Pattern | Found | Value |
|---------|-------|-------|
| P-001 Error spike | Yes | 12 errors / 2h (threshold: 3) |
| P-002 Latency spike | Yes | p95=45s (threshold: 15s) |
| P-003 Feedback cluster | No | — |

## Slice Plan Display

```
  Slice plan (cap=5):
  Cluster 1: 8 error traces (2026-05-27 10:00–12:00)
  Cluster 2: 5 high-latency traces
  Cluster 3: 3 negative-feedback traces
  Cluster 4: 2 remaining samples
  → 4 clusters queued (under cap of 5)
```

→ Proceeds automatically to WF-2.3 (LLM analysis running)
