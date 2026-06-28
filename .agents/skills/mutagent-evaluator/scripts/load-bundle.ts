/**
 * scripts/load-bundle.ts
 * ---------------------------------------------------------------------------
 * The bundle loader: takes a run-bundle directory (.mutagent-diagnostics/{runId}/)
 * and the loaded subject profile, discovers + parses the run artifacts, and
 * returns a validated RunBundle (the "validated audit input" of the data-flow).
 *
 * Subject-agnostic: it does not hard-code which artifacts a subject produces. It
 * discovers a known set of well-known artifact names (best-effort), records
 * absolute paths, parses any JSON, and surfaces missing-but-optional artifacts
 * as warnings rather than throwing. Only the bundle directory itself must exist.
 *
 * Deterministic: directory entries are sorted before processing; no clock/random.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type RunBundle } from "./contracts/types.ts";

/**
 * Well-known artifacts the evaluator looks for in a run-bundle. The KEY is the
 * logical name used downstream (run-deterministic / lenses); the VALUE is the
 * relative filename within the bundle. Missing entries become warnings.
 */
export const WELL_KNOWN_ARTIFACTS: Readonly<Record<string, string>> = {
  runMeta: "runMeta.json",
  tracesMetadata: "traces-metadata.json",
  entityContext: "entity-context.json",
  renderInput: "render-input.json",
  report: "report.html",
};

/** Logical names whose VALUE is a sub-directory of evidence files. */
export const WELL_KNOWN_DIRS: Readonly<Record<string, string>> = {
  evidence: "evidence",
  wave6: "wave6",
};

export interface LoadBundleResult {
  bundle: RunBundle;
  ok: boolean;
}

/**
 * Identities that mean "this bundle was produced BY the evaluator itself".
 * Self-grading violates EV-PR-001 (reviewer ≠ executor): an audit must never
 * grade a run it produced, or it can launder its own non-determinism into a
 * pass. Compared case-insensitively against the known producer fields.
 */
const SELF_PRODUCER_IDENTITIES: ReadonlySet<string> = new Set([
  "mutagent-evaluator",
  "@mutagent/evaluator",
]);

/**
 * runMeta fields that, by convention, name the process that produced the run.
 * Checked in order; the first present string value is taken as the producer.
 */
const PRODUCER_FIELDS: readonly string[] = ["producer", "tool", "generator"];

/**
 * EV-PR-001 provenance guard. Inspects the audited run's runMeta for a
 * producer/tool/generator marker. If it explicitly identifies the evaluator
 * itself, THROW — a self-produced bundle must not be silently audited.
 *
 * ABSENCE of any producer field is OK (the common case; the bundle was produced
 * by some other process that simply doesn't stamp provenance).
 */
function assertNotSelfProduced(runMeta: unknown, bundleDir: string): void {
  if (typeof runMeta !== "object" || runMeta === null) return;
  const meta = runMeta as Record<string, unknown>;
  for (const field of PRODUCER_FIELDS) {
    const value = meta[field];
    if (typeof value !== "string") continue;
    if (SELF_PRODUCER_IDENTITIES.has(value.trim().toLowerCase())) {
      throw new Error(
        `load-bundle: reviewer ≠ executor (EV-PR-001) — this bundle is marked as ` +
          `self-produced (runMeta.${field} = "${value}"); the evaluator must not ` +
          `audit a run it produced itself: ${bundleDir}`,
      );
    }
  }
}

function parseJsonSafe(path: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Load + validate a run-bundle. Throws ONLY when the bundle directory does not
 * exist (the one structural prerequisite). Everything else is a warning.
 */
export function loadBundle(bundleDir: string, runId?: string): LoadBundleResult {
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    throw new Error(
      `load-bundle: bundle directory not found or not a directory: ${bundleDir}`,
    );
  }

  const artifacts: Record<string, string> = {};
  const data: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [logical, rel] of Object.entries(WELL_KNOWN_ARTIFACTS)) {
    const abs = join(bundleDir, rel);
    if (!existsSync(abs)) {
      warnings.push(`optional artifact missing: ${rel}`);
      continue;
    }
    artifacts[logical] = abs;
    if (rel.endsWith(".json")) {
      const { value, error } = parseJsonSafe(abs);
      if (error) {
        warnings.push(`artifact ${rel} present but failed to parse: ${error}`);
      } else {
        data[logical] = value;
      }
    }
  }

  // EV-PR-001 provenance guard: a bundle the evaluator produced itself must not
  // be silently audited (reviewer ≠ executor). Runs as soon as runMeta is
  // parsed; absence of a producer marker is OK (the common case).
  assertNotSelfProduced(data.runMeta, bundleDir);

  // Directory-shaped artifacts: record the sorted file listing (deterministic).
  for (const [logical, rel] of Object.entries(WELL_KNOWN_DIRS)) {
    const abs = join(bundleDir, rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      warnings.push(`optional artifact dir missing: ${rel}/`);
      continue;
    }
    artifacts[logical] = abs;
    const files = readdirSync(abs)
      .filter((f) => statSync(join(abs, f)).isFile())
      .sort();
    data[logical] = files.map((f) => ({
      file: f,
      path: join(abs, f),
    }));
  }

  const resolvedRunId =
    runId ??
    (typeof (data.runMeta as { runId?: unknown } | undefined)?.runId ===
    "string"
      ? (data.runMeta as { runId: string }).runId
      : basename(bundleDir));

  const bundle: RunBundle = {
    runId: resolvedRunId,
    bundleDir,
    artifacts,
    data,
    warnings,
  };

  // "ok" = at least one well-known artifact was found; a totally empty dir is a
  // load failure worth surfacing (but not a throw — the caller decides).
  const ok = Object.keys(artifacts).length > 0;
  return { bundle, ok };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
declare const Bun: { argv: string[] } | undefined;
async function main(): Promise<void> {
  const argv =
    typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const bundleDir = argv[0];
  if (!bundleDir) {
    console.error("usage: load-bundle.ts <bundleDir> [runId]");
    process.exit(2);
  }
  const { bundle, ok } = loadBundle(bundleDir, argv[1]);
  console.info(
    JSON.stringify(
      {
        runId: bundle.runId,
        artifacts: Object.keys(bundle.artifacts),
        warnings: bundle.warnings,
        ok,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
