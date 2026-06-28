# Claude Code Transcripts — Source Platform Reference

> Claude Code stores all sessions as JSONL files at a known path.
> No CLI needed — pure file reads.
> Upstream docs: https://code.claude.com/docs/en/data-usage

## Session path

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

- `<encoded-project-path>`: absolute project path encoded by Claude Code (path separators → hyphens, URL-encoded special chars)
- `<session-id>`: UUID format
- Default retention: `cleanupPeriodDays` setting (30 days by default)
- Format: plaintext JSONL, one event per line

## Discover sessions for this project

```bash
# List all session files for current project
find ~/.claude/projects -name "*.jsonl" -newer /tmp/ref-date -ls

# Find by project path (approximate — encoding varies)
ls ~/.claude/projects/ | grep "$(pwd | sed 's|/|-|g')"
```

`scripts/self-diagnostics/probe.ts` handles the encoding automatically.

## CLI install check

No CLI required. Pure file reads via `Read` or `Bash(cat ...)`.

> Official docs: https://code.claude.com/docs/en/data-usage
>
> The ensure-cli gate (PR-021 — `references/workflows/onboarding.md` Phase 2)
> reports `status: not-required` for this source: there is nothing to install,
> so onboarding links these docs and proceeds directly to file reads.

## Filter/Search Support

See `references/filter-search-matrix.md`. All filtering is file-level or content-grep:
- by session ID: filename matches session UUID
- by time: file `mtime`
- has error: `grep '"isError":true'`
- by skill: `grep '"toolName":"Skill"'`
- full-text: grep over JSONL content

## Normalization

Normalizer: `scripts/normalize/platforms/claude-code.ts`

```bash
# Normalize a session file:
bun scripts/cli/run.sh scripts/normalize/platforms/claude-code.ts < session.jsonl
```
