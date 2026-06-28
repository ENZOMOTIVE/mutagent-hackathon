/**
 * scripts/verify/spec-impl-coverage.ts
 * The BUILD-FAITHFULNESS gate (PR-024) — assert every spec-declared code tool is implemented + tested.
 * Type A — Pure core (computeCoverage, no I/O) + a thin guarded CLI. Mirrors validate-spec.ts.
 *
 * WHY: TDD proves the code that EXISTS passes; it is SILENT on whether all the code the SPEC requires
 * exists (a dropped tool has no test, so nothing fails). A build is GREEN only when TDD passes AND
 * this gate passes. The dogfood sim shipped a scaffold missing `collect-range` with 27 green tests —
 * this gate makes that a STEER instead.
 *
 * CONVENTION: each implementing module carries `// @implements <tool-id>`; ≥1 test references that
 * module (by basename or the same marker). The actor DECLARES the mapping in code; this script VERIFIES
 * completeness against the spec; the Verifier RE-RUNS it (Context-Inversion — never trusts the actor).
 *
 * Usage: scripts/cli/run.sh scripts/verify/spec-impl-coverage.ts <agentspec.yaml> <scaffold-dir>
 *   exit 0 = every code tool covered (+ no dangling job.backed_by refs)  → "[coverage] PASS"
 *   exit 1 = at least one uncovered tool OR a dangling backed_by ref (a STEER)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/** One spec code-tool's coverage status. */
export interface CoverageEntry {
  id: string;
  module: string | null;
  test: string | null;
  covered: boolean;
  reason?: string;
}

export interface CoverageResult {
  ok: boolean;
  entries: CoverageEntry[];
  /** job.backed_by refs (P2) that don't resolve to a declared code-tool id — a spec defect. */
  danglingBackedBy: string[];
}

/** A scanned file. Pure inputs so the core is unit-testable without disk. */
export interface ScannedFile {
  path: string;
  content: string;
}

/** `@implements <id>` marker matcher — id is treated literally (regex-escaped). */
function implementsMarker(id: string): RegExp {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@implements\\s+${esc}(?:\\b|\\s|$)`, "m");
}

/**
 * PURE core. For each declared code-tool id, require (a) a src file carrying `// @implements <id>`
 * AND (b) ≥1 test file referencing that module (by basename) or carrying the same marker. Also flags
 * job `backed_by` refs that don't resolve to a declared tool id. No I/O, never throws.
 */
export function computeCoverage(
  toolIds: string[],
  srcFiles: ScannedFile[],
  testFiles: ScannedFile[],
  backedByRefs: string[] = [],
): CoverageResult {
  const entries: CoverageEntry[] = [];
  for (const id of toolIds) {
    const re = implementsMarker(id);
    const mod = srcFiles.find((f) => re.test(f.content)) ?? null;
    let test: ScannedFile | null = null;
    if (mod) {
      const base = path.basename(mod.path).replace(/\.ts$/, "");
      test =
        testFiles.find((t) => t.content.includes(base) || re.test(t.content)) ?? null;
    }
    const covered = Boolean(mod) && Boolean(test);
    entries.push({
      id,
      module: mod ? mod.path : null,
      test: test ? test.path : null,
      covered,
      reason: !mod
        ? `no module carries \`// @implements ${id}\``
        : !test
          ? `module ${path.basename(mod.path)} has no test referencing it`
          : undefined,
    });
  }
  const declared = new Set(toolIds);
  const danglingBackedBy = [...new Set(backedByRefs)].filter((r) => !declared.has(r));
  const ok = entries.every((e) => e.covered) && danglingBackedBy.length === 0;
  return { ok, entries, danglingBackedBy };
}

/** Recursively collect .ts files under a dir (excluding node_modules / dotdirs). */
function walkTs(dir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".ts"))
        out.push({ path: full, content: fs.readFileSync(full, "utf-8") });
    }
  };
  walk(path.resolve(dir));
  return out;
}

/** Read a spec + scaffold from disk and compute coverage. Throws only on an unreadable spec file. */
export function coverageForScaffold(
  specPath: string,
  scaffoldDir: string,
): CoverageResult {
  const spec = parseYaml(fs.readFileSync(path.resolve(specPath), "utf-8")) as Record<
    string,
    unknown
  >;
  const def = (spec?.definition ?? {}) as Record<string, unknown>;
  const tools = (def?.tools ?? {}) as Record<string, unknown>;
  const codeTools = Array.isArray(tools?.code) ? (tools.code as { id?: string }[]) : [];
  const toolIds = codeTools.map((t) => t?.id).filter((x): x is string => Boolean(x));
  const jobs = Array.isArray(def?.jobs_to_be_done)
    ? (def.jobs_to_be_done as { backed_by?: unknown }[])
    : [];
  const backedBy = jobs.flatMap((j) =>
    Array.isArray(j?.backed_by) ? (j.backed_by as string[]) : [],
  );
  const all = walkTs(scaffoldDir);
  const srcFiles = all.filter((f) => !/\.test\.ts$/.test(f.path));
  const testFiles = all.filter((f) => /\.test\.ts$/.test(f.path));
  return computeCoverage(toolIds, srcFiles, testFiles, backedBy);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function runCli(argv: string[]): number {
  const args = argv.slice(2).filter((a) => !a.startsWith("--"));
  const [specPath, scaffoldDir] = args;
  if (!specPath || !scaffoldDir) {
    process.stderr.write(
      "Usage: scripts/cli/run.sh scripts/verify/spec-impl-coverage.ts <agentspec.yaml> <scaffold-dir>\n" +
        "Asserts every definition.tools.code[].id has an `// @implements <id>` module + a test.\n" +
        "Exit 0 = all covered; exit 1 = an uncovered tool or a dangling backed_by ref (STEER).\n",
    );
    return 1;
  }
  let result: CoverageResult;
  try {
    result = coverageForScaffold(specPath, scaffoldDir);
  } catch (err) {
    process.stderr.write(`Error reading ${specPath}: ${String(err)}\n`);
    return 1;
  }
  console.info("tool-id            module                          test                 covered");
  console.info("─────────────────  ──────────────────────────────  ───────────────────  ───────");
  for (const e of result.entries) {
    const mod = e.module ? path.basename(e.module) : "—";
    const tst = e.test ? path.basename(e.test) : "—";
    console.info(
      `${e.id.padEnd(17)}  ${mod.padEnd(30)}  ${tst.padEnd(19)}  ${e.covered ? "✓" : "✗"}` +
        (e.reason ? `\n  └─ ${e.reason}` : ""),
    );
  }
  for (const d of result.danglingBackedBy)
    console.info(`✗ dangling job.backed_by → "${d}" is not a declared code tool`);
  if (result.ok) {
    console.info(`[coverage] PASS — all ${result.entries.length} code tool(s) implemented + tested.`);
    return 0;
  }
  const missing = result.entries.filter((e) => !e.covered).map((e) => e.id);
  console.info(
    `[coverage] STEER — uncovered: ${missing.join(", ") || "(none)"}` +
      (result.danglingBackedBy.length ? ` · dangling: ${result.danglingBackedBy.join(", ")}` : ""),
  );
  return 1;
}

if (import.meta.main) process.exit(runCli(process.argv));
