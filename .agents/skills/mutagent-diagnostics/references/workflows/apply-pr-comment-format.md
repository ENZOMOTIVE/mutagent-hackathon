# Diagnostic Apply PR Comment Format

> Authority: PR-023 (v0.3+).
> Applies to: every PR opened by `diagnostics-apply-worker` after applying operator-approved remedies.
>
> Pre-release note: no backwards-compat constraints. Streamroll updates permitted until v1.0.

---

## MANDATORY Closing PR Comment

Every PR opened by `diagnostics-apply-worker` MUST include a closing "Final Status" comment
BEFORE requesting review. The comment MUST contain all sections below.

**Why**: creates an auditable record linking the applied change back to the diagnostic session,
approved remedy payload, and verification result. The operator uses this comment to triage
PRs across multiple parallel apply runs.

---

## Comment Template

```markdown
## Diagnostic Apply — Final Status

### Decisions + WHYs

| Decision | Choice | Why |
|----------|--------|-----|
| Remedy applied | <remedyId> — <title> | Operator-approved via copy-back at <diagnosedAt> |
| Target | <targetClass> at <file:line> | From ActionablePlan.files[] |
| Diff scope | <N lines> | Minimal change per PR-004 (branch hygiene) |

### Verification Log

```
<paste of verify[] commands + output>
```

Acceptance criterion: <ActionablePlan.acceptance>
Result: PASS / FAIL

### Run-Tag References

- runId: <runId from run-meta.json>
- tags: <tags from run-meta.json>
- diagnosedAt: <ISO timestamp>
- sourcePlatform: <platform>
- sessionId: <sessionId>

### Backwards-compat Note

Pre-release (v0.1–v0.5): streamroll updates permitted. No migration scripts required.
First production release will add a migration note here.

### Linked Finding

Finding ID: <findingId>
Failure origin: WHAT=<what> · WHY=<why> · WHERE=<where>
Evidence: <evidence pointer from failureOrigin.evidence>
```

---

## Enforcement

- The `diagnostics-apply-worker` agent MUST post this comment before calling `gh pr create`.
- If `run-meta.json` does not exist for the session (legacy run before v0.3), omit the
  Run-Tag References section and note: "run-meta unavailable (pre-v0.3 run)".
- The `acceptance` field in ActionablePlan is the contract. If verification fails, the PR
  MUST be marked as draft and the operator notified before requesting review.
- Do NOT reference the operator's local `feedback_pr_final_status_comment` memory rule —
  this format is the skill's own, portable across any project using mutagent-diagnostics.

---

## Related

- `references/principles.md` — PR-023 (Clipboard payloads = self-contained actionable plans)
- `scripts/report/persist-selections.ts` — persists operator-selections.json
- `scripts/run/session.ts` — run-meta.json generation
- `assets/agents/diagnostics-apply-worker.md` — apply-worker agent definition
