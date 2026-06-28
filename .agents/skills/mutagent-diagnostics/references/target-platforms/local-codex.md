# Local Codex — Target Platform Reference

> Apply target: OpenAI Codex CLI running on the local machine.
> Target class: `local-agent`
> Apply branch: local-agent (read-verify-only; HITL for config changes)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-agent` |
| Mutability | read-verify; HITL via HTML |
| Isolation | N/A (agent runs in its own session) |

## How Remedies Are Applied

Codex CLI remedies are primarily **configuration changes** (`~/.codex/config.toml`).

1. **Read before write (PR-003)**: read `~/.codex/config.toml` before proposing edits
2. **HITL gate (PR-014)**: HTML report + markdown remedy; user applies via TOML edit or CLI command
3. **Ephemeral mode**: suggest `codex exec --ephemeral` when sessions should not be recorded

## Config Targets

| File | Purpose |
|------|---------|
| `~/.codex/config.toml` | Main Codex CLI config |
| `~/.codex/sessions/` | Active session recordings (read-only diagnostic source) |
| `~/.codex/archived_sessions/` | Archived sessions (read-only) |

## Capability Probing

```bash
# Check Codex CLI is installed
which codex

# Check config
cat ~/.codex/config.toml 2>/dev/null

# Session count
ls ~/.codex/sessions/ | wc -l
ls ~/.codex/archived_sessions/ | wc -l
```

## Remedy Categories (iter-8 locked)

- **Config patch**: update `~/.codex/config.toml` key (model, provider, timeout)
- **Session management guidance**: informational only; no automated session deletion
- **Ephemeral mode recommendation**: when session recording is contributing to noise

## Audit

```json
{
  "targetPlatform": "local-codex",
  "targetClass": "local-agent",
  "remedyType": "config-patch",
  "before": { "key": "model", "value": "old-model" },
  "after": { "key": "model", "value": "new-model" },
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```

## Session Path Constants (confirmed iter-8)

```
Active:   ~/.codex/sessions/<session>.jsonl
Archived: ~/.codex/archived_sessions/<session>.jsonl
Config:   ~/.codex/config.toml
Source:   codex-rs/rollout/src/lib.rs
```
