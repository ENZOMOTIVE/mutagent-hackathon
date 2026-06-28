/**
 * scripts/awareness/blind-spots.ts
 * R2.2 — blind-spots derivation for the Methodology Step 1.5 widget.
 * Type A — Pure Script (deterministic; NO clock/random/LLM/I-O).
 *
 * A "blind spot" is a signal that Tier-0 CANNOT measure (so it would never become
 * the auto-picked primary signal) but which the awareness LLM mini-sample (R2.2)
 * CAN surface. The blind-spots table makes the measurement gap HONEST (design
 * philosophy §2.3): for each candidate signal we state whether Tier-0 can measure
 * it, who checked it, and what was found.
 *
 * The canonical Tier-0-MEASURABLE set is derived from what tier0-scan.ts actually
 * computes: error spike, latency spike, feedback cluster, low score, api exhaustion,
 * skill-behavior deviation. EVERYTHING ELSE in the WHAT taxonomy is a Tier-0
 * blind spot — only the LLM awareness layer can see it.
 */

import type { WhatCategory } from "../normalize/trace.ts";

/** WHAT-categories Tier-0 can MEASURE deterministically (from tier0-scan.ts). */
export const TIER0_MEASURABLE: ReadonlySet<WhatCategory> = new Set<WhatCategory>([
  "latency-spike",
  "low-score",
  "user-complaint", // feedback cluster
  "cost-overshoot", // token totals are countable
]);

/**
 * WHAT-categories that are Tier-0 BLIND SPOTS — only the LLM awareness layer
 * (or a deep-read) can surface them. The complement of TIER0_MEASURABLE over the
 * full WhatCategory union.
 */
export const TIER0_BLIND_SPOTS: ReadonlyArray<WhatCategory> = [
  "wrong-output",
  "missing-output",
  "loop",
  "format-violation",
  "hallucination",
  "missing-context",
];

export interface BlindSpotRow {
  /** Signal / failure-mode name. */
  signal: string;
  /** Whether Tier-0 can MEASURE this signal. */
  measurable: "Tier-0" | "No";
  /** Who checked it ("tier-0 scan" | "awareness LLM sample" | "—"). */
  checkedBy: string;
  /** What the check found. */
  result: string;
}

export interface BlindSpotsInput {
  /**
   * Signals the awareness LLM mini-sample DISCOVERED (free-form labels from the
   * analyzer). Used to fill the "result" column for blind-spot signals.
   */
  awarenessFindings: string[];
  /**
   * Whether the awareness layer actually fired. When false (library priors), the
   * blind-spots table renders a single placeholder row.
   */
  awarenessFired: boolean;
}

/**
 * Build the blind-spots table rows. Deterministic: iterates the canonical
 * Tier-0-measurable list (marked measurable) then the blind-spot list (marked No),
 * attributing the awareness LLM as the checker for blind spots when it fired.
 *
 * A blind-spot signal whose name appears (case-insensitive substring) in the
 * awarenessFindings is marked "DISCOVERED"; otherwise "not observed".
 */
export function buildBlindSpots(input: BlindSpotsInput): BlindSpotRow[] {
  if (!input.awarenessFired) {
    return [
      {
        signal: "(all)",
        measurable: "No",
        checkedBy: "—",
        result: "Awareness layer skipped (library priors exist) — see Step 1.5 placeholder.",
      },
    ];
  }

  const rows: BlindSpotRow[] = [];

  // Tier-0-measurable signals first (these are NOT blind spots).
  for (const sig of TIER0_MEASURABLE) {
    rows.push({
      signal: sig,
      measurable: "Tier-0",
      checkedBy: "tier-0 scan",
      result: "Measured deterministically (no LLM needed).",
    });
  }

  // Blind spots — only the awareness LLM can see these.
  const lowered = input.awarenessFindings.map((f) => f.toLowerCase());
  for (const sig of TIER0_BLIND_SPOTS) {
    const discovered = lowered.some((f) => f.includes(sig.toLowerCase()));
    rows.push({
      signal: sig,
      measurable: "No",
      checkedBy: "awareness LLM sample",
      result: discovered ? "DISCOVERED by awareness sample" : "not observed in awareness sample",
    });
  }

  return rows;
}

/**
 * True when the awareness sample surfaced at least one Tier-0 blind spot — i.e.
 * the measurement layer caught something Tier-0 would have missed. Used to mark
 * "discovered" badges on the R2.4 selection-rule cards.
 */
export function awarenessDiscoveredBlindSpot(rows: BlindSpotRow[]): boolean {
  return rows.some((r) => r.measurable === "No" && r.result.startsWith("DISCOVERED"));
}

// ── SO-05 CLI entrypoint ──────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  // Accept awareness findings as a JSON array string or a file path
  const findingsArg = get("--findings");
  const firedStr = get("--awareness-fired");
  const outputPath = get("--output");

  if (!findingsArg) {
    process.stderr.write(
      "Usage: bun scripts/awareness/blind-spots.ts --findings '[\"signal1\",\"signal2\"]' [--awareness-fired true|false] [--output <file>]\n"
    );
    process.exit(1);
  }

  const { writeFileSync } = await import("fs");

  let awarenessFindings: string[];
  try {
    awarenessFindings = JSON.parse(findingsArg) as string[];
  } catch {
    process.stderr.write(`--findings must be a JSON array string\n`);
    process.exit(1);
  }

  const awarenessFired = firedStr !== "false";
  const rows = buildBlindSpots({ awarenessFindings, awarenessFired });
  const discovered = awarenessDiscoveredBlindSpot(rows);

  const result = { rows, discoveredBlindSpot: discovered };
  const out = JSON.stringify(result, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, out, "utf8");
    process.stderr.write(`Blind-spots table written to ${outputPath}\n`);
  } else {
    process.stdout.write(out + "\n");
  }
  process.exit(0);
}
