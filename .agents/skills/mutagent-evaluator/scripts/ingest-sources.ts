/**
 * scripts/ingest-sources.ts — FU-3 multi-source ingestion (the BLOCKER).
 * ---------------------------------------------------------------------------
 * Resolves a `sources[]` config (contracts/source-spec.ts) into the EXISTING
 * `EvalTrace` shape. One run fans across N named sources — a live Langfuse
 * project + local NDJSON exports — and aggregates them so downstream
 * (sample-traces / profile-subject / discover) consumes the result UNCHANGED
 * (no downstream contract change). This is the prerequisite for a REAL
 * `*discover` / sample / profile (the engine was single-local-NDJSON before).
 *
 * Architecture (mirrors the package's pure-core + DI-seam + lazy-effect style):
 *   - `ingestSources(config, fetchers)` is the PURE-given-fetchers orchestration
 *     core: it resolves each source via its registered fetcher (a DI seam),
 *     maps every raw record through the SV-1-tolerant `mapRecord` (load-traces),
 *     and aggregates per-source + total counts. Deterministic in config order.
 *     The deterministic gate injects FIXTURE fetchers (no network, no creds).
 *   - `localNdjsonFetcher` / `langfuseFetcher` are the EFFECTFUL leaves (fs /
 *     network). `langfuseFetcher` resolves creds from `creds_ref → process.env`
 *     at call time, uses global `fetch` (no SDK), honors the GENTLE fetch_policy,
 *     and NEVER logs a secret value.
 *
 * SECRET-SAFETY: credentials are read ONLY via env-var-name refs; values stay in
 * memory for the Basic-auth header and are never written to disk/logs/git. A
 * missing referenced var THROWS naming only the VARIABLE, never a value.
 */
import { existsSync, readFileSync } from "node:fs";
import { mapRecord } from "./load-traces.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";
import {
  SourceKind,
  type SourceKindValue,
  type SourceSpec,
  type SourcesConfig,
  type FetchPolicy,
} from "./contracts/source-spec.ts";

// ── DI seam: a fetcher per source kind ──────────────────────────────────────

/** Raw records pulled from a source, BEFORE EvalTrace mapping (mapping is
 *  centralized in `ingestSources` so SV-1 runs identically for every kind). */
export interface RawSourceBatch {
  records: Record<string, unknown>[];
  /** records/lines that failed to parse at fetch time (skipped + surfaced). */
  malformed: number;
}

/** Fetch the raw batch for one source spec. The effectful leaf; injected so the
 *  gate can substitute a deterministic mock. */
export type SourceFetcher = (spec: SourceSpec) => Promise<RawSourceBatch>;

/** kind → fetcher. Partial: a run only needs fetchers for the kinds it uses; a
 *  missing one for a referenced kind FAILS LOUD (never a silent skip). */
export type FetcherRegistry = Partial<Record<SourceKindValue, SourceFetcher>>;

// ── Result shapes ───────────────────────────────────────────────────────────

export interface PerSourceResult {
  id: string;
  kind: SourceKindValue;
  /** EvalTraces successfully mapped from this source. */
  traces: number;
  /** malformed records skipped for this source. */
  malformed: number;
}

export interface IngestResult {
  /** all sources' traces, in config order — the existing EvalTrace shape. */
  traces: EvalTrace[];
  perSource: PerSourceResult[];
  totalMalformed: number;
}

/**
 * Resolve a `sources[]` config to EvalTrace[]. PURE given `fetchers`: sources are
 * processed in CONFIG ORDER (deterministic); each raw record is normalized via
 * the SV-1-tolerant `mapRecord`. THROWS (fail-loud) when a source references a
 * kind with no registered fetcher — ingestion never silently drops a source.
 */
export async function ingestSources(
  config: SourcesConfig,
  fetchers: FetcherRegistry,
): Promise<IngestResult> {
  const traces: EvalTrace[] = [];
  const perSource: PerSourceResult[] = [];
  let totalMalformed = 0;

  for (const spec of config.sources) {
    const fetcher = fetchers[spec.kind];
    if (fetcher === undefined) {
      throw new Error(
        `ingestSources: no fetcher registered for source '${spec.id}' of kind ` +
          `'${spec.kind}'. Register a fetcher for this kind, or remove the source.`,
      );
    }
    const batch = await fetcher(spec);
    const mapped = batch.records.map((r) => mapRecord(r));
    traces.push(...mapped);
    perSource.push({
      id: spec.id,
      kind: spec.kind,
      traces: mapped.length,
      malformed: batch.malformed,
    });
    totalMalformed += batch.malformed;
  }

  return { traces, perSource, totalMalformed };
}

// ── Effectful leaf: local NDJSON ────────────────────────────────────────────

/**
 * Read a local compact-NDJSON export (one JSON record per line). Tolerant: blank
 * lines are ignored, malformed lines are SKIPPED + COUNTED (a multi-GB export
 * must not abort on one bad line). Returns RAW records — mapping happens in
 * `ingestSources`. THROWS only when the file path itself is missing/unspecified.
 */
export const localNdjsonFetcher: SourceFetcher = async (
  spec: SourceSpec,
): Promise<RawSourceBatch> => {
  if (spec.path === undefined || spec.path === "") {
    throw new Error(`localNdjsonFetcher: source '${spec.id}' has no 'path' set.`);
  }
  if (!existsSync(spec.path)) {
    throw new Error(`localNdjsonFetcher: file not found for '${spec.id}': ${spec.path}`);
  }
  const text = readFileSync(spec.path, "utf8");
  const records: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      malformed += 1;
    }
  }
  const cap = spec.fetch_policy?.sample_cap;
  return {
    records: typeof cap === "number" ? records.slice(0, cap) : records,
    malformed,
  };
};

// ── Effectful leaf: Langfuse REST (live source) ─────────────────────────────

export interface LangfuseCreds {
  endpoint: string;
  publicKey: string;
  secretKey: string;
}

/**
 * Resolve a Langfuse source's credentials from env-var-NAME refs. Takes the env
 * map EXPLICITLY (defaults to process.env) so it is testable without mutating
 * the real environment. THROWS (fail-loud, no swap) when `creds_ref` is absent or
 * a referenced variable is unset — the error names the VARIABLE, NEVER a value
 * (secret-safety: a leaked secret must never reach a log/exception string).
 */
export function resolveLangfuseCreds(
  spec: SourceSpec,
  env: Record<string, string | undefined> = process.env,
): LangfuseCreds {
  const ref = spec.creds_ref;
  if (ref === undefined) {
    throw new Error(
      `resolveLangfuseCreds: source '${spec.id}' (langfuse) has no 'creds_ref'. ` +
        "Provide endpoint/public_key/secret_key env-var NAME refs.",
    );
  }
  const need = (name: string | undefined, field: string): string => {
    if (name === undefined || name === "") {
      throw new Error(
        `resolveLangfuseCreds: source '${spec.id}' creds_ref.${field} is not set ` +
          "(expected an env-var NAME).",
      );
    }
    const val = env[name];
    if (val === undefined || val === "") {
      throw new Error(
        `resolveLangfuseCreds: env var '${name}' (creds_ref.${field} for source ` +
          `'${spec.id}') is unset. Source the creds first (.mutagent/.env). ` +
          "NOT substituting another source.",
      );
    }
    return val;
  };
  return {
    endpoint: need(ref.endpoint, "endpoint").replace(/\/+$/, ""),
    publicKey: need(ref.public_key, "public_key"),
    secretKey: need(ref.secret_key, "secret_key"),
  };
}

/** GENTLE fetch-policy defaults (handover): page 25, serial, no delay. */
function policyWithDefaults(p: FetchPolicy | undefined): Required<Pick<FetchPolicy, "page_size" | "concurrency" | "delay_ms">> & { sample_cap?: number } {
  return {
    page_size: p?.page_size ?? 25,
    concurrency: p?.concurrency ?? 1,
    delay_ms: p?.delay_ms ?? 0,
    sample_cap: p?.sample_cap,
  };
}

/** Pure async sleep (used to space out gentle paged fetches). */
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Fetch raw trace records from a live Langfuse project via its public REST API
 * (`GET {host}/api/public/traces?page=&limit=`, HTTP Basic auth = public:secret).
 * Honors the GENTLE fetch_policy (page_size · serial paging · inter-page delay ·
 * sample_cap). Uses global `fetch` — NO SDK dependency. Secrets are used only to
 * build the Authorization header and are never logged. EFFECTFUL (network); only
 * the CLI / a real smoke constructs this — the gate uses a mock fetcher.
 */
export const langfuseFetcher: SourceFetcher = async (
  spec: SourceSpec,
): Promise<RawSourceBatch> => {
  const creds = resolveLangfuseCreds(spec);
  const policy = policyWithDefaults(spec.fetch_policy);
  const auth = "Basic " + Buffer.from(`${creds.publicKey}:${creds.secretKey}`).toString("base64");

  const records: Record<string, unknown>[] = [];
  let malformed = 0;
  let page = 1;
  // Serial paging (concurrency is intentionally 1 by default — be gentle).
  for (;;) {
    const limit = policy.page_size;
    const url = `${creds.endpoint}/api/public/traces?page=${page}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) {
      // Surface status WITHOUT the auth header / secret.
      throw new Error(
        `langfuseFetcher: source '${spec.id}' GET /api/public/traces page ${page} ` +
          `failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { data?: unknown };
    const data = Array.isArray(body.data) ? body.data : [];
    if (data.length === 0) break;
    for (const rec of data) {
      if (rec !== null && typeof rec === "object") {
        records.push(rec as Record<string, unknown>);
      } else {
        malformed += 1;
      }
      if (policy.sample_cap !== undefined && records.length >= policy.sample_cap) {
        return { records, malformed };
      }
    }
    if (data.length < limit) break; // last page
    page += 1;
    await sleep(policy.delay_ms);
  }
  return { records, malformed };
};

/** The default registry of real (effectful) fetchers used by the CLI + smoke. */
export const DEFAULT_FETCHERS: FetcherRegistry = {
  [SourceKind.LocalNdjson]: localNdjsonFetcher,
  [SourceKind.Langfuse]: langfuseFetcher,
};

// ── CLI entrypoint ──────────────────────────────────────────────────────────
//
// Usage: bun scripts/ingest-sources.ts <sources.yaml>
// Reads + parses + validates a sources config, runs the DEFAULT (effectful)
// fetchers, and prints a SECRET-FREE run log: per-source kind + trace + malformed
// counts and the totals. It prints NO trace content and NO credentials.

declare const Bun: { argv: string[] } | undefined;

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const path = argv[0];
  if (!path) {
    console.error("usage: ingest-sources.ts <sources.yaml|.json>");
    process.exit(2);
    return;
  }
  // Lazy imports — keep the deterministic gate from loading fs-yaml at module load.
  const { readFileSync: rf } = await import("node:fs");
  const { parse: parseYaml } = await import("yaml");
  const { parseSourcesConfig } = await import("./contracts/source-spec.ts");

  const raw = rf(path, "utf8");
  const config = parseSourcesConfig(parseYaml(raw) as unknown);
  const result = await ingestSources(config, DEFAULT_FETCHERS);

  console.info(
    JSON.stringify(
      {
        config_version: config.config_version,
        sources: result.perSource.length,
        perSource: result.perSource,
        totalTraces: result.traces.length,
        totalMalformed: result.totalMalformed,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
