import {
  AdlStage,
  SubjectKind,
  makeHandoverBundle,
} from "./handover-contract.ts";
import type {
  AdlStageValue,
  Acceptance,
  ArtifactRef,
  ContextPack,
  HandoverBundle,
  Provenance,
  Subject,
  SubjectKindValue,
  EscalationPolicyValue,
} from "./handover-contract.ts";
import type { TopologyIndex } from "./sync-index.ts";

// ---------------------------------------------------------------------------
// O6 — dispatch wiring.
//
// resolveDispatch maps a resolved *command + an INJECTED context to a
// DispatchDescriptor: WHAT subject is being acted on, WHICH routing ADL stage
// it is, interactive|batch, gated, and (for a real route) the HandoverBundle
// that the orchestrator EMITS to the owning skill.
//
// THE TWO-ENUM MAPPING (the iter-3 cert flagged this as O6's core job — do NOT
// conflate the two enums):
//   - The *sync TOPOLOGY classifies a directory with one enum
//     (build|evaluate|diagnose|orchestrator|shared|unknown — a DIR classification).
//   - The routing/handover AdlStage is a different enum
//     (build|evaluate|diagnose|improve|audit — a routed ACTION).
//   This module produces the ROUTING enum from the *command, and resolves the
//   target subject's PATH from the topology. The *audit case is the proof they
//   are not the same: *audit routes to the evaluator (topology stage "evaluate")
//   but its routing stage is Audit. The command — not the subject's topology
//   classification — decides the routing stage.
//
// Producer-side, orchestrator-owned. The actual cross-skill RUNTIME invocation
// (handing the bundle to a real sibling skill) is DECLARED in orchestrator.md,
// NOT wired here. This file is the deterministic engine: resolve → (gate) → emit
// a descriptor. The descriptor's `bundle` is what a future runtime step ships.
//
// Design invariants (mirror scripts/handover-contract.ts + scripts/sync-index.ts):
//   - Pure functions + (no CLI needed — this is a library used by the gate +
//     the orchestrator's documented execution flow). No clock, no random, no
//     network. Any timestamp / id / path is an INJECTED ctx field, so the same
//     command + ctx always yields a deep-equal descriptor.
//   - The topology index is INJECTED (from *sync) rather than re-scanned, so the
//     engine stays pure + deterministic against committed fixtures.
// ---------------------------------------------------------------------------

/** Where a command runs: on the parent session (interactive) or a sub-agent (batch). */
export type DispatchMode = "interactive" | "batch";

/**
 * One row of the command → route table. Mirrors routing.yaml. A `dispatch` row
 * carries the route_target skill name + the ROUTING adl_stage; a `local` row is
 * orchestrator-internal (no subject, no bundle). `gated` is the approval flag
 * the execution gate (scripts/gate.ts) reads.
 */
export interface RouteEntry {
  type: "dispatch" | "local";
  /** The skill the *command routes to (dispatch rows only). Resolved in the topology. */
  route_target?: string;
  /** The ROUTING ADL stage (dispatch rows only) — NOT the subject's topology stage. */
  adl_stage?: AdlStageValue;
  mode: DispatchMode;
  gated: boolean;
  /** Why a local command is orchestrator-internal (local rows only). */
  reason?: string;
}

// The canonical command → route table. Data-driven mirror of routing.yaml's
// `commands` block (route_target · stage · mode · gated). The routing AdlStage
// is assigned PER COMMAND here — this is the two-enum mapping's source of truth.
const ROUTES: Readonly<Record<string, RouteEntry>> = {
  // ── dispatch commands (route to a subject, emit a bundle) ──────────────────
  "*spec": {
    type: "dispatch",
    route_target: "mutagent-agentspec",
    adl_stage: AdlStage.Spec,
    mode: "interactive", // the *spec interview runs on the parent session (AskUserQuestion is parent-only)
    gated: false, // spec gathering is read/author-only — no apply, so ungated
  },
  "*evaluate": {
    type: "dispatch",
    route_target: "mutagent-evaluator",
    adl_stage: AdlStage.Evaluate,
    mode: "batch",
    gated: false,
  },
  "*audit": {
    type: "dispatch",
    route_target: "mutagent-evaluator", // SAME target as *evaluate …
    adl_stage: AdlStage.Audit, // … but a DIFFERENT routing stage (no conflation)
    mode: "batch",
    gated: false,
  },
  "*diagnose": {
    type: "dispatch",
    route_target: "mutagent-diagnostics",
    adl_stage: AdlStage.Diagnose,
    mode: "batch",
    gated: true, // the IMPROVE (apply) step downstream is approval-gated
  },
  // ── local-only commands (orchestrator-internal — no subject, no bundle) ────
  "*sync": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal topology index — runs scripts/sync-index.ts; routes to no subject",
  },
  "*status": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal state read — routes to no subject",
  },
  "*onboard": {
    type: "local",
    mode: "interactive",
    gated: true, // CLI install is ALWAYS approval-gated (§4)
    reason: "orchestrator-led onboarding/config — local; CLI install is approval-gated",
  },
  "*help": {
    type: "local",
    mode: "interactive",
    gated: false,
    reason: "orchestrator-internal dashboard render — routes to no subject",
  },
};

// Command aliases (mirrors routing.yaml `aliases`). *config ⇒ *onboard.
const ALIASES: Readonly<Record<string, string>> = {
  "*config": "*onboard",
};

/** Normalize a command to its canonical `*name` form (adds a leading `*`, resolves aliases). */
function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const starred = trimmed.startsWith("*") ? trimmed : `*${trimmed}`;
  const lowered = starred.toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

/**
 * Look up a command's route entry (after normalization + alias resolution).
 * Returns undefined for an unrecognized command. Exported so the execution gate
 * (scripts/gate.ts) reuses the SAME route table — one source of truth for the
 * routing stage + gated flag.
 */
export function lookupRoute(command: string): RouteEntry | undefined {
  return ROUTES[normalizeCommand(command)];
}

// ── Descriptor types (discriminated union on `kind`) ─────────────────────────

/** A real stage route: a resolved subject + the HandoverBundle to emit. */
export interface DispatchDescriptor {
  kind: "dispatch";
  /** The normalized *command that produced this descriptor. */
  command: string;
  /** What is being acted on — resolved from the injected *sync topology. */
  target_subject: Subject;
  /** The ROUTING ADL stage (build|evaluate|diagnose|improve|audit). */
  adl_stage: AdlStageValue;
  mode: DispatchMode;
  gated: boolean;
  /** The bundle the orchestrator EMITS to the target skill (declare-only runtime). */
  bundle: HandoverBundle;
}

/** A local-only command (orchestrator-internal): no subject, no bundle fabricated. */
export interface LocalDescriptor {
  kind: "local";
  command: string;
  mode: DispatchMode;
  gated: boolean;
  reason: string;
}

/** An unrecognized command — explicitly typed, never coerced into a fake route. */
export interface UnknownDescriptor {
  kind: "unknown";
  command: string;
  reason: string;
}

export type Descriptor =
  | DispatchDescriptor
  | LocalDescriptor
  | UnknownDescriptor;

/**
 * The injected context resolveDispatch needs. The topology comes from *sync; the
 * bundle inputs (acceptance · provenance · escalation_policy · inputs ·
 * context_pack) are all INJECTED — provenance.produced_at especially is a passed
 * stamp, never a self-read clock, so the engine is deterministic.
 */
export interface DispatchContext {
  /** The *sync topology index — injected, never re-scanned here. */
  topology: TopologyIndex;
  /** The raw NL ask that triggered the route, when one did (optional). */
  intent?: { utterance?: string };
  /** The downstream stage's goal + criteria. */
  acceptance: Acceptance;
  /** Who/when produced the bundle — both INJECTED (no clock). */
  provenance: Provenance;
  escalation_policy: EscalationPolicyValue;
  /** Artifacts crossing the boundary (optional; defaults to empty). */
  inputs?: ArtifactRef[];
  /** The curated context handed down (optional; defaults to empty). */
  context_pack?: Partial<ContextPack>;
}

/** Map a topology entry kind ("skill"|"agent") to a HandoverBundle SubjectKind. */
function toSubjectKind(kind: string): SubjectKindValue {
  return kind === SubjectKind.Agent ? SubjectKind.Agent : SubjectKind.Skill;
}

/**
 * Resolve a *command + injected ctx to a DispatchDescriptor.
 *
 *   - dispatch command → resolve the route_target in the injected topology, build
 *     the target Subject {kind,name,path}, and BUILD the HandoverBundle (routing
 *     adl_stage from the command, subject from the topology, everything else
 *     injected via ctx). Reuses makeHandoverBundle.
 *   - local command (*sync/*status/*onboard/*help) → a non-dispatch descriptor,
 *     no subject/bundle fabricated.
 *   - unknown command → an explicit unknown descriptor.
 *
 * Pure + deterministic: same command + ctx ⇒ deep-equal descriptor. THROWS only
 * on a precondition violation — a dispatch command whose route_target is not in
 * the topology (you must *sync before you can route; an un-indexed target is
 * surfaced loudly, not fabricated).
 */
export function resolveDispatch(
  command: string,
  ctx: DispatchContext,
): Descriptor {
  const normalized = normalizeCommand(command);
  const route = ROUTES[normalized];

  if (route === undefined) {
    return {
      kind: "unknown",
      command: normalized,
      reason: `unrecognized command '${normalized}' — not in the routing table`,
    };
  }

  if (route.type === "local") {
    return {
      kind: "local",
      command: normalized,
      mode: route.mode,
      gated: route.gated,
      reason: route.reason ?? "orchestrator-internal command (routes to no subject)",
    };
  }

  // dispatch — resolve the target subject from the injected topology.
  const targetName = route.route_target;
  const entry = ctx.topology.entries.find((e) => e.name === targetName);
  if (entry === undefined) {
    throw new Error(
      `resolveDispatch: route_target '${targetName}' for '${normalized}' is not ` +
        `in the topology index (run *sync first — an un-indexed target cannot be routed)`,
    );
  }

  const target_subject: Subject = {
    kind: toSubjectKind(entry.kind),
    name: entry.name,
    path: entry.path,
  };

  const adl_stage = route.adl_stage as AdlStageValue;

  const bundle = makeHandoverBundle({
    adl_stage,
    subject: target_subject,
    intent:
      ctx.intent?.utterance !== undefined
        ? { command: normalized, utterance: ctx.intent.utterance }
        : { command: normalized },
    acceptance: ctx.acceptance,
    provenance: ctx.provenance,
    escalation_policy: ctx.escalation_policy,
    inputs: ctx.inputs,
    context_pack: ctx.context_pack,
  });

  return {
    kind: "dispatch",
    command: normalized,
    target_subject,
    adl_stage,
    mode: route.mode,
    gated: route.gated,
    bundle,
  };
}
