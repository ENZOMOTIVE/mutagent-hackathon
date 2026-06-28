# Install Paths — Per-Platform Reference

> Per-platform install locations for the `mutagent-diagnostics` skill binding and agent files.
> Used by `scripts/cli/init.ts` (`pnpx @mutagent/diagnostics init`) to determine where to
> install on each detected platform.

## Detection + Install Table

| Platform | Detection marker | Skill path | Agents path | Binding format |
|---|---|---|---|---|
| Claude Code | `~/.claude/` exists | `~/.claude/skills/mutagent-diagnostics/` | `~/.claude/agents/` | `.md` |
| Codex | `~/.codex/` exists | `~/.codex/skills/mutagent-diagnostics/` | `~/.codex/agents/` | `.toml` |
| Cursor | `.cursor/` in CWD exists | `.cursor/rules/` (project-scoped) | n/a (no agent primitive yet) | `.mdc` |

## Notes

### Claude Code

- Detection: `~/.claude/` directory presence (filesystem probe — not env var).
- Skill: full skill directory copied to `~/.claude/skills/mutagent-diagnostics/`.
- Agents: `assets/agents/*.md` symlinked (or copied) to `~/.claude/agents/`.
  Use `scripts/cli/install-agents.ts --scope=user` for user-scope install.
- **Session restart required** after install: the `subagent_type` registry caches at boot.

### Codex

- Detection: `~/.codex/` directory presence.
- Skill: full skill directory copied to `~/.codex/skills/mutagent-diagnostics/`.
- Agents: `assets/agents/*.md` **transcoded** `.md → .toml` (YAML frontmatter → `[agent]` TOML block)
  and written to `~/.codex/agents/`.
  Use `scripts/cli/install-agents.ts --transcode-only --to codex <input.md> <output.toml>`.
- See `references/source-platforms/codex.md` for the full TOML format spec.

### Cursor

- Detection: `.cursor/` directory in the **current working directory** (project-scoped; no
  user-global `~/.cursor/` detection implemented in v0.1).
- Skill: skill rules copied to `.cursor/rules/mutagent-diagnostics.mdc` (project-scoped).
- Agents: **no agent primitive** on Cursor yet.
- See `references/target-platforms/local-cursor.md` (Binding Surface & Install Path) for current Cursor binding state and TODO. (Cursor is an apply target, not a trace source — PR-016.)

## Path resolution rules

- All `~/` prefixes resolve via `os.homedir()` at runtime — never hardcoded `~` expansion.
- CWD-relative paths (Cursor) resolve from `process.cwd()` at install time.
- Idempotent: re-running `pnpx @mutagent/diagnostics init` on an already-installed path is safe.
  Existing files are not clobbered unless `--force` is passed.

## Per-platform trigger / activation

| Platform | How to invoke mutagent-diagnostics after install |
|---|---|
| Claude Code | Slash command `/mutagent-diagnostics` OR natural language "diagnose my agents" |
| Codex | Invoke agent by name from Codex session (agent primitive in `~/.codex/agents/`) |
| Cursor | `.mdc` rule injected as a Cursor Background Agents rule (TBD — see `target-platforms/local-cursor.md`) |

See also: `SKILL.md §1 — Triggers` for the canonical natural-language activation list.
