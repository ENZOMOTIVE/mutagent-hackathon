/**
 * scripts/library/store.ts
 * R2.3 (+D2) — class-memory library read/write store.
 * Type A — Pure Script (file I/O; clock + home INJECTED for determinism).
 *
 * WRITE GATE (R2.3, LOAD-BEARING): the library is written ONLY from operator-
 * APPROVED findings. writeApprovedFinding() refuses unless the caller passes
 * `approved: true`. There is NO bypass — an un-approved finding NEVER lands in
 * the library (mirrors the report's approval gate; do not bypass it).
 *
 * DETERMINISM: INDEX.md is sorted by entity slug; journal.md is append-only;
 * pattern files are stable JSON. The only non-determinism (timestamps) is injected
 * by the caller so tests are byte-stable.
 *
 * The library lives PER-HOST + GITIGNORED — see paths.ts. We never commit data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, statSync } from "fs";
import {
  libraryRoot,
  indexPath,
  byEntityRoot,
  entityDir,
  entityJsonPath,
  journalPath,
  patternsDir,
  patternPath,
  deepReadLedgerPath,
  entitySlug,
} from "./paths.ts";
import type { DeepReadLedgerEntry, LibraryEntity, LibraryPattern, LibraryRunRecord } from "./types.ts";
import { DEEP_READ_LEDGER_TTL_MS } from "./types.ts";

export interface ApprovedFindingInput {
  entityName: string;
  entityType: LibraryEntity["entityType"];
  /** MUST be true — the write gate refuses otherwise (R2.3 approved-only). */
  approved: boolean;
  findingId: string;
  signal: string;
  /** Regex source promoted as a Tier-0 detector (plain regex). */
  regex: string;
  regexFlags?: string;
  /** D2 — verbatim operator invocation that produced this run. */
  operatorInvocation?: string;
  runId: string;
  /** INJECTED timestamp (ISO8601) — keeps writes deterministic in tests. */
  nowIso: string;
}

export interface WriteResult {
  written: boolean;
  reason: string;
  entitySlug: string;
}

/** Ensure a directory exists (idempotent). */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Load an entity record, or null when absent. */
export function loadEntity(slug: string, home?: string): LibraryEntity | null {
  const p = entityJsonPath(slug, home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LibraryEntity;
  } catch {
    return null;
  }
}

/**
 * R2.3 — the SOLE library write path. Refuses unless `approved === true`. Creates
 * the per-entity dir, upserts entity.json (append run + pattern), appends to the
 * journal, writes the pattern file, and regenerates INDEX.md deterministically.
 */
export function writeApprovedFinding(input: ApprovedFindingInput, home?: string): WriteResult {
  const slug = entitySlug(input.entityName);

  // WRITE GATE — approved-only (R2.3). No bypass.
  if (!input.approved) {
    return {
      written: false,
      reason: "REFUSED — library write requires an operator-APPROVED finding (R2.3 approved-only gate).",
      entitySlug: slug,
    };
  }

  ensureDir(entityDir(slug, home));
  ensureDir(patternsDir(slug, home));

  // Upsert entity.json.
  const existing = loadEntity(slug, home);
  const runRecord: LibraryRunRecord = {
    runId: input.runId,
    diagnosedAt: input.nowIso,
    operatorInvocation: input.operatorInvocation,
    approvedFindingCount: 1,
  };
  const pattern: LibraryPattern = {
    patternId: `${slug}-${input.findingId}`,
    signal: input.signal,
    regex: input.regex,
    flags: input.regexFlags,
    sourceFindingId: input.findingId,
    approvedAt: input.nowIso,
  };

  let entity: LibraryEntity;
  if (existing) {
    // Append run (append-only) + upsert pattern by id.
    const runs = [...existing.runs, runRecord];
    const patterns = upsertPattern(existing.patterns, pattern);
    // BLOCK G — tolerate pre-ledger entity.json records (field added in Wave-17).
    const deepReadLedger = existing.deepReadLedger ?? [];
    entity = { ...existing, runs, patterns, deepReadLedger, updatedAt: input.nowIso };
  } else {
    entity = {
      name: input.entityName,
      entityType: input.entityType,
      slug,
      runs: [runRecord],
      patterns: [pattern],
      deepReadLedger: [],
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
  }

  writeFileSync(entityJsonPath(slug, home), JSON.stringify(entity, null, 2) + "\n", "utf8");
  writeFileSync(patternPath(slug, pattern.patternId, home), JSON.stringify(pattern, null, 2) + "\n", "utf8");

  // Append-only journal entry.
  const journalEntry =
    `## ${input.nowIso} — ${input.findingId} (${input.signal})\n` +
    `- run: ${input.runId}\n` +
    (input.operatorInvocation ? `- invocation: ${input.operatorInvocation.replace(/\n/g, " ")}\n` : "") +
    `- pattern: \`${input.regex}\`${input.regexFlags ? ` /${input.regexFlags}` : ""}\n\n`;
  appendFileSync(journalPath(slug, home), journalEntry, "utf8");

  // Regenerate deterministic INDEX.md.
  regenerateIndex(home);

  return { written: true, reason: "Approved finding written to library.", entitySlug: slug };
}

function upsertPattern(patterns: LibraryPattern[], next: LibraryPattern): LibraryPattern[] {
  const idx = patterns.findIndex((p) => p.patternId === next.patternId);
  if (idx === -1) return [...patterns, next];
  const copy = [...patterns];
  copy[idx] = next;
  return copy;
}

/**
 * Regenerate INDEX.md from the on-disk entity records. DETERMINISTIC: entities are
 * sorted by slug; each row lists run-count + pattern-count. Pure given disk state.
 */
export function regenerateIndex(home?: string): void {
  ensureDir(libraryRoot(home));
  const root = byEntityRoot(home);
  const slugs = existsSync(root)
    ? readdirSync(root).filter((e) => {
        try {
          return statSync(entityDir(e, home)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  slugs.sort(); // deterministic ordering.

  const lines: string[] = [
    "# mutagent-diagnostics — class-memory library",
    "",
    "> Per-host, gitignored. Approved findings only (R2.3). Patterns are matched FIRST in Tier-0.",
    "",
    "| Entity | Type | Runs | Patterns |",
    "|--------|------|------|----------|",
  ];
  for (const slug of slugs) {
    const e = loadEntity(slug, home);
    if (!e) continue;
    lines.push(`| ${e.name} | ${e.entityType} | ${e.runs.length} | ${e.patterns.length} |`);
  }
  lines.push("");
  writeFileSync(indexPath(home), lines.join("\n"), "utf8");
}

/** True when library priors exist for the entity (drives R2.1 refusal downgrade). */
export function hasPriors(entityName: string, home?: string): boolean {
  const e = loadEntity(entitySlug(entityName), home);
  return !!e && e.patterns.length > 0;
}

/**
 * Build the priorSignalsRef string for an entity (consumed by R2.1's gate + R2.2's
 * SKIP). Returns the journal-relative ref when priors exist, else undefined.
 */
export function priorSignalsRef(entityName: string, home?: string): string | undefined {
  const slug = entitySlug(entityName);
  return hasPriors(entityName, home) ? `by-entity/${slug}/journal.md` : undefined;
}

// ── BLOCK G — cross-run deep-read LEDGER ─────────────────────────────────────
//
// The ledger records, per (entity, trace), that the deep-read analyzer already
// digested that trace. It lives in its OWN file (deep-read-ledger.json) — NOT inside
// entity.json — because deep-read digests are produced by the analyzer, not gated by
// the operator-approved write gate (R2.3) that governs patterns. Persistence is
// append-only + deduped by traceId; the clock is INJECTED (entry.ts) for byte-stable
// tests. foldValidDigests() applies the validity filter ONLY — it does NOT promote;
// Block C re-applies the evidence floor to the folded digests (clean boundary, R2).

/** Load an entity's deep-read ledger from its own file, or [] when absent/corrupt. */
export function loadLedger(entityName: string, home?: string): DeepReadLedgerEntry[] {
  const slug = entitySlug(entityName);
  const p = deepReadLedgerPath(slug, home);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as DeepReadLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist an entity's deep-read ledger deterministically (stable JSON + trailing newline). */
function writeLedger(slug: string, entries: DeepReadLedgerEntry[], home?: string): void {
  ensureDir(entityDir(slug, home));
  writeFileSync(deepReadLedgerPath(slug, home), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * BLOCK G — true when the entity's ledger already holds a digest for `traceId`.
 * Existence check only — does NOT consider validity (a stale-but-present entry still
 * counts as ledgered). Callers that need validity use foldValidDigests().
 */
export function isLedgered(entityName: string, traceId: string, home?: string): boolean {
  return loadLedger(entityName, home).some((e) => e.traceId === traceId);
}

/**
 * BLOCK G — append deep-read digests to an entity's ledger, deduped by traceId. A new
 * entry whose traceId already exists REPLACES the prior entry (latest digest wins —
 * a re-read with a newer analyzerVersion/fingerprint/ts supersedes the stale one).
 * Append-only across distinct traceIds; existing-trace digests are upserted in place.
 * Returns the persisted ledger.
 */
export function recordLedger(
  entityName: string,
  entries: DeepReadLedgerEntry[],
  home?: string
): DeepReadLedgerEntry[] {
  const slug = entitySlug(entityName);
  const merged = loadLedger(entityName, home);
  for (const next of entries) {
    const idx = merged.findIndex((e) => e.traceId === next.traceId);
    if (idx === -1) merged.push(next);
    else merged[idx] = next; // dedupe by traceId — latest digest wins.
  }
  writeLedger(slug, merged, home);
  return merged;
}

export interface FoldValidOptions {
  /** Current analyzer version — entries stamped with a different version are invalid. */
  analyzerVersion: string;
  /** Current entity fingerprint — entries stamped with a different fingerprint are invalid. */
  entityFingerprint: string;
  /** INJECTED current time (ms epoch) for TTL checks — keeps the fold deterministic in tests. */
  nowMs: number;
  /** Max age before an entry is stale. Defaults to DEEP_READ_LEDGER_TTL_MS (~30d). */
  ttlMs?: number;
}

/**
 * BLOCK G — fold an entity's ledger down to the entries that are still VALID.
 *
 * An entry is INVALID (excluded → the trace re-admits for a fresh deep-read) when ANY:
 *   - entry.analyzerVersion  !== opts.analyzerVersion   (analyzer logic changed)
 *   - entry.entityFingerprint !== opts.entityFingerprint (entity changed under it)
 *   - opts.nowMs - Date.parse(entry.ts) > ttlMs          (digest aged out)
 *
 * An entry with an unparseable ts is treated as INVALID (fail-stale, never fail-fresh).
 *
 * BOUNDARY (R2): this returns version-stamped digests + validity filtering ONLY. It does
 * NOT decide promotion — Block C re-applies the evidence floor to these. Keep it clean.
 */
export function foldValidDigests(
  entityName: string,
  opts: FoldValidOptions,
  home?: string
): DeepReadLedgerEntry[] {
  const ttlMs = opts.ttlMs ?? DEEP_READ_LEDGER_TTL_MS;
  return loadLedger(entityName, home).filter((e) => {
    if (e.analyzerVersion !== opts.analyzerVersion) return false;
    if (e.entityFingerprint !== opts.entityFingerprint) return false;
    const tsMs = Date.parse(e.ts);
    if (Number.isNaN(tsMs)) return false; // fail-stale on a corrupt timestamp.
    if (opts.nowMs - tsMs > ttlMs) return false;
    return true;
  });
}

/**
 * BLOCK G — targeted poison removal: drop the ledger entry for `traceId` so the trace
 * re-admits for a fresh deep-read on the next run. Returns true when an entry was
 * removed, false when none matched. Persists only when a change occurred.
 */
export function invalidateEntry(entityName: string, traceId: string, home?: string): boolean {
  const slug = entitySlug(entityName);
  const ledger = loadLedger(entityName, home);
  const next = ledger.filter((e) => e.traceId !== traceId);
  if (next.length === ledger.length) return false;
  writeLedger(slug, next, home);
  return true;
}
