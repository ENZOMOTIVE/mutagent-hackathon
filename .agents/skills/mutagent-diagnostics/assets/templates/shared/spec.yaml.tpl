# spec.yaml — afkloop spec for {{wave_id}}
# Template extracted from afkloop-mdiag-w2 spec.yaml (proven across 5 iterations).
# Consumer renderer fills {{...}} placeholders at install / dispatch time.

afkloop_id: {{wave_id}}
intent: |
  {{wave_intent_paragraph}}

scope:
  files:
    {{#each scope_files}}
    - {{path_glob}}
    {{/each}}
  repos: [{{repos_csv}}]
  worktree_path: {{worktree_path}}
  branch: {{branch}}
  pr_trunk: {{pr_trunk_number}}

goal_condition:
  type: observable
  predicate: |
    {{goal_predicate}}
  probe_interval: {{probe_interval}}

termination_gates:
  max_iterations: {{max_iterations}}
  max_wallclock_minutes: {{max_wallclock_minutes}}
  max_consecutive_failures: {{max_consecutive_failures}}
  max_tokens_spent: {{max_tokens_spent}}
  on_scope_creep: abort
  on_phase_complete: {{on_phase_complete_action}}

# ────────────────────────────────────────────────────────────────────────────
# DISPATCH GATE — hard pre-spawn check
# ────────────────────────────────────────────────────────────────────────────
# NO TeamCreate, NO Agent() spawn may proceed for iteration N without
# operator-approved review artifacts present + an approval signal file on
# disk. iter-1 of each wave MAY be grandfathered per `precedent_record`.
dispatch_gate:
  scope: {{dispatch_gate_scope}}
  required_artifacts_before_dispatch:
    {{#each required_dashboard_artifacts}}
    - path: {{path}}
      semantics: {{semantics}}
    {{/each}}
  required_signal_file:
    path: {{approval_flag_path_template}}
    semantics: |
      Created ONLY by operator via clipboard-export from the iter-N dashboard
      lockin block (LOCK / REVISE / HOLD / DROP radios + decision textarea).
      Orchestrator MUST verify file exists + has non-zero size before any
      Agent() / TeamCreate call.
  enforcement:
    mode: refuse_spawn_with_message
    error_message: |
      Iteration <N> requires operator-approved review artifacts + the
      iter-<N>-approved.flag signal file. Dispatch REFUSED. Operator must
      review the rendered artifacts and clipboard-export their decision.
  precedent_record:
    {{#each precedent_records}}
    {{iter_label}}: |
      {{precedent_text}}
    {{/each}}

iteration_contract:
  inputs:
    {{#each iteration_inputs}}
    - {{description}}
    {{/each}}
  one_tick_does: |
    {{one_tick_does_paragraph}}

  deliverables:
    code_artifacts:
      {{#each code_artifacts}}
      - "{{artifact}}"
      {{/each}}
    design_review_artifacts:
      {{#each design_review_artifacts}}
      {{key}}:
        path: {{path}}
        purpose: |
          {{purpose}}
      {{/each}}

agent_team:
  actor:
    subagent_type: {{actor_subagent_type}}
    prompt_template: |
      MANDATORY PRE-READ:
        cat {{handover_path_template}}
      {{actor_prompt_body}}
  verifier:
    subagent_type: {{verifier_subagent_type}}
    role: {{verifier_role}}
    watches:
      {{#each verifier_watch_sources}}
      - {{source}}
      {{/each}}
    can_inject: [course-correct, abort, escalate-to-user]

live_steering_protocol:
  mode: checkpoint
  checkpoint_triggers:
    {{#each checkpoint_triggers}}
    - {{trigger}}
    {{/each}}

observability:
  tasklist_prefix: "[{{wave_id}}]"
  per_iter_log: {{per_iter_log_path_template}}
  per_iter_handover: {{per_iter_handover_path_template}}
  views_anchor:
    {{#each views_anchors}}
    {{key}}: {{path}}
    {{/each}}

exit_behavior:
  on_success: |
    {{on_success_text}}
  on_gate_hit: |
    {{on_gate_hit_text}}
  on_user_interrupt: |
    {{on_user_interrupt_text}}
  on_phase_complete: |
    {{on_phase_complete_text}}

skill_handover:
  parent_skills:
    {{#each parent_skills}}
    - {{skill_name}}
    {{/each}}
  inline_files:
    # Pulled into iter-N-handover.md verbatim at Phase 1.5
    {{#each inline_files}}
    - {{path}}
    {{/each}}
  handover_doc: {{handover_doc_path_template}}

prior_session_artifacts:
  {{#each prior_session_artifacts}}
  - path: {{path}}
    description: {{description}}
  {{/each}}

known_gotchas:
  {{#each known_gotchas}}
  - id: {{id}}
    description: {{description}}
    workaround: {{workaround}}
    source: {{source}}
  {{/each}}
