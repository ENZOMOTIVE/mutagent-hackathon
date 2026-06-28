# Onboarding Workflow — 8 Phases

> Load this when `scripts/setup/detect.ts` returns `state: "missing"` or `state: "partial"`,
> or when `--reconfigure` flag is present.

## Phase map

```
Phase 1: Source platform pick
Phase 2: Source credential + CLI install check
Phase 3: Connectivity probe (informational)
Phase 4: Target platform pick
Phase 5: Target credential + CLI install check
Phase 6: Trigger rules + schedule
Phase 7: Final confirm
Phase 8: First-run pick (diagnose now OR halt)
```

## Platform-native ASK mechanism

| Runtime | ASK method |
|---------|-----------|
| Claude Code | `AskUserQuestion` tool (multi-select, preview attr) |
| Codex | Numbered chat-message multi-choice |
| Cursor | Numbered chat-message multi-choice |
| OpenCode | Numbered chat-message multi-choice |
| Generic | Numbered chat-message multi-choice |

Always use the `ask_tool.native_tool` from config if present. On first run, detect runtime via `scripts/cli/init.ts`.

## Phase 1 — Source Platform

```
Where do your agent traces live? Pick one:

  1. Langfuse (cloud or self-hosted)
  2. OpenTelemetry-compliant endpoint
  3. Local trace file (.jsonl / .ndjson)
  4. Claude Code local transcripts (~/.claude/projects/<encoded>/<session>.jsonl)
  5. Codex local transcripts (~/.codex/sessions/<session>.jsonl)
  6. Other — describe what you have
```

Load `references/source-platforms/{chosen}.md` for CLI operation details.

## Phase 2 — Source Credential + CLI Install (approve-to-install gate, PR-021)

> **Operator rule (Wave-6): NEVER auto-install.** Source platforms are usually
> driven via a CLI during onboarding, and most clients will NOT have it installed.
> Onboarding must (1) link the platform's official CLI docs, and (2) when the CLI
> is missing, OFFER to install it — but the install MUST be checked + approved by
> the user first. There is NO code path that installs a CLI silently/automatically.

**Mechanism** — a reusable `ensure-cli(platform)` helper:
- `scripts/setup/ensure-cli.ts` → `planCliEnsure(platform)` probes PATH (pure read,
  never installs) and returns one of:
  `not-required` (file-only / backend-specific — e.g. local-jsonl, claude-code, otel),
  `present`, `missing-installable`, `missing-no-installer`.
- `scripts/cli/init.ts` → `ensureSourceCli(platform, approve)` drives the gate.

**Steps**

1. Probe the CLI (pure — no install):
   ```bash
   bun scripts/cli/run.sh scripts/setup/detect.ts --cli <platform>
   # → JSON plan: { status, installCommand, docsUrl, approvalRequired }
   ```
2. Show the platform's **official CLI docs link** (from the plan's `docsUrl`, mirrored
   in `references/source-platforms/{platform}.md`). Per-platform links:
   | Platform | Official CLI / tooling docs |
   |---|---|
   | Langfuse | https://langfuse.com/docs/api-and-data-platform/features/cli |
   | OpenTelemetry | https://opentelemetry.io/docs/specs/otlp/ (no single CLI — backend-specific) |
   | Codex | https://developers.openai.com/codex/cli |
   | Claude Code transcripts | https://code.claude.com/docs/en/data-usage (file reads — no CLI) |
   | Local JSONL | file reads — no CLI (see `references/source-platforms/local-jsonl.md`) |
3. **If `status: missing-installable`** → ASK the user before installing, using the
   platform-portable ASK mechanism (same table as Phase 1):
   - **Claude Code**: `AskUserQuestion` — two options, each with a `preview`:
     - `Install <CLI> now` → preview = the exact install command (`pip install langfuse`)
     - `Skip — use REST/file fallback` → preview = the `fallbackNote` from the plan
     Drive `ensureSourceCli(platform, approve)` where `approve` resolves the
     AskUserQuestion result to a boolean.
   - **Codex / Cursor / OpenCode / generic**: chat y/N fallback
     (`promptInstallApprovalChat`, **default NO**), or run:
     ```bash
     bun scripts/cli/run.sh scripts/cli/init.ts --ensure-cli <platform>
     ```
   - **On approve** → the documented install command runs (the ONLY install path).
   - **On decline** → continue with REST/file fallback; record the CLI as absent
     (the `EnsureCliResult.note` is logged into the onboarding transcript).
4. **If `status: missing-no-installer`** (e.g. otel) → surface docs + REST/file
   fallback. Do NOT ask, do NOT install.
5. **If `status: not-required` / `present`** → nothing to install; proceed.
6. Prompt for `credential_ref` key name (for non-file sources).
7. Write to `.mutagentrc` (gitignored).

## Phase 3 — Connectivity Probe (informational)

Test that the source platform is reachable:
```bash
Bash("<source-cli> health --json")  # or platform-equivalent ping
```
Display result to operator. Non-blocking if probe fails (operator may be offline).

## Phase 4 — Target Platform

```
Where do your agent definitions live?

  1. Claude Code agents (.claude/agents/*.md)
  2. Codex agents (.codex/agents/*.md)
  3. Cursor agents (cursor-equivalent dir)
  4. OpenCode agents (opencode-equivalent dir)
  5. Mastra code construct (source code: new Agent({...}))
  6. Anthropic Cloud Agent SDK (source code)
  7. Cloud REST API (HTTP GET/PUT)
  8. Other — describe
```

Load `references/target-platforms/{chosen}.md` for apply recipe.

## Phase 5 — Target Credential + CLI Install

Same pattern as Phase 2. For local targets: confirm git and gh CLI are present. For remote: prompt for `rest_base_url` + `credential_ref`.

## Phase 5b — Verify diagnostics-* agents (non-blocking check — W9-10)

> **W9-10 (lean onboarding):** Agent install is NOT a mandatory onboarding step.
> `pnpx @mutagent/diagnostics init` (i.e. `init --mode init`) is the install path
> and runs before onboarding. Onboarding's job is PLATFORM CONFIG only.
>
> This phase runs `verify-agents` as a non-blocking check:
> - If agents are **ready** → skip silently, proceed to Phase 6.
> - If agents are **missing** → OFFER install (not forced, not default); user may decline.
> - Phase 6 is NOT gated on agents being present — onboarding completes regardless.
>
> **Install scope (W9-fix):** `pnpx @mutagent/diagnostics init` installs PROJECT-LOCAL
> by default — skill + agents land in `<your project>/.claude/` (Claude Code) and
> `<your project>/.codex/` (Codex), i.e. the directory you ran init in. Pass `--global`
> to install into the home dir (`~/.claude`, `~/.codex`) instead. When checking for an
> existing install, project scope looks ONLY at `<project>/.claude/agents` — a global
> `~/.claude/agents` never counts as a project install, so the project install is never
> wrongly skipped. (`verify-agents --scope=project|user` checks one scope at a time.)

```bash
bun scripts/cli/run.sh scripts/setup/verify-agents.ts "$PROJECT_ROOT" [--scope=project|user]
```

**Verify outputs**:
- `analyzer: "ready"|"missing"|"invalid"|"pending-restart"`
- `applyWorker: ...`
- `harnessRestartRequired: boolean`

**Branch on the verify result:**

- **On `ready`** (both agents): skip silently, proceed to Phase 6. No prompt needed.
- **On `missing`** (one or more agents): OFFER install — do not install automatically.
  Ask the operator:
  ```
  diagnostics-* agents are not installed. Install them now?
    1. Yes — install (pnpx @mutagent/diagnostics init --mode install)
    2. No — skip (you can install later with: pnpx @mutagent/diagnostics init)
  ```
  On Yes: run install. On No: record as absent, continue to Phase 6.
  NOTE: If `pnpx init` was already run before onboarding (the recommended path),
  agents should be present and this offer will never appear.
- **On `pending-restart`**: note that a restart is needed after onboarding completes.
  Do NOT halt — continue to Phase 6. Surface the restart reminder in Phase 7.
- **On `invalid`**: offer re-install with `--force`. Non-blocking — continue to Phase 6.

**Integration with cli/init.ts**: `InitDescriptor.agentsBoundary` surfaces the state
after `init --mode init` completes, so the agent can check without re-running verify.

## Phase 6 — Trigger Rules + Schedule

> **⏸ Schedule-mode question is DISABLED for now (v0.1).** Do NOT ask the operator to pick a
> schedule mode — v0.1 is always on-demand. Auto-set `schedule.mode: on-demand` and move on.
> Re-enable this question when scheduling is wired post-v0.1 (see `references/workflows/schedule-prep.md`).
> The `schedule.mode` config field is still written (it just always = `on-demand` for now).

> **⏸ Auto-trigger-rule question is DISABLED for now (operator directive).** Do NOT ask the
> operator to add auto-trigger rules — the skill is **on-demand-only by design** (no cron, no
> auto-fire; invocation is always explicit `/mutagent-diagnostics`), so prompting for trigger
> rules configures something the skill deliberately never uses. Auto-set `trigger_rules: []`
> (the on-demand default) silently and move on. Re-enable this question when scheduled triggers
> are supported post-v0.1 (see `references/workflows/schedule-prep.md`). The `trigger_rules`
> config field is preserved (it just always = `[]` for now).

Note: v0.1 ships `schedule.mode: on-demand` with `trigger_rules: []` (on-demand only). Scheduling + trigger rules wired post-v0.1 per `references/workflows/schedule-prep.md`.

## Phase 7 — Final Confirm

Display summary of all config fields. Ask:
```
Ready to write .mutagent-diagnostics/config.yaml with these settings?
  1. Yes — write config
  2. Go back to Phase N (pick a phase)
  3. Cancel
```

If confirmed: write `config.yaml` (committed, non-secrets) + update `.mutagentrc` (gitignored, secrets).

> **W13-D — `default_audience` (operator directive).** When writing the generated
> `config.yaml`, ALWAYS include `default_audience: client`. A published / client
> install must produce the **client-stripped** report by default; internal is
> opt-in (the operator can flip it to `internal` later, or pass `--audience internal`
> at render time per-run). This is the default emitted by `assets/templates/config.yaml.tpl`.
> The orchestrator threads this value as `--audience <config.default_audience>` at the
> Step-9 render call when the operator gave no explicit flag.
> **Self-diagnosis reports are ALWAYS internal regardless of this field (PR-022).**

> **If diagnostics-* agents were installed** (either via `pnpx init` before onboarding,
> or via the Phase 5b offer), restart your Claude Code session before running diagnostics.
> Claude Code's `subagent_type` registry is loaded once at session boot.
>
> **Fallback cases** (see I-005 — applies when agents cannot activate normally):
> - **Agent not registered**: Session restart required.
> - **Tool grant stripped**: The diagnostics-* agents require specific tool grants
>   (Read, Write, Bash, Agent, etc.) that may be absent in some environments.
>   If tool-grant-stripped, dispatch `subagent_type: general-purpose` with the
>   analyzer instructions inlined into the prompt — see Phase 5b note.
>   Tool grants are configured in `.claude/settings.json` (project) or
>   `~/.claude/settings.json` (user). Add the required grants then restart.
> - **Both cases simultaneously**: Run `scripts/cli/run.sh scripts/setup/verify-agents.ts`
>   — the output distinguishes `"missing"` (not installed) from `"invalid"` (wrong name/frontmatter)
>   and `"pending-restart"` (installed but session not restarted yet).
>
> **Recommended install path (W9-10)**: run `pnpx @mutagent/diagnostics init` BEFORE
> starting onboarding. This installs skill+agents in one step and the restart can
> happen before onboarding begins.

## Phase 8 — First-Run Pick

After config written, emit suggestions:
```
Setup complete! Here are some things to try first:

  1. Diagnose traces from the last 24 hours
  2. Diagnose your most recently failing agent
  3. Diagnose all sessions with negative feedback this week
  4. Diagnose all high-latency sessions
  5. I'll invoke manually later

[Suggestions ranked by likely relevance based on source platform + trigger rules]
```

If operator picks 1-4: proceed to `references/workflows/diagnostics.md`.
If operator picks 5: halt and confirm onboarding complete.
