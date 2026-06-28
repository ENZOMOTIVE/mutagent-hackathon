# Local Cursor — Target Platform Reference

> Apply target: Cursor IDE running on the local machine.
> Target class: `local-agent`
> Apply branch: local-agent (read-verify-only; HITL for rule changes)
>
> **Note (PR-016):** Cursor is an apply **target** only (`local-cursor`), NOT a trace source —
> it ships no `SourcePlatform` enum entry and no `normalize/platforms/cursor.ts`. The binding-surface
> research formerly held in `references/source-platforms/cursor.md` (a phantom source-platform doc)
> was folded here in the 2026-06 drift-fix; see "Binding Surface & Install Path" below.

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `local-agent` |
| Mutability | read-verify; HITL for `.cursorrules` edits |
| Isolation | N/A (IDE rules are per-workspace) |

## How Remedies Are Applied

Cursor remedies target `.cursorrules` files and Cursor-specific settings.

1. **Read before write (PR-003)**: read `.cursorrules` at workspace root before proposing changes
2. **HITL gate (PR-014)**: HTML report + markdown diff of rule changes; user applies in Cursor UI or manually edits `.cursorrules`
3. **BG-worktree for `.cursorrules` (PR-004)**: if remedy requires committing `.cursorrules` change, open a BG-worktree PR

## Config Targets

| File | Purpose |
|------|---------|
| `<workspace>/.cursorrules` | Workspace-scoped AI rules |
| `~/.cursor/settings.json` | Global Cursor settings |
| `<workspace>/.cursor/` | Per-workspace Cursor config |

## Capability Probing

```bash
# Check Cursor is installed
ls /Applications/Cursor.app 2>/dev/null || which cursor

# Check workspace rules
cat .cursorrules 2>/dev/null

# Check global settings
cat ~/.cursor/settings.json 2>/dev/null
```

## Session/Trace Source

Cursor does not produce structured trace JSONL files by default. Diagnostics via:
- OTel if Cursor Background Agents are configured with tracing export
- Manual session exports if available

## Remedy Categories

- **`.cursorrules` update**: append or replace rule sections via PR (BG worktree)
- **Settings recommendation**: informational; user applies in Cursor UI
- **Background Agent config**: update Background Agent settings (post-v0.1 scheduling)

## Audit

```json
{
  "targetPlatform": "local-cursor",
  "targetClass": "local-agent",
  "remedyType": "cursorrules-patch",
  "before": "...",
  "after": "...",
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```

## Binding Surface & Install Path (OQ-4 — lookup pending)

> Folded from the retired `references/source-platforms/cursor.md` (2026-06 drift-fix). Cursor binding
> is DEFERRED pending an authoritative docs lookup; these are best-effort research notes.

Candidate binding surfaces identified prior to authoritative-docs confirmation:

| Surface | Status | Notes |
|---|---|---|
| `.cursorrules` (root-level) | Deprecated in newer Cursor versions | Flat rules file; no per-agent dispatch; legacy |
| `.cursor/rules/*.mdc` | **Likely correct for recent Cursor** | Project-scoped MDC rules; supports metadata frontmatter |
| Cursor Background Agents | Separate cloud product | Different from local rule binding; requires Cursor subscription |

**Provisional recommendation:** use `.cursor/rules/*.mdc` for project-scoped binding.
Install path: `.cursor/rules/mutagent-diagnostics.mdc` (created in the user's project directory).

**Detection marker** — `init.ts` detects Cursor by probing for a `.cursor/` directory in the
**current working directory** (`existsSync(join(process.cwd(), ".cursor"))`); no user-global
`~/.cursor/` detection yet.

**MDC format (provisional)** — Markdown + Cursor-specific frontmatter keys (`description`, `globs`,
`alwaysApply`); the skill's SKILL.md content is adapted into the `.mdc` body.

**Agent primitive** — none on Cursor yet; `init.ts` installs the skill rule only (no agent files).

**TODO (OQ-4 / OQ-7):** WebFetch Cursor docs to confirm the binding surface (`.cursorrules` vs
`.cursor/rules/*.mdc`), determine the user-scope install location, verify MDC frontmatter keys, and
add a Cursor transcript fetcher when the OQ-7 fetcher-extensibility design is resolved.

Upstream docs: https://cursor.com/docs (search "rules", "background agents", ".cursorrules").

## Post-v0.1 Scheduling

Cursor Background Agents support `cron`-style scheduling. See `references/workflows/schedule-prep.md` for the post-v0.1 schedule integration plan.
