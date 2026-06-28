import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

// ---------------------------------------------------------------------------
// O7 — the HandoverBundle contract BLUEPRINT.
//
// The typed contract the orchestrator EMITS when routing an ADL stage to a
// skill/agent (evaluate → diagnose → improve, plus the audit sibling). One
// bundle = one stage→stage handover.
//
// It is the EXPLICIT, AUDITABLE inter-stage boundary: every artifact that
// crosses between stages is enumerated in `inputs`, and the curated context
// handed down is enumerated in `context_pack` — so a downstream data-leak /
// context-flow audit (ADL Evaluator §7) can see exactly WHAT crossed the
// boundary and what was withheld (`partial_loads`). The object is CLOSED
// (additionalProperties:false at every level) so an undeclared field smuggled
// across the boundary is caught rather than silently passed.
//
// Producer-side, orchestrator-owned this iteration. Dispatch wiring (O6) lands
// later — this file only DECLARES the contract that future dispatch satisfies.
//
// Design invariants (mirror scripts/sync-index.ts):
//   - Pure functions + a thin CLI wrapper. No clock, no random, no network.
//   - Any timestamp / id / path is an INJECTED input, never self-generated, so
//     makeHandoverBundle is deterministic (same input ⇒ identical bundle) and
//     serialized fixtures are machine-independent (relative / placeholder
//     locators only).
//
// NOTE: the `adl_stage` enum here (spec|build|evaluate|diagnose|improve|audit) is the
// ROUTING-stage set. It intentionally differs from the TOPOLOGY `AdlStage` in
// sync-index.ts (which adds orchestrator|shared|unknown and omits improve|audit):
// one classifies a routed action, the other classifies a directory on disk.
// ---------------------------------------------------------------------------

/** The FROZEN contract version. Bump only via an explicit, reviewed migration. */
export const HANDOVER_BUNDLE_VERSION = "0.1.0" as const;

// ── Categorical constants (no magic strings) ───────────────────────────────
export const AdlStage = {
  Spec: "spec",
  Build: "build",
  Evaluate: "evaluate",
  Diagnose: "diagnose",
  Improve: "improve",
  Audit: "audit",
} as const;
export type AdlStageValue = (typeof AdlStage)[keyof typeof AdlStage];

export const SubjectKind = {
  Skill: "skill",
  Agent: "agent",
} as const;
export type SubjectKindValue = (typeof SubjectKind)[keyof typeof SubjectKind];

/** The artifact kinds that cross an ADL stage boundary. Closed → auditable. */
export const ArtifactKind = {
  Trace: "trace",
  Dataset: "dataset",
  Verdict: "verdict",
  Scorecard: "scorecard",
  Findings: "findings",
  Report: "report",
  Source: "source",
  Spec: "spec",
  Config: "config",
} as const;
export type ArtifactKindValue = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export const EscalationPolicy = {
  Escalate: "escalate",
  Abort: "abort",
  Proceed: "proceed",
} as const;
export type EscalationPolicyValue =
  (typeof EscalationPolicy)[keyof typeof EscalationPolicy];

// ── TypeBox schemas (closed objects at every level) ─────────────────────────

/** What is being acted on. `path` mirrors the *sync index entry path. */
export const SubjectSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal(SubjectKind.Skill),
      Type.Literal(SubjectKind.Agent),
    ]),
    name: Type.String({ minLength: 1 }),
    // Relative path under mutagent-system/ (determinism: never absolute).
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Subject = Static<typeof SubjectSchema>;

/** The NL ask + the resolved *command that triggered the route. */
export const IntentSchema = Type.Object(
  {
    // The resolved *command, e.g. "*evaluate" / "*diagnose".
    command: Type.String({ minLength: 1 }),
    // The raw NL ask, when one triggered the route (absent for direct commands).
    utterance: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Intent = Static<typeof IntentSchema>;

/**
 * A reference to a single artifact crossing the boundary. `path` (relative) OR
 * `uri` locates it — the at-least-one rule is enforced in validateHandoverBundle
 * (TypeBox alone cannot express "at least one of"). `sha` / `bytes` are optional
 * integrity / size hints.
 */
export const ArtifactRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal(ArtifactKind.Trace),
      Type.Literal(ArtifactKind.Dataset),
      Type.Literal(ArtifactKind.Verdict),
      Type.Literal(ArtifactKind.Scorecard),
      Type.Literal(ArtifactKind.Findings),
      Type.Literal(ArtifactKind.Report),
      Type.Literal(ArtifactKind.Source),
      Type.Literal(ArtifactKind.Spec),
      Type.Literal(ArtifactKind.Config),
    ]),
    // Relative path (determinism: never absolute / machine-specific).
    path: Type.Optional(Type.String({ minLength: 1 })),
    // Remote locator (e.g. a langfuse:// session uri).
    uri: Type.Optional(Type.String({ minLength: 1 })),
    sha: Type.Optional(Type.String({ minLength: 1 })),
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

/** One context item that was withheld / only partially loaded, with the why. */
export const PartialLoadSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type PartialLoad = Static<typeof PartialLoadSchema>;

/**
 * The curated context handed down (mirrors the diagnostics CONTEXT_PACK).
 * `partial_loads` is how a downstream auditor sees what was withheld / missing.
 */
export const ContextPackSchema = Type.Object(
  {
    rules: Type.Array(Type.String()),
    memory: Type.Array(Type.String()),
    partial_loads: Type.Array(PartialLoadSchema),
  },
  { additionalProperties: false },
);
export type ContextPack = Static<typeof ContextPackSchema>;

/** The goal + criteria the downstream stage must satisfy. */
export const AcceptanceSchema = Type.Object(
  {
    goal: Type.String({ minLength: 1 }),
    criteria: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type Acceptance = Static<typeof AcceptanceSchema>;

/** Who produced the bundle, and when — both INJECTED, never self-generated. */
export const ProvenanceSchema = Type.Object(
  {
    produced_by: Type.String({ minLength: 1 }),
    // INJECTED ISO-8601 stamp (never a self-read clock — keeps builds machine-independent).
    produced_at: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Provenance = Static<typeof ProvenanceSchema>;

/** The full handover-contract bundle. Closed object — undeclared fields rejected. */
export const HandoverBundleSchema = Type.Object(
  {
    bundle_version: Type.Literal(HANDOVER_BUNDLE_VERSION),
    adl_stage: Type.Union([
      Type.Literal(AdlStage.Spec),
      Type.Literal(AdlStage.Build),
      Type.Literal(AdlStage.Evaluate),
      Type.Literal(AdlStage.Diagnose),
      Type.Literal(AdlStage.Improve),
      Type.Literal(AdlStage.Audit),
    ]),
    subject: SubjectSchema,
    intent: IntentSchema,
    // The data that crosses the boundary — explicit + enumerable (leak-auditable).
    inputs: Type.Array(ArtifactRefSchema),
    context_pack: ContextPackSchema,
    acceptance: AcceptanceSchema,
    provenance: ProvenanceSchema,
    escalation_policy: Type.Union([
      Type.Literal(EscalationPolicy.Escalate),
      Type.Literal(EscalationPolicy.Abort),
      Type.Literal(EscalationPolicy.Proceed),
    ]),
  },
  { additionalProperties: false },
);
export type HandoverBundle = Static<typeof HandoverBundleSchema>;

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

// Compiled checker — the "compiled checker" path (compiled once at module load).
const HandoverBundleChecker = TypeCompiler.Compile(HandoverBundleSchema);

/**
 * Validate an arbitrary value against the HandoverBundle contract.
 *
 * Two floors:
 *   1. STRUCTURAL — the compiled TypeBox checker. Catches missing / wrong-typed
 *      / out-of-enum / non-frozen-version fields AND undeclared extra fields
 *      (additionalProperties:false — the data-leak case).
 *   2. SEMANTIC — every `inputs[]` artifact must be LOCATABLE: a relative `path`
 *      or a `uri`. An artifact with neither is an unlocatable / missing-data
 *      smell that TypeBox cannot express ("at least one of").
 *
 * Pure: no I/O, no clock. Never throws — a non-object input yields ok:false.
 */
export function validateHandoverBundle(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!HandoverBundleChecker.Check(obj)) {
    for (const e of HandoverBundleChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }

  const inputs = (obj as { inputs?: unknown } | null)?.inputs;
  if (Array.isArray(inputs)) {
    inputs.forEach((raw, i) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      const hasPath = typeof a.path === "string" && a.path.trim() !== "";
      const hasUri = typeof a.uri === "string" && a.uri.trim() !== "";
      if (!hasPath && !hasUri) {
        errors.push(
          `/inputs/${i}: artifact must carry a relative \`path\` or a \`uri\` (unlocatable artifact)`,
        );
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

// ── Builder ───────────────────────────────────────────────────────────────

/**
 * Input to makeHandoverBundle. `bundle_version` is NOT accepted — the builder
 * stamps the frozen constant. `provenance` (produced_by + produced_at) is fully
 * INJECTED by the caller; the builder never generates a timestamp or id.
 * `inputs` / `context_pack` are optional and default to empty.
 */
export interface HandoverBundleInput {
  adl_stage: AdlStageValue;
  subject: Subject;
  intent: Intent;
  acceptance: Acceptance;
  provenance: Provenance;
  escalation_policy: EscalationPolicyValue;
  inputs?: ArtifactRef[];
  context_pack?: Partial<ContextPack>;
}

/**
 * Assemble a HandoverBundle from injected input. Pure + deterministic: the same
 * input always yields a deep-equal bundle (no clock, no random). Defaults the
 * optional collections to empty so a minimal route still produces a valid,
 * fully-enumerated bundle.
 */
export function makeHandoverBundle(input: HandoverBundleInput): HandoverBundle {
  return {
    bundle_version: HANDOVER_BUNDLE_VERSION,
    adl_stage: input.adl_stage,
    subject: input.subject,
    intent: input.intent,
    inputs: input.inputs ?? [],
    context_pack: {
      rules: input.context_pack?.rules ?? [],
      memory: input.context_pack?.memory ?? [],
      partial_loads: input.context_pack?.partial_loads ?? [],
    },
    acceptance: input.acceptance,
    provenance: input.provenance,
    escalation_policy: input.escalation_policy,
  };
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper. Validates a serialized HandoverBundle JSON file:
//   bun run scripts/handover-contract.ts <bundle.json>
// Exit 0 = valid; exit 1 = invalid (errors on stdout) or bad usage. Guarded
// parsing; deterministic (the only input is the file argument).
// ---------------------------------------------------------------------------
function runCli(argv: string[]): number {
  const inputPath = argv.slice(2).find((a) => !a.startsWith("--"));
  if (inputPath === undefined) {
    process.stderr.write(
      "Usage: bun run scripts/handover-contract.ts <bundle.json>\n" +
        `Validates a serialized HandoverBundle against the frozen v${HANDOVER_BUNDLE_VERSION} ` +
        "contract. Exit 0 = valid; exit 1 = invalid (errors on stdout).\n",
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf-8"));
  } catch (err) {
    process.stderr.write(`Error reading ${inputPath}: ${String(err)}\n`);
    return 1;
  }

  const result = validateHandoverBundle(parsed);
  if (result.ok) {
    console.info("[handover-contract] PASS — valid HandoverBundle.");
    return 0;
  }
  for (const e of result.errors) console.info(e);
  process.stderr.write(
    `[handover-contract] FAIL — ${result.errors.length} error(s).\n`,
  );
  return 1;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  process.exit(runCli(argv));
}
