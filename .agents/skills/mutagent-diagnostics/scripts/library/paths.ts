/**
 * scripts/library/paths.ts
 * R2.3 — class-memory library path resolution. PER-HOST + GITIGNORED.
 * Type A — Pure Script (path construction only; the home dir is INJECTABLE).
 *
 * The library is the skill's cross-run memory: per-entity journals of approved
 * findings + regex patterns that get matched FIRST in Tier-0 (so a known failure
 * mode is recognised cheaply on the next run). It lives PER-HOST under the user's
 * home (~/.mutagent-diagnostics/library/) and is GITIGNORED — we commit the library
 * CODE + a .gitignore entry, NEVER the library DATA (it is host-/operator-specific
 * and may carry operator-private invocation briefs via D2).
 *
 * Layout (Evolvr-style):
 *   ~/.mutagent-diagnostics/library/
 *     INDEX.md                      # deterministic ToC, sorted by entity
 *     by-entity/<entity-slug>/
 *       entity.json                 # machine record (name, type, runs[], priors)
 *       journal.md                  # append-only human log of approved findings
 *       patterns/<pattern-id>.json  # regex detectors promoted from approved findings
 *       deep-read-ledger.json       # BLOCK G — cross-run deep-read digests (deduped by traceId)
 *
 * The home directory is INJECTABLE so tests never touch the real ~/.
 */

import { join } from "path";
import { homedir } from "os";

/** Root of the per-host library. Injectable home for tests. */
export function libraryRoot(home: string = homedir()): string {
  return join(home, ".mutagent-diagnostics", "library");
}

export function indexPath(home?: string): string {
  return join(libraryRoot(home), "INDEX.md");
}

export function byEntityRoot(home?: string): string {
  return join(libraryRoot(home), "by-entity");
}

export function entityDir(entitySlug: string, home?: string): string {
  return join(byEntityRoot(home), entitySlug);
}

export function entityJsonPath(entitySlug: string, home?: string): string {
  return join(entityDir(entitySlug, home), "entity.json");
}

export function journalPath(entitySlug: string, home?: string): string {
  return join(entityDir(entitySlug, home), "journal.md");
}

export function patternsDir(entitySlug: string, home?: string): string {
  return join(entityDir(entitySlug, home), "patterns");
}

export function patternPath(entitySlug: string, patternId: string, home?: string): string {
  return join(patternsDir(entitySlug, home), `${patternId}.json`);
}

/**
 * BLOCK G — per-entity deep-read ledger file (cross-run digests, deduped by traceId).
 * Lives under the entity's class-memory dir, alongside entity.json — same per-host,
 * gitignored boundary as the rest of the library.
 */
export function deepReadLedgerPath(entitySlug: string, home?: string): string {
  return join(entityDir(entitySlug, home), "deep-read-ledger.json");
}

/**
 * Deterministic entity slug: lowercase, non-alphanumerics → "-", collapse repeats,
 * trim leading/trailing "-". Stable across runs so the same entity always maps to
 * the same library dir.
 */
export function entitySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}
