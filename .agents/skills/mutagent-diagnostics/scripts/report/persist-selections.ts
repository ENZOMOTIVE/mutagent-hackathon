/**
 * scripts/report/persist-selections.ts
 * R-SELF-15-c: Persist operator-approved remedy selections from a copy-back paste.
 *
 * When the operator copies a remedy payload and pastes it back to the orchestrator,
 * the orchestrator calls this script to append the selection to
 * <config-base>/.mutagent-diagnostics/diagnostics-history/<session>/operator-selections.json
 *
 * On re-render of the same session, the renderer reads this file and auto-injects
 * an "Operator selections" section at the top of the report.
 *
 * Usage: bun scripts/cli/run.sh scripts/report/persist-selections.ts
 *   --config-root <path>   host project root (where .mutagent-diagnostics/ lives)
 *   --session <sessionId>  diagnostic session ID
 *   --selection <json>     JSON string of a single operator selection payload
 *
 * Type A — Pure Script (file I/O only)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";

export interface OperatorSelection {
  remedyId: string;
  findingId: string;
  title: string;
  what: string;
  why: string;
  where: string;
  selectedAt: string;
  diff?: { before: string; after: string };
  plan?: unknown;
}

export interface OperatorSelectionsFile {
  sessionId: string;
  selections: OperatorSelection[];
  lastUpdated: string;
}

/**
 * Append a single operator selection to the session's operator-selections.json.
 * Idempotent: if the same remedyId is already present, it is overwritten (not duplicated).
 */
export function persistSelection(
  configRoot: string,
  sessionId: string,
  selection: Omit<OperatorSelection, "selectedAt">
): OperatorSelectionsFile {
  const sessionDir = resolve(
    configRoot,
    ".mutagent-diagnostics",
    "diagnostics-history",
    sessionId
  );
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const filePath = join(sessionDir, "operator-selections.json");
  let existing: OperatorSelectionsFile = {
    sessionId,
    selections: [],
    lastUpdated: new Date().toISOString(),
  };

  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf8")) as OperatorSelectionsFile;
    } catch {
      // overwrite corrupted file
    }
  }

  const entry: OperatorSelection = {
    ...selection,
    selectedAt: new Date().toISOString(),
  };

  // Dedup by remedyId — overwrite existing entry if present
  const idx = existing.selections.findIndex((s) => s.remedyId === entry.remedyId);
  if (idx >= 0) {
    existing.selections[idx] = entry;
  } else {
    existing.selections.push(entry);
  }
  existing.lastUpdated = new Date().toISOString();

  writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return existing;
}

/**
 * Read operator selections for a session, or return null if none exist.
 */
export function readSelections(
  configRoot: string,
  sessionId: string
): OperatorSelectionsFile | null {
  const filePath = resolve(
    configRoot,
    ".mutagent-diagnostics",
    "diagnostics-history",
    sessionId,
    "operator-selections.json"
  );
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as OperatorSelectionsFile;
  } catch {
    return null;
  }
}

/**
 * Render an "Operator selections" HTML section for injection at top of re-rendered report.
 * Returns empty string if no selections exist.
 */
export function renderSelectionsSection(selections: OperatorSelectionsFile | null): string {
  if (!selections || selections.selections.length === 0) return "";

  const rows = selections.selections
    .map(
      (s) =>
        `<tr>
          <td><code>${s.remedyId}</code></td>
          <td>${s.findingId}</td>
          <td>${s.title}</td>
          <td style="color:var(--dim,#888)">${new Date(s.selectedAt).toLocaleString()}</td>
        </tr>`
    )
    .join("\n");

  return `
<div class="section operator-selections">
  <h2>Operator Selections</h2>
  <p class="sub">Remedies approved in previous session — auto-injected from operator-selections.json</p>
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr><th>Remedy ID</th><th>Finding</th><th>Title</th><th>Selected At</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const configRoot = getArg("--config-root") ?? process.cwd();
  const sessionId = getArg("--session");
  const selectionJson = getArg("--selection");

  if (!sessionId || !selectionJson) {
    process.stderr.write("Usage: persist-selections.ts --config-root <path> --session <id> --selection <json>\n");
    process.exit(1);
  }

  let selection: Omit<OperatorSelection, "selectedAt">;
  try {
    selection = JSON.parse(selectionJson) as Omit<OperatorSelection, "selectedAt">;
  } catch (e) {
    process.stderr.write(`Invalid --selection JSON: ${e}\n`);
    process.exit(1);
  }

  const result = persistSelection(configRoot, sessionId, selection);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}
