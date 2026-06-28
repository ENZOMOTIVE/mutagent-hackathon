# team.yaml — afkloop team for {{wave_id}}
# Template extracted from afkloop-mdiag-w2 team.yaml (proven across 5 iterations).
# Consumer renderer fills {{...}} placeholders at install / dispatch time.

team:
  name: {{wave_id}}-iter-{N}
  lifecycle: per-iteration   # TeamCreate at tick start, TeamDelete at tick end

  # ──────────────────────────────────────────────────────────────────────
  # PRE-SPAWN GATE — see spec.yaml dispatch_gate for full rationale
  # ──────────────────────────────────────────────────────────────────────
  pre_spawn_gate:
    skip_for_iterations: [{{grandfather_iterations_csv}}]
    required_files_exist:
      {{#each required_review_files}}
      - {{path_template}}
      {{/each}}
    required_signal_file:
      path: {{approval_flag_path_template}}
      check: test -s
    on_failure: |
      REFUSE TeamCreate AND any Agent() spawn for iter-{N}. Print error,
      surface paths to operator, await re-invocation after approval.
      ABORT cascades up to the parent orchestrator — do NOT silently
      proceed. Do NOT improvise around the gate.

  actor:
    type: {{actor_agent_type}}
    scope:
      {{#each actor_scope_globs}}
      - {{glob}}
      {{/each}}
    forbidden_paths:
      - .github/workflows/**     # infra changes deferred to end-of-wave PR
      - Dockerfile**
      - tsconfig*.json
      - bunfig.toml
      - .claude/settings.local.json   # operator-owned on root
      {{#each additional_forbidden_paths}}
      - {{glob}}
      {{/each}}
    prompt: |
      You are the Actor for {{wave_id}} iteration {N}{{actor_phase_suffix}}.

      MANDATORY PRE-READ:
        cat {{handover_path_template}}

      This handover contains:
        - The {{phase_descriptor}} scope (your task)
        - Skill operational contracts (relevant SKILL.md + workflow refs) inlined
        - Per-remedy acceptance commands
        - Known gotchas
        - Drift from prior iterations + rediscovery promotions
        - Scope envelope + forbidden paths

      Internalize handover BEFORE editing. Then:
        1. Implement remedies in handover-specified order (within-phase deps)
        2. ONE commit per remedy, message prefixed with remedy ID
        3. Run acceptance commands LOCALLY before pushing
        4. Push to {{branch}}
        5. Emit checkpoints at: plan internalized, first commit pushed, all commits done, acceptance run

      Hard constraints:
        - Do NOT merge to main
        - Do NOT touch forbidden_paths
        - Do NOT skip pre-commit hooks (--no-verify FORBIDDEN per feedback_correctness_discipline)
        - On Verifier SendMessage with binding steering — comply

      {{additional_actor_constraints}}

      On phase complete: post PR Final-Status comment per feedback_pr_final_status_comment.md.

  verifier:
    type: {{verifier_agent_type}}
    role: live-steering-observer + handover-saturation-auditor
    ground_truth_sources:
      {{#each verifier_ground_truth_sources}}
      - {{source}}
      {{/each}}
    prompt: |
      You are the Verifier for {{wave_id}} iteration {N}.
      You do NOT execute the implementation.

      VERIFIER CONTEXT INVERSION — you receive the SUPERSET of Actor's brief:
        - Full iter-{N}-handover.md (same as Actor)
        - All skill operational contracts (SKILL.md + workflow refs)
        - prior_session_artifacts catalog (so you can cross-reference)
        - known_gotchas catalog (so you can pre-empt rediscovery)
        - Verifier-only ground-truth probes (do NOT run as Actor's behalf)

      GOAL (this iteration): {{verifier_goal_summary}}.
      Hard gates: scope envelope, forbidden_paths, no-merge-to-main, no --no-verify.

      {{additional_verifier_invariants}}

      Monitor Actor's task output. On each checkpoint:
        - Read Actor's stated plan + diff so far
        - Cross-check against handover-inlined contracts
        - Check scope compliance (in scope + not forbidden)
        - Check drift from THIS phase's remedy IDs
        - Decide: PROCEED (silent) | STEER (SendMessage Actor) | ABORT (SendMessage Orchestrator)

      Steering messages must be SPECIFIC + REASONED + MINIMAL.
      Drift in ≥3 dimensions = ABORT not STEER (per anti-pattern table).

      On iteration end, list REDISCOVERY EVENTS (Actor probed --help / introspection
      / trial-and-error that should have been in handover). These get promoted into
      iter-{N+1}-handover.md known_gotchas. Loop converges toward zero rediscovery
      per iteration.

      Final verdict: PASS | RETRY | ABORT.
      On PASS — confirm phase Final-Status comment is accurate before authorizing
      pause-for-dogfood.

per_phase_overrides:
  {{#each per_phase_overrides}}
  {{iter_label}}:
    phase: {{phase_letter}}
    remedies: [{{remedies_csv}}]
    risk_pill: {{risk_pill_class}}
    estimated_hours: {{estimated_hours}}
    acceptance:
      {{#each acceptance_commands}}
      - {{cmd}}
      {{/each}}
    {{optional_phase_notes}}
  {{/each}}
