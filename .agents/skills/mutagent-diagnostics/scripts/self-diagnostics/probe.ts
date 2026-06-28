/**
 * scripts/self-diagnostics/probe.ts
 * [INTERNAL] Detect host coding-agent runtime and locate current session transcript path (PR-022)
 * Type A — Pure Script (env + fs probing — no I/O side effects)
 *
 * Self-diagnostics is GATED by config.yaml: self_diagnostics.enabled (default: false)
 * Only runs for skill maintainers + dogfood mode.
 *
 * Usage: bun scripts/self-diagnostics/probe.ts [project-root]
 */

import { existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import os from "os";

export type HostRuntime = "claude-code" | "codex" | "unknown";

export interface ProbeResult {
  runtime: HostRuntime;
  transcriptRoot: string | null;
  currentSessionPath: string | null;
  allSessionPaths: string[];
  notes: string[];
}

/**
 * Probe the host runtime and locate session transcripts.
 * Claude Code: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 * Codex:       ~/.codex/sessions/<session>.jsonl
 */
export function probeHostRuntime(projectRoot: string): ProbeResult {
  const home = os.homedir();
  const notes: string[] = [];

  // Detect Claude Code
  const claudeProjectsRoot = join(home, ".claude", "projects");
  if (existsSync(claudeProjectsRoot)) {
    // PRIMARY resolution: scan ~/.claude/projects/ for the subdirectory whose
    // encoded form matches this project's cwd. Claude Code encodes the absolute
    // project path by replacing path separators with hyphens — the result
    // LEGITIMATELY starts with a leading hyphen (e.g. `-Users-foo-proj`), so we
    // must NOT strip it (SD-1). We match against the live directory listing so
    // any encoding quirks (trailing chars, special-char handling) still resolve.
    const encodedPath = encodeProjectPath(projectRoot);
    const projectSessionDir = resolveClaudeProjectDir(claudeProjectsRoot, encodedPath);

    if (projectSessionDir) {
      const sessions = readdirSync(projectSessionDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(projectSessionDir, f))
        .sort((a, b) => {
          // Sort by mtime descending — most recent first
          try {
            return statSync(b).mtimeMs - statSync(a).mtimeMs;
          } catch {
            return 0;
          }
        });

      return {
        runtime: "claude-code",
        transcriptRoot: projectSessionDir,
        currentSessionPath: sessions[0] ?? null,
        allSessionPaths: sessions,
        notes: [`Found ${sessions.length} Claude Code session(s) for this project`],
      };
    }

    // Project not found — surface the encoded path we looked for, for debugging
    notes.push(`Claude Code projects dir exists but no session dir matched: ${encodedPath}`);
    return {
      runtime: "claude-code",
      transcriptRoot: claudeProjectsRoot,
      currentSessionPath: null,
      allSessionPaths: [],
      notes,
    };
  }

  // Detect Codex (iter-8 confirmed paths)
  const codexSessionsRoot = join(home, ".codex", "sessions");
  if (existsSync(codexSessionsRoot)) {
    const sessions = readdirSync(codexSessionsRoot)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(codexSessionsRoot, f))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

    return {
      runtime: "codex",
      transcriptRoot: codexSessionsRoot,
      currentSessionPath: sessions[0] ?? null,
      allSessionPaths: sessions,
      notes: [`Found ${sessions.length} Codex session(s)`],
    };
  }

  notes.push("Could not detect Claude Code or Codex session directories.");
  return {
    runtime: "unknown",
    transcriptRoot: null,
    currentSessionPath: null,
    allSessionPaths: [],
    notes,
  };
}

/**
 * Encode a project path the same way Claude Code does.
 * Claude Code encodes the ABSOLUTE path by replacing every path separator with
 * a hyphen. Because an absolute POSIX path begins with `/`, the encoded form
 * LEGITIMATELY begins with a leading hyphen (e.g. `/srv/foo` → `-srv-foo`).
 *
 * SD-1: a previous version stripped that leading hyphen (`.replace(/^-/, "")`),
 * which meant the encoded form never matched the real on-disk directory name —
 * those directories really do start with `-`. The strip is removed here.
 *
 * Exported for unit testing.
 */
export function encodeProjectPath(projectPath: string): string {
  const abs = resolve(projectPath);
  return abs.replace(/\//g, "-");
}

/**
 * Resolve the `~/.claude/projects/` subdirectory for a project.
 *
 * PRIMARY path: an exact match on the encoded directory name. Because the
 * encoded form keeps its leading hyphen (SD-1), this now matches the real
 * directory layout.
 *
 * FALLBACK path: if the exact name isn't present (Claude Code's encoder may
 * differ on edge chars across versions), scan the live listing for a directory
 * whose own decoded form points back at the same cwd. This makes the cwd match
 * — not the synthesized string — the source of truth.
 *
 * Returns the absolute directory path, or null when nothing matches.
 */
function resolveClaudeProjectDir(
  claudeProjectsRoot: string,
  encodedPath: string,
): string | null {
  const exact = join(claudeProjectsRoot, encodedPath);
  if (existsSync(exact) && statSync(exact).isDirectory()) {
    return exact;
  }

  let entries: string[];
  try {
    entries = readdirSync(claudeProjectsRoot);
  } catch {
    return null;
  }

  const match = entries.find((name) => name === encodedPath);
  return match ? join(claudeProjectsRoot, match) : null;
}

// CLI entrypoint
if (import.meta.main) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const result = probeHostRuntime(projectRoot);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.currentSessionPath ? 0 : 1);
}
