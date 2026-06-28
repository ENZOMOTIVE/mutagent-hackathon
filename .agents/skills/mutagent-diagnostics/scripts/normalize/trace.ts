/**
 * scripts/normalize/trace.ts
 * Canonical TraceMetadata, TraceBody, and Finding types.
 * Every per-platform normalizer converts to these shapes.
 * Type A — Pure Script (type definitions only — no I/O)
 *
 * Wave-3 Phase 3-C additions:
 *   - I-023: Finding.assumptions? — explicit assumption enumeration (optional field)
 *   - I-025: Remedy.applyTarget? — file/module/agent the remedy patches
 *   - I-012: TraceMetadata.skillBehaviorDeviationCount? — tier0 skill-deviation signal
 *   - I-013: TraceFilter.skill_agent_scope lives in scripts/config/schema.ts (TraceFilterSchema)
 *
 * Wave-8 PRD-SO-07: TraceMetadata.totalCostUsd? — total run cost in USD for bigStat tile
 * Wave-8 PRD-CC-01: Remedy.rationale? / whyWorks? / applyInstructions? / changeType?
 * Wave-8 PRD-CC-02: FeedbackSource type + Finding.feedbackSources[]
 *
 * Wave-9 W9-F (PR-046): Two-layer feedback schema
 *   - Finding.translatedFeedback[]  — symptom → component-level translation records
 *   - Remedy.feedbackOnFix[]        — outcome records for applied fixes
 * Wave-9 W9-09 (PR-048): Trace-Hungry escalation telemetry
 *   - RunMeta.deepRead              — tier reached, llmReadCount, batches, stopReason
 */

// ── Canonical trace types ────────────────────────────────────────────────────

export interface TraceMetadata {
  /** Platform-native trace/session identifier */
  traceId: string;
  /** Session identifier (may equal traceId for single-thread platforms) */
  sessionId: string;
  /** Agent name or identifier */
  agentId?: string;
  /** Trace start time (ISO8601) */
  startTime?: string;
  /** Trace end time (ISO8601) */
  endTime?: string;
  /** Latency in milliseconds */
  latencyMs?: number;
  /** Token usage (total input + output) */
  totalTokens?: number;
  /** Whether trace contains error events */
  hasError: boolean;
  /** Whether trace has associated feedback */
  hasFeedback: boolean;
  /** Numeric score if present (raw, before scale normalization) */
  rawScore?: number;
  /** Scale type — populated after score-scale auto-discovery (iter-8) */
  scaleType?: ScaleType;
  /** Normalized score in [0, 1] range (0 = worst, 1 = best) */
  normalizedScore?: number;
  /** Tags or labels from the source platform */
  tags?: string[];
  /** Source platform identifier */
  sourcePlatform: SourcePlatform;

  // ── R-SELF-06-a: provider-side + harness-side event metadata ──────────────

  /**
   * API error events with retry tracking (from JSONL subtype:"api_error").
   * Used by tier0-scan to detect provider-exhaustion as a primary signal.
   */
  apiErrors?: Array<{
    retryAttempt: number;
    maxRetries: number;
    timestamp: string;
  }>;

  /**
   * Compaction/context-trim events (from JSONL compact_boundary events).
   * Useful for diagnosing context-overflow failure patterns.
   */
  compactionEvents?: Array<{
    preTokens: number;
    postTokens: number;
    durationMs: number;
  }>;

  // ── R-SELF-09-a: provenance + team-member context ─────────────────────────

  /** Parent session ID — populated when this session was spawned by another agent */
  parentSessionId?: string;
  /** Agent setting/role identifier (from first agent-setting event in transcript) */
  agentSetting?: string;
  /** True if this session was dispatched as a team-member agent (not the lead) */
  isTeammate?: boolean;

  // ── I-012: skill workflow deviation counter ───────────────────────────────

  /**
   * I-012: Count of skill workflow deviation events detected in this trace session.
   * A value > 0 indicates the skill deviated from its documented workflow
   * (e.g., skipped signal census, omitted assumption enumeration, bypassed scope construct).
   * Populated by per-platform normalizers when deviation markers are found in the trace.
   */
  skillBehaviorDeviationCount?: number;

  // ── PRD-SO-07: total cost field ───────────────────────────────────────────

  /**
   * PRD-SO-07: Total cost for this trace in USD.
   * Populated by the langfuse normalizer from raw.totalCost.
   * The enricher's buildBigStat aggregates this as a SUM across the session window
   * and renders it as "$N.NN / window" (red > $50, yellow > $10, muted <= $10).
   * USD-only for now (Q10 recommendation).
   */
  totalCostUsd?: number;

  // ── W12-12: de-double-counted billed tokens ───────────────────────────────

  /**
   * W12-12: Billed INPUT tokens for this trace, computed from doGenerate-only
   * generation spans (the leaf LLM calls). The parent `ai.generateText` wrapper
   * span repeats its children's usage, so a naive sum across all generation
   * spans double-counts (~2.2×). This field counts ONLY the leaf doGenerate
   * spans, giving the true billed figure. Undefined when no usage is present.
   */
  billedInputTokens?: number;

  /**
   * W12-12: Billed OUTPUT tokens for this trace (doGenerate-only, de-double-counted).
   * See `billedInputTokens` for the double-count rationale.
   */
  billedOutputTokens?: number;

  // ── W18-cache: GROUNDED prompt-caching detection ──────────────────────────
  //
  // CORE RULE: cache state is read ONLY from the source's cache-token fields
  // (Langfuse usageDetails.input_cached_tokens / Anthropic cache_read_input_tokens /
  // cache_creation_input_tokens, OTel gen_ai.usage.cache_* attrs, and usage.* equivalents).
  // It is NEVER inferred from flat promptTokens or byte sizes. The motivating miss:
  // a client agent's caching was active ~89%, but the skill inferred "uncached →
  // 408M billed tokens" from byte sizes. ABSENCE OF A CACHE FIELD ≠ NO CACHING.
  //
  // When NO cache-token field is present on ANY usage-bearing generation span,
  // cacheStatus is "unknown" — NOT "uncached". A grounded hit-rate is only emitted
  // when the cache fields are present.

  /**
   * W18-cache: Cached INPUT tokens served from the prompt cache (cache READ),
   * summed across the same doGenerate-only generation spans as billedInputTokens.
   * Sourced ONLY from cache-token fields (e.g. Langfuse usageDetails.input_cached_tokens,
   * Anthropic cache_read_input_tokens). Undefined when no span carried a cache-read
   * field — undefined means "unknown", NOT "zero cached" (that is the core W18 rule).
   */
  cachedInputTokens?: number;

  /**
   * W18-cache: Cache-CREATION input tokens (tokens written into the cache on a
   * cache-miss write), summed across the doGenerate-only spans. Sourced ONLY from
   * cache-creation fields (e.g. Anthropic cache_creation_input_tokens,
   * Langfuse usageDetails.cache_creation_input_tokens). Undefined when absent.
   * Cache-creation tokens are billed input but are NOT cache HITS — they are the
   * write side of the cache and are excluded from the hit-rate numerator.
   */
  cacheCreationTokens?: number;

  /**
   * W18-cache: GROUNDED cache status for this trace's billed generation spans.
   *   - 'hit'     -- cache fields present AND cachedInputTokens > 0 (cache was read).
   *   - 'miss'    -- cache fields present but cachedInputTokens === 0 (caching is
   *                  observable on this provider/shape, but nothing was served from
   *                  cache for this trace — a GROUNDED miss, distinct from unknown).
   *   - 'unknown' -- NO cache-token field present on any usage-bearing span. We do
   *                  NOT know whether caching was active. NEVER report this as
   *                  "uncached" — absence of a cache field is not evidence of no cache.
   * Undefined only when the trace carries no billed generation usage at all.
   */
  cacheStatus?: CacheStatus;

  /**
   * W18-cache: Cache-hit rate in [0, 1] = cachedInputTokens / (total cache-attributed
   * input tokens). Populated ONLY when cacheStatus is 'hit' or 'miss' (i.e. cache
   * fields were present). Undefined when cacheStatus is 'unknown' or absent — there
   * is no grounded basis to compute a rate without the cache fields.
   *
   * Denominator = cachedInputTokens + (uncached billed input) + cacheCreationTokens,
   * reconstructing the provider's total input from the grounded token fields. This
   * is computed ONLY from cache-token fields — never from promptTokens flatness or
   * byte sizes.
   */
  cacheHitRate?: number;
}

/**
 * W18-cache: grounded cache state. `unknown` is a first-class, load-bearing value:
 * it means the cache-token fields were absent, so cache state is genuinely unknown.
 * It is deliberately distinct from `miss` (cache fields present, nothing served) so
 * downstream renders never collapse "we don't know" into "no caching happened".
 */
export type CacheStatus = "hit" | "miss" | "unknown";

export type SourcePlatform =
  | "langfuse"
  | "otel"
  | "local-jsonl"
  | "claude-code"
  | "codex";

export type ScaleType =
  | "boolean"
  | "discrete-1-5"
  | "discrete-1-10"
  | "continuous-0-1"
  | "categorical";

export interface TraceMessage {
  /** Message index within the trace */
  index: number;
  /** Role: user | assistant | tool | system */
  role: "user" | "assistant" | "tool" | "system";
  /** Message content (may be truncated for large messages) */
  content: string;
  /** Tool name if this is a tool call or tool result */
  toolName?: string;
  /** Tool call arguments (JSON string) */
  toolArgs?: string;
  /** Tool result content */
  toolResult?: string;
  /** Whether this is an error result */
  isError?: boolean;
  /** Timestamp (ISO8601) */
  timestamp?: string;
}

export interface TraceBody {
  metadata: TraceMetadata;
  messages: TraceMessage[];
  /** Raw user feedback text if present */
  userFeedback?: string;
  /** Embedded score value if present */
  score?: number;
}

// ── EntityContext (Wave-5 R1.7 / APPENDIX-A) ──────────────────────────────────

/**
 * A long text field with its size metadata, so the renderer can decide whether
 * to wrap it in an ExpandableSection (>1 KB) and surface size + token counts in
 * the summary. All fields are content-derived at ingest — DETERMINISTIC, no LLM.
 *
 * INVARIANT (APPENDIX §A.4): `sizeBytes === byteLength(text)`.
 */
export interface SizedText {
  /** The (PII-sanitized where applicable) text content. */
  text: string;
  /** UTF-8 byte length of `text`. MUST equal byteLength(text). */
  sizeBytes: number;
  /** Approximate token count (≈ chars/4 heuristic — deterministic, no tokenizer). */
  tokensApprox?: number;
  /**
   * F-S2c (PR-055 proposed): OPTIONAL marker letting a consumer distinguish
   * "content existed but was sanitized away" from "content was genuinely empty".
   * Set true when a non-empty source value was PII-redacted down to empty/zero
   * (sizeBytes 0 + fullyRedacted true) — vs the field simply being absent on the
   * parent (e.g. EntityContext.systemPrompt undefined = "no prompt found").
   * Schema only — Block A sets it; absent on normal sized text (backward-compat).
   */
  fullyRedacted?: boolean;
}

/** Per-tool usage stats aggregated from trace observations (deterministic). */
export interface ToolInventoryEntry {
  name: string;
  /** Total invocations across all traces. */
  callCount: number;
  /** Mean invocations per trace (callCount / traceCount), rounded to 2dp. */
  callsPerTrace: number;
  /** Mean latency in ms (endTime-startTime per observation), when timing present. */
  avgLatencyMs?: number;
  /** 95th-percentile latency in ms (nearest-rank), when timing present. */
  p95LatencyMs?: number;
  /** Tool signature / arg-shape sample, when derivable from the trace. */
  signature?: string;
}

/**
 * Wave-5 R1.7 (APPENDIX-A §A.2): rich, content-derived context for the diagnosed
 * entity, extracted by each per-platform normalizer ALONGSIDE TraceBody[] at ingest.
 * The renderer consumes this via RenderInput.diagnosedEntity. NO LLM calls —
 * every field is derived from trace content so re-runs are byte-identical.
 */
export interface EntityContext {
  /** Display name — trace.name majority vote (or skill name for self-diag). */
  name: string;
  /** Category: agent, tool, skill, or model. */
  entityType: "agent" | "tool" | "skill" | "model";
  /** Whether source code is accessible for diagnostics (true for self-diag skill). */
  codeAccess: boolean;
  /** Model identifier — first GENERATION observation's .model. */
  model?: string;
  /** System prompt (sanitized) — system-role message OR <system>…</system> regex. */
  systemPrompt?: SizedText;
  /** Aggregated tool-usage inventory (grouped by name). */
  toolInventory?: ToolInventoryEntry[];
  /**
   * F-S2b (PR-055 proposed): OPTIONAL aggregate counter on the tool inventory —
   * number of tool-call/tool-result messages SKIPPED during aggregation because
   * they had no resolvable `toolName`. A non-zero value warns the operator the
   * inventory undercounts. Companion to `toolInventory` (NOT a per-tool field).
   * Schema only — Block A sets it (absent = not computed yet).
   */
  skippedCount?: number;
  /**
   * F-S2b (PR-055 proposed): OPTIONAL aggregate counter on the tool inventory —
   * number of distinct tools in `toolInventory` that have NO latency data
   * (avgLatencyMs/p95LatencyMs undefined). Lets the renderer caveat latency
   * coverage. Companion to `toolInventory` (NOT a per-tool field). Schema only —
   * Block A sets it (absent = not computed yet).
   */
  toolsWithoutLatency?: number;
  /** Sanitized input sample (first prompt, sliced). */
  inputSample?: SizedText & { sanitized: boolean };
  /** Provenance string: "langfuse-export" | "claude-code-jsonl" | …. */
  source: string;
  /** Where remedies apply (e.g. "config.yaml / skill assets (NEVER source)"). */
  applyTarget?: string;
  /**
   * W11-07: Cross-platform identity pointers for this entity, resolved from
   * config.agents[] at Step 3.7. Absent when the entity is not declared in
   * config.agents (run proceeds with trace-name-based matching only).
   *
   * The normalizer populates all other fields; identity is a post-ingest annotation
   * injected by resolveEntityIdentity() after config is loaded.
   */
  identity?: EntityIdentityPointers;
}

/**
 * W11-07: Resolved cross-platform identity pointers for a named entity.
 * Derived from config.agents[N].langfuse + config.agents[N].otel via
 * resolveEntityIdentity() in scripts/normalize/platforms/entity-context.ts.
 */
export interface EntityIdentityPointers {
  /** Langfuse trace.name / tags / agentIdField overrides for this entity. */
  langfuse?: {
    traceName?: string;
    tags?: string[];
    agentIdField?: string;
  };
  /** OTel service.name + resource attribute overrides for this entity. */
  otel?: {
    serviceName?: string;
    resourceAttrs?: Record<string, string>;
  };
}

// ── Wave-9 W9-F: Two-layer feedback schema (PR-046) ──────────────────────────

/**
 * W9-F (PR-046 Layer 2): A single translated-feedback entry bridging raw user
 * symptom → component-level RCA target. Captures the translation step explicitly
 * so the renderer can show "what the user said" vs "what it means for the agent".
 *
 * Optional/backward-compatible: absent when no feedback was translated for the finding.
 */
export interface TranslatedFeedback {
  /**
   * Index into Finding.feedbackSources (0-based) that this translation derives from.
   * When feedbackSources is absent, this is an index into a legacy userFeedback string
   * split (treat as 0 in that case).
   */
  sourceIndex: number;
  /** Verbatim excerpt from the raw feedback that drove this translation. */
  rawQuote: string;
  /**
   * The system component to which the symptom was translated (the RCA target).
   * Examples: "tool-definition", "system-prompt", "routing-config".
   */
  component: string;
  /**
   * The specific location affected, expressed as a WhereCategory value.
   * Drives the per-finding taxonomy strip in the renderer.
   */
  affectedComponent: WhereCategory;
  /** One-sentence explanation of the translation reasoning. */
  reasoning: string;
  /** Translator's confidence in the mapping. */
  confidence: "high" | "medium" | "low";
}

/**
 * W9-F (PR-046 Layer 3 — fix-feedback): Outcome record for an applied remedy.
 * Accumulated in Remedy.feedbackOnFix[] after the operator tests the fix in a
 * subsequent session. Enables the renderer to show a per-remedy fix history.
 *
 * Optional/backward-compatible: absent until a fix has been tested.
 */
export interface FeedbackOnFix {
  /** Trace session ID of the test run that produced this feedback. */
  testSessionId: string;
  /** ISO8601 timestamp when the fix was tested. */
  testedAt: string;
  /**
   * Observed outcome after applying the remedy:
   *   - 'closed'       — the finding is fully resolved.
   *   - 'partial'      — the finding is partially resolved (still occurs, less severe).
   *   - 'ineffective'  — the fix was applied but had no measurable effect.
   *   - 'regressed'    — the fix introduced a new problem.
   */
  outcome: "closed" | "partial" | "ineffective" | "regressed";
  /** Optional free-text comment from the tester or operator. */
  comment?: string;
  /**
   * Recommended follow-up steps when outcome !== 'closed'.
   * Empty or absent when the finding is fully closed.
   */
  nextSteps?: string[];
}

// ── Finding types (output of RCA layer) ──────────────────────────────────────

export type WhatCategory =
  | "wrong-output"
  | "missing-output"
  | "loop"
  | "latency-spike"
  | "cost-overshoot"
  | "format-violation"
  | "hallucination"
  | "user-complaint"
  | "low-score"
  | "missing-context";

export type WhyCategory =
  | "prompt-underspec"
  | "prompt-overspec"
  | "tool-misuse"
  | "tool-missing"
  | "context-overflow"
  | "provider-limit"
  | "data-staleness"
  | "handoff-loss"
  | "dependency-failure";

export type WhereCategory =
  | "system-prompt"
  | "tool-definition"
  | "agent-config"
  | "routing-config"
  | "upstream-data"
  | "provider-side"
  | "harness-side"
  | "user-input";

export interface FailureOrigin {
  what: WhatCategory;
  why: WhyCategory;
  where: WhereCategory;
  /** Pointer to specific evidence: file:line, trace message slice, code pointer */
  evidence: string;
  /**
   * F-EV1 (PR-055 proposed): plain-words narration of the event that actually
   * happened in the cited trace — the human-readable companion to the `evidence`
   * pointer. Example: "the agent called the summarize tool, received a 429,
   * retried 3×, then returned empty output". REQUIRED going forward so the renderer can
   * tell the operator WHAT happened, not just WHERE to look (`evidence`). The
   * `evidence` field stays as the file:line / message-slice / code pointer.
   */
  whatHappened: string;
  /**
   * F-EV1 (PR-055 proposed): OPTIONAL verbatim excerpt/quote from the trace body
   * that illustrates `whatHappened`. Carries the raw illustrative quote only —
   * the consumer (Block A/C) PII-sanitizes this before emit.
   */
  example?: string;
  confidence: "high" | "medium" | "low";
}

// ── Assumption (R1.3 / Wave-5 — assumptions block) ────────────────────────────

/**
 * Wave-5 R1.3 (PR-030 Assumption Explicitness, structured form): a single
 * assumption made during RCA, with an explicit verification status and the
 * basis for that status. Replaces the old free-text `string[]` form so the
 * renderer can emit verified / unverified / hypothesis-pending pills
 * (gold-standard `.assumptions` block).
 *
 * - "verified"           → confirmed against trace evidence or population stats
 * - "unverified"         → asserted but not directly confirmed (needs follow-up)
 * - "hypothesis-pending" → a hypothesis whose confirmation requires a source we
 *                          do not have access to yet (e.g. client code)
 */
export interface Assumption {
  /** The assumption statement (objective, single sentence). */
  text: string;
  /** Verification status — drives the pill class in the renderer. */
  status: "verified" | "unverified" | "hypothesis-pending";
  /** Why the status holds: the evidence basis or the source still required. */
  basis: string;
}

export interface WhyChainEntry {
  why: string;
  evidence: string;
  /**
   * F-EV1 (PR-055 proposed): plain-words narration of the event that actually
   * happened at this why-chain step, in the cited trace. Human-readable companion
   * to the `evidence` pointer (which stays as the file:line / message-slice
   * pointer). REQUIRED going forward.
   */
  whatHappened: string;
  /**
   * F-EV1 (PR-055 proposed): OPTIONAL verbatim excerpt/quote from the trace body
   * illustrating `whatHappened`. Raw quote only — the consumer (Block A/C)
   * PII-sanitizes before emit.
   */
  example?: string;
  /** True for the deepest/original failure origin */
  isOrigin?: boolean;
}

/**
 * R-SELF-15-a (PR-023): Clipboard payloads = self-contained actionable plans.
 * Every remedy that ships a clipboard payload MUST embed a plan so the
 * operator can apply it without re-reading the trace.
 */
export interface ActionablePlan {
  /** Files this remedy touches — NEW | EDIT | DELETE */
  files: Array<{
    path: string;
    lineRange?: string;
    action: "NEW" | "EDIT" | "DELETE";
  }>;
  /** Minimal before/after diff for the primary change */
  diff?: { before: string; after: string };
  /** Bash commands to run to verify the fix (e.g. bun run test) */
  verify: string[];
  /** Single sentence stating what must be true after apply for the remedy to be accepted */
  acceptance: string;
  /** Remedy IDs that must be applied before this one */
  dependsOn?: string[];
  /** Milestone tag (v0.2, v0.3, …) */
  milestone?: string;
  /** Suggested git commit message */
  commitMessage?: string;
  /** Free-form notes for the apply-worker */
  extraNotes?: string;
}

/**
 * W12-08 (PR-052 proposed): explicit marker for a remedy whose Before/After diff
 * could NOT be authored because the source/origin is not findable. Honors
 * `feedback_model_intent_sacred` — a remedy with no findable source MUST carry
 * this marker rather than a fabricated/guessed diff.
 *
 *   - "source-unavailable" -- the apply target exists but its current source is
 *                             not accessible to the analyzer (e.g. client code the
 *                             skill cannot read), so a Before/After cannot be cited.
 *   - "origin-unknown"     -- the failure origin itself could not be pinned to a
 *                             concrete source location; the remedy is a hypothesis.
 *
 * The renderer shows a labeled "source not found — hypothesis" caveat block in
 * place of the Before/After grid when this is set. EXACTLY ONE of `diff` /
 * `diffStatus` must be present on every remedy (enforced by findings-contract.ts).
 */
export type DiffStatus = "source-unavailable" | "origin-unknown";

export interface Remedy {
  remedyId: string;
  title: string;
  failureOrigin: FailureOrigin;
  /**
   * W12-08 (PR-052 proposed): Before/After diff for the primary change.
   * REQUIRED WHEN A SOURCE IS FINDABLE. When the source/origin is not findable,
   * OMIT this and set `diffStatus` instead — NEVER fabricate a diff. The
   * findings-contract validator enforces that exactly one of `diff` / `diffStatus`
   * is present.
   */
  diff?: { before: string; after: string };
  /**
   * W12-08 (PR-052 proposed): explicit absence marker, set IFF `diff` is omitted
   * because the source/origin is not findable. See DiffStatus. Renderer shows a
   * "source not found — hypothesis" caveat block instead of the Before/After grid.
   */
  diffStatus?: DiffStatus;
  /**
   * W13-C (D-1): REQUIRED categorical — analyzer-emitted, contract-enforced at
   * Step 7.1 (findings-contract.ts). Implementation/operational cost of the fix.
   */
  cost: "low" | "medium" | "high";
  /**
   * W13-C (D-1): REQUIRED categorical — analyzer-emitted, contract-enforced at
   * Step 7.1. Confidence the fix resolves the root cause.
   */
  correctness: "low" | "medium" | "high";
  /**
   * Lower = higher priority.
   * W13-C (D-1): enricher-DERIVED from `cost × correctness` (orchestrator-protocol
   * §8 / scripts/enrich/rank-remedies.ts). NOT analyzer-supplied — the enricher
   * always backfills it, so it can never reach the renderer undefined. Deterministic
   * (no LLM judgment) → reproducible ranking.
   */
  rank: number;
  /**
   * W12-08 (PR-052 proposed): REQUIRED — routing class for the apply target.
   * local-agent | local-code-construct | remote. Pairs with applyTarget: the
   * target says WHERE, the class says HOW the apply-worker writes there.
   */
  targetClass: string;
  /**
   * R-SELF-15-a: Self-contained actionable plan embedded in the clipboard payload.
   * Renderer puts this in data-payload so the operator's copy-back markdown
   * contains everything the apply-worker needs to act without context re-read.
   */
  plan?: ActionablePlan;
  /**
   * I-025 / W12-08 (PR-052 proposed): HARD-REQUIRED — file, module, or agent that
   * this remedy patches. EVERY remedy MUST link to a target: a code location, or
   * (per target platform) the agent prompt / agent definition. Drives the
   * applyTarget pill in the renderer. Absent → rejected by findings-contract.ts.
   * Examples: "scripts/tier0-scan.ts", ".claude/agents/search-agent.md:34"
   */
  applyTarget: string;

  // ── PRD-CC-01: Two-rationale + apply-instructions + changeType fields ──────

  /**
   * PRD-CC-01 (D1) / W12-08 (PR-052 proposed): REQUIRED — comparative rationale:
   * WHY pick this remedy over alternatives. Purple block in the renderer
   * ("Why this remedy"). Distinct from whyWorks (causal mechanism) per D1.
   * Absent → rejected by findings-contract.ts.
   */
  rationale: string;

  /**
   * PRD-CC-01 (D1) / W12-08 (PR-052 proposed): REQUIRED — causal mechanism:
   * WHY the fix actually closes the failure (focus on the ORIGIN). Cyan block in
   * the renderer ("Why this works"). Distinct from rationale (comparative) per D1.
   * Absent → rejected by findings-contract.ts.
   */
  whyWorks: string;

  /**
   * PRD-CC-01 (D4) / W12-08 (PR-052 proposed): REQUIRED (≥1) — ordered list of
   * apply instructions (numbered steps). Rendered in the right column of the
   * apply-grid. The apply-worker executes these in order after the ActionablePlan.
   * Empty/absent → rejected by findings-contract.ts.
   */
  applyInstructions: string[];

  /**
   * PRD-CC-01: Type of change this remedy makes to the target file or construct.
   * Drives the changeType pill in the renderer's meta strip.
   *   - 'add'     -- new file, class, function, or config entry
   *   - 'modify'  -- patch to existing code/config
   *   - 'delete'  -- remove file, function, or config entry
   *   - 'replace' -- full rewrite of existing construct (supersedes modify when scope > 50%)
   */
  changeType?: "add" | "modify" | "delete" | "replace";

  // ── Wave-9 W9-F: Fix-feedback layer (PR-046 Layer 3) ─────────────────────

  /**
   * W9-F (PR-046 Layer 3): Accumulated fix-outcome records from post-apply test
   * sessions. Each entry is appended after the remedy is applied and retested.
   *
   * Absent on new/unapplied remedies (backward-compatible). The renderer shows a
   * per-remedy fix history when this array is non-empty.
   */
  feedbackOnFix?: FeedbackOnFix[];
}

// ── PRD-CC-02: Structured feedback source ────────────────────────────────────

/**
 * PRD-CC-02 (D5): One structured feedback entry grounding a finding.
 * Three source types -- chat (operator messages), trace-score (Langfuse/OTel scores with
 * comments), external (third-party feedback platform or issue tracker).
 *
 * Renderer color-codes by sourceType (cyan=chat, yellow=trace-score, purple=external).
 * NO emojis on headers or source-type labels (D9).
 */
export interface FeedbackSource {
  /**
   * Where this feedback originated.
   *   - 'chat'        -- operator chat session (Claude Code session transcript)
   *   - 'trace-score' -- Langfuse/OTel score with an attached comment
   *   - 'external'    -- third-party issue tracker, Slack DM, PR review, etc.
   */
  sourceType: "chat" | "trace-score" | "external";
  /**
   * Human-readable provenance label (shown in the renderer's fb-head).
   * Examples: "Operator feedback (2026-06-02)", "Langfuse score: latency-eval", "GitHub Issue #42"
   */
  provenance: string;
  /** Verbatim body of the feedback -- displayed inside a <blockquote>. */
  body: string;
  /** ISO8601 timestamp when this feedback was captured (optional). */
  capturedAt?: string;
  /** Trace ID referenced by the feedback (for trace-score sources). */
  traceId?: string;
  /**
   * Score information for trace-score sources.
   * Only populated when sourceType === 'trace-score'.
   */
  score?: {
    name: string;
    value: number;
    scorerType?: string;
  };
  /**
   * Name of the external platform for sourceType === 'external'.
   * Examples: "GitHub Issues", "Slack", "Linear", "Jira"
   */
  externalPlatform?: string;
}

export interface Finding {
  findingId: string;
  /** Actionable summary (objective, evidence-grounded — not raw subjective feedback) */
  actionable: string;
  /**
   * I-042: Raw subjective user feedback (operator notes, tester observations, verbal reports).
   * Distinct from `actionable` (objective). Renderer shows "User Feedback" block IFF non-empty.
   * Restores the User-Feedback (subjective) vs System-Feedback (objective) distinction
   * that was dropped in the iter9-flat rewrite.
   *
   * LEGACY COMPAT (PRD-CC-02): When feedbackSources is absent, consumers SHOULD auto-promote
   * this field to a single FeedbackSource entry:
   *   { sourceType: 'chat', provenance: 'legacy userFeedback field', body: userFeedback }
   * The promotion logic belongs to CONSUMERS (renderer / enricher), not this type definition.
   */
  userFeedback?: string;
  /**
   * I-023 / Wave-5 R1.3 (PR-030 Assumption Explicitness): Explicit assumptions
   * made during RCA, in STRUCTURED form ({ text, status, basis }). Constraints,
   * preconditions, or domain facts surfaced during RCA, each tagged with a
   * verification status so the renderer can emit verified / unverified /
   * hypothesis-pending pills (gold-standard `.assumptions` block).
   *
   * Must be enumerated before finalizing the finding (see rca.md §Assumption
   * enumeration). The enricher (scripts/enrich/build-render-input.ts) converts
   * legacy free-text `string[]` (with inline VERIFIED/UNVERIFIED/hypothesis-pending
   * markers) into this structured form.
   *
   * W12-08 (PR-052 proposed): REQUIRED — every finding MUST enumerate ≥1 structured
   * assumption before it is finalized. A finding with zero assumptions is rejected
   * by findings-contract.ts. (Was optional pre-W12 for backward-compat.)
   */
  assumptions: Assumption[];
  /**
   * Wave-5 R1.3 — gold-standard story-led display fields (all OPTIONAL; the
   * enricher derives them, the renderer falls back gracefully when absent).
   */
  /** Severity badge for the gold-standard finding head (CRIT / HIGH / MED / RULE-OUT / LOW). */
  severity?: "crit" | "high" | "med" | "info";
  /** Story-led h2 title (e.g. "The draft tool is the latency sink"). Falls back to actionable. */
  title?: string;
  /** One-line sub-description under the finding h2 (gold-standard `.sub`). */
  subDesc?: string;
  /** Worst-case callout shown in a `.crit` / `.warn` box at the top of the finding panel. */
  worstCaseCallout?: string;
  /** Apply-target label for the taxonomy strip (e.g. "code-change (client)", "prompt-update"). */
  applyLabel?: string;
  /**
   * Wave-18 (W18-problem): REQUIRED descriptive problem statement — the PRIMARY block
   * of every finding panel (always rendered, at the TOP, before Evidence / why-chain /
   * remedies).
   *
   * Format: `<subject> <observed behavior, declarative> — <quantified impact + evidence>
   * [— scope: N/total traces]`.
   *
   * Describes WHAT is wrong and HOW BAD it is — NOT what to do about it. It is a
   * declarative description of observed behavior and its measured impact, grounded in
   * evidence. The fix/recommendation lives ONLY in `remedies`; `problem` must never be
   * phrased as a task or todo (e.g. NOT "Make X faster — use a smaller model" but rather
   * "X takes 4.2s p95 — 3.1x the 1.4s session median — on 12/40 traces").
   *
   * Was OPTIONAL pre-W18 (renderer silently fell back to the action-biased `actionable`
   * field, which is why reports rendered todos in the Problem slot). Now required so the
   * descriptive statement is always present and the fallback can be killed.
   */
  problem: string;
  /** Evidence prose/HTML shown under the Evidence h3 (gold-standard `<h3>Evidence</h3> + p/table`). */
  evidenceHtml?: string;
  failureOrigin: FailureOrigin;
  /** Recursive why-chain until failure origin */
  whyChain: WhyChainEntry[];
  remedies: Remedy[];
  /** Source trace IDs that produced this finding */
  sourceTraceIds: string[];
  /** Reference IDs: trace.id → session.id → finding.id */
  referenceIds: { traceId: string; sessionId: string; findingId: string };
  /**
   * Wave-4: Optional criterion result when diagnostics runs against a target
   * that declares a self-diagnosis-contract.yaml (opt-in structured-report mode).
   * Open-ended findings leave this undefined.
   */
  criterion?: CriterionResult;
  /**
   * Wave-6 R2.5 — Sampling representativeness proof for THIS finding's evidence.
   * The deterministic shape computed by scripts/sample/representative.ts
   * (buildCoverageProof). Renders a per-finding `coverageConfidence` widget below
   * the why-chain. WARN-only: a "low" level never blocks the report — it surfaces
   * the caveat honestly (design philosophy §2.3). Optional (backward-compat).
   */
  coverageProof?: FindingCoverageProof;

  // ── PRD-CC-02: Structured feedback sources ────────────────────────────────

  /**
   * PRD-CC-02 (D5): Structured feedback sources grounding this finding.
   * Displayed between Problem and Evidence in the renderer as a Feedback block.
   * Each source is color-coded by sourceType (cyan=chat / yellow=trace-score / purple=external).
   *
   * When absent, consumers SHOULD check `userFeedback` for a legacy string and
   * promote it to [{sourceType:'chat', provenance:'legacy userFeedback field', body: userFeedback}].
   * The promotion logic lives in consumers (renderer/enricher), not here.
   */
  feedbackSources?: FeedbackSource[];

  // ── Wave-9 W9-F: Translated feedback layer (PR-046) ──────────────────────

  /**
   * W9-F (PR-046 Layer 2): Translated-feedback entries for this finding — one per
   * raw feedback excerpt that was mapped to a component-level RCA target.
   *
   * Absent when no feedback translation has been performed (backward-compatible).
   * Rendered as a "Translated Feedback" block between feedbackSources and Evidence.
   */
  translatedFeedback?: TranslatedFeedback[];

  // ── PRD-SD-04: Audience tagging ───────────────────────────────────────────
  /**
   * PRD-SD-04 (PR-033): Audience classification for this finding.
   *   - 'PRODUCT' -- user-facing; the default for client diagnoses
   *   - 'META'    -- internal-only; applies to skill self-diagnosis findings
   *   - 'CORE'    -- schema/CLI/contract surface findings
   *
   * Self-diagnosis dispatcher force-sets 'META' on every finding (PRD-SD-04).
   * For client diagnoses, the analyzer determines audience case-by-case.
   */
  audience?: "PRODUCT" | "META" | "CORE";
}

/**
 * Wave-6 R2.5 — render-facing mirror of scripts/sample/representative.ts CoverageProof.
 * Defined here (not imported from sample/) so trace.ts stays dependency-light and the
 * renderer can consume it via the Finding type. The sampler produces this shape;
 * the renderer reads it. Numbers are deterministic (no clock/random).
 */
export interface FindingCoverageProof {
  /** Per-finding confidence 0..100 (mean of the 4 dimension coveragePcts). */
  coverageConfidence: number;
  /** high (≥90) · medium (≥70) · low (else). */
  level: "high" | "medium" | "low";
  /** Per-dimension coverage rows (latency · score · temporal · tool-trajectory). */
  dimensions: Array<{
    dimension: "latency" | "score" | "temporal" | "tool-trajectory";
    populationBuckets: number;
    coveredBuckets: number;
    coveragePct: number;
  }>;
  /** Population vs sample bias proof. */
  population: {
    populationSize: number;
    sampleSize: number;
    sampleFraction: number;
    populationMeanBadness: number;
    sampleMeanBadness: number;
  };
}

// ── PRD-MP-05: RunMeta decision-logging ──────────────────────────────────────

/**
 * PRD-MP-05 (PR-027): Append-only decision-logging fields for a diagnostic run.
 * Every methodology decision is recorded here as an audit row.
 * All fields are OPTIONAL for backward-compat with existing run-meta JSON files.
 *
 * NOTE: render.ts also defines a RunMeta interface (renderer-level, with signalCensus +
 * mermaidTopology). This type in trace.ts is the CANONICAL definition for decision
 * logging and is intended to be the shared base. Phase-2 agents (w8-render, w8-selfdiag)
 * should extend or union this with render.ts RunMeta as needed.
 */
export interface RunMeta {
  // ── Step 5b -- sampling override decision ───────────────────────────────

  /**
   * PRD-MP-05 / Step 5b: Records when the orchestrator switched from the slicer's
   * window-based plan to a representative-sample approach because focus was set.
   *   from    -- original sampling strategy (e.g. 'window-based')
   *   to      -- overriding strategy (e.g. 'representative-sample')
   *   reason  -- free-text explanation (e.g. 'focus=cost-loops')
   */
  samplingOverride?: {
    from: string;
    to: string;
    reason: string;
  };

  // ── Step 6 -- dispatch shape decision ───────────────────────────────────

  /**
   * PRD-MP-05 / Step 6: Records the single-shot vs fan-out analyzer dispatch decision.
   *   analyzerCount -- number of analyzer sub-agents dispatched (1..5)
   *   reason        -- one-liner explaining which criterion fired (see protocol Step 6)
   *   slicesUsed    -- slice IDs passed to each analyzer
   */
  dispatch?: {
    analyzerCount: number;
    reason: string;
    slicesUsed: string[];
  };

  // ── Step 7.1 -- redispatch tracking ─────────────────────────────────────

  /**
   * PRD-MP-05 / Step 7.1: Tracks redispatch events when a finding is missing
   * required fields and the orchestrator issues a "RESEND with missing: X, Y, Z".
   * Capped at 2 redispatches per finding (Q4 recommendation).
   */
  redispatches?: Array<{
    findingId: string;
    missingFields: string[];
    attemptCount: number;
  }>;

  // ── Step 8.9 -- wave-6 checklist exemptions ─────────────────────────────

  /**
   * PRD-MP-05 / Step 8.9: Records when a wave-6 checklist step was skipped under
   * an approved exemption. Required when skipping; surfaced in the Methodology tab.
   *   stepId      -- the checklist step that was skipped (e.g. 'awareness-sample')
   *   reason      -- why it was skipped
   *   declaredBy  -- who declared the exemption (e.g. 'orchestrator', 'operator')
   */
  exemptions?: Array<{
    stepId: string;
    reason: string;
    declaredBy: string;
  }>;

  // ── Step 11.0 -- apply skip ──────────────────────────────────────────────

  /**
   * PRD-MP-05 / Step 11.0 + PRD-SO-04: Populated when config.target.platform === 'report-only'.
   * The apply-confirm AskUserQuestion is skipped; the run halts after Step 10 HITL review.
   *   reason -- why apply was skipped (e.g. 'config target = report-only')
   */
  applySkipped?: {
    reason: string;
  };

  // ── General decision log ─────────────────────────────────────────────────

  /**
   * PRD-MP-05 (PR-027, PR-043): General append-only decision log.
   * Every methodology decision that does not fit a typed field above is recorded here.
   *   step      -- enum key for grep-ability (Q17 recommendation):
   *               '5b-override' | '6-dispatch' | '7.1-redispatch' | '8.9-exemption' | '11.0-skip'
   *   choice    -- what was decided
   *   rationale -- why this choice was made
   *   timestamp -- ISO8601 when the decision was made
   */
  decisions?: Array<{
    step:
      | "5b-override"
      | "6-dispatch"
      | "7.1-redispatch"
      | "8.9-exemption"
      | "11.0-skip";
    choice: string;
    rationale: string;
    timestamp: string;
  }>;

  // ── Wave-9 W9-09: Trace-Hungry escalation telemetry (PR-048) ─────────────

  /**
   * W9-09 (PR-048): Deep-read escalation record.
   * Populated at the end of the tiered-escalation loop (orchestrator Step 6).
   * Surfaced in the report header bigStat row (tier reached · tier0 scanned ·
   * llmReadCount · coverageConfidence · stopReason).
   *
   * Optional/backward-compatible: absent in runs predating Wave-9.
   */
  deepRead?: {
    /** Total traces in scope when the escalation loop ran. */
    population: number;
    /** The highest tier actually reached (read count, not the rung label). */
    tierReached: 100 | 250 | 500 | 1000 | number;
    /** Cumulative traces LLM-read across all batches. */
    llmReadCount: number;
    /** Overall coverage confidence after the final batch. */
    coverageConfidence: "high" | "medium" | "low";
    /** Why the escalation loop terminated. */
    stopReason: "evidence-sufficient" | "ceiling-reached" | "time-budget";
    /** Per-batch escalation records (one entry per rung reached). */
    batches: Array<{
      /** The tier/rung read up to (e.g. 50, 100, 250, 500, 1000). */
      tier: number;
      /** Count of distinct new failureOrigin.what categories surfaced in this batch. */
      newFailureCategories: number;
      /** Coverage confidence after this batch. */
      coverageConfidence: string;
    }>;
  };

  // ── F-S7: local-jsonl dropped-line surface (PR-055 proposed) ─────────────

  /**
   * F-S7 (PR-055 proposed): partial-load accounting per source. Records when a
   * source could not be fully ingested — e.g. the local-jsonl loader skipped
   * malformed NDJSON lines that failed JSON.parse. Surfacing dropped lines lets
   * the report caveat coverage honestly instead of silently undercounting.
   *
   * One entry per affected source. Optional/backward-compatible: absent when no
   * lines were dropped. Schema only — Block A populates it.
   *   source           -- provenance label (e.g. 'local-jsonl: traces.ndjson')
   *   droppedLineCount -- total NDJSON lines dropped for this source
   *   droppedSamples   -- first-N raw bad lines (verbatim), for operator triage
   */
  partial_loads?: Array<{
    source: string;
    droppedLineCount: number;
    droppedSamples: string[];
  }>;
}

// ── Score-scale types (iter-8) ────────────────────────────────────────────────

export interface ScaleProbeResult {
  scaleType: ScaleType;
  min: number;
  max: number;
  distinctValues?: number[];
  /** For categorical: list of known category strings */
  categories?: string[];
  /** Computed "negative" threshold for the given scale */
  negativeThreshold?: number | string;
}

// ── I-013 note ────────────────────────────────────────────────────────────────
// TraceFilter.skill_agent_scope is in scripts/config/schema.ts (TraceFilterSchema),
// NOT here. trace.ts stays plain TypeScript interfaces — no TypeBox, no runtime schemas.

// ── Wave-4: Contract-aware types (opt-in structured-report mode) ──────────────

/**
 * 10-category Hybrid set — operator-locked 2026-05-31.
 * MUST match the categories declared in self-diagnosis-contract.v0.1.0.yaml.tpl.
 */
export type SuccessCriteriaCategory =
  | "operational"
  | "onboarding"
  | "behavioral"
  | "hitl"
  | "output"
  | "methodology"
  | "tier-performance"
  | "source-platform"
  | "target-platform"
  | "maintenance";

/**
 * Per-criterion result when diagnostics runs against a target that declares
 * a self-diagnosis-contract.yaml. Open-ended path does NOT populate this.
 */
export interface CriterionResult {
  category: SuccessCriteriaCategory;
  id: string;
  statement: string;
  status: "pass" | "fail" | "not-applicable" | "pending";
  evidenceRef?: {
    kind: "trace" | "commit" | "cmd-output" | "file:line" | "screenshot";
    value: string;
  };
}

/**
 * Extension marker for the opt-in structured-report mode.
 * The `criterion` optional field on Finding is the runtime surface.
 * Targets that do not declare a self-diagnosis-contract.yaml never populate it.
 */
export interface ContractAwareFinding {
  criterion?: CriterionResult;
}
