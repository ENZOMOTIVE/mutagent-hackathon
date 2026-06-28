# Platform Knowledge Table

> Expandable table. Static info ships with the skill.
> Runtime details (latest CLI flags, current API endpoints) recovered via the linked upstream docs.
> Add new harnesses by submitting a PR to this file.

| Harness | Transcript path (static) | ASK primitive | Schedule primitive | Upstream docs |
|---------|--------------------------|---------------|-------------------|---------------|
| **Claude Code** | `~/.claude/projects/<encoded-path>/<session-id>.jsonl` (plaintext JSONL; 30-day default retention via `cleanupPeriodDays`) | `AskUserQuestion` tool — structured multi-select, `preview` attr for code/diff comparisons. Native. | Native `/loop` + `CronCreate` + `ScheduleWakeup` tools. | [code.claude.com/docs](https://code.claude.com/docs/en/) |
| **Codex CLI** | `~/.codex/sessions/<session>.jsonl` (active) + `~/.codex/archived_sessions/<session>.jsonl` (archived). Config: `~/.codex/config.toml`. Constants `SESSIONS_SUBDIR="sessions"` + `ARCHIVED_SESSIONS_SUBDIR="archived_sessions"` in `codex-rs/rollout/src/lib.rs`. Default-on; suppress with `codex exec --ephemeral`. | Approval prompts via TUI (Windows toast fallback). No structured-picker tool primitive yet — chat-based multi-choice. | External cron + `codex exec` for non-interactive runs. No native scheduler. | [developers.openai.com/codex](https://developers.openai.com/codex/cli) · [codex-rs/rollout source](https://github.com/openai/codex/tree/main/codex-rs/rollout) |
| **Cursor** | Local SQLite under VSCode-style workspace storage (e.g. `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb` on macOS). Verify at runtime via probe. | Chat-based confirmation. No public structured-picker tool surfaced. | Background Agents (2025+) — autonomous task primitive; verify scheduling support at runtime. | [cursor.com/docs](https://cursor.com/docs) |
| **OpenCode** | Path TBD — runtime probe at onboarding. | Chat-based (Plan mode + general prompting). | None documented — use OS cron. | [opencode.ai/docs](https://opencode.ai/docs) |
| *Add more harnesses here* | *operator adds rows over time* | | | |

---

## Notes

- **Encoding of Claude Code project paths**: Claude Code encodes the absolute project path into the directory name under `~/.claude/projects/`. The encoding is an internal detail — `cli/init.ts` probes by trying known encodings and falls back to listing all project dirs.
- **Codex paths confirmed iter-8**: path confirmed from `codex-rs/rollout/src/lib.rs` source constants. If paths change in a future Codex release, update this table and `scripts/normalize/platforms/codex.ts`.
- **Semantic search**: not supported on any harness in v0.1.
- **Schedule recovery**: platform scheduling specifics (exact API, cron syntax, daemon setup) are recovered at runtime by the agent via the upstream docs links above. This table stores only static facts.
