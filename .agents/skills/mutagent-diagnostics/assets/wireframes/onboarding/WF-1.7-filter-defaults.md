# WF-1.7 — Filter Defaults + Scope

> Phase 7 of onboarding: set default filter scope for diagnostics runs.
> Prev: WF-1.6 | Next: WF-1.8

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  Step 6 of 7 — Default Scope                                │
│                                                             │
│  How many traces should diagnostics analyze per run?        │
│                                                             │
│  [1] Last 7 days, up to 100 traces    (recommended)         │
│  [2] Last 24 hours, up to 50 traces   (fast)                │
│  [3] Last 30 days, up to 500 traces   (thorough)            │
│  [4] Custom                                                 │
│                                                             │
│  Errors-only mode:                                          │
│  [Y] Include errors only (faster, higher signal)            │
│  [N] Include all traces                    (default)        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Custom Path

```
  Custom filter configuration:
  
  Time window from ("7daysAgo", "24h", ISO date): > 7daysAgo
  Time window to ("now", ISO date):               > now
  Max traces:                                     > 100
  Filter to errors only? (y/n):                   > n
  Filter by agent ID (leave empty for all):        > 
```

## On Confirm

Updates `filters` section in `config.yaml`:
```yaml
filters:
  time_window:
    from: "7daysAgo"
    to: "now"
  has_error: null   # null = all
  limit: 100
```

## Note on Score Filters

Score-based filters are NOT set here — they require score-scale auto-discovery at runtime (iter-8). Thresholds are never hardcoded in config.
