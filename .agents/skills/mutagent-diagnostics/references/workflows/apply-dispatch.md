# Apply Dispatch Workflow

> Three target classes (iter-8). Load the correct branch per `target_spec.mode` + `target_spec.platform`.

## Dispatch pattern

Orchestrator always spawns `diagnostics-apply-worker` as a BG agent on a Worktree:
```
Agent({
  subagent_type: 'diagnostics-apply-worker',
  run_in_background: true,
  isolation: 'worktree',
  prompt: JSON.stringify({ approved_remedies, target_spec, diagnosed_at_hash })
})
```

The apply-worker operates in `.worktrees/mutagent-diagnostics-{timestamp}/`. The operator's current branch is never touched (PR-004).

---

## Branch 1 — local-agent (markdown .md files)

Platforms: `local-claude`, `local-codex`, `local-cursor`, `local-opencode`

```
1. git worktree add .worktrees/mutagent-diagnostics-{ts}/ origin/main
2. stale-detector.ts: compare diagnosed_at_hash vs current HEAD
   → if stale: surface to orchestrator (offer re-diagnose | apply-anyway | cancel)
3. Edit target .md file in worktree:
   - For YAML frontmatter changes: target specific field
   - For Markdown body changes: target specific section
4. Fill pr-body.md.tpl from assets/templates/
5. git -C .worktrees/{ts} add .
6. git -C .worktrees/{ts} commit -m "Diagnostics: {auto-summary}"
7. git -C .worktrees/{ts} push origin mutagent/{type}-{agent}-{date}
8. gh pr create --title "[mutagent-diagnostics] {auto-summary}" --body-file pr-body.md
9. Write audit.json + audit.md from templates
10. Report PR URL to orchestrator
```

Branch naming: `mutagent/<diagnostic-type>-<agent-id>-<date>` (from iter-2 C2 lock).

---

## Branch 2 — local-code-construct (JS/TS/Python source — iter-8)

Platforms: `local-mastra`, `local-cloud-agent-sdk`

```
1. git worktree add .worktrees/mutagent-diagnostics-{ts}/ origin/main
2. stale-detector.ts: stale check
3. Read source file (e.g., src/agents/search.ts)
4. Identify agent definition:
   - Mastra: new Agent({ name: '...', instructions: '...' })
   - Cloud Agent SDK: Agent({ ... })
5. Apply remedy.diff.before → remedy.diff.after as targeted string edit
   (preserve surrounding code structure — be surgical)
6. Run lint + typecheck inside worktree:
   Bash("cd .worktrees/{ts} && bun run lint || true && bun run typecheck")
   → If lint/typecheck fails: skip this remedy, surface error to orchestrator
7. Commit + push + gh pr create (same as Branch 1)
8. Audit emit
```

---

## Branch 3 — remote (cloud REST)

```
1. Read-before-write GET:
   curl -s -H "Authorization: Bearer $TOKEN" {rest_base_url}/agents/{agentId}
2. stale-detector.ts: compare diagnosed_at_hash vs current_hash from GET response
3. Compute dry-run diff (proposed vs current)
4. Show diff to operator via orchestrator
5. uuidgen for idempotency key
6. PUT:
   curl -X PUT -H "Idempotency-Key: {key}" -H "Content-Type: application/json" \
     -d @payload.json {rest_base_url}/agents/{agentId}
7. On 5xx: retry once with same idempotency key
8. On persistent failure: escalate to operator
9. Audit emit (local file only — no PR for remote applies)
```

---

## Audit emit (all branches)

Always write dual-emit audit (PR-013):
- `assets/templates/audit.json.tpl` → `.mutagent-diagnostics/audit/{session}/audit.json`
- `assets/templates/audit.md.tpl` → `.mutagent-diagnostics/audit/{session}/audit.md`

For non-code targets (remote): audit files are the ONLY trail (no PR).

---

## Stale detection decision tree

```
stale-detector.ts returns stale: true
  ↓
Surface to orchestrator
  ↓
Orchestrator presents to operator:
  1. Re-diagnose from latest target state
  2. Apply anyway (force — operator accepts stale risk)
  3. Cancel

If option 2 selected: continue apply with stale flag set in audit
```
