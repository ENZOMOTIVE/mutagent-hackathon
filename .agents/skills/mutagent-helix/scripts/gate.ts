import { lookupRoute } from "./dispatch.ts";
import {
  checkOnboardingComplete,
  SOURCE_STAGES,
} from "./onboarding-check.ts";
import type { MissingKey } from "./onboarding-check.ts";
import type { MutagentConfig } from "./config-schema.ts";
import type { AdlStageValue } from "./handover-contract.ts";

// ---------------------------------------------------------------------------
// O8 — execution gating.
//
// gateExecution adjudicates whether a resolved *command may EXECUTE, given the
// current config + a small ctx. It enforces TWO floors and nothing else:
//
//   1. ONBOARDING floor — for a command whose ROUTING stage is a SOURCE stage
//      (evaluate / diagnose — the stages that consume traces), it calls
//      checkOnboardingComplete(config, [stage]) and, if incomplete, blocks with
//      the EXACT missing keys carried through. CRITICAL: this is the
//      shape-vs-completeness split (iter-4 rediscovery #1) — completeness is the
//      completion-check's job; this gate calls it, it does NOT tighten the config
//      schema. *audit routes to the evaluator but its routing stage is Audit,
//      which is NOT a source stage — so *audit does not demand a source.
//
//   2. APPROVAL floor — a `gated` command (CLI install / apply: *diagnose,
//      *onboard) is blocked 'approval-required' unless ctx.approval_granted. This
//      is §4's "CLI-install approval gate, ALWAYS required"; orchestrator-led
//      batch-approval (after platforms are configured) sets approval_granted.
//      Standalone + sandboxed clients still gate.
//
// allowed = blockers.length === 0.
//
// Pure + deterministic: no I/O, no clock, no random. Reuses the SAME route table
// as scripts/dispatch.ts via lookupRoute — one source of truth for the routing
// stage + the gated flag (same-package import, not a sealed-sibling cross-ref).
// ---------------------------------------------------------------------------

/** A single reason a command is blocked from executing. Discriminated on `kind`. */
export type Blocker =
  | {
      kind: "onboarding-incomplete";
      /** The exact config keys still required (from checkOnboardingComplete). */
      missing: MissingKey[];
      reason: string;
    }
  | {
      kind: "approval-required";
      reason: string;
    };

export interface GateResult {
  /** True iff there are no blockers. */
  allowed: boolean;
  blockers: Blocker[];
}

/** The small injected context the gate reads. */
export interface GateContext {
  /**
   * Set when the operator has granted approval for a gated command (the
   * orchestrator-led batch-approval after platforms are configured). Absent /
   * false ⇒ a gated command is blocked.
   */
  approval_granted?: boolean;
}

/** True iff `stage` is a SOURCE stage (consumes an observability source). */
function isSourceStage(stage: AdlStageValue): boolean {
  return SOURCE_STAGES.includes(stage);
}

/**
 * Adjudicate whether `command` may execute against `config`.
 *
 * @param command the resolved *command (with or without a leading `*`).
 * @param config  the parsed (possibly partial) MutagentConfig.
 * @param ctx     gate context (approval_granted for gated commands).
 * @returns { allowed, blockers } — allowed iff blockers is empty.
 *
 * Pure + deterministic. An unrecognized command (no route) has no applicable
 * floor and returns allowed:true with no blockers — command recognition is the
 * dispatch layer's job (it returns an explicit `unknown` descriptor); the gate
 * only adjudicates the onboarding + approval floors.
 */
export function gateExecution(
  command: string,
  config: MutagentConfig,
  ctx: GateContext = {},
): GateResult {
  const blockers: Blocker[] = [];
  const route = lookupRoute(command);

  // ── 1. ONBOARDING floor (source stages only) ────────────────────────────────
  // Only a dispatch command carries a routing adl_stage; a source stage among
  // them (evaluate / diagnose) must clear onboarding before it can run.
  const stage = route?.adl_stage;
  if (stage !== undefined && isSourceStage(stage)) {
    const status = checkOnboardingComplete(config, [stage]);
    if (!status.complete) {
      blockers.push({
        kind: "onboarding-incomplete",
        missing: status.missing,
        reason: `onboarding is incomplete for the ${stage} stage — ${status.missing
          .map((m) => m.key)
          .join(", ")}`,
      });
    }
  }

  // ── 2. APPROVAL floor (gated commands) ──────────────────────────────────────
  if (route?.gated === true && ctx.approval_granted !== true) {
    blockers.push({
      kind: "approval-required",
      reason:
        "this command is gated (CLI install / apply) — explicit operator approval is required",
    });
  }

  return { allowed: blockers.length === 0, blockers };
}
