/**
 * scripts/library/types.ts
 * R2.3 (+D2) — class-memory library record types.
 * Type A — Pure Script (type + schema definitions only).
 *
 * entity.json is the machine record per diagnosed entity. journal.md is the
 * append-only human log. patterns/<id>.json are regex detectors promoted from
 * operator-APPROVED findings (the only write trigger).
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

/**
 * D2: a single run record stored in the library. operatorInvocation is the
 * VERBATIM brief preserved even when parsing succeeded (re-parse later + library
 * authenticity, plan §5 D2).
 */
export const LibraryRunRecordSchema = Type.Object({
  runId: Type.String(),
  diagnosedAt: Type.String(),
  /** D2 — verbatim operator brief that initiated this run (may be empty). */
  operatorInvocation: Type.Optional(Type.String()),
  /** How many approved findings this run contributed to the library. */
  approvedFindingCount: Type.Number(),
});
export type LibraryRunRecord = Static<typeof LibraryRunRecordSchema>;

/**
 * A regex pattern detector promoted from an approved finding. Plain regex (no LLM)
 * so Tier-0 can match it deterministically + cheaply.
 */
export const LibraryPatternSchema = Type.Object({
  patternId: Type.String(),
  /** Signal/failure-mode this pattern detects (e.g. "loop", "hallucination"). */
  signal: Type.String(),
  /** Plain regex source string (matched against trace text/tags in Tier-0). */
  regex: Type.String(),
  /** Regex flags (e.g. "i"). */
  flags: Type.Optional(Type.String()),
  /** The finding id this pattern was promoted from (provenance). */
  sourceFindingId: Type.String(),
  /** ISO8601 when it was approved into the library. */
  approvedAt: Type.String(),
});
export type LibraryPattern = Static<typeof LibraryPatternSchema>;

/**
 * BLOCK G (deep-read LEDGER) — one cross-run record per (entity, trace) the deep-read
 * analyzer has already digested. The ledger lets the next run SKIP re-reading a trace
 * whose digest is still VALID, while remaining honest about staleness: an entry is
 * INVALIDATED (and excluded from a fold) when the analyzer version changed, the entity
 * fingerprint changed, or the entry aged past its TTL. Blocks B (deep-read planning)
 * and C (promotion) consume this — but the ledger itself NEVER decides promotion: it
 * carries version-stamped digests + validity only (R2 boundary; Block C re-applies the
 * evidence floor to folded digests).
 */
export const DeepReadLedgerEntrySchema = Type.Object({
  /** Trace this digest was produced from (the dedupe key within an entity ledger). */
  traceId: Type.String(),
  /** Failure-mode / signal the deep-read attributed to this trace (e.g. "loop"). */
  signal: Type.String(),
  /** Short deterministic digest of what happened — NO client identity, synthetic-safe. */
  whatHappenedDigest: Type.String(),
  /** Pointer back to the evidence the digest was derived from (e.g. journal/report ref). */
  evidenceRef: Type.String(),
  /** Analyzer version that produced the digest — bump invalidates prior entries. */
  analyzerVersion: Type.String(),
  /** Entity fingerprint at digest time — a change (e.g. prompt edit) invalidates priors. */
  entityFingerprint: Type.String(),
  /** INJECTED ISO8601 timestamp the entry was recorded (drives TTL invalidation). */
  ts: Type.String(),
});
export type DeepReadLedgerEntry = Static<typeof DeepReadLedgerEntrySchema>;

export const LibraryEntitySchema = Type.Object({
  name: Type.String(),
  entityType: Type.Union([
    Type.Literal("agent"),
    Type.Literal("tool"),
    Type.Literal("skill"),
    Type.Literal("model"),
  ]),
  slug: Type.String(),
  /** D2 — append-only run history (latest last). */
  runs: Type.Array(LibraryRunRecordSchema),
  /** Promoted regex detectors (matched FIRST in Tier-0). */
  patterns: Type.Array(LibraryPatternSchema),
  /**
   * BLOCK G — cross-run deep-read ledger (append-only, deduped by traceId). Persisted
   * in its OWN file (deep-read-ledger.json) so the approved-only entity.json write gate
   * stays clean; carried on the record type for typed composition by Blocks B/C.
   */
  deepReadLedger: Type.Array(DeepReadLedgerEntrySchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type LibraryEntity = Static<typeof LibraryEntitySchema>;

/**
 * R2.3 — prior-signal weight multiplier. A signal backed by a library prior counts
 * 3× in the R2.2 awareness/selection step (plan §4 R2.3).
 */
export const PRIOR_SIGNAL_WEIGHT = 3;

/**
 * BLOCK G — default ledger TTL: 30 days in milliseconds. A deep-read digest older than
 * this is treated as stale and excluded from foldValidDigests(). Callers may override
 * per-fold; this is the sane default so a year-old digest never silently re-admits.
 */
export const DEEP_READ_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
