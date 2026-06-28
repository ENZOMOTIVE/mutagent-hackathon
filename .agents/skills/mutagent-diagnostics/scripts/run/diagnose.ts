/**
 * scripts/run/diagnose.ts
 * R2.6 (+D2) — the `/mutagent-diagnostics "<brief>"` single-arg invocation entry.
 * Type A — Pure Script (parse + run-session wiring; clock via session.ts).
 *
 * ⚠️ ZONE 1.5 — CLI SURFACE. This is the operator-facing invocation contract:
 *   /mutagent-diagnostics "<natural language brief>"   (single positional arg)
 *
 * NO onboarding prompts, NO mid-run AskUserQuestion (design philosophy §2.2 —
 * operator-driven). The brief is parsed (parse-brief.ts), the VERBATIM string is
 * preserved (D2), a run session is created, and both verbatim + parsed shapes are
 * persisted to run-meta.json. When the brief carries a focus, the downstream report
 * leads with the 🎯 Guided tab; otherwise it renders the neutral survey (Overview).
 *
 * This entry does NOT touch onboarding (scripts/cli/init.ts) — it is the RUN path.
 */

import { parseBrief, isFocusedInvocation, type ParsedInvocation } from "../invocation/parse-brief.ts";
import { createRunSession, persistRunMeta } from "./session.ts";

export interface DiagnoseInvocation {
  /** The VERBATIM operator brief (D2 — never dropped). */
  operatorInvocation: string;
  /** Best-effort parse of the brief. */
  parsed: ParsedInvocation;
  /** True when the report should lead with the 🎯 Guided tab (focus set). */
  guided: boolean;
  /** Generated run id (from the run session). */
  runId: string;
}

/**
 * R2.6 — build a diagnose invocation from the single-arg brief. Creates a run
 * session and persists the verbatim + parsed invocation (D2). Pure aside from the
 * run-session file write (which session.ts owns + tests inject configRoot for).
 *
 * `configRoot` defaults to cwd; tests pass a temp dir. The brief is preserved
 * VERBATIM regardless of parse outcome.
 */
export function startDiagnoseFromBrief(brief: string, configRoot: string): DiagnoseInvocation {
  const operatorInvocation = (brief ?? "").trim();
  const parsed = parseBrief(operatorInvocation);
  const guided = isFocusedInvocation(parsed);

  const session = createRunSession({ configRoot });
  // D2: persist BOTH the verbatim brief and (implicitly) the run record. The parsed
  // shape rides in-memory to the renderer (runMeta.parsedInvocation); the verbatim
  // is the durable persisted field (run-meta.json.operatorInvocation).
  persistRunMeta(session, { operatorInvocation });

  return { operatorInvocation, parsed, guided, runId: session.runId };
}

// CLI entrypoint: `/mutagent-diagnostics "<brief>"` → single positional arg.
if (import.meta.main) {
  const brief = process.argv[2] ?? "";
  if (brief.trim().length === 0) {
    process.stderr.write('Usage: /mutagent-diagnostics "<natural language brief>"\n');
    process.exit(1);
  }
  const invocation = startDiagnoseFromBrief(brief, process.cwd());
  process.stdout.write(JSON.stringify(invocation, null, 2) + "\n");
  process.exit(0);
}
