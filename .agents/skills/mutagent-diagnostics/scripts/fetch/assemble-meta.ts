#!/usr/bin/env tsx
/**
 * scripts/fetch/assemble-meta.ts — R-002-A-v2
 *
 * Appends a single metadata entry to a JSON array read from stdin,
 * then writes the updated array to stdout.
 *
 * Replaces the inline `bun eval` + `python3` heredoc block in
 * claude-code-transcripts.sh (was lines 94-104), restoring PR-019 / R-SELF-03-c
 * compliance and eliminating both compounding bugs in one cut.
 *
 * Usage:
 *   echo '<prior-array-json>' | run.sh scripts/fetch/assemble-meta.ts --entry '<entry-json>'
 *
 * stdin:  prior meta array as JSON (e.g. `[]` on first call)
 * stdout: updated meta array as JSON
 * stderr: error details on any parse failure
 * exit 1: on any parse failure — NEVER silently falls back to prior array
 *
 * Runtime: portable — no Bun.* API calls; runs under bun, pnpm-tsx, or npx-tsx.
 */

/** Read all of stdin as a string (works in both Node and Bun). */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entryFlagIdx = args.indexOf('--entry');

  if (entryFlagIdx === -1 || entryFlagIdx + 1 >= args.length) {
    process.stderr.write(
      'ERROR: assemble-meta.ts requires --entry <json-string>\n' +
      'Usage: run.sh scripts/fetch/assemble-meta.ts --entry \'{"key":"val"}\'\n'
    );
    process.exit(1);
  }

  const entryStr = args[entryFlagIdx + 1];

  // Parse the new entry
  let entry: unknown;
  try {
    entry = JSON.parse(entryStr);
  } catch (e) {
    process.stderr.write(
      `ERROR: assemble-meta.ts failed to parse --entry as JSON: ${e}\n` +
      `  Received (first 300 chars): ${entryStr.slice(0, 300)}\n`
    );
    process.exit(1);
  }

  // Read the prior array from stdin
  const stdinContent = await readStdin();
  let arr: unknown[];
  try {
    const trimmed = stdinContent.trim();
    const parsed: unknown = JSON.parse(trimmed.length > 0 ? trimmed : '[]');
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected a JSON array, got ${typeof parsed}`);
    }
    arr = parsed;
  } catch (e) {
    process.stderr.write(`ERROR: assemble-meta.ts failed to parse stdin as JSON array: ${e}\n`);
    process.exit(1);
  }

  arr.push(entry);
  process.stdout.write(JSON.stringify(arr));
}

main().catch((e: unknown) => {
  process.stderr.write(`ERROR: assemble-meta.ts unexpected error: ${e}\n`);
  process.exit(1);
});
