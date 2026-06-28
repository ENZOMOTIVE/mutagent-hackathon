# WF-1.2 — Source Platform Picker

> Phase 2 of onboarding: pick the trace source platform.
> Prev: WF-1.1 | Next: WF-1.3

## Display

```
┌─────────────────────────────────────────────────────────────┐
│  Step 1 of 7 — Where are your agent traces stored?          │
│                                                             │
│  [1] Langfuse                (cloud or self-hosted)         │
│  [2] OpenTelemetry / Jaeger  (OTel-compatible backend)      │
│  [3] Local JSONL file        (.jsonl or .ndjson)            │
│  [4] Claude Code sessions    (auto-detected)                │
│  [5] Codex CLI sessions      (auto-detected)                │
│  [6] I don't know yet        (skip, configure later)        │
└─────────────────────────────────────────────────────────────┘
```

## On Selection

| Choice | Action |
|--------|--------|
| 1 (Langfuse) | → WF-1.3a (Langfuse auth check) |
| 2 (OTel) | → WF-1.3b (OTel endpoint check) |
| 3 (Local JSONL) | → WF-1.3c (file path input) |
| 4 (Claude Code) | → probe `~/.claude/projects/` → WF-1.4 |
| 5 (Codex) | → probe `~/.codex/sessions/` → WF-1.4 |
| 6 (Skip) | → Set `source.platform: null` → WF-1.4 |

## Validation

After selection, validate connectivity:
- Langfuse: `langfuse traces list --limit 1` → check exit code
- OTel: `curl -m 5 $ENDPOINT/health` → check response
- Local JSONL: `ls $FILE` → check file exists
- Claude Code: `ls ~/.claude/projects/` → count sessions
- Codex: `ls ~/.codex/sessions/` → count sessions

If validation fails → show inline error + offer retry or skip
