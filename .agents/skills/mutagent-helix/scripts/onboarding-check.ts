import { AdlStage, type AdlStageValue } from "./handover-contract.ts";
import type { MutagentConfig, Stages } from "./config-schema.ts";

// ---------------------------------------------------------------------------
// C2 — the onboarding completion-check.
//
// PRD §6: "Orchestrator-led unified onboarding completes all steps required by
// all stages." This is the pure predicate behind that: given a (possibly
// partial) config object + the set of stages the operator will use, it reports
// whether onboarding is COMPLETE and, if not, the exact keys still missing — the
// "what onboarding still needs" surface.
//
// NOT built off *sync's `hasOnboarding`. That field means only "the skill has an
// init surface (a bin is present)" — a topology fact, NOT a completeness check.
// This is a real key-presence check against the parsed config object.
//
// PURE + deterministic: no I/O, no clock, no random. Defensive against partial /
// undefined sub-objects so it can run on a fresh, mostly-empty config.
//
// Two floors:
//   1. SHARED floor (always): ≥1 provider with a credentials_ref, workspace.repo,
//      models.default, models.pinned_judge.
//   2. SOURCE floor (per active source stage): each active stage in SOURCE_STAGES
//      (evaluate / diagnose — the stages that consume traces) needs an
//      observability.platform. Non-source stages (build / improve / audit) do
//      NOT demand a source.
// ---------------------------------------------------------------------------

/**
 * The stages that consume an observability source (where traces come from).
 * Evaluator + diagnostics care; spec / build / improve / audit do not (spec is an
 * interactive author-only stage with no trace source).
 *
 * Typed `readonly AdlStageValue[]` so `gate.ts`'s `SOURCE_STAGES.includes(stage)`
 * accepts any AdlStageValue. The members are nonetheless all valid `Stages` keys —
 * `SOURCE_STAGE_KEYS` carries that narrower fact for the safe `config.stages[stage]`
 * index in checkOnboardingComplete (`spec` is intentionally NOT a key of Stages).
 */
export const SOURCE_STAGES: readonly AdlStageValue[] = [
  AdlStage.Evaluate,
  AdlStage.Diagnose,
];

/** The same source stages, typed as `Stages` keys for a provably-safe stage-block index. */
const SOURCE_STAGE_KEYS: readonly (keyof Stages)[] = [
  AdlStage.Evaluate,
  AdlStage.Diagnose,
];

/** A single unmet onboarding requirement: the config key + why it's needed. */
export interface MissingKey {
  key: string;
  reason: string;
}

export interface OnboardingStatus {
  complete: boolean;
  /** The exact keys still required for onboarding to be complete (empty when complete). */
  missing: MissingKey[];
}

/** True iff `s` is a non-empty trimmed string. */
function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "";
}

/**
 * Check whether onboarding is complete for the given config + active stages.
 *
 * @param config       the parsed (possibly partial) MutagentConfig.
 * @param activeStages the ADL stages the operator intends to use; only active
 *                     SOURCE stages (evaluate/diagnose) demand an observability
 *                     platform.
 * @returns { complete, missing } — `missing` lists the exact keys still needed.
 *
 * Pure + deterministic: same inputs ⇒ deep-equal result. No I/O, no clock.
 */
export function checkOnboardingComplete(
  config: MutagentConfig,
  activeStages: AdlStageValue[],
): OnboardingStatus {
  const missing: MissingKey[] = [];
  const shared = config?.shared;

  // ── 1. SHARED floor ───────────────────────────────────────────────────────
  const providers = shared?.providers ?? [];
  const hasUsableProvider = providers.some((p) => hasText(p?.credentials_ref));
  if (!hasUsableProvider) {
    missing.push({
      key: "shared.providers",
      reason: "at least one provider with a credentials_ref is required",
    });
  }

  if (!hasText(shared?.workspace?.repo)) {
    missing.push({
      key: "shared.workspace.repo",
      reason: "the target repo/workspace is required",
    });
  }

  if (!hasText(shared?.models?.default)) {
    missing.push({
      key: "shared.models.default",
      reason: "a default model is required",
    });
  }

  if (!hasText(shared?.models?.pinned_judge)) {
    missing.push({
      key: "shared.models.pinned_judge",
      reason: "a pinned judge model is required",
    });
  }

  // ── 2. SOURCE floor (per active source stage) ───────────────────────────────
  // De-dup active stages so a stage listed twice can't push duplicate keys. Iterate
  // SOURCE_STAGE_KEYS (typed as `Stages` keys) so the `config.stages[stage]` index is
  // provably safe — `spec` is intentionally not a source stage and not a Stages key.
  const activeSourceStages = SOURCE_STAGE_KEYS.filter((s) => activeStages.includes(s));
  for (const stage of activeSourceStages) {
    const platform = config?.stages?.[stage]?.observability?.platform;
    if (!hasText(platform)) {
      missing.push({
        key: `stages.${stage}.observability.platform`,
        reason: `the ${stage} stage needs an observability source platform`,
      });
    }
  }

  return { complete: missing.length === 0, missing };
}
