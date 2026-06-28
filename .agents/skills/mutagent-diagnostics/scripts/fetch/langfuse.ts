/**
 * scripts/fetch/langfuse.ts
 * R-SELF-03-b: Fetch trace metadata from Langfuse — CLI runner OR REST runner.
 *
 * Wraps `langfuse traces list --json` (CLI) OR the public REST endpoint
 * `GET /api/public/traces` (Basic auth, base64(pk:sk)) to emit
 * last-Nh-meta.json consumable by tier0-scan.ts.
 *
 * Runner selection (R-002 — F-SELF-002 fix):
 *   - `pickRunner()` probes `command -v langfuse` once.
 *   - Binary present  → `runLangfuseCli`   (legacy path, unchanged).
 *   - Binary absent   → `runLangfuseRest`  (no install needed, creds-only).
 * Tests can still inject `opts.runner` to bypass selection entirely.
 *
 * Usage: bun scripts/cli/run.sh scripts/fetch/langfuse.ts
 *   --hours N           Look back N hours (default: 24)
 *   --agent-id ID       Filter by agent ID
 *   --has-feedback      Only include traces with feedback
 *   --score-below N     Only include traces with score < N (requires scale probe)
 *   --output-dir DIR    Write last-Nh-meta.json here
 *   --no-cap            Drop the REST 10-page (1000-trace) safety cap
 *
 * R-SELF-03-c compliance: uses published Bash CLI calls, NOT inline Python heredocs.
 * Type A — Pure Script (Bash subprocess OR fetch + JSON parsing)
 */

import { execSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { URLSearchParams } from "url";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TraceMetadata } from "../normalize/trace.ts";

/** Minimal env shape — avoids depending on the `NodeJS` global namespace. */
type EnvLike = Record<string, string | undefined>;

export interface LangfuseFetchOptions {
  hours?: number;
  agentId?: string;
  hasFeedback?: boolean;
  scoreBelow?: number;
  outputDir?: string;
  /**
   * Dependency-injection seam for tests (Wave-5.1 T1). When omitted the real
   * `runLangfuseCli` shell-out is used. Unit tests pass a synthetic runner so
   * NO real `langfuse` binary is invoked and NO network call is made.
   * The runner receives the FULLY-BUILT arg string (sans the `--json` flag,
   * which `runLangfuseCli` appends) so arg-builder behavior is assertable.
   */
  runner?: LangfuseCliRunner;
  /**
   * Credential presence override for tests. When omitted, presence is read from
   * `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` in the environment. When the
   * default real runner is used and creds are absent, `fetchLangfuseTraces`
   * throws BEFORE shelling out (fail-fast, no half-built CLI call).
   */
  hasCreds?: boolean;
  /**
   * When the REST runner is active, cap pagination at 10 pages (1000 traces) by
   * default. Set `noCap: true` to drain every page Langfuse reports. Ignored by
   * the CLI runner (which the CLI itself paginates).
   */
  noCap?: boolean;
}

/**
 * Runner contract: takes the arg string `fetchLangfuseTraces` built (e.g.
 * `traces list --from "…" --has-feedback`) and returns the parsed `--json`
 * payload. The real implementation appends `--json` and shells out; the test
 * double captures the arg string and returns synthetic `LangfuseTraceRaw[]`.
 */
export type LangfuseCliRunner = (args: string) => unknown; // eslint-disable-line no-unused-vars

/** Minimal Langfuse API trace shape (from CLI --json output) */
interface LangfuseTraceRaw {
  id?: string;
  name?: string;
  sessionId?: string;
  startTime?: string;
  endTime?: string;
  latency?: number;
  totalCost?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  scores?: Array<{ name: string; value: number | string }>;
  level?: string;
  statusMessage?: string;
}

/**
 * F-S1 (PR-055 proposed): TypeBox schema for the RAW fetch result.
 *
 * The runner (CLI `--json` parse OR REST collected array) is contractually an
 * ARRAY of trace objects. Before Wave-15, `fetchLangfuseTraces` bare-cast the
 * runner output to `LangfuseTraceRaw[]` and then did `Array.isArray(raw) ? raw : []`,
 * so a NON-array response (an auth-error JSON object, a single trace object, or
 * `null`) silently collapsed to ZERO traces — a whole-corpus drop with no surface.
 *
 * This schema lets us FAIL LOUD on a malformed top-level shape instead. We only
 * assert the OUTER shape (array of objects with optional, loosely-typed fields)
 * — individual field normalization stays in `normalizeRawTrace`. `additionalProperties`
 * is allowed so unknown Langfuse fields never trip the gate (forward-compat).
 *
 * NOTE: an EMPTY array from a genuinely-empty fetch is LEGAL and passes — only
 * non-array / non-object-element shapes throw.
 */
const LangfuseTraceRawSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    latency: Type.Optional(Type.Number()),
    totalCost: Type.Optional(Type.Number()),
    tags: Type.Optional(Type.Array(Type.String())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    scores: Type.Optional(
      Type.Array(
        Type.Object(
          { name: Type.String(), value: Type.Union([Type.Number(), Type.String()]) },
          { additionalProperties: true }
        )
      )
    ),
    level: Type.Optional(Type.String()),
    statusMessage: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

const LangfuseFetchResultSchema = Type.Array(LangfuseTraceRawSchema);

/**
 * F-S1 (PR-055 proposed): fail-loud validation of the raw fetch result.
 *
 * Throws a clear, source-naming error when the runner returns anything other
 * than an array of trace-shaped objects (e.g. an auth-error JSON object, a
 * single trace, `null`, a string). Returns the value typed as
 * `LangfuseTraceRaw[]` when it validates. An empty array passes (legal empty fetch).
 *
 * `sourceLabel` names WHERE the data came from (CLI runner vs REST vs injected)
 * so the operator can see which fetch path produced the bad shape.
 */
export function validateLangfuseFetchResult(
  raw: unknown,
  sourceLabel: string
): LangfuseTraceRaw[] {
  if (!Value.Check(LangfuseFetchResultSchema, raw)) {
    // Describe the arrived shape so the error is actionable without a debugger.
    const arrived = Array.isArray(raw)
      ? `array with ${raw.length} element(s) but element shape mismatch`
      : raw === null
        ? "null"
        : typeof raw === "object"
          ? `non-array object (keys: ${Object.keys(raw as object).slice(0, 8).join(", ") || "none"})`
          : typeof raw;
    const firstErr = [...Value.Errors(LangfuseFetchResultSchema, raw)][0];
    const detail = firstErr ? ` — ${firstErr.message} at ${firstErr.path || "/"}` : "";
    throw new Error(
      `langfuse fetch: malformed result from ${sourceLabel} — expected an array of trace objects, ` +
        `got ${arrived}${detail}. A non-array response (auth-error JSON, single object, null) is NOT ` +
        `treated as zero traces — fix the source/credentials or the fetch path. ` +
        `(see references/source-platforms/langfuse.md)`
    );
  }
  return raw as LangfuseTraceRaw[];
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/**
 * Run a Langfuse CLI command and return parsed JSON output.
 * Uses `langfuse` binary — install via: npm install -g @langfuse/langfuse-cli
 *
 * The `--json` flag is appended HERE (not by the caller) so the arg string the
 * caller builds matches the `langfuse traces …` manual vocabulary exactly
 * (see references/source-platforms/langfuse.md). The Wave-5.1 T3 cli-contract
 * test asserts the built arg string against that manual to catch flag drift.
 */
export function runLangfuseCli(args: string): unknown {
  try {
    const raw = execSync(`langfuse ${args} --json`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw.trim());
  } catch (err) {
    throw new Error(`langfuse CLI error (args: ${args}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * REST runner — invariants for parity with `runLangfuseCli`:
 *   - SAME `args` contract: receives `buildTracesListArgs()` output (sans `--json`).
 *   - SAME return shape: `LangfuseTraceRaw[]` (drop-in for `normalizeRawTrace`).
 *   - SAME synchronous signature (uses `curl` via `execSync`, NOT global fetch)
 *     so the `LangfuseCliRunner` contract is preserved end-to-end and the
 *     existing sync test suite keeps passing.
 *   - Reads creds + host from `env` (defaults to `process.env`); throws fail-fast
 *     with the SAME message text as the top-level creds gate so callers see one
 *     consistent error regardless of which runner is active.
 *
 * Flag translation (documented in `references/source-platforms/langfuse.md`):
 *   --from "X"          → ?fromTimestamp=X
 *   --agent-id "Y"      → &name=Y           (REST has no agentId; `name` is the
 *                                            closest documented proxy — surface
 *                                            in the source-platform note)
 *   --has-feedback      → post-filter on `.scores.length > 0`
 *                         (REST has no native flag — superset is returned and
 *                          trimmed locally to preserve CLI semantics)
 *   --score-below N     → post-filter on `.scores[0].value < N`
 *                         (same superset-then-trim pattern as --has-feedback)
 *
 * Pagination: walks `meta.totalPages` (cap = 10 pages = 1000 traces unless
 * `runOpts.noCap` is set — propagated from `LangfuseFetchOptions.noCap`).
 *
 * Network seam: tests inject `runOpts.httpGet(url, headers) => string`
 * (returns the raw response body); production uses an `execSync("curl …")`
 * fallback. Keeps the suite byte-deterministic without globalThis monkeying.
 */
export type LangfuseHttpGet = (
  // eslint-disable-next-line no-unused-vars
  url: string,
  // eslint-disable-next-line no-unused-vars
  headers: Record<string, string>
) => string;

export interface RunLangfuseRestOpts {
  /** Honour `opts.noCap` from `fetchLangfuseTraces`. */
  noCap?: boolean;
  /** Test seam — inject a synchronous HTTP GET. Default = curl via execSync. */
  httpGet?: LangfuseHttpGet;
}

function defaultHttpGet(url: string, headers: Record<string, string>): string {
  // -s silent / -S show errors / -f fail-fast on >=400 (so curl exits non-zero
  // and execSync throws — matches the CLI runner's error-propagation shape).
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" ");
  return execSync(`curl -sSf ${headerArgs} ${JSON.stringify(url)}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function runLangfuseRest(
  args: string,
  env: EnvLike = process.env as EnvLike,
  runOpts: RunLangfuseRestOpts = {}
): LangfuseTraceRaw[] {
  const host = env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
  const pk = env.LANGFUSE_PUBLIC_KEY;
  const sk = env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) {
    // Match the message shape of the top-level fail-fast gate so callers see
    // ONE error message regardless of which runner the picker selected.
    throw new Error(
      "langfuse fetch: missing credentials — set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (see references/source-platforms/langfuse.md)"
    );
  }
  const auth = "Basic " + Buffer.from(`${pk}:${sk}`).toString("base64");

  // Translate the arg string built by buildTracesListArgs() → REST query params.
  const baseQs = new URLSearchParams();
  baseQs.set("limit", "100");

  const fromMatch = args.match(/--from\s+"([^"]+)"/);
  if (fromMatch) baseQs.set("fromTimestamp", fromMatch[1]);

  const agentMatch = args.match(/--agent-id\s+"([^"]+)"/);
  if (agentMatch) baseQs.set("name", agentMatch[1]);

  const hasFeedbackFlag = /--has-feedback(?:\s|$)/.test(args);
  const scoreBelowMatch = args.match(/--score-below\s+(-?\d+(?:\.\d+)?)/);
  const scoreBelow = scoreBelowMatch ? parseFloat(scoreBelowMatch[1]) : undefined;

  const httpGet = runOpts.httpGet ?? defaultHttpGet;
  const cap = runOpts.noCap ? Number.POSITIVE_INFINITY : 10;
  const collected: LangfuseTraceRaw[] = [];

  let page = 1;
  // Synchronous pagination — bounded by cap or meta.totalPages, whichever hits
  // first. Each iteration is an isolated curl invocation so failures surface
  // immediately (curl -f).
  while (page <= cap) {
    baseQs.set("page", String(page));
    const url = `${host.replace(/\/+$/, "")}/api/public/traces?${baseQs.toString()}`;
    let bodyText: string;
    try {
      bodyText = httpGet(url, { Authorization: auth, Accept: "application/json" });
    } catch (err) {
      throw new Error(
        `langfuse REST error (page ${page}, url ${url}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let body: { data?: LangfuseTraceRaw[]; meta?: { totalPages?: number } };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch (err) {
      throw new Error(
        `langfuse REST: failed to parse JSON (page ${page}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const data = Array.isArray(body.data) ? body.data : [];
    collected.push(...data);
    const totalPages = body.meta?.totalPages ?? page;
    if (page >= totalPages) break;
    page += 1;
  }

  // Post-filters — REST returns a superset; trim to preserve CLI semantics.
  let out = collected;
  if (hasFeedbackFlag) {
    out = out.filter((t) => Array.isArray(t.scores) && t.scores.length > 0);
  }
  if (scoreBelow !== undefined) {
    out = out.filter((t) => {
      const v = t.scores?.[0]?.value;
      return typeof v === "number" && v < scoreBelow;
    });
  }
  return out;
}

/**
 * Probe which runner to use. CLI wins when the binary is on PATH (legacy
 * onboarding); REST wins otherwise (no install required, creds-only).
 * Tests can pass `opts.runner` to `fetchLangfuseTraces` to bypass the probe.
 */
export function pickRunner(env: EnvLike = process.env as EnvLike): LangfuseCliRunner {
  try {
    execSync("command -v langfuse", {
      stdio: "ignore",
      env,
    });
    return runLangfuseCli;
  } catch {
    return (args: string) => runLangfuseRest(args, env);
  }
}

// `process.env as EnvLike` cast above documents intent — Node typings expose
// `process.env` as `NodeJS.ProcessEnv`, and the cast keeps callers honest about
// the structural shape we actually consume.

/**
 * Pure arg-builder: filters → `langfuse traces list …` flag string.
 * Extracted so the Wave-5.1 T3 cli-contract test can assert the exact command
 * the skill builds against the documented CLI manual WITHOUT shelling out.
 * Does NOT append `--json` (that's `runLangfuseCli`'s job).
 */
export function buildTracesListArgs(opts: LangfuseFetchOptions = {}): string {
  const { hours = 24, agentId, hasFeedback, scoreBelow } = opts;
  const fromIso = isoHoursAgo(hours);
  let cliArgs = `traces list --from "${fromIso}"`;
  if (agentId) cliArgs += ` --agent-id "${agentId}"`;
  if (hasFeedback) cliArgs += ` --has-feedback`;
  if (scoreBelow !== undefined) cliArgs += ` --score-below ${scoreBelow}`;
  return cliArgs;
}

/** Read Langfuse credential presence from the environment (PUBLIC + SECRET). */
function hasLangfuseCreds(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY) && Boolean(process.env.LANGFUSE_SECRET_KEY);
}

function normalizeRawTrace(raw: LangfuseTraceRaw): TraceMetadata {
  const hasError = raw.level === "ERROR" || Boolean(raw.statusMessage?.toLowerCase().includes("error"));
  const hasFeedback = Array.isArray(raw.scores) && raw.scores.length > 0;
  const rawScore = hasFeedback
    ? (() => {
        const s = raw.scores?.[0]?.value;
        return typeof s === "number" ? s : undefined;
      })()
    : undefined;
  return {
    traceId: raw.id ?? `lf-${Date.now()}`,
    sessionId: raw.sessionId ?? raw.id ?? `lf-${Date.now()}`,
    startTime: raw.startTime,
    endTime: raw.endTime,
    latencyMs: typeof raw.latency === "number" ? raw.latency : undefined,
    hasError,
    hasFeedback,
    rawScore,
    tags: raw.tags,
    sourcePlatform: "langfuse",
  };
}

export function fetchLangfuseTraces(opts: LangfuseFetchOptions = {}): TraceMetadata[] {
  const { outputDir, runner, hasCreds, noCap } = opts;

  // Fail-fast: with the REAL runner, missing creds means every CLI/REST call
  // would fail mid-stream. Throw BEFORE building/issuing the command. Tests
  // that inject a `runner` bypass this gate (they never touch the real
  // CLI/network). Both runners (CLI + REST) require the same creds, so this
  // single gate fronts both paths.
  if (!runner) {
    const credsPresent = hasCreds ?? hasLangfuseCreds();
    if (!credsPresent) {
      throw new Error(
        "langfuse fetch: missing credentials — set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (see references/source-platforms/langfuse.md)"
      );
    }
  }

  const cliArgs = buildTracesListArgs(opts);
  // R-002: default runner is the picker (CLI if installed, REST otherwise).
  // When REST is selected, bind the `noCap` flag into a closure so the runner
  // contract (`(args) => unknown`) stays unchanged.
  const exec: LangfuseCliRunner = runner ?? (() => {
    const picked = pickRunner();
    if (picked === runLangfuseCli) return picked;
    return (args: string) => runLangfuseRest(args, process.env, { noCap });
  })();
  // F-S1: name the active fetch path so a malformed-shape error points the
  // operator at the right source. An injected runner is a test/DI seam.
  const sourceLabel = runner
    ? "injected runner"
    : exec === runLangfuseCli
      ? "langfuse CLI (traces list --json)"
      : "langfuse REST (GET /api/public/traces)";
  // F-S1: FAIL LOUD on a non-array / shape-mismatched result instead of silently
  // collapsing it to zero traces (whole-corpus drop). An empty array still passes.
  const raw = validateLangfuseFetchResult(exec(cliArgs), sourceLabel);
  const traces: TraceMetadata[] = raw.map(normalizeRawTrace);

  if (outputDir) {
    const dir = resolve(outputDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last-Nh-meta.json"), JSON.stringify(traces, null, 2) + "\n", "utf8");
  }

  return traces;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const opts: LangfuseFetchOptions = {
    hours: getArg("--hours") ? parseInt(getArg("--hours")!, 10) : 24,
    agentId: getArg("--agent-id"),
    hasFeedback: args.includes("--has-feedback"),
    scoreBelow: getArg("--score-below") ? parseFloat(getArg("--score-below")!) : undefined,
    outputDir: getArg("--output-dir") ?? "/tmp/mutagent-fetch",
    noCap: args.includes("--no-cap"),
  };

  try {
    const traces = fetchLangfuseTraces(opts);
    process.stdout.write(JSON.stringify(traces, null, 2) + "\n");
    process.stderr.write(`[langfuse fetch] ${traces.length} traces in last ${opts.hours}h\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
