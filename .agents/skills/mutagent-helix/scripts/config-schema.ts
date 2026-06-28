import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { parse as parseYaml } from "yaml";

import { AdlStage } from "./handover-contract.ts";

// ---------------------------------------------------------------------------
// C1-C3 — the MutagentConfig schema for `~/.mutagent/config.yaml`.
//
// ONE config file drives the orchestrator + all skills (PRD §6). It has three
// top-level blocks:
//
//   shared   — the cross-cutting base: provider credential REFS, repo/workspace,
//              default + pinned-judge models, brand/theme.
//   stages   — per-ADL-stage settings; the consuming stages (evaluate/diagnose)
//              carry an `observability` source (where traces come from).
//   triggers — a SEPARATE per-stage block of trigger rules. It ships DISABLED
//              (enabled:false, empty rules). The always-on monitor that would
//              consume triggers is FUTURE + out-of-scope here — no auto-fire,
//              no cron (feedback_self_diagnostics_on_demand_only). The schema
//              supports the block so the future monitor has a home, but the
//              shipped default is OFF.
//
// SHAPE vs COMPLETENESS — a deliberate split:
//   - This SCHEMA enforces SHAPE only: closed objects (additionalProperties:false
//     at every level), correct types, the frozen version, valid enum values. A
//     present provider must carry both `name` and `credentials_ref`.
//   - It does NOT enforce onboarding completeness. The sub-fields of `shared`
//     are OPTIONAL so a PARTIAL, mid-onboarding config still validates
//     STRUCTURALLY. Whether a config is COMPLETE (has creds, a repo, models, a
//     source for each active stage) is the job of scripts/onboarding-check.ts.
//   - Consequence (by design, per the iter-4 contract): a raw-secret-SHAPED
//     `credentials_ref` still validates structurally — the schema cannot tell a
//     leaked secret from an env-var ref. The no-raw-secret rule is a CONVENTION
//     enforced by docs + review; fixtures use env-var NAMES only.
//
// Design invariants (mirror scripts/handover-contract.ts + scripts/sync-index.ts):
//   - Pure functions + a thin CLI wrapper. No clock, no random, no network.
//   - `loadConfig` reads an INJECTED path — never the real `~/.mutagent`. `~`
//     expansion happens only in the thin CLI, never in the pure core, so tests
//     stay deterministic against committed fixtures.
//
// NOTE: the per-stage keys reuse the ROUTING `AdlStage` enum exported from
// handover-contract.ts (same package — allowed). That set (build|evaluate|
// diagnose|improve|audit) is the routed-ACTION classification; it intentionally
// differs from sync-index.ts's directory-CLASSIFICATION enum. Don't conflate.
// ---------------------------------------------------------------------------

/** The FROZEN config-contract version. Bump only via an explicit migration. */
export const CONFIG_VERSION = "0.1.0" as const;

// ── Categorical constants (no magic strings) ────────────────────────────────

/**
 * Observability source platforms a stage can pull traces from. Closed enum →
 * the config audit can detect an undeclared / typo'd platform. Mirrors the
 * source platforms the diagnostics + evaluator skills support.
 */
export const ObservabilityPlatform = {
  Langfuse: "langfuse",
  Otel: "otel",
  LocalJsonl: "local-jsonl",
  ClaudeCode: "claude-code",
  Codex: "codex",
} as const;
export type ObservabilityPlatformValue =
  (typeof ObservabilityPlatform)[keyof typeof ObservabilityPlatform];

// ── TypeBox schemas (closed objects at every level) ─────────────────────────

/**
 * A provider credential REFERENCE — `credentials_ref` is an ENV-VAR NAME, never
 * a raw secret value (no-raw-secret contract; enforced by convention + review,
 * not by the schema). A present provider must carry both fields.
 */
export const ProviderSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    credentials_ref: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Provider = Static<typeof ProviderSchema>;

/** Repo + workspace location. Relative `path` only (determinism: never absolute). */
export const WorkspaceSchema = Type.Object(
  {
    repo: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Workspace = Static<typeof WorkspaceSchema>;

/** The default model + the pinned judge model. */
export const ModelsSchema = Type.Object(
  {
    default: Type.Optional(Type.String({ minLength: 1 })),
    pinned_judge: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Models = Static<typeof ModelsSchema>;

/** Dashboard brand / theme styling (the adapter-logo look-and-feel). */
export const BrandSchema = Type.Object(
  {
    theme: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Brand = Static<typeof BrandSchema>;

/**
 * The shared cross-cutting base. Sub-fields are OPTIONAL on purpose — a partial,
 * mid-onboarding config still validates structurally; completeness is the
 * onboarding check's concern, not the schema's.
 */
export const SharedSchema = Type.Object(
  {
    providers: Type.Optional(Type.Array(ProviderSchema)),
    workspace: Type.Optional(WorkspaceSchema),
    models: Type.Optional(ModelsSchema),
    brand: Type.Optional(BrandSchema),
  },
  { additionalProperties: false },
);
export type Shared = Static<typeof SharedSchema>;

/** Where a stage reads traces from (evaluator + diagnostics care). */
export const ObservabilitySchema = Type.Object(
  {
    platform: Type.Union([
      Type.Literal(ObservabilityPlatform.Langfuse),
      Type.Literal(ObservabilityPlatform.Otel),
      Type.Literal(ObservabilityPlatform.LocalJsonl),
      Type.Literal(ObservabilityPlatform.ClaudeCode),
      Type.Literal(ObservabilityPlatform.Codex),
    ]),
    // Optional project / dataset namespace within the platform.
    project: Type.Optional(Type.String({ minLength: 1 })),
    // Optional endpoint REFERENCE (env-var name) — never a raw URL with creds.
    endpoint_ref: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Observability = Static<typeof ObservabilitySchema>;

/** A per-stage settings block. `observability` is the source-platform binding. */
export const StageBlockSchema = Type.Object(
  {
    observability: Type.Optional(ObservabilitySchema),
  },
  { additionalProperties: false },
);
export type StageBlock = Static<typeof StageBlockSchema>;

/** Per-stage settings, keyed by the routing AdlStage. Every stage optional. */
export const StagesSchema = Type.Object(
  {
    [AdlStage.Build]: Type.Optional(StageBlockSchema),
    [AdlStage.Evaluate]: Type.Optional(StageBlockSchema),
    [AdlStage.Diagnose]: Type.Optional(StageBlockSchema),
    [AdlStage.Improve]: Type.Optional(StageBlockSchema),
    [AdlStage.Audit]: Type.Optional(StageBlockSchema),
  },
  { additionalProperties: false },
);
export type Stages = Static<typeof StagesSchema>;

/**
 * One trigger rule (FUTURE monitor input). Closed → auditable. Minimal by
 * design: the consuming always-on monitor is out-of-scope this iteration, so
 * the shape is intentionally small (an event + an optional stage/command to run).
 */
export const TriggerRuleSchema = Type.Object(
  {
    on: Type.String({ minLength: 1 }),
    run: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type TriggerRule = Static<typeof TriggerRuleSchema>;

/**
 * A per-stage trigger block. Ships DISABLED: `enabled` defaults false, `rules`
 * defaults empty. No auto-fire / no cron — the always-on monitor is future +
 * out-of-scope (feedback_self_diagnostics_on_demand_only).
 */
export const TriggerStageBlockSchema = Type.Object(
  {
    enabled: Type.Boolean({ default: false }),
    rules: Type.Array(TriggerRuleSchema, { default: [] }),
  },
  { additionalProperties: false },
);
export type TriggerStageBlock = Static<typeof TriggerStageBlockSchema>;

/** Per-stage trigger blocks, keyed by routing AdlStage. Every stage optional. */
export const TriggersSchema = Type.Object(
  {
    [AdlStage.Build]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Evaluate]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Diagnose]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Improve]: Type.Optional(TriggerStageBlockSchema),
    [AdlStage.Audit]: Type.Optional(TriggerStageBlockSchema),
  },
  { additionalProperties: false },
);
export type Triggers = Static<typeof TriggersSchema>;

/** The full `~/.mutagent/config.yaml` contract. Closed object — extras rejected. */
export const MutagentConfigSchema = Type.Object(
  {
    config_version: Type.Literal(CONFIG_VERSION),
    shared: Type.Optional(SharedSchema),
    stages: Type.Optional(StagesSchema),
    triggers: Type.Optional(TriggersSchema),
  },
  { additionalProperties: false },
);
export type MutagentConfig = Static<typeof MutagentConfigSchema>;

/**
 * The canonical DISABLED trigger block — the shipped default. The schema allows
 * `enabled:true` so a future monitor can opt in, but the shipped + onboarding
 * default is OFF with no rules (on-demand-only).
 */
export const DEFAULT_TRIGGER_BLOCK: TriggerStageBlock = {
  enabled: false,
  rules: [],
};

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

// Compiled checker — compiled once at module load.
const MutagentConfigChecker = TypeCompiler.Compile(MutagentConfigSchema);

/**
 * Validate an arbitrary value against the MutagentConfig contract.
 *
 * STRUCTURAL only — the compiled TypeBox checker. Catches missing / wrong-typed
 * / out-of-enum / non-frozen-version fields AND undeclared extra fields at every
 * level (additionalProperties:false). It deliberately does NOT judge onboarding
 * COMPLETENESS (that is checkOnboardingComplete's job) — so a partial config and
 * even a raw-secret-shaped credentials_ref pass here. Pure: no I/O, no clock.
 * Never throws — a non-object input yields ok:false.
 */
export function validateConfig(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (!MutagentConfigChecker.Check(obj)) {
    for (const e of MutagentConfigChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export type LoadConfigResult =
  | { ok: true; config: MutagentConfig }
  | { ok: false; errors: string[] };

/**
 * Read + YAML-parse + validate a config file at an INJECTED path. Guarded
 * parsing (mirrors sync-index.ts): a missing file, malformed YAML, or a config
 * that fails structural validation returns { ok:false, errors } — never throws.
 *
 * The path is taken VERBATIM: no `~` expansion, no env lookup. Callers that want
 * `~/.mutagent/config.yaml` expand `~` themselves (the thin CLI does this); the
 * pure core stays deterministic against committed fixtures and never reads the
 * real home-directory config.
 */
export function loadConfig(configPath: string): LoadConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    return { ok: false, errors: [`cannot read ${configPath}: ${String(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, errors: [`malformed YAML in ${configPath}: ${String(err)}`] };
  }

  const result = validateConfig(parsed);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, config: parsed as MutagentConfig };
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper. Validates a config file (with `~` expansion here, NOT in
// the pure core):
//   bun run scripts/config-schema.ts [path]   (defaults to ~/.mutagent/config.yaml)
// Exit 0 = valid; exit 1 = invalid (errors on stdout) or unreadable.
// ---------------------------------------------------------------------------

/** Expand a leading `~/` to the home dir. CLI-only — keeps the core deterministic. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(1));
  }
  return p;
}

function runCli(argv: string[]): number {
  const arg = argv.slice(2).find((a) => !a.startsWith("--"));
  const target = expandHome(arg ?? "~/.mutagent/config.yaml");

  const result = loadConfig(path.resolve(target));
  if (result.ok) {
    console.info(`[config-schema] PASS — valid MutagentConfig (${target}).`);
    return 0;
  }
  for (const e of result.errors) console.info(e);
  process.stderr.write(
    `[config-schema] FAIL — ${result.errors.length} error(s) in ${target}.\n`,
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
