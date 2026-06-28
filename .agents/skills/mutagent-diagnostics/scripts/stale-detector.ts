/**
 * scripts/stale-detector.ts
 * Hash comparison for target freshness check — PR-011
 * Type A — Pure Script (pure hash compare, no I/O side effects)
 *
 * Before any apply, the orchestrator calls this script to check if the target
 * has changed since the diagnostic was run.
 *
 * Usage: bun scripts/stale-detector.ts <diagnosed-at-hash> <current-hash>
 * Exit 0 = fresh (hashes match), Exit 1 = stale (hashes differ), Exit 2 = error
 */

import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";

export interface StalenessResult {
  stale: boolean;
  diagnosedAtHash: string;
  currentHash: string;
  reason?: string;
}

/**
 * Compare two content hashes.
 * Returns stale=true if they differ.
 */
export function checkStaleness(
  diagnosedAtHash: string,
  currentHash: string
): StalenessResult {
  const stale = diagnosedAtHash !== currentHash;
  return {
    stale,
    diagnosedAtHash,
    currentHash,
    reason: stale
      ? "Target has changed since diagnostic was run. Re-diagnose recommended."
      : undefined,
  };
}

/**
 * Compute SHA-256 hash of a file's content.
 * Returns null if file doesn't exist.
 */
export function hashFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA-256 hash of a string value.
 */
export function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// CLI entrypoint
if (import.meta.main) {
  const diagnosedAtHash = process.argv[2];
  const currentHash = process.argv[3];

  if (!diagnosedAtHash || !currentHash) {
    process.stderr.write(
      "Usage: bun scripts/stale-detector.ts <diagnosed-at-hash> <current-hash>\n"
    );
    process.exit(2);
  }

  const result = checkStaleness(diagnosedAtHash, currentHash);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.stale ? 1 : 0);
}
