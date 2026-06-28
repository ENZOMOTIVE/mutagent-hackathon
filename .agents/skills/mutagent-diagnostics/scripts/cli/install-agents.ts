/**
 * scripts/cli/install-agents.ts
 * Symlink assets/agents/*.md into the host coding-agent's agents directory.
 * Phase 3-E addition: MD→TOML transcode for Codex (--transcode-only --to codex).
 *
 * Implements R-SELF-01-a (approved 2026-05-28).
 * Closes F-SELF-01: onboarding never installed the agent symlinks, so every
 * dispatch fell back to subagent_type=general-purpose.
 *
 * Usage:
 *   bun scripts/cli/install-agents.ts [project-root] [--scope=project|user] [--force]
 *   bun scripts/cli/install-agents.ts --transcode-only --to codex <input.md> <output.toml>
 *
 * Default scope: project (.claude/agents/) — falls back to user (~/.claude/agents/)
 * if no project .claude/ dir exists.
 *
 * Idempotent: if the symlink already points at the correct target, prints OK and exits 0.
 * Will NOT clobber a non-symlink at the destination unless --force is passed.
 *
 * IMPORTANT: After install, the host coding-agent (Claude Code) must restart its
 * session to pick up the new agent types — its subagent_type registry is loaded
 * at session boot.
 *
 * MD→TOML transcode (Phase 3-E / OQ-3):
 *   Converts Claude Code .md agent files (YAML frontmatter + body) to Codex .toml format.
 *   TOML format: [agent] block with key-value pairs + [agent.body] content.
 *   See references/source-platforms/codex.md for format spec.
 *   ⚠️ Verify against Codex docs before publishing — format is best-effort per OQ-3.
 */

import {
  existsSync, lstatSync, readlinkSync, readdirSync, symlinkSync,
  unlinkSync, mkdirSync, realpathSync, readFileSync, writeFileSync,
} from "fs";
import { resolve, join, basename } from "path";
import { homedir } from "os";

// ── MD→TOML transcode (Phase 3-E) ────────────────────────────────────────────

export type TranscodeTargetPlatform = "codex";

/**
 * Parse a minimal YAML frontmatter block (between --- delimiters).
 * Handles simple string values and comma-separated lists.
 * Returns meta key-value pairs and the document body.
 */
export function parseAgentFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  // Match opening --- ... closing ---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/);
  if (!fmMatch) {
    return { meta: {}, body: content };
  }
  const rawFrontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";

  const meta: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    // Strip \r so CRLF files parse identically to LF files
    const kv = line.replace(/\r$/, "").match(/^([^:#][^:]*?):\s*(.*)$/);
    if (kv) {
      meta[kv[1].trim()] = kv[2].trim();
    }
  }
  return { meta, body };
}

/**
 * Serialize a frontmatter value to a TOML value string.
 * - "tools" key: "Bash, Read" → ["Bash", "Read"]
 * - All other values: quoted string with escaping
 */
export function serializeToTomlValue(key: string, value: string): string {
  if (key === "tools") {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    return `[${parts.join(", ")}]`;
  }
  // Generic string: escape backslashes and double-quotes
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Transcode a Claude Code agent .md file to Codex .toml format.
 *
 * Output shape:
 *   [agent]
 *   name = "..."
 *   description = "..."
 *   tools = ["Bash", "Read", ...]
 *   ...other frontmatter keys...
 *
 *   [agent.body]
 *   content = """
 *   ...body...
 *   """
 *
 * ⚠️ Verify [agent] and [agent.body] key names against Codex docs before publishing.
 */
export function transcodeAgentMdToToml(mdContent: string): string {
  const { meta, body } = parseAgentFrontmatter(mdContent);

  const lines: string[] = ["[agent]"];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key} = ${serializeToTomlValue(key, value)}`);
  }

  const trimmedBody = body.trim();
  if (trimmedBody) {
    lines.push("");
    lines.push("[agent.body]");
    // TOML multi-line basic string: first newline after """ is trimmed by TOML spec
    lines.push(`content = """\n${trimmedBody}\n"""`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Transcode a single .md file to a platform-specific format and write to dest.
 * Currently only "codex" (TOML) is supported; others will be copied as-is.
 */
export function transcodeAgentFile(
  srcPath: string,
  destPath: string,
  targetPlatform: TranscodeTargetPlatform
): void {
  const content = readFileSync(srcPath, "utf8");
  if (targetPlatform === "codex") {
    const toml = transcodeAgentMdToToml(content);
    writeFileSync(destPath, toml, "utf8");
  } else {
    // Other platforms: copy as-is
    writeFileSync(destPath, content, "utf8");
  }
}

export type InstallScope = "project" | "user";

export interface InstallEntry {
  agentName: string;
  src: string;
  dest: string;
  /** "installed" = new symlink created. "ok" = already correct. "skipped" = collision, --force not set. "replaced" = collision replaced. */
  action: "installed" | "ok" | "skipped" | "replaced";
  note?: string;
}

export interface InstallResult {
  scope: InstallScope;
  destDir: string;
  entries: InstallEntry[];
  needsSessionRestart: boolean;
  errors: string[];
}

// realpath-resolve so SKILL_DIR is the canonical install location even if the
// script is invoked through a symlink chain (e.g. when ~/.claude/skills/<skill>
// is itself a symlink into a worktree). Otherwise SRC paths won't match existing
// canonical symlinks and idempotency breaks. (Sibling of F-SELF-05 cwd-leak.)
const SCRIPT_DIR = realpathSync(import.meta.dirname ?? import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, ""));
const SKILL_DIR = resolve(SCRIPT_DIR, "../..");
const AGENTS_SRC_DIR = join(SKILL_DIR, "assets", "agents");

export function installAgents(
  projectRoot: string,
  scope: InstallScope = "project",
  force = false
): InstallResult {
  const result: InstallResult = {
    scope,
    destDir: "",
    entries: [],
    needsSessionRestart: false,
    errors: [],
  };

  // Pick destination
  if (scope === "project") {
    const projDotClaude = join(projectRoot, ".claude");
    if (!existsSync(projDotClaude)) {
      result.errors.push(
        `Project .claude/ dir missing at ${projDotClaude}. ` +
        `Either init the project's Claude Code setup, or re-run with --scope=user.`
      );
      return result;
    }
    result.destDir = join(projDotClaude, "agents");
  } else {
    result.destDir = join(homedir(), ".claude", "agents");
  }

  if (!existsSync(result.destDir)) {
    mkdirSync(result.destDir, { recursive: true });
  }

  if (!existsSync(AGENTS_SRC_DIR)) {
    result.errors.push(`Skill agents src dir missing: ${AGENTS_SRC_DIR}`);
    return result;
  }

  const agentFiles = readdirSync(AGENTS_SRC_DIR).filter((f) => f.endsWith(".md"));

  for (const fname of agentFiles) {
    const src = join(AGENTS_SRC_DIR, fname);
    const dest = join(result.destDir, fname);
    const entry: InstallEntry = { agentName: basename(fname, ".md"), src, dest, action: "installed" };

    if (existsSync(dest)) {
      const stat = lstatSync(dest);
      if (stat.isSymbolicLink()) {
        const literal = readlinkSync(dest);
        // Compare CANONICAL paths — the existing symlink may point at a different
        // representation (e.g. ~/.claude/skills/...) that realpath-resolves to
        // the same place as our src (which may go through a worktree chain).
        let canonicalDest: string | null = null;
        try { canonicalDest = realpathSync(dest); } catch { /* dangling */ }
        const canonicalSrc = realpathSync(src);
        if (canonicalDest === canonicalSrc) {
          entry.action = "ok";
          entry.note = `Symlink resolves to the correct skill source (literal target: ${literal}).`;
          result.entries.push(entry);
          continue;
        }
        if (!force) {
          entry.action = "skipped";
          entry.note = `Existing symlink resolves elsewhere (${canonicalDest ?? "<dangling>"}). Re-run with --force to replace.`;
          result.entries.push(entry);
          continue;
        }
        unlinkSync(dest);
        entry.action = "replaced";
      } else {
        if (!force) {
          entry.action = "skipped";
          entry.note = `Destination exists and is NOT a symlink. Re-run with --force to replace.`;
          result.entries.push(entry);
          continue;
        }
        unlinkSync(dest);
        entry.action = "replaced";
      }
    }

    try {
      symlinkSync(src, dest);
      result.entries.push(entry);
      result.needsSessionRestart = true;
    } catch (err) {
      result.errors.push(`Failed to symlink ${dest} → ${src}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);

  // ── Transcode-only mode (Phase 3-E) ──────────────────────────────────────
  // Usage: install-agents.ts --transcode-only --to <platform> <input.md> <output.toml>
  if (args.includes("--transcode-only")) {
    // Resolve --to platform (supports both "--to codex" and "--to=codex")
    let platform: string | undefined;
    const toEqIdx = args.findIndex((a) => a.startsWith("--to="));
    const toSpaceIdx = args.indexOf("--to");
    if (toEqIdx !== -1) {
      platform = args[toEqIdx]!.split("=")[1];
    } else if (toSpaceIdx !== -1) {
      platform = args[toSpaceIdx + 1];
    }

    if (!platform || platform !== "codex") {
      process.stderr.write(
        `[install-agents] --transcode-only requires --to codex (only 'codex' is supported)\n`
      );
      process.exit(1);
    }

    // Collect positional args — skip flag tokens and the platform value following "--to"
    const toConsumesNext = toSpaceIdx !== -1; // "--to codex" form consumes next token
    const skipSet = new Set<number>();
    if (toConsumesNext) {
      skipSet.add(toSpaceIdx);
      skipSet.add(toSpaceIdx + 1);
    }
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (skipSet.has(i)) continue;
      const a = args[i]!;
      if (!a.startsWith("--")) positional.push(a);
    }

    const inputPath = positional[0];
    const outputPath = positional[1];

    if (!inputPath || !outputPath) {
      process.stderr.write(
        `[install-agents] --transcode-only usage: install-agents.ts --transcode-only --to codex <input.md> <output.toml>\n`
      );
      process.exit(1);
    }

    if (!existsSync(inputPath)) {
      process.stderr.write(`[install-agents] Input file not found: ${inputPath}\n`);
      process.exit(1);
    }

    try {
      transcodeAgentFile(inputPath, outputPath, "codex");
      process.stderr.write(`[install-agents] Transcoded ${inputPath} → ${outputPath} (codex TOML)\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `[install-agents] Transcode failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  }

  // ── Standard install mode ─────────────────────────────────────────────────
  const positional = args.filter((a) => !a.startsWith("--"));
  const projectRoot = positional[0] ?? process.cwd();
  const scopeArg = args.find((a) => a.startsWith("--scope="));
  const scope: InstallScope = scopeArg?.split("=")[1] === "user" ? "user" : "project";
  const force = args.includes("--force");

  const result = installAgents(projectRoot, scope, force);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // Human summary on stderr (won't pollute JSON pipes)
  if (result.errors.length === 0) {
    const installed = result.entries.filter((e) => e.action === "installed" || e.action === "replaced");
    const ok = result.entries.filter((e) => e.action === "ok");
    const skipped = result.entries.filter((e) => e.action === "skipped");
    process.stderr.write(`\n[install-agents] ${result.scope} scope → ${result.destDir}\n`);
    process.stderr.write(`  ${installed.length} installed, ${ok.length} already-ok, ${skipped.length} skipped\n`);
    if (result.needsSessionRestart) {
      process.stderr.write(`\n⚠ Restart your Claude Code session — the agent-type registry caches at boot.\n`);
    }
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}
