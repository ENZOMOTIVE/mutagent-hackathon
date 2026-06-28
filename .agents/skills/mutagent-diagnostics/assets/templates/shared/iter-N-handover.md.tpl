# iter-{{N}}-handover.md — {{wave_id}} {{phase_label}}

> **MANDATORY PRE-READ** for Actor + Verifier of `{{wave_id}}-iter-{{N}}`.
> Pre-staged during autonomous burn. Read in entirety BEFORE editing.

---

## §0 — One-line summary

{{summary_one_liner}}

> **Predecessor**: {{predecessor_ref}}.

---

## §1 — Environment + Hard constraints

| Setting | Value |
|---|---|
| **Worktree path** | `{{worktree_path}}` |
| **Branch** | `{{branch}}` |
| **Trunk PR** | {{trunk_pr_ref}} — OPEN, do NOT merge to main |
| **Baseline HEAD** | `{{baseline_sha}}` ({{baseline_note}}) |

**Hard constraints (UNCHANGED):**
- ❌ Do NOT merge to `main`.
- ❌ Do NOT touch `.github/workflows/`, `Dockerfile`, `tsconfig*.json`, `bunfig.toml`, root checkout.
- ❌ Do NOT skip pre-commit hooks (`--no-verify` FORBIDDEN per `feedback_correctness_discipline`).
- ❌ Do NOT add `process.env.DISABLE_*` / `ENABLE_*` rollback knobs.
{{additional_hard_constraints}}

---

## §2 — In-scope work

{{in_scope_table_or_prose}}

---

## §3 — Cross-dependency callout

{{cross_dep_callout}}

---

## §4 — Within-phase ordering (suggested)

{{ordering_steps}}

---

## §5 — Acceptance commands

```bash
{{acceptance_commands}}
```

---

## §6 — Final-Status PR comment (template Actor fills + posts)

```markdown
## 🏁 {{phase_label}} — Final Status

### Decisions table

| Decision | Choice | WHY |
|---|---|---|
{{decisions_table_rows}}

### Commit chain

{{commit_chain_summary}}

### Status

{{final_status_summary}}

**DO NOT merge {{trunk_pr_ref}} to main** until operator green-lights.
```

---

## §7 — Verifier-only ground-truth probes

```bash
{{verifier_probes}}
```

---

## §8 — Known gotchas

{{known_gotchas_table}}

### Carried forward (from prior iterations)

{{carried_forward_gotchas}}

---

## §9 — Memory rules in force

{{memory_rules_list}}

---

## §10 — Exit criteria (PASS)

All of:
{{exit_criteria_bullets}}

On PASS → {{on_pass_next_step}}.

---

## §11 — Failure modes

| Symptom | Verdict |
|---|---|
{{failure_modes_table_rows}}

---

End of iter-{{N}}-handover.md. After this iteration: {{post_iter_next_action}}.
