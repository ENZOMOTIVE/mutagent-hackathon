/**
 * scripts/self-diagnostics/dispatch.ts
 * [INTERNAL] Invoke orchestrator with own session transcript as source (PR-022)
 * Type A — Pure Script (dispatch setup only; actual orchestration is agent-driven)
 *
 * Self-diagnostics is GATED by config.yaml: self_diagnostics.enabled (default: false)
 * Only runs for skill maintainers + dogfood mode.
 *
 * PRD-SD-01: descriptor now carries a serialized EntityContext (skill-typed) so the
 * enricher can inject it via --entity-context without re-deriving it at render time.
 *
 * PRD-SD-04: all self-diag findings are forced to audience: 'META' (PR-033). The
 * descriptor carries audienceOverride: 'META' so the enricher/orchestrator can apply
 * this without inspecting the finding type.
 *
 * Usage: bun scripts/self-diagnostics/dispatch.ts [project-root]
 * Outputs a dispatch descriptor that the orchestrator reads to run self-diagnostics.
 */

import { resolve, join } from "path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { probeHostRuntime } from "./probe.ts";
import { buildSkillSelfEntityContext } from "../normalize/platforms/entity-context.ts";
import type { EntityContext } from "../normalize/trace.ts";

export interface SelfDiagnosticsDispatchDescriptor {
  /** [INTERNAL] marker */
  internal: true;
  sessionPath: string;
  sourcePlatform: "claude-code" | "codex" | "local-jsonl";
  /** Branch for self-remedy PRs */
  remedyBranch: string;
  /** [INTERNAL] prefix for PR titles */
  marker: string;
  dispatchedAt: string;
  /** Descriptor file path written to disk */
  descriptorPath: string;
  /**
   * PRD-SD-01: Skill-typed EntityContext to be injected via --entity-context.
   * Fully populated: entityType='skill', codeAccess=true, applyTarget set.
   * Enricher prefers this over findings.entities[0] (Q1: override+warn).
   */
  entityContext: EntityContext;
  /**
   * PRD-SD-04 (PR-033): Force all self-diag findings to audience='META'.
   * The enricher applies this override unconditionally on self-diagnostics paths.
   * Client diagnoses never carry this field — analyzer determines audience case-by-case.
   */
  audienceOverride: "META";
}

/**
 * Read the skill version from a package.json path (best-effort, returns undefined on failure).
 */
function readSkillVersion(packageJsonPath: string): string | undefined {
  try {
    if (!existsSync(packageJsonPath)) return undefined;
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function createSelfDiagnosticsDispatch(
  projectRoot: string,
  remedyBranch = "mutagent/self-diagnostics/{date}",
  marker = "[INTERNAL]"
): SelfDiagnosticsDispatchDescriptor | null {
  const probe = probeHostRuntime(projectRoot);

  if (!probe.currentSessionPath) {
    return null;
  }

  const sourcePlatform =
    probe.runtime === "claude-code"
      ? "claude-code"
      : probe.runtime === "codex"
        ? "codex"
        : "local-jsonl";

  const date = new Date().toISOString().slice(0, 10);
  const resolvedBranch = remedyBranch.replace("{date}", date);
  const dispatchedAt = new Date().toISOString();

  // PRD-SD-01: Build skill-typed entity context. Version from package.json (best-effort).
  const pkgPath = resolve(projectRoot, "package.json");
  const version = readSkillVersion(pkgPath);
  const entityContext = buildSkillSelfEntityContext({
    skillName: "mutagent-diagnostics",
    version,
    source: sourcePlatform,
  });

  const descriptor: SelfDiagnosticsDispatchDescriptor = {
    internal: true,
    sessionPath: probe.currentSessionPath,
    sourcePlatform,
    remedyBranch: resolvedBranch,
    marker,
    dispatchedAt,
    descriptorPath: "", // filled below
    // PRD-SD-01: skill-typed EntityContext pre-built for enricher injection
    entityContext,
    // PRD-SD-04: force all self-diag findings to META audience
    audienceOverride: "META",
  };

  // Write descriptor to .mutagent-diagnostics/self-diagnostics/pending.json
  const outputDir = resolve(projectRoot, ".mutagent-diagnostics", "self-diagnostics");
  mkdirSync(outputDir, { recursive: true });
  const descriptorPath = join(outputDir, "pending.json");
  descriptor.descriptorPath = descriptorPath;

  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), "utf8");
  return descriptor;
}

// CLI entrypoint
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const result = createSelfDiagnosticsDispatch(projectRoot);

  if (!result) {
    process.stderr.write(
      "Could not locate current session transcript. Self-diagnostics skipped.\n"
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}
