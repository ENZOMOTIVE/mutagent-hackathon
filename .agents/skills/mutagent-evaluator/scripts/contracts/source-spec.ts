/**
 * scripts/contracts/source-spec.ts — FU-3 multi-source ingestion config contract.
 * ---------------------------------------------------------------------------
 * The evaluator's `load-traces.ts` was a single local-NDJSON parser. FU-3 makes
 * ingestion `sources[]`-driven: one run resolves N named sources (a live
 * Langfuse project + local NDJSON exports + …), each normalized to the EXISTING
 * `EvalTrace` shape. This file is the typed gateway: untyped YAML/JSON config →
 * a validated `SourcesConfig` the ingester trusts.
 *
 * SECRET-SAFETY (DEC-11 + worktree secret-safety): a `SourceSpec` carries env-var
 * NAME references ONLY (e.g. `creds_ref.secret_key = "MYSOURCE_LANGFUSE_SECRET_KEY"`),
 * never a raw secret. The closed-object schema (`additionalProperties: false`)
 * makes a stray `*_value` field a HARD validation error — a raw key can never
 * accidentally validate. The ingester resolves the names against `process.env`
 * at fetch time (ingest-sources.ts); the value never touches disk/logs/git.
 *
 * Field-name authority: the implementation handover defines the shipped contract
 * (`id` · `kind` · `creds_ref` · `fetch_policy{page_size,concurrency,delay_ms,
 * sample_cap}`). The forward-looking `.mutagent/sources.draft.yaml` used slightly
 * different local field names (`endpoint_ref`, `max_concurrency`, `min_delay_ms`)
 * — those are the operator's local draft, reconciled to these contract names here.
 *
 * PURE: validate + narrow only. No clock / random / network / fs. Mirrors the
 * guarded-parse style of `parseSubjectVocab` (THROW on the first schema error).
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The config schema version for the `sources[]` capability. Bumped from the
 * orchestrator's single-`observability` config (0.1.0) — multi-source ingestion
 * is the new (additive) shape this version introduces.
 */
export const SOURCES_CONFIG_VERSION = "0.2.0";

/** The trace-source kinds the ingester knows how to fetch. Closed union. */
export const SourceKind = {
  /** A live Langfuse project, read via its public REST API (gentle, paged). */
  Langfuse: "langfuse",
  /** A local compact-NDJSON export file (one JSON trace record per line). */
  LocalNdjson: "local-ndjson",
} as const;
export type SourceKindValue = (typeof SourceKind)[keyof typeof SourceKind];

// ── TypeBox shapes ──────────────────────────────────────────────────────────

/**
 * Credential references — env-var NAMES, never raw secrets. All optional so a
 * partial spec still validates (the ingester decides which it needs per kind and
 * THROWs at fetch time if a required name is missing/unset — fail-loud, no swap).
 */
export const CredsRefSchema = Type.Object(
  {
    /** env-var name holding the source host/base URL. */
    endpoint: Type.Optional(Type.String({ minLength: 1 })),
    /** env-var name holding the public key (Langfuse Basic-auth user). */
    public_key: Type.Optional(Type.String({ minLength: 1 })),
    /** env-var name holding the secret key (Langfuse Basic-auth password). */
    secret_key: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** GENTLE fetch policy — bound load on the source. All optional (defaults applied
 *  by the ingester, NOT the parser — the parser stays pure). */
export const FetchPolicySchema = Type.Object(
  {
    /** records per page (Langfuse list pagination). Ingester default: 25. */
    page_size: Type.Optional(Type.Integer({ minimum: 1 })),
    /** max concurrent in-flight requests. Ingester default: 1 (serial, gentle). */
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    /** delay between pages, ms. Ingester default: 0. */
    delay_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    /** stop after this many records (a single run's cap). */
    sample_cap: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type FetchPolicy = Static<typeof FetchPolicySchema>;

export const SourceSpecSchema = Type.Object(
  {
    /** stable, unique source id (indexes the per-source counts in a run log). */
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal(SourceKind.Langfuse),
      Type.Literal(SourceKind.LocalNdjson),
    ]),
    /** local-ndjson: the export file path (relative to the run cwd). */
    path: Type.Optional(Type.String({ minLength: 1 })),
    /** langfuse: env-var-name credential refs (never raw secrets). */
    creds_ref: Type.Optional(CredsRefSchema),
    /** langfuse: the project to read (informational; scoped by the creds). */
    project: Type.Optional(Type.String({ minLength: 1 })),
    fetch_policy: Type.Optional(FetchPolicySchema),
  },
  { additionalProperties: false },
);
export type SourceSpec = Static<typeof SourceSpecSchema>;

export const SourcesConfigSchema = Type.Object(
  {
    config_version: Type.String({ minLength: 1 }),
    sources: Type.Array(SourceSpecSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type SourcesConfig = Static<typeof SourcesConfigSchema>;

// ── Guarded parse ───────────────────────────────────────────────────────────

/**
 * Validate + narrow an unknown value to `SourcesConfig`. THROWS with the first
 * schema error (path + message) when the value does not match — a malformed
 * sources config must never silently reach the ingester. Additionally enforces a
 * cross-field invariant TypeBox can't express: source ids are UNIQUE (they key
 * the per-source counts; a duplicate would collide).
 */
export function parseSourcesConfig(value: unknown): SourcesConfig {
  if (!Value.Check(SourcesConfigSchema, value)) {
    const first = [...Value.Errors(SourcesConfigSchema, value)][0];
    const where = first?.path ?? "(root)";
    const msg = first?.message ?? "does not match SourcesConfig";
    throw new Error(`parseSourcesConfig: invalid sources config at ${where}: ${msg}`);
  }
  const seen = new Set<string>();
  for (const s of value.sources) {
    if (seen.has(s.id)) {
      throw new Error(
        `parseSourcesConfig: duplicate source id '${s.id}' — source ids must be unique`,
      );
    }
    seen.add(s.id);
  }
  return value;
}
