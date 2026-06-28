# Codex Transcripts — Source Platform Reference

> Codex CLI session path CONFIRMED iter-8.
> Source: codex-rs/rollout/src/lib.rs constants.
> Upstream docs: https://developers.openai.com/codex/cli · https://github.com/openai/codex

## Session paths (confirmed iter-8)

```
Active sessions:   ~/.codex/sessions/<session>.jsonl
Archived sessions: ~/.codex/archived_sessions/<session>.jsonl
Config:            ~/.codex/config.toml

Constants (codex-rs/rollout/src/lib.rs):
  SESSIONS_SUBDIR = "sessions"
  ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"
```

- Default: session recording is ON
- Suppress: `codex exec --ephemeral`
- Config: `~/.codex/config.toml`

## Discover sessions

```bash
# List all active sessions
ls ~/.codex/sessions/

# Most recent session
ls -lt ~/.codex/sessions/ | head -5

# Find by approximate date (file mtime)
find ~/.codex/sessions -newer /tmp/ref-date -name "*.jsonl"
```

## CLI install check

> Official Codex CLI docs: https://developers.openai.com/codex/cli
>
> Reading Codex transcripts needs **no CLI** (they are local JSONL files under
> `~/.codex/sessions/`) — the `codex` CLI only PRODUCES them. During onboarding the
> ensure-cli gate (PR-021 — `references/workflows/onboarding.md` Phase 2) probes for
> the `codex` binary; if missing it shows the docs link + the install command below
> and **asks for explicit approval before installing** (never auto-installs). On
> decline, the skill still reads any existing session files directly.

Codex CLI install:
```bash
which codex
# Install: npm install -g @openai/codex
# or: curl https://install.codex.openai.com | sh
```

## Filter/Search Support

See `references/filter-search-matrix.md`. Pure file reads:
- by session ID: filename = session UUID
- by time: file `mtime`
- has error: `grep '"error":'`
- by skill: `grep '"skill":'`
- by agent type: `grep '"agent_type":'`
- full-text: grep over JSONL content

## Normalization

Normalizer: `scripts/normalize/platforms/codex.ts`

```bash
# Normalize a session file:
bun scripts/cli/run.sh scripts/normalize/platforms/codex.ts < session.jsonl
```
