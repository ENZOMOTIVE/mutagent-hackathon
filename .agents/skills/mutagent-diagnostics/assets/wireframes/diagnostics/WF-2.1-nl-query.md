# WF-2.1 — Natural Language Query Entry

> Entry point for a diagnostics run.
> User states what they want in plain language; skill translates to TraceFilter.

## Trigger

User says: "run diagnostics", "diagnose my agents", "why is my agent failing?",
"check last week's agent sessions", etc.

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  mutagent-diagnostics — Running                             │
│                                                             │
│  What would you like to diagnose?                           │
│  (or press Enter to use defaults from config.yaml)          │
│                                                             │
│  Examples:                                                  │
│  • "Why did my search agent fail last week?"                │
│  • "Show me sessions with negative feedback"                │
│  • "Analyze errors from yesterday"                          │
│  • "Check the checkout-agent sessions"                      │
│                                                             │
│  > _                                                        │
└─────────────────────────────────────────────────────────────┘
```

## NL → TraceFilter Translation

The orchestrator translates the query:

| NL Fragment | TraceFilter Field |
|-------------|------------------|
| "last week" | `time_window.from = "7daysAgo"` |
| "yesterday" | `time_window.from = "1daysAgo"` |
| "errors" / "failed" | `has_error = true` |
| "negative feedback" | `has_feedback = true, score_below = <auto-discovered>` |
| "search agent" | `agent_id = "search-agent"` |
| (empty / Enter) | use `config.yaml` defaults |

## After Translation

Show confirmation before running:

```
  Interpreted as:
  • Time window: last 7 days
  • Filter: errors only
  • Agent: all agents
  • Limit: 100 traces

  [1] Run with these filters
  [2] Adjust filters
  [3] Cancel
```

→ On confirm: proceed to WF-2.2 (tier-0 scan progress)
