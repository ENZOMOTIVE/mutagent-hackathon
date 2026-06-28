# Local Claude (Claude Code) — Target Platform Reference

> Apply target: Claude Code running on the local machine.
> Target class: `local-agent`
> Apply branch: local-agent (read-verify-only; no code edits; git BG-worktree for self-diagnostics PRs)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-agent` |
| Mutability | read-verify; HITL via HTML |
| Isolation | N/A (agent runs in its own session) |

## How Remedies Are Applied

Claude Code remedies are **configuration changes**, not code edits.

1. **Read before write (PR-003)**: read `~/.claude/settings.json` (or project `.claude/settings.json`) before proposing edits
2. **HITL gate (PR-014)**: HTML report + markdown remedy proposal rendered; user applies in Claude Code settings UI or confirms before file edit
3. **BG-worktree only (PR-004)**: if remedy involves committing configuration to `.claude/` in the project, a separate worktree branch is opened — no direct main-branch commits

## Config Targets

| File | Purpose |
|------|---------|
| `~/.claude/settings.json` | Global user settings |
| `<project>/.claude/settings.json` | Project-scoped settings |
| `<project>/.claude/skills/` | Installed skill bundles |
| `CLAUDE.md` | Project instructions (human-authored) |

## Capability Probing

```bash
# Check Claude Code is installed
which claude || npx claude --version

# List recent projects
ls ~/.claude/projects/

# Check settings
cat ~/.claude/settings.json 2>/dev/null
```

## Remedy Categories (iter-8 locked)

- **Skill install**: copy skill bundle to `.claude/skills/<skill-name>/`
- **Settings update**: patch `~/.claude/settings.json` key
- **CLAUDE.md addendum**: append or insert a section via PR (BG worktree)
- **Session cleanup**: no automated session cleanup — surfaced as informational finding only

## Audit

Auditor emits `audit.json` + `audit.md` per PR-013. All fields required:
```json
{
  "targetPlatform": "local-claude",
  "targetClass": "local-agent",
  "remedyType": "skill-install",
  "before": {},
  "after": {},
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```
