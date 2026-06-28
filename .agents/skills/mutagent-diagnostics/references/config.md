# Config Reference — config.yaml Schema with Doc Strings

> Config location: `<host>/.mutagent-diagnostics/config.yaml`
> Secrets location: `<host>/.mutagentrc` (gitignored — never commit)
> Schema source of truth: `scripts/config/schema.ts` (TypeBox)

## Full annotated config.yaml

```yaml
# ──── SOURCE ─────────────────────────────────────────────────────────────────
# Where agent traces come from.
source:
  # Source platform identifier. Required.
  # Supported in v0.1: langfuse | otel | local-jsonl | claude-code | codex
  platform: langfuse

  # Endpoint URL for the source platform.
  # Empty = use default CLI auth / env vars.
  # Set for self-hosted platforms (e.g., self-hosted Langfuse).
  endpoint: ""

  # Key name in .mutagentrc for the source API secret.
  # NEVER store the value here — only the key name.
  # Example: LANGFUSE_SECRET_KEY → .mutagentrc has LANGFUSE_SECRET_KEY=sk-...
  credential_ref: LANGFUSE_SECRET_KEY

# ──── TARGET ─────────────────────────────────────────────────────────────────
# Where agent definitions live (apply remedies back here).
target:
  # Target platform identifier. Required.
  # local-agent: .claude/agents/*.md, .codex/agents/*.md, etc.
  # local-code-construct: Mastra Agent, Cloud Agent SDK, LangGraph, etc.
  # cloud-rest: REST API with GET/PUT for agent definition CRUD
  platform: local-claude

  # Apply mode. Required.
  # local = markdown file edits via BG worktree + PR
  # remote = REST PUT with idempotency-key
  mode: local

  # Root directory for local targets (relative to project root).
  # Default: .claude/agents/
  root: .claude/agents/

  # REST base URL for remote targets.
  # rest_base_url: https://api.example.com/v1

  # Key name in .mutagentrc for REST auth token.
  # credential_ref: REST_API_TOKEN

# ──── ASK TOOL ───────────────────────────────────────────────────────────────
# Platform-native ASK mechanism. Auto-detected by cli/init.ts at first run.
# Override here if auto-detection is wrong.
ask_tool:
  # Host coding-agent runtime. Required.
  # claude-code | codex | cursor | opencode | generic
  runtime: claude-code

  # Platform tool name for structured multi-select.
  # AskUserQuestion on Claude Code; varies on other runtimes.
  native_tool: AskUserQuestion

  # Fallback when native tool is unavailable.
  # chat-multi-choice: numbered list in chat message
  fallback: chat-multi-choice

# ──── SCHEDULE ───────────────────────────────────────────────────────────────
# When the orchestrator wakes to check trigger rules.
# v0.1 ships on-demand ONLY. Schedule structure prepared for post-v0.1 wiring.
# See references/workflows/schedule-prep.md for adding scheduling post-v0.1.
schedule:
  # on-demand = operator manually invokes (v0.1 supported)
  # daily-batch = native /loop or cron wake (post-v0.1)
  mode: on-demand

  # For daily-batch: local time (HH:MM format)
  at: "09:00"

  # Timezone. Defaults to system timezone.
  # timezone: "America/New_York"

# ──── TRIGGER RULES ──────────────────────────────────────────────────────────
# Which traces qualify for a diagnostic run when schedule fires or operator invokes.
# Each rule's match is a TraceFilter; traces matching ANY rule are diagnosed.
trigger_rules:
  - name: high-latency-errors
    match:
      latency_p99_ms_above: 5000
      has_error: true
    action: diagnose

  - name: feedback-bearing
    match:
      has_feedback: true
      # score_below is computed via score-scale auto-discovery (iter-8)
      # Do NOT hardcode here — let the orchestrator probe and compute threshold
    action: diagnose

  # Example: specific agent filter
  # - name: search-agent-failures
  #   match:
  #     agent_id: search-agent
  #     has_error: true
  #   action: diagnose

# ──── HEARTBEAT ──────────────────────────────────────────────────────────────
# Controls notifications for scheduled (non-interactive) runs.
heartbeat:
  # Whether to log when no triggers fire (no operator ping)
  notify_on_zero_matches: false

  # Whether to notify operator when triggers fire and report is ready
  notify_on_matches: true

  # Cost guardrail: max full diagnostic runs per day
  max_diagnostics_per_day: 3

# ──── SELF DIAGNOSTICS [INTERNAL] ────────────────────────────────────────────
# Skill diagnoses itself after usage session (PR-022).
# OFF by default for end users. ON for skill maintainers + dogfood mode.
self_diagnostics:
  # Enable/disable self-diagnostics. Default: false.
  enabled: false

  # Cadence: per-session | daily | manual
  cadence: per-session

  # Source: auto-detect host (claude-code | codex)
  source: host-coding-agent

  # Branch for self-remedy PRs (use {date} placeholder)
  remedy_branch: mutagent/self-diagnostics/{date}

  # [INTERNAL] prefix added to all self-remedy PR titles
  marker: "[INTERNAL]"
```

## TraceFilter fields (for trigger_rules.match)

| Field | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Filter by agent identifier |
| `session_id` | string | Filter by specific session/trace ID |
| `start_time` | ISO8601 string | Start of time window |
| `end_time` | ISO8601 string | End of time window |
| `has_error` | boolean | Only traces with error events |
| `has_feedback` | boolean | Only traces with attached feedback |
| `score_below` | number | Traces with score below threshold (computed by orchestrator from scale probe) |
| `latency_p99_ms_above` | number | Traces with P99 latency above threshold (ms) |
| `by_skill` | string | Traces where a specific skill was triggered |
| `by_route` | string | Traces with a specific operation name |
| `by_tag` | string[] | Traces with specific tags |

## Security notes

- `config.yaml` is committed to the project repository (non-secrets only)
- `.mutagentrc` is gitignored and holds actual secret values
- The `credential_ref` field in config.yaml is a KEY NAME pointing to `.mutagentrc`, never the value
- Three-layer protection: `.gitignore` pattern + `git check-ignore` before any write + PR-time `git status` check
