# Adapter Strategy — Q1-Q6 Locked Decisions

> All Q1-Q6 → Option A. Locked iter-5. See decisions-log.md for operator verbatim answers.

## Q1 — Per-platform reference docs

**Decision**: Per-platform reference doc + ONE normalization script per source.

Each source platform has:
- `references/source-platforms/<name>.md` — CLI operation manual + filter examples + credential setup + hyperlinks
- `scripts/normalize/platforms/<name>.ts` — Platform JSON → canonical TraceBody shape

Custom platforms: drop a new reference doc + normalize.ts. The orchestrator discovers it from config.yaml `source.platform`.

## Q2 — Normalization in script

**Decision**: Normalization is deterministic mapping in a TypeScript script.

The normalize scripts are Type A (pure, no LLM, no I/O). They receive raw platform JSON and emit canonical `TraceBody`. This makes normalization testable, reproducible, and cost-free.

The agent NEVER interprets raw platform JSON directly — it always reads via the normalized shape.

## Q3 — CLI install detection at onboarding

**Decision**: CLI install detection at onboarding via `Bash(which <cli>)` + AskUserQuestion install prompt if missing.

Trigger: operator picks a source/target platform during onboarding. Agent immediately checks:
```bash
Bash("which langfuse") # or equivalent
```
If missing, prompt with the install command from the per-platform reference doc.
Do NOT proceed with that platform until CLI is confirmed present.

## Q4 — Target apply: pure agent operations

**Decision**: Target applies are pure agent operations (Bash git/gh + Bash curl).

No TypeScript wrapper scripts for apply. The apply-worker agent uses:
- `Bash(git worktree add ...)` + `Bash(git commit ...)` + `Bash(gh pr create ...)` for local targets
- `Bash(curl PUT ...)` for remote targets

Scripts handle deterministic preparation (stale-detect, pr-body fill); agent handles the write operations.

## Q5 — Idempotency via uuidgen

**Decision**: `Bash(uuidgen)` generates the idempotency key for REST writes.

Every remote PUT includes `Idempotency-Key: {uuid}`. Same key on retry → server ignores duplicate. Retry on 5xx (max 2 attempts). Escalate to operator on persistent failure.

## Q6 — Custom platform extensibility

**Decision**: Custom platform onboarding = drop new reference doc + normalize.ts.

No plugin registry or config DSL. To add a new source platform:
1. Add `references/source-platforms/<new-platform>.md` with CLI operation manual + hyperlinks
2. Add `scripts/normalize/platforms/<new-platform>.ts` implementing `normalize<Platform>File(content: string): TraceBody`
3. Update `scripts/config/schema.ts` to include the new platform literal

The orchestrator reads `source.platform` from config and looks up the reference doc by convention.

---

## Filter vs Search distinction

| Term | What it is | Maps to |
|------|-----------|---------|
| **Filter** | Narrowing on trace metadata (agent ID, time, score, error flag, tags) | Native CLI `--flag` arguments |
| **Search** | Additional categorization on top of filter (full-text, semantic, by content match) | Additional API call OR client-side post-filter |

Master Filter/Search Coverage Matrix: `filter-search-matrix.md`

For unknown platforms: agent does runtime CLI docs lookup — `Bash(<cli> --help)` + WebFetch upstream docs — and reasons over the help text to map dimensions.
