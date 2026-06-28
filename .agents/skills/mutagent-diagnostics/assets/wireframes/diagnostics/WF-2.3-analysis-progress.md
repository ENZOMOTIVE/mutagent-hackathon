# WF-2.3 — LLM Analysis Progress

> Displayed while diagnostics-analyzer sub-agents run in parallel (cap: 5).
> Each cluster is analyzed by one sub-agent.

## Display (Parallel Execution)

```
┌─────────────────────────────────────────────────────────────┐
│  Deep analysis running (4 clusters, cap=5)                  │
│                                                             │
│  Cluster 1 [errors, 8 traces]        ████████ complete     │
│  Cluster 2 [latency, 5 traces]       ████░░░░ tier-2...    │
│  Cluster 3 [feedback, 3 traces]      ██░░░░░░ tier-1...    │
│  Cluster 4 [sample, 2 traces]        ░░░░░░░░ queued       │
│                                                             │
│  Findings so far: 3 critical, 1 warning                     │
│  Budget: 142s elapsed / 240s cap                           │
└─────────────────────────────────────────────────────────────┘
```

## Analysis Tiers (shown in progress labels)

| Label | Tier |
|-------|------|
| "tier-0..." | Pre-LLM pattern scan |
| "tier-1..." | Known pattern matching |
| "tier-2..." | Tree-based structural analysis |
| "tier-3..." | Deep structural (LLM) |
| "tier-4..." | LLM deviation detection |
| "complete" | All tiers done for this cluster |

## Budget Exhaustion Warning

If budget cap (240s) is reached before all clusters complete:
```
  ⚠ Analysis budget reached (240s). 1 cluster not fully analyzed.
  Partial findings included in report.

  [1] View partial report
  [2] Resume analysis (run again with narrower scope)
```

→ On all clusters complete: proceed to WF-2.4 (report HTML)
