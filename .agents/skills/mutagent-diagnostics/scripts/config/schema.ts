/**
 * scripts/config/schema.ts
 * TypeBox schema for .mutagent-diagnostics/config.yaml — SINGLE SOURCE OF TRUTH (PR-009)
 * Type A — Pure Script (deterministic schema definition)
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

// ── Source platform ──────────────────────────────────────────────────────────

export const SourcePlatformSchema = Type.Union([
  Type.Literal("langfuse"),
  Type.Literal("otel"),
  Type.Literal("local-jsonl"),
  Type.Literal("claude-code"),
  Type.Literal("codex"),
]);

/**
 * PRD-SO-03: Enum-constrained format values (Q9 — yes, enum-constrain).
 * Used by source.format to hint the normalizer which shape to expect.
 */
export const SourceFormatSchema = Type.Union([
  Type.Literal("langfuse-export"),
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("raw"),
]);

export const SourceConfigSchema = Type.Object({
  /** Source platform identifier */
  platform: SourcePlatformSchema,
  /** Endpoint URL. Empty = use default CLI auth / env vars; set for self-hosted */
  endpoint: Type.Optional(Type.String({ default: "" })),
  /** Key name in .mutagentrc for the source API secret (never store value here) */
  credential_ref: Type.Optional(Type.String()),
  /**
   * PRD-SO-03: One or more local file paths (glob or exact) for local-jsonl or
   * langfuse-export sources. Exactly-one constraint with endpoint (Q8 — yes):
   * set paths for file-based ingestion; set endpoint for API-based ingestion.
   * Examples: ["traces/agent-logs.ndjson.gz", "traces/2026-06/*.jsonl"]
   */
  paths: Type.Optional(Type.Array(Type.String())),
  /**
   * PRD-SO-03: Explicit format hint for the per-platform normalizer.
   * When absent the normalizer auto-detects from platform + file extension heuristic.
   * Use "langfuse-export" for Langfuse NDJSON exports, "raw" for unknown shapes.
   */
  format: Type.Optional(SourceFormatSchema),
  /**
   * PRD-SO-03: Custom JSON field name that identifies the agent in a trace record.
   * Default varies by platform (Langfuse uses "name"; local-jsonl uses "agentId").
   * Override when your trace schema uses a non-standard field (e.g., "agent_name").
   */
  agent_field: Type.Optional(Type.String()),
  /**
   * PRD-SO-03: Latency unit override. Default "auto" applies a heuristic:
   * values < 60 on a span > 1000ms are assumed seconds and converted to ms.
   * Set to "ms" or "s" to force a specific unit and bypass the heuristic (Q6).
   */
  latency_unit: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("ms"), Type.Literal("s")], {
      default: "auto",
    })
  ),
});

// ── Target platform ──────────────────────────────────────────────────────────

export const TargetPlatformSchema = Type.Union([
  Type.Literal("local-claude"),
  Type.Literal("local-codex"),
  Type.Literal("local-cursor"),
  Type.Literal("local-opencode"),
  Type.Literal("local-mastra"),
  Type.Literal("local-cloud-agent-sdk"),
  Type.Literal("cloud-rest"),
  /**
   * PRD-SO-04: report-only target — produce the HTML report but skip the apply gate
   * (Step 11 AskUserQuestion is hard-skipped; runMeta.applySkipped is populated).
   * Use for read-only environments, audits, or when you want a report without committing
   * to any agent-definition changes.
   */
  Type.Literal("report-only"),
]);

export const TargetModeSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("remote"),
]);

export const TargetConfigSchema = Type.Object({
  /** Target platform where agent definitions live */
  platform: TargetPlatformSchema,
  /** local = markdown/source-code file edits via BG worktree; remote = REST PUT */
  mode: TargetModeSchema,
  /** Root dir for local targets (relative to project root) */
  root: Type.Optional(Type.String({ default: ".claude/agents/" })),
  /** REST base URL for remote targets */
  rest_base_url: Type.Optional(Type.String()),
  /** Key name in .mutagentrc for REST auth (never store value here) */
  credential_ref: Type.Optional(Type.String()),
});

// ── ASK tool ────────────────────────────────────────────────────────────────

export const AskRuntimeSchema = Type.Union([
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("cursor"),
  Type.Literal("opencode"),
  Type.Literal("generic"),
]);

export const AskToolConfigSchema = Type.Object({
  /** Detected coding-agent runtime (auto-detected by cli/init.ts) */
  runtime: AskRuntimeSchema,
  /** Platform-specific tool name (AskUserQuestion on Claude Code) */
  native_tool: Type.Optional(Type.String({ default: "AskUserQuestion" })),
  /** Fallback when native tool unavailable */
  fallback: Type.Optional(
    Type.Literal("chat-multi-choice", { default: "chat-multi-choice" })
  ),
});

// ── Schedule ─────────────────────────────────────────────────────────────────

export const ScheduleModeSchema = Type.Union([
  Type.Literal("on-demand"),
  Type.Literal("daily-batch"),
]);

export const ScheduleConfigSchema = Type.Object({
  /** When orchestrator wakes to check trigger rules. v0.1 supports on-demand only. */
  mode: Type.Optional(ScheduleModeSchema),
  /** For daily-batch — local time (HH:MM) */
  at: Type.Optional(Type.String({ default: "09:00" })),
  /** Timezone for scheduled runs. Defaults to system timezone. */
  timezone: Type.Optional(Type.String({ default: "America/New_York" })),
});

// ── Trigger rules ────────────────────────────────────────────────────────────

export const TraceFilterSchema = Type.Object({
  agent_id: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
  start_time: Type.Optional(Type.String()),
  end_time: Type.Optional(Type.String()),
  has_error: Type.Optional(Type.Boolean()),
  has_feedback: Type.Optional(Type.Boolean()),
  score_below: Type.Optional(Type.Number()),
  latency_p99_ms_above: Type.Optional(Type.Number()),
  by_skill: Type.Optional(Type.String()),
  by_route: Type.Optional(Type.String()),
  by_tag: Type.Optional(Type.Array(Type.String())),
  /**
   * I-013: Restrict diagnostic analysis to traces from these agent IDs.
   * Empty array or absent = no filter (all agents included).
   * Typical use: set to the skill's own agent IDs for self-diagnostics scoping.
   * snake_case to match existing TraceFilterSchema field convention (agent_id, by_skill, by_tag).
   */
  skill_agent_scope: Type.Optional(Type.Array(Type.String())),
});

export const TriggerRuleSchema = Type.Object({
  /** Human-readable name for this rule */
  name: Type.String(),
  /** Filter conditions that qualify traces for diagnosis */
  match: TraceFilterSchema,
  /** What to do on match */
  action: Type.Literal("diagnose"),
});

// ── Heartbeat ────────────────────────────────────────────────────────────────

export const HeartbeatConfigSchema = Type.Object({
  /** Whether to ping operator when no triggers fire */
  notify_on_zero_matches: Type.Optional(Type.Boolean({ default: false })),
  /** Whether to ping operator when triggers fire and report is ready */
  notify_on_matches: Type.Optional(Type.Boolean({ default: true })),
  /** Cost guardrail: max full diagnostic runs per day */
  max_diagnostics_per_day: Type.Optional(Type.Number({ default: 3 })),
});

// ── Self-diagnostics [INTERNAL] ──────────────────────────────────────────────

export const SelfDiagnosticsCadenceSchema = Type.Union([
  Type.Literal("per-session"),
  Type.Literal("daily"),
  Type.Literal("manual"),
]);

export const SelfDiagnosticsConfigSchema = Type.Object({
  /**
   * OFF by default for end users.
   * ON for skill maintainers + dogfood mode.
   * [INTERNAL] — when enabled, feeds own session transcript through RCA pipeline (PR-022)
   */
  enabled: Type.Optional(Type.Boolean({ default: false })),
  /** How often to self-diagnose */
  cadence: Type.Optional(SelfDiagnosticsCadenceSchema),
  /** Auto-detect host coding agent for transcript path */
  source: Type.Optional(Type.String({ default: "host-coding-agent" })),
  /** Branch name for self-remedy PRs (template: use {date} placeholder) */
  remedy_branch: Type.Optional(
    Type.String({ default: "mutagent/self-diagnostics/{date}" })
  ),
  /** [INTERNAL] prefix added to all self-remedy PR titles */
  marker: Type.Optional(Type.String({ default: "[INTERNAL]" })),
});

// ── Feedback sources (Phase-2 self-diag opt-in) ─────────────────────────────

/**
 * PRD-SO-02 + Phase-2 self-diag: opt-in config for auto-collecting feedback sources.
 * When enabled, the skill collects operator feedback from configured sources (chat
 * transcripts, Langfuse trace scores, external platform) and surfaces it in findings
 * as feedbackSources[] blocks (D5).
 *
 * Opt-in via config.feedback_sources.enabled: true (Q11 — opt-in, not always-on).
 * Each sub-source has its own enabled flag for granular control.
 */
export const FeedbackSourcesConfigSchema = Type.Object({
  /**
   * Master switch. OFF by default. When true, the skill collects feedback from all
   * enabled sub-sources and injects FeedbackSource[] into each finding before render.
   */
  enabled: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Chat source: search recent Claude Code / coding-agent session transcripts
   * (~/.claude/projects/<encoded>/*.jsonl) for operator messages mentioning the entity.
   */
  chat: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      /**
       * How many most-recent session files to scan. Default 10. Higher values cost
       * more I/O but catch older feedback.
       */
      max_sessions: Type.Optional(Type.Number({ default: 10 })),
    })
  ),
  /**
   * Langfuse trace-score source: fetch trace scores with comments matching the entity.
   * Only active when source.platform = "langfuse".
   */
  trace_score: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      /**
       * Minimum score value to include (inclusive). Absent = include all scores.
       * Use to filter out non-feedback scores (e.g., numeric quality scores without comments).
       */
      min_score: Type.Optional(Type.Number()),
    })
  ),
  /**
   * External feedback platform source: REST endpoint returning FeedbackSource[].
   * Optional — only active when endpoint is set.
   */
  external: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      /** REST endpoint URL returning FeedbackSource[] JSON for the entity. */
      endpoint: Type.Optional(Type.String()),
      /** Key name in .mutagentrc for the external platform's auth (never store value here). */
      credential_ref: Type.Optional(Type.String()),
    })
  ),
});

export type FeedbackSourcesConfig = Static<typeof FeedbackSourcesConfigSchema>;

// ── Run metadata (v0.3 run-tagging) ─────────────────────────────────────────

export const RunMetaSchema = Type.Object({
  runId: Type.String(),
  /** Tags applied to this specific run (from config.run_tags + any --tag CLI args) */
  tags: Type.Array(Type.String()),
  startedAt: Type.String(),
  endedAt: Type.Optional(Type.String()),
  /** Platform that provided traces for this run */
  source: Type.Optional(Type.String()),
  /** Target platform for this run's remedies */
  target: Type.Optional(Type.String()),
  /** Number of traces analyzed in this run */
  traceCount: Type.Optional(Type.Number()),
  /**
   * Wave-6 D2: the VERBATIM operator invocation brief that initiated this run.
   * Persisted even when parsing succeeds (re-parse later + library authenticity).
   * Optional (backward-compat — absent on runs not started via the slash command).
   */
  operatorInvocation: Type.Optional(Type.String()),
});

export type RunMeta = Static<typeof RunMetaSchema>;

// ── Default audience (W13-D operator directive) ──────────────────────────────

/**
 * W13-D: the audience a render pass uses when NO explicit `--audience` flag is
 * given. Two values:
 *   "client"   — the client-stripped report (internal nodes NODE-STRIPPED).
 *   "internal" — the full report (Methodology + Trajectory + internal banners).
 *
 * Operator directive: a published / client install should produce the
 * client-stripped report BY DEFAULT; internal is opt-in. So `init` writes
 * `default_audience: client` and the schema default is also "client".
 *
 * This NEVER overrides the PR-022 self-diag invariant: an `isMetaReport`
 * (self-diagnosis) render is ALWAYS internal regardless of this field — the
 * renderer hard-refuses `audience:client` on a meta report.
 */
export const DefaultAudienceSchema = Type.Union(
  [Type.Literal("client"), Type.Literal("internal")],
  { default: "client" }
);

export type DefaultAudience = Static<typeof DefaultAudienceSchema>;

/**
 * W13-D: the schema-level default audience. Single source of truth for "what does
 * a fresh install render as when nobody says otherwise" → "client" (operator
 * directive). `init` writes this value; the resolver below falls back to it.
 */
export const DEFAULT_AUDIENCE: DefaultAudience = "client";

/**
 * W13-D: deterministically resolve the effective render audience.
 *
 * Precedence (highest first):
 *   1. explicit `--audience` flag (operator override at render time)
 *   2. config.default_audience  (the fresh-init default — "client")
 *   3. DEFAULT_AUDIENCE         (schema fallback — "client")
 *
 * PR-022 INVARIANT (non-negotiable): a self-diagnosis render (isMetaReport)
 * is ALWAYS "internal" — it overrides every other input. Self-diag is never
 * client. This mirrors the renderer's hard-refuse so the orchestrator never
 * even builds an `--audience client` invocation for a meta report.
 *
 * Pure + deterministic — no clock, no I/O. The orchestrator calls this to decide
 * the `--audience` value it threads into the Step-9 render command.
 *
 * @param opts.explicitFlag       the operator's `--audience` value, if any.
 * @param opts.configDefault      config.default_audience, if present.
 * @param opts.isMetaReport       true for a self-diagnosis render (PR-022).
 */
export function resolveEffectiveAudience(opts: {
  explicitFlag?: DefaultAudience;
  configDefault?: DefaultAudience;
  isMetaReport?: boolean;
}): DefaultAudience {
  // PR-022: self-diag is ALWAYS internal — overrides flag + config.
  if (opts.isMetaReport) return "internal";
  if (opts.explicitFlag === "client" || opts.explicitFlag === "internal") {
    return opts.explicitFlag;
  }
  if (opts.configDefault === "client" || opts.configDefault === "internal") {
    return opts.configDefault;
  }
  return DEFAULT_AUDIENCE;
}

// ── Root config ──────────────────────────────────────────────────────────────

// ── Agent identity map (W11-07) ─────────────────────────────────────────────

/**
 * W11-07: Per-platform observability identity for a named agent.
 * Each entry tells the skill HOW to find this agent's traces on each supported
 * observability platform (Langfuse trace.name / tags, OTel service.name / attrs).
 *
 * This is the CROSS-PLATFORM JOIN KEY: one code-level agent may appear as
 * different identifiers in different tracing back-ends.
 *
 * Example config.yaml entry:
 *   agents:
 *     - name: search-agent
 *       langfuse:
 *         traceName: "search-agent-v2"
 *         tags: ["production", "search"]
 *         agentIdField: "metadata.agent_id"
 *       otel:
 *         serviceName: "search-svc"
 *         resourceAttrs: { "deployment.env": "prod" }
 */
export const AgentPlatformLangfuseSchema = Type.Object({
  /** Langfuse trace.name value for this agent. */
  traceName: Type.Optional(Type.String()),
  /** Langfuse tags that identify this agent's traces. */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Override the JSON field used to extract agentId from raw Langfuse records. */
  agentIdField: Type.Optional(Type.String()),
});

export const AgentPlatformOtelSchema = Type.Object({
  /** OpenTelemetry service.name resource attribute value. */
  serviceName: Type.Optional(Type.String()),
  /** Additional OTEL resource attributes that narrow the agent identity. */
  resourceAttrs: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const AgentIdentitySchema = Type.Object({
  /** Canonical code-level agent name (matches the entity you pass to parse-brief). */
  name: Type.String(),
  /** Langfuse-specific identity pointers for this agent. */
  langfuse: Type.Optional(AgentPlatformLangfuseSchema),
  /** OTel-specific identity pointers for this agent. */
  otel: Type.Optional(AgentPlatformOtelSchema),
});

export type AgentIdentity = Static<typeof AgentIdentitySchema>;

// ─────────────────────────────────────────────────────────────────────────────

export const DiagnosticsConfigSchema = Type.Object({
  source: SourceConfigSchema,
  target: TargetConfigSchema,
  ask_tool: AskToolConfigSchema,
  schedule: Type.Optional(ScheduleConfigSchema),
  trigger_rules: Type.Optional(Type.Array(TriggerRuleSchema)),
  heartbeat: Type.Optional(HeartbeatConfigSchema),
  self_diagnostics: Type.Optional(SelfDiagnosticsConfigSchema),
  /**
   * v0.3 run-tagging: default tags applied to EVERY diagnostic run.
   * Useful for filtering in diagnostics-history by feature, milestone, or environment.
   * Examples: ["production", "search-agent"] or ["self-diagnostics", "internal"]
   */
  run_tags: Type.Optional(Type.Array(Type.String())),
  /**
   * PRD-SO-02 + Phase-2 self-diag: opt-in feedback source collection.
   * When enabled, findings are enriched with feedbackSources[] from chat, trace
   * scores, and/or external platforms before render (D5).
   * Defaults to disabled. Opt-in explicitly per Q11.
   */
  feedback_sources: Type.Optional(FeedbackSourcesConfigSchema),
  /**
   * W11-07: Optional agent identity map — cross-platform join keys so the skill
   * can resolve a code-level agent name to its observability identifiers on
   * Langfuse (trace.name / tags / agentIdField) and OTel (service.name / attrs).
   *
   * ADDITIVE + OPTIONAL: absent in existing configs (backward-compatible).
   * Populate when your agent appears under different names across platforms.
   * The identity for the diagnosed agent (from parse-brief.entity) is looked up
   * here and injected into EntityContext.identity at Step 3.7.
   *
   * Example:
   *   agents:
   *     - name: search-agent
   *       langfuse: { traceName: "search-v2", tags: ["prod"] }
   *       otel: { serviceName: "search-svc" }
   */
  agents: Type.Optional(Type.Array(AgentIdentitySchema)),
  /**
   * W13-D (operator directive): the audience used for the rendered report when no
   * explicit `--audience` flag is passed to the renderer.
   *
   * ADDITIVE + OPTIONAL (backward-compatible — absent in pre-W13-D configs).
   * Schema default is "client": a fresh `init` writes `default_audience: client`
   * so a published/client install produces the client-stripped report by default;
   * internal is opt-in. The orchestrator threads this value as
   * `--audience <config.default_audience>` at the Step-9 render invocation when the
   * operator gave no explicit flag.
   *
   * Effective-default precedence at render time:
   *   explicit `--audience` flag  >  config.default_audience  >  renderer fallback ("internal").
   * The renderer's own argv default stays "internal" (safe when neither config nor
   * flag is present); the config default makes a fresh init effectively "client".
   *
   * NEVER overrides PR-022: an `isMetaReport` (self-diag) render is ALWAYS internal.
   */
  default_audience: Type.Optional(DefaultAudienceSchema),
});

export type DiagnosticsConfig = Static<typeof DiagnosticsConfigSchema>;
export type TraceFilter = Static<typeof TraceFilterSchema>;
export type TriggerRule = Static<typeof TriggerRuleSchema>;
