# Local OpenCode — Target Platform Reference

> Apply target: OpenCode running on the local machine.
> Target class: `local-agent`
> Apply branch: local-agent (read-verify-only; HITL for config changes)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-agent` |
> Mutability | read-verify; HITL via HTML |
| Isolation | N/A (agent config is per-project) |

## How Remedies Are Applied

OpenCode remedies target `opencode.json` / `opencode.toml` configuration files.

1. **Read before write (PR-003)**: read project config before proposing changes
2. **HITL gate (PR-014)**: HTML report + markdown diff; user applies
3. **BG-worktree (PR-004)**: if remedy requires a commit, open a BG-worktree PR

## Config Targets

| File | Purpose |
|------|---------|
| `<project>/opencode.json` | Project-level OpenCode config |
| `<project>/opencode.toml` | Alternative TOML config |
| `~/.opencode/` | Global OpenCode settings |

## Capability Probing

```bash
# Check OpenCode is installed
which opencode

# Check project config
cat opencode.json 2>/dev/null || cat opencode.toml 2>/dev/null

# List sessions (if recorded)
ls ~/.opencode/sessions/ 2>/dev/null
```

## Trace Source

OpenCode session recording format: see `references/harness-knowledge.md` for Platform Knowledge Table entry. Path: TBD per OpenCode version (check harness-knowledge.md OQ-6 status).

## Remedy Categories

- **Config key update**: patch `opencode.json` field (model, timeout, provider)
- **Rule/system-prompt update**: BG-worktree PR for project-scoped prompt changes
- **Provider config**: update API key reference in config (key name only — never the key value)

## Audit

```json
{
  "targetPlatform": "local-opencode",
  "targetClass": "local-agent",
  "remedyType": "config-patch",
  "before": {},
  "after": {},
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```

## Notes

- OpenCode session path confirmation is deferred to a future wave. Session-ingestion for OpenCode traces is not implemented in v0.1. Check `references/harness-knowledge.md` for any updated OpenCode session path entry.
