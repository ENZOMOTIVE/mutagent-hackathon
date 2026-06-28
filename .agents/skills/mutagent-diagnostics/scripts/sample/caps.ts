/**
 * scripts/sample/caps.ts
 * R2.1 + W9-09 — multi-cap enforcement for the mandatory LLM deep-read.
 * Type A — Pure Script (deterministic; NO random; clock is INJECTABLE).
 *
 * Three caps bound a deep-read run. Each cap is `{ active, value }` so it can be
 * toggled independently of its threshold (D1):
 *   - max_trace_count  — DIP→RAMP escalation rungs [50,100,250,500,1000]; default
 *                        ceiling = min(N,1000). The 50 rung is the cheap DIP first probe
 *                        (sip 50, ramp only if evidence is still thin); it is NOT a hard
 *                        ceiling (the W6 single-50-cap that PR-035 originally described is
 *                        superseded — see PR-048). The "value" field in the Cap shape holds
 *                        the CURRENT tier ceiling (set by the escalation loop); DEFAULT_CAPS
 *                        uses 1000 as the initial hard ceiling.  active:true.
 *                        OPERATOR OVERRIDE: computeCeiling(N, override) raises the ceiling
 *                        ABOVE 1000 ON COMMAND (operator-explicit only, never auto) — pass
 *                        --max-trace <N> on the CLI to thread it into the cap value too.
 *   - time_budget_sec  — per-tier lookup {50:300, 100:600, 250:900, 500:1200, 1000:1800};
 *                        hard ceiling 1800 s.  active:true.
 *   - cost_budget_usd  — INACTIVE BY DEFAULT (D1, PR-041 — trace-hungry, not cost-shy).
 *
 * D1 rationale (Wave-6 plan §5 D1): skill-side cost tracking is unreliable today
 * (false +/−/security). Max-trace + time bound the run reliably; the $10 is the
 * "if-activated" value, NOT auto-applied. enforceCaps SKIPS inactive caps entirely
 * — an inactive cap can never trip, regardless of its value.
 *
 * Enforcement semantics: caps trip FIRST-TO-TRIP. When any active cap is exceeded
 * the run STOPS, emits whatever findings it has, and raises a banner (the caller
 * renders runMeta.capBanner). The cap NEVER silently truncates without the banner.
 *
 * W9-09 additions (drift-fix 2026-06: dip rung + operator override):
 *   - ESCALATION_RUNGS     : DIP→RAMP read targets [50, 100, 250, 500, 1000]
 *   - TIME_BUDGET_BY_TIER  : per-tier time budgets (seconds), incl. 50→300
 *   - computeCeiling(N, override?) : min(N, override ?? 1000) — override raises >1000 on command
 *   - timeBudgetForTier()  : lookup with hard ceiling 1800 s
 */

// ── Cap schema ────────────────────────────────────────────────────────────────

export interface Cap {
  /** When false, this cap is never evaluated (D1). */
  active: boolean;
  /** Threshold value (interpreted per cap kind). */
  value: number;
}

export type CapKind = "max_trace_count" | "time_budget_sec" | "cost_budget_usd";

export interface CapsConfig {
  max_trace_count: Cap;
  time_budget_sec: Cap;
  cost_budget_usd: Cap;
}

/**
 * W9-09 + drift-fix: DIP→RAMP escalation rungs (operator-locked per PR-048).
 * The escalation loop iterates through these in order up to the run ceiling.
 * The leading 50 is the cheap DIP first probe (sip 50 traces, then ramp only if
 * evidence is still thin) — it is NOT a hard ceiling. The W6 single-50-cap that
 * PR-035 originally described is superseded by this dip→ramp+override policy.
 */
export const ESCALATION_RUNGS: ReadonlyArray<50 | 100 | 250 | 500 | 1000> = [50, 100, 250, 500, 1000];

/**
 * W9-09 + drift-fix: Per-tier time budget in seconds (simple lookup table, hard
 * ceiling 1800 s). Keys are the rung values; any tier not in the table uses the
 * hard ceiling. The 50-dip rung gets a 300 s budget (short — it's a quick probe).
 */
export const TIME_BUDGET_BY_TIER: Readonly<Record<number, number>> = {
  50: 300,
  100: 600,
  250: 900,
  500: 1200,
  1000: 1800,
};

/** W9-09: Absolute hard ceiling for time budget regardless of tier (seconds). */
export const TIME_BUDGET_HARD_CEILING_SEC = 1800;

/**
 * W9-09 + drift-fix: DEFAULT max-trace ceiling when the operator gives no override.
 * The deep-read NEVER auto-exceeds this; only an explicit operator override raises it.
 */
export const DEFAULT_MAX_TRACE_CEILING = 1000;

/**
 * W9-09 + drift-fix: Compute the effective run ceiling.
 *
 *   - NO override (default): `min(population, DEFAULT_MAX_TRACE_CEILING)` = min(N, 1000).
 *     Small stacks (N < first rung) skip forced escalation; the ceiling is still N.
 *   - OPERATOR OVERRIDE: `min(population, override)` — the operator can RAISE the ceiling
 *     ABOVE 1000 ON COMMAND (e.g. override 5000 → min(N, 5000)). The override is
 *     operator-explicit only (threaded from `--max-trace <N>`), NEVER applied automatically.
 *
 * The override is honored only when it is a positive, finite number; a non-positive or
 * non-finite override is ignored and the 1000 default applies (fail-safe). Fractional
 * overrides are floored for determinism. Pure, deterministic.
 */
export function computeCeiling(population: number, maxTraceOverride?: number): number {
  const overrideValid =
    typeof maxTraceOverride === "number" &&
    Number.isFinite(maxTraceOverride) &&
    maxTraceOverride > 0;
  const ceiling = overrideValid ? Math.floor(maxTraceOverride) : DEFAULT_MAX_TRACE_CEILING;
  return Math.min(population, ceiling);
}

/**
 * W9-09: Look up the time budget for a given tier rung.
 * Returns the entry from TIME_BUDGET_BY_TIER, or TIME_BUDGET_HARD_CEILING_SEC if
 * the tier is not in the table. Caps at TIME_BUDGET_HARD_CEILING_SEC.
 */
export function timeBudgetForTier(tier: number): number {
  const budget = TIME_BUDGET_BY_TIER[tier] ?? TIME_BUDGET_HARD_CEILING_SEC;
  return Math.min(budget, TIME_BUDGET_HARD_CEILING_SEC);
}

/**
 * D1-locked defaults. max-trace + time ACTIVE; cost INACTIVE (value is the
 * if-activated figure, never auto-applied).
 *
 * W9-09: max_trace_count.value is the hard run ceiling (1000 = max rung).
 *        time_budget_sec.value is the hard time ceiling (1800 s = max rung budget).
 *        The escalation loop uses timeBudgetForTier() to set per-tier budgets.
 */
export const DEFAULT_CAPS: CapsConfig = {
  max_trace_count: { active: true, value: 1000 },
  time_budget_sec: { active: true, value: TIME_BUDGET_HARD_CEILING_SEC },
  cost_budget_usd: { active: false, value: 10.0 },
};

// ── Run accounting ────────────────────────────────────────────────────────────

export interface CapUsage {
  /** Traces read by the LLM so far (counts awareness-layer traces too — no double-count). */
  tracesRead: number;
  /** Elapsed wall-clock seconds since run start. */
  elapsedSec: number;
  /** Estimated spend so far (only consulted when cost cap is active). */
  estimatedCostUsd: number;
}

export interface CapTrip {
  kind: CapKind;
  /** The cap's threshold value. */
  limit: number;
  /** The observed value that exceeded the limit. */
  observed: number;
  /** Human-readable banner line (rendered as runMeta.capBanner). */
  banner: string;
}

export interface EnforceResult {
  /** True when the run must STOP (an active cap tripped). */
  stop: boolean;
  /** The FIRST cap that tripped (first-to-trip), or null when none did. */
  trip: CapTrip | null;
}

/**
 * Evaluate caps against current usage. Inactive caps are SKIPPED (D1) — they
 * never appear in a trip. The check order is fixed (max_trace → time → cost) so
 * "first-to-trip" is deterministic. Pure: no clock read here — the caller passes
 * `usage.elapsedSec` computed from an injectable start time.
 */
export function enforceCaps(caps: CapsConfig, usage: CapUsage): EnforceResult {
  // Fixed evaluation order → deterministic first-to-trip.
  const order: Array<{ kind: CapKind; cap: Cap; observed: number; unit: string }> = [
    { kind: "max_trace_count", cap: caps.max_trace_count, observed: usage.tracesRead, unit: "traces" },
    { kind: "time_budget_sec", cap: caps.time_budget_sec, observed: usage.elapsedSec, unit: "s" },
    { kind: "cost_budget_usd", cap: caps.cost_budget_usd, observed: usage.estimatedCostUsd, unit: "USD" },
  ];

  for (const { kind, cap, observed, unit } of order) {
    if (!cap.active) continue; // D1 — inactive caps never trip.
    if (observed > cap.value) {
      return {
        stop: true,
        trip: {
          kind,
          limit: cap.value,
          observed,
          banner:
            `⛔ Deep-read STOPPED — ${kind} cap exceeded ` +
            `(${observed} ${unit} > ${cap.value} ${unit}). ` +
            `Emitting findings gathered so far. (R2.1${kind === "cost_budget_usd" ? "" : "/D1"})`,
        },
      };
    }
  }

  return { stop: false, trip: null };
}

/**
 * Compute elapsed seconds from an injectable start + now. Keeping the clock OUT
 * of enforceCaps preserves determinism in tests (pass both timestamps).
 */
export function elapsedSeconds(startMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - startMs) / 1000);
}

// ── Wave-17 Block B: expanded-first-pass cap reconciliation ──────────────────
//
// The awareness rework (llm-sample.ts) expands the discovery first-pass from 5 to
// ~12-15 traces for statistical power. Those traces are LLM-read, so per R2.1 cap
// accounting they COUNT against max_trace_count exactly like any deep-read trace
// (CapUsage.tracesRead doc-comment: "counts awareness-layer traces too — no
// double-count"). A naive expanded sample could therefore blow the deep-read
// budget on a small remaining headroom. reconcileFirstPass() clamps the requested
// first-pass size to the headroom left under the active max_trace_count cap, BEFORE
// the sample is drawn — so the expanded pass never overshoots the budget.

export interface FirstPassReconcileInput {
  /** The size the sampler WANTS for the expanded discovery first-pass (e.g. 12). */
  requested: number;
  /** Traces already LLM-read this run (awareness + deep-read), per CapUsage.tracesRead. */
  alreadyRead: number;
  /** Marginal candidate count after ledger-subtraction — the true upper bound. */
  availableCandidates: number;
}

export interface FirstPassReconcileResult {
  /** The reconciled first-pass size to actually draw (>= 0). */
  granted: number;
  /** True when `granted < requested` because a bound (cap or candidates) clamped it. */
  clamped: boolean;
  /** Why the value was clamped (or "ok" when granted === requested). */
  reason: string;
}

/**
 * Wave-17 Block B (R2.1 accounting): reconcile the expanded first-pass size against
 * the deep-read max_trace_count cap and the marginal-candidate ceiling.
 *
 * The granted size is the minimum of three bounds:
 *   1. `requested`                              — what the sampler asked for.
 *   2. `availableCandidates`                    — can't sample more than exist (post-ledger).
 *   3. headroom = cap.value - alreadyRead       — remaining budget under the active cap.
 *
 * When max_trace_count is INACTIVE (D1 toggle), only bounds 1 + 2 apply (the cap
 * imposes no headroom limit). Headroom is floored at 0 — an already-exhausted
 * budget grants nothing. Pure + deterministic: no clock, no random, no I/O.
 */
export function reconcileFirstPass(
  caps: CapsConfig,
  input: FirstPassReconcileInput
): FirstPassReconcileResult {
  const requested = Math.max(0, Math.floor(input.requested));
  const candidates = Math.max(0, Math.floor(input.availableCandidates));

  // Bound by marginal candidates first (always applies).
  let granted = Math.min(requested, candidates);
  let reason = granted < requested ? "clamped to available marginal candidates (post-ledger)" : "ok";

  // Bound by remaining cap headroom — only when the max-trace cap is ACTIVE (D1).
  const cap = caps.max_trace_count;
  if (cap.active) {
    const headroom = Math.max(0, Math.floor(cap.value) - Math.max(0, Math.floor(input.alreadyRead)));
    if (headroom < granted) {
      granted = headroom;
      reason = "clamped to remaining max_trace_count headroom (R2.1 cap accounting)";
    }
  }

  return {
    granted,
    clamped: granted < requested,
    reason: granted === requested ? "ok" : reason,
  };
}

/**
 * Merge a partial caps override (e.g. from config.yaml) onto DEFAULT_CAPS. Each
 * cap field is overridden wholesale when present. Pure.
 */
export function resolveCaps(override?: Partial<CapsConfig>): CapsConfig {
  return {
    max_trace_count: override?.max_trace_count ?? DEFAULT_CAPS.max_trace_count,
    time_budget_sec: override?.time_budget_sec ?? DEFAULT_CAPS.time_budget_sec,
    cost_budget_usd: override?.cost_budget_usd ?? DEFAULT_CAPS.cost_budget_usd,
  };
}

// ── CLI entrypoint (PRD-SO-05) ────────────────────────────────────────────────
//
// Usage:
//   bun scripts/cli/run.sh scripts/sample/caps.ts --output <file>
//
// Reads usage from --tracesRead, --elapsedSec, --estimatedCostUsd and evaluates
// the caps. Writes a JSON result { stop, trip, capsConfig } to --output.
// When --output is omitted, result is printed to stdout.
//
// OPERATOR OVERRIDE: --max-trace <N> raises (or lowers) the active max_trace_count
// ceiling ON COMMAND — e.g. `--max-trace 5000` lets a fresh run read up to 5000 traces
// instead of the 1000 default. Operator-explicit only; with no flag the 1000 default holds.

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const args = process.argv.slice(2);

  function argNum(flag: string, fallback: number): number {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1] !== undefined) {
      const v = Number(args[idx + 1]);
      return isNaN(v) ? fallback : v;
    }
    return fallback;
  }

  const tracesRead = argNum("--tracesRead", 0);
  const elapsedSec = argNum("--elapsedSec", 0);
  const estimatedCostUsd = argNum("--estimatedCostUsd", 0);

  const outputIdx = args.indexOf("--output");
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;

  // Operator-explicit max-trace override (raises the ceiling above the 1000 default ON COMMAND).
  const maxTraceOverride = argNum("--max-trace", 0);
  const overrideActive = Number.isFinite(maxTraceOverride) && maxTraceOverride > 0;
  const caps: CapsConfig = overrideActive
    ? resolveCaps({ max_trace_count: { active: true, value: Math.floor(maxTraceOverride) } })
    : DEFAULT_CAPS;

  const usage: CapUsage = { tracesRead, elapsedSec, estimatedCostUsd };
  const result = enforceCaps(caps, usage);

  const out = {
    stop: result.stop,
    trip: result.trip,
    capsConfig: caps,
    usage,
    maxTraceOverride: overrideActive ? Math.floor(maxTraceOverride) : null,
  };

  const json = JSON.stringify(out, null, 2);
  if (outputPath) {
    writeFileSync(resolve(outputPath), json, "utf-8");
    console.info(`caps-result written to ${outputPath}`);
  } else {
    console.info(json);
  }
}
