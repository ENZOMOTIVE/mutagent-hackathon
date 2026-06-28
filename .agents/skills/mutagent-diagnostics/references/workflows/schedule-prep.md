# Schedule Prep — How to Wire Scheduling Post-v0.1

> v0.1 ships `schedule.mode: on-demand` ONLY.
> This document prepares the operator to add scheduling via their host runtime after v0.1.

## Why no schedules in v0.1

Scheduling is host-runtime-specific. v0.1 ships the structure (config fields, trigger_rules, heartbeat config) but no schedule wiring. The operator can ask their coding agent to wire scheduling at any time using the playbook below.

---

## How to ask your coding agent to set up scheduling

Tell your coding agent:
```
Set up daily diagnostics at 09:00 using mutagent-diagnostics.
Source: langfuse. Trigger rule: has_feedback + score_below threshold.
```

The coding agent will follow the appropriate procedure for your host runtime:

---

## Claude Code — native /loop + CronCreate

```bash
# Claude Code has native scheduling primitives (confirmed in docs)
# 1. Update config.yaml: schedule.mode = daily-batch, at = "09:00"
# 2. Register with Claude Code's scheduler:
#    CronCreate({ cron: "0 9 * * *", command: "invoke mutagent-diagnostics" })
# OR use /loop for interactive polling:
#    /loop 24h <diagnose my agents>
```

Reference: [code.claude.com/docs](https://code.claude.com/docs/en/)

---

## Codex CLI — external cron + codex exec

```bash
# Codex has no native scheduler — use OS cron
# 1. Update config.yaml: schedule.mode = daily-batch, at = "09:00"
# 2. Add crontab entry:
crontab -e
# Add line:
# 0 9 * * * codex exec --ephemeral "invoke mutagent-diagnostics for daily batch"
```

Reference: [developers.openai.com/codex](https://developers.openai.com/codex/cli)

---

## Cursor — Background Agents (2025+)

```bash
# Verify Background Agents support scheduling in your Cursor version
# If supported: register a recurring task via Background Agents UI
# If not: fall back to OS cron (see Codex pattern above)
```

Reference: [cursor.com/docs](https://cursor.com/docs)

---

## Headless / CI (GitHub Actions)

```yaml
# .github/workflows/mutagent-diagnostics-daily.yml
name: Daily Diagnostics
on:
  schedule:
    - cron: '0 9 * * *'
jobs:
  diagnose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run diagnostics
        run: pnpx @mutagent/diagnostics run --non-interactive
        env:
          LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
```

---

## config.yaml schedule fields

```yaml
schedule:
  mode: daily-batch        # Change from on-demand → daily-batch
  at: "09:00"             # Local time
  timezone: "America/New_York"

heartbeat:
  notify_on_matches: true   # Notify operator when triggers fire
  max_diagnostics_per_day: 3  # Cost guardrail
```

**Important**: scheduled runs produce a report + notification. HITL apply gate still fires — operator must confirm apply on next interactive session.
