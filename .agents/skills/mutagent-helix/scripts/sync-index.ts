import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// *sync — topology indexer for mutagent-system.
//
// Deterministically scans `mutagent-system/*` for skills/agents and emits a
// structured topology index plus a rendered markdown table (the dashboard
// SYSTEM-panel breakdown). No clock, no network, no env reads — same tree in,
// same output out.
//
// A directory under <systemRoot> is INDEXED if it carries ANY marker:
//   - SKILL.md            (top-level OR `.claude/skills/<x>/SKILL.md`)
//   - .claude/agents/*.md
//   - package.json with a `name`
//   - CLAUDE.md
// Dirs named `scripts` / `node_modules` / `dist`, and dotdirs, are EXCLUDED.
//
// Scanning logic lives in EXPORTED pure functions so it is unit-testable; the
// CLI main() only parses args + prints.
// ---------------------------------------------------------------------------

export type Kind = "skill" | "agent";

export type AdlStage =
  | "spec"
  | "build"
  | "evaluate"
  | "diagnose"
  | "orchestrator"
  | "shared"
  | "unknown";

export interface TopologyEntry {
  /** Directory name (the skill/agent id within mutagent-system). */
  name: string;
  /** `skill` (publishable/packaged unit) or `agent` (a markdown agent def). */
  kind: Kind;
  /** Path relative to the scanned systemRoot. */
  path: string;
  /** ADL stage this unit owns, inferred from its canonical name. */
  adl_stage: AdlStage;
  /** package.json `version`, or null when there is no package.json. */
  version: string | null;
  /** True when package.json declares a `bin` (a `pnpx <skill> init` surface). */
  hasOnboarding: boolean;
}

export interface TopologyIndex {
  /** The scanned root (absolute as supplied by the caller). */
  root: string;
  /** Detected entries, sorted by name. */
  entries: TopologyEntry[];
}

interface Markers {
  skillMd: boolean;
  agentMd: boolean;
  packageName: string | null;
  packageVersion: string | null;
  hasBin: boolean;
  claudeMd: boolean;
}

// Directory names that are never indexed even if they carry a marker file.
const EXCLUDED_DIRS = new Set(["scripts", "node_modules", "dist"]);

// Canonical mutagent unit -> ADL stage. Keyed on the stable directory name.
const STAGE_BY_NAME: Record<string, AdlStage> = {
  "mutagent-agentspec": "spec",
  "mutagent-skill-builder": "build",
  "mutagent-evaluator": "evaluate",
  "mutagent-diagnostics": "diagnose",
  "mutagent-orchestrator": "orchestrator",
  "mutagent-templates": "shared",
};

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * A dir is SKILL-marked if it has a top-level SKILL.md OR any
 * `.claude/skills/<x>/SKILL.md` (the real on-disk home for shipped skills).
 */
function hasSkillMd(dir: string): boolean {
  if (isFile(path.join(dir, "SKILL.md"))) return true;
  const skillsDir = path.join(dir, ".claude", "skills");
  if (!isDir(skillsDir)) return false;
  return safeReaddir(skillsDir).some((sub) =>
    isFile(path.join(skillsDir, sub, "SKILL.md")),
  );
}

function hasAgentMd(dir: string): boolean {
  const agentsDir = path.join(dir, ".claude", "agents");
  if (!isDir(agentsDir)) return false;
  return safeReaddir(agentsDir).some((f) => f.endsWith(".md"));
}

function readPackage(dir: string): {
  name: string | null;
  version: string | null;
  hasBin: boolean;
} {
  const pkgPath = path.join(dir, "package.json");
  if (!isFile(pkgPath)) return { name: null, version: null, hasBin: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      version?: string;
      bin?: unknown;
    };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      hasBin: parsed.bin !== undefined && parsed.bin !== null,
    };
  } catch {
    return { name: null, version: null, hasBin: false };
  }
}

function readMarkers(dir: string): Markers {
  const pkg = readPackage(dir);
  return {
    skillMd: hasSkillMd(dir),
    agentMd: hasAgentMd(dir),
    packageName: pkg.name,
    packageVersion: pkg.version,
    hasBin: pkg.hasBin,
    claudeMd: isFile(path.join(dir, "CLAUDE.md")),
  };
}

function hasAnyMarker(m: Markers): boolean {
  return m.skillMd || m.agentMd || m.packageName !== null || m.claudeMd;
}

/**
 * Kind precedence (first match wins):
 *   SKILL.md            -> skill   (a shipped skill, even if it also has agents)
 *   .claude/agents/*.md -> agent   (a markdown agent definition)
 *   CLAUDE.md           -> agent   (an agent boot/def dir, e.g. the orchestrator)
 *   package.json name   -> skill   (a packaged unit with no skill/agent marker, e.g.
 *                                   shared templates)
 *   (default)           -> agent
 *
 * NOTE: agent markers (.claude/agents, CLAUDE.md) are checked BEFORE the package name,
 * because the orchestrator carries a `name` (required to be a valid monorepo workspace
 * member) yet is an AGENT, not a publishable skill. Templates (named, no CLAUDE.md)
 * still resolves to skill via the package-name rule.
 */
function resolveKind(m: Markers): Kind {
  if (m.skillMd) return "skill";
  if (m.agentMd) return "agent";
  if (m.claudeMd) return "agent";
  if (m.packageName !== null) return "skill";
  return "agent";
}

/** Map a canonical unit name to its ADL stage; unknown names => 'unknown'. */
export function inferAdlStage(name: string): AdlStage {
  return STAGE_BY_NAME[name] ?? "unknown";
}

/**
 * Scan <systemRoot> for skill/agent directories. Pure: the root is a parameter
 * so tests can point at fixtures. Returns an empty index when the root does not
 * exist. Entries are sorted by name for deterministic output.
 */
export function scanTopology(systemRoot: string): TopologyIndex {
  const entries: TopologyEntry[] = [];
  if (!isDir(systemRoot)) return { root: systemRoot, entries };

  for (const name of safeReaddir(systemRoot)) {
    if (name.startsWith(".")) continue;
    if (EXCLUDED_DIRS.has(name)) continue;

    const dir = path.join(systemRoot, name);
    if (!isDir(dir)) continue;

    const markers = readMarkers(dir);
    if (!hasAnyMarker(markers)) continue;

    entries.push({
      name,
      kind: resolveKind(markers),
      path: path.relative(systemRoot, dir) || name,
      adl_stage: inferAdlStage(name),
      version: markers.packageVersion,
      hasOnboarding: markers.hasBin,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { root: systemRoot, entries };
}

const TABLE_HEADER =
  "| ADL Stage | Name | Kind | Version | Onboarding | Path |";
const TABLE_SEPARATOR = "| --- | --- | --- | --- | --- | --- |";

/**
 * Render the topology index as a markdown table — the breakdown the dashboard
 * SYSTEM panel shows. An empty index renders just header + separator.
 */
export function renderMarkdownTable(index: TopologyIndex): string {
  const rows = index.entries.map(
    (e) =>
      `| ${e.adl_stage} | ${e.name} | ${e.kind} | ${e.version ?? "—"} | ${
        e.hasOnboarding ? "✓" : "—"
      } | ${e.path} |`,
  );
  return [TABLE_HEADER, TABLE_SEPARATOR, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper. Default root is this file's grandparent:
//   scripts/ -> mutagent-orchestrator/ -> mutagent-system/
// Flags: --json (index only) · --table (table only) · <root> positional override.
// ---------------------------------------------------------------------------
function defaultSystemRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const jsonOnly = args.includes("--json");
  const tableOnly = args.includes("--table");
  const positional = args.find((a) => !a.startsWith("--"));
  const systemRoot = positional
    ? path.resolve(positional)
    : defaultSystemRoot();

  const index = scanTopology(systemRoot);

  if (jsonOnly) {
    console.info(JSON.stringify(index, null, 2));
    return;
  }
  if (tableOnly) {
    console.info(renderMarkdownTable(index));
    return;
  }
  console.info(renderMarkdownTable(index));
  console.info("");
  console.info(JSON.stringify(index, null, 2));
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv =
    typeof Bun !== "undefined" ? Bun.argv : process.argv;
  main(argv);
}
