# Codex — Skill + Agent Install Format Reference

> This file covers **skill binding and agent install format** for the Codex platform.
> For transcript/session fetch (session paths, normalization), see
> `references/source-platforms/codex-transcripts.md`.

## Status

| Topic | Status |
|---|---|
| Session paths | **Confirmed** (iter-8) — see `codex-transcripts.md` |
| Skill install format | **Best-effort** — OQ-3 docs lookup pending; verify before publishing |
| Agent install format (TOML) | **Best-effort** — per dashboard line 625 + OQ-3 |

> ⚠️ Verify skill + agent paths against Codex docs before publishing. These are best-effort
> based on the confirmed `~/.codex/` home dir and general agent platform conventions.

## Skill install path

```
~/.codex/skills/mutagent-diagnostics/
```

Codex uses `~/.codex/` as its home directory (confirmed from `config.toml` path in
`codex-rs/rollout/src/lib.rs`). Skill binding: copy the full skill directory to
`~/.codex/skills/<skill-name>/`.

```bash
# Install skill to Codex
cp -r /path/to/mutagent-diagnostics ~/.codex/skills/mutagent-diagnostics
```

## Agent install path

```
~/.codex/agents/
```

Agent files are stored as `.toml` files (not Markdown) in `~/.codex/agents/`.

```bash
# Install an agent (after MD→TOML transcode)
bun scripts/cli/run.sh scripts/cli/install-agents.ts \
  --transcode-only --to codex \
  assets/agents/diagnostics-analyzer.md \
  ~/.codex/agents/diagnostics-analyzer.toml
```

## Agent format: MD → TOML transcode

Codex uses **TOML** for agent configuration. Claude Code `.md` agent files must be transcoded
to TOML format via `scripts/cli/install-agents.ts --transcode-only --to codex`.

### Input (`.md` / Claude Code format)

```markdown
---
name: diagnostics-analyzer
description: Parallel analyzer agent for mutagent-diagnostics
tools: Bash, Read, Write, SendMessage
---

Agent body content here.
```

### Output (`.toml` / Codex format)

```toml
[agent]
name = "diagnostics-analyzer"
description = "Parallel analyzer agent for mutagent-diagnostics"
tools = ["Bash", "Read", "Write"]

[agent.body]
content = """
Agent body content here.
"""
```

### TOML key mapping

| Markdown frontmatter key | TOML key | Type | Notes |
|---|---|---|---|
| `name:` | `[agent] name` | string | Required |
| `description:` | `[agent] description` | string | Required |
| `tools:` | `[agent] tools` | array | Comma-separated → TOML string array |
| Other frontmatter keys | `[agent] <key>` | string | Passed through verbatim |
| Body (after `---`) | `[agent.body] content` | multi-line string | Trimmed |

### Transcode CLI

```bash
bun scripts/cli/run.sh scripts/cli/install-agents.ts \
  --transcode-only --to codex <input.md> <output.toml>
```

`--transcode-only` skips symlink/copy logic and only writes the transcoded file.
`--to codex` selects the TOML output format.

> ⚠️ Verify TOML key names (`[agent]`, `[agent.body]`) against Codex docs before publishing.
> agentskills.io format compatibility is assumed per operator OQ-3 answer — lookup pending.

## Config reference

```
~/.codex/config.toml          # Codex config (confirmed — codex-rs source)
~/.codex/sessions/            # Active sessions (confirmed — codex-rs source)
~/.codex/archived_sessions/   # Archived sessions (confirmed — codex-rs source)
~/.codex/skills/              # Skill install directory (best-effort)
~/.codex/agents/              # Agent install directory (best-effort)
```

## Activation

Codex agents are activated by agent name from within a Codex session:
- Sub-agent dispatch: invoke the agent by its `name` field
- No slash-command equivalent (Codex uses TOML `name` as the identifier)

## CLI install check

> Official Codex CLI docs: https://developers.openai.com/codex/cli
>
> When Codex is the **source** platform, onboarding's ensure-cli gate (PR-021 —
> `references/workflows/onboarding.md` Phase 2) probes for the `codex` binary and,
> if missing, shows these docs + the install command below and **asks for explicit
> approval before installing** (never auto-installs). See also
> `references/source-platforms/codex-transcripts.md`.

```bash
which codex
# Install: npm install -g @openai/codex
# or: curl https://install.codex.openai.com | sh
```

## Upstream docs

- https://developers.openai.com/codex/cli
- https://github.com/openai/codex

## Cross-references

- `references/source-platforms/codex-transcripts.md` — session transcript paths + fetch
- `references/source-platforms/install-paths.md` — install path table (all platforms)
- `references/oq-answers.md` OQ-3 — operator answer + lookup-pending status
- `scripts/cli/install-agents.ts` — transcode CLI implementation
