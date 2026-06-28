/**
 * scripts/invocation/parse-brief.ts
 * R2.6 (+D2) — natural-language operator-brief parser (regex v0.2).
 * Type A — Pure Script (deterministic regex parse; NO clock/random/LLM/I-O).
 *
 * The slash-command `/mutagent-diagnostics "<brief>"` takes a single positional
 * natural-language arg. This parser extracts a best-effort structured shape:
 *   { agent?, timeWindow?, focus?, residual, scopeType, entity? }
 *
 * DEFENSIVE BY DESIGN (plan §4 R2.6): the parser NEVER throws and NEVER drops the
 * brief. Anything it cannot classify lands in `residual` and the run proceeds with
 * a neutral survey (design philosophy §2.2 — operator-driven, never skill-prompts).
 *
 * D2: the caller stores the VERBATIM brief (runMeta.operatorInvocation) ALONGSIDE
 * this parsed shape (runMeta.parsedInvocation) — the verbatim is never dropped even
 * when parsing fully succeeds (re-parse later + intent context + library authenticity).
 *
 * v0.2 regex grammar (documented, intentionally simple — iterate later):
 *   agent      ← "agent <name>" | "for <name>" | "diagnose <name>"
 *                NOTE: "the agent <name>" is NOT matched (article false-positive guard)
 *   timeWindow ← "last <N> <unit>" | "past <N> <unit>" | "<N><unit-short> window"
 *   focus      ← "focus on <text>" | "focused on <text>" | "focus: <text>" | "about <text>"
 *   scopeType  ← derived from the named entity: "skill" if it looks like a skill name
 *                (contains "skill" / "diagnostics" / ends in "-skill"), "agent" otherwise.
 *                null when no entity is extractable.
 *   entity     ← the raw extracted name (same as agent field when set)
 *
 * W11-06 changes:
 *   - FOCUS_RE: added "focus: <text>" colon form
 *   - AGENT_RE: negative lookbehind (?<!the\s) to guard "the agent X" false-positive
 *   - ParsedInvocation: added scopeType + entity fields
 */

export interface ParsedInvocation {
  /** Agent / entity the operator named, when extractable. */
  agent?: string;
  /** Time window phrase, normalized (e.g. "last 24h"). */
  timeWindow?: string;
  /** Focus directive — when set, the report leads with a Guided tab. */
  focus?: string;
  /** Everything not classified — the brief is NEVER dropped (defensive). */
  residual: string;
  /**
   * W11-06: classified scope of the diagnosed subject.
   * - "skill"  — the named entity looks like a skill (contains "skill" or
   *              "diagnostics", or ends in "-skill")
   * - "agent"  — a named entity was found but it does not match skill heuristics
   * - null     — no entity was extractable from the brief
   */
  scopeType: "skill" | "agent" | null;
  /**
   * W11-06: the raw extracted entity name (same value as `agent` when set).
   * Populated when scopeType is non-null; absent when scopeType === null.
   */
  entity?: string;
}

/**
 * W11-06 AGENT_RE:
 * Guards against "the agent X" false-positive in two layers:
 *
 * Layer 1 — Negative lookbehind (?<!the\s):
 *   Prevents the "agent" keyword itself from firing when preceded by "the ".
 *   Handles "focus on the agent" where "agent" is a generic noun, not a trigger.
 *
 * Layer 2 — Negative lookahead (?!the\b|a\b|an\b):
 *   Prevents article/determiner words from being captured as the entity name.
 *   Handles "diagnose the agent" where "diagnose" triggers and "the" would
 *   otherwise be captured as the entity name.
 *
 * Combined: "diagnose the agent" → no entity (both layers block it)
 *           "diagnose search-agent" → entity = "search-agent" (neither layer fires)
 */
const AGENT_RE =
  /(?<!the\s)\b(?:agent|for|diagnose)\s+(?!the\b|a\b|an\b)([a-z0-9][a-z0-9._-]*)/i;
const TIME_RE =
  /\b(?:last|past)\s+(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|w|minutes?|mins?|m)\b/i;
/**
 * W11-06 FOCUS_RE: extended to also match "focus: <text>" (colon form).
 * Original forms retained: "focus on", "focused on", "about".
 */
const FOCUS_RE = /\b(?:focus(?:ed)?\s+on|focus\s*:|about)\s+(.+?)(?:\s*$|[.;])/i;

/** Normalize a time unit token to a short canonical form. */
function normalizeUnit(unit: string): string {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return "h";
  if (u.startsWith("d")) return "d";
  if (u.startsWith("w")) return "w";
  if (u.startsWith("min") || u === "m") return "m";
  return u;
}

/**
 * W11-06: Classify a named entity as 'skill' or 'agent' from its name heuristic.
 * Deterministic — same input always returns same output.
 * Heuristic: skill if name contains "skill", "diagnostics", or ends in "-skill".
 */
function classifyScopeType(name: string): "skill" | "agent" {
  const lower = name.toLowerCase();
  if (
    lower.includes("skill") ||
    lower.includes("diagnostics") ||
    lower.endsWith("-skill")
  ) {
    return "skill";
  }
  return "agent";
}

/**
 * R2.6 — parse a natural-language brief into ParsedInvocation. Deterministic +
 * defensive: never throws, always returns a residual. An empty/whitespace brief
 * yields `{ residual: "", scopeType: null }` and the caller falls back to a neutral survey.
 */
export function parseBrief(brief: string): ParsedInvocation {
  const trimmed = (brief ?? "").trim();
  if (trimmed.length === 0) return { residual: "", scopeType: null };

  const result: ParsedInvocation = { residual: trimmed, scopeType: null };

  const agentMatch = AGENT_RE.exec(trimmed);
  if (agentMatch) {
    const name = agentMatch[1];
    result.agent = name;
    result.entity = name;
    result.scopeType = classifyScopeType(name);
  }

  const timeMatch = TIME_RE.exec(trimmed);
  if (timeMatch)
    result.timeWindow = `last ${timeMatch[1]}${normalizeUnit(timeMatch[2])}`;

  const focusMatch = FOCUS_RE.exec(trimmed);
  if (focusMatch) result.focus = focusMatch[1].trim();

  return result;
}

/**
 * True when the parsed invocation carries a focus directive — drives the report's
 * tab layout (focus → Guided REPLACES Overview; no focus → neutral survey).
 */
export function isFocusedInvocation(parsed: ParsedInvocation): boolean {
  return typeof parsed.focus === "string" && parsed.focus.trim().length > 0;
}

// ── CLI entrypoint (PRD-SO-05) ────────────────────────────────────────────────
//
// Usage:
//   bun scripts/cli/run.sh scripts/invocation/parse-brief.ts "<brief string>"
//   bun scripts/cli/run.sh scripts/invocation/parse-brief.ts --output <file> "<brief>"
//
// Accepts a positional brief string (may be quoted). Emits { verbatim, parsed } JSON
// to --output (stdout when omitted). Exit 0 always (parse-brief never throws).

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const args = process.argv.slice(2);

  let outputPath: string | null = null;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else {
      remaining.push(args[i]);
    }
  }

  // The brief is everything in remaining joined (handles multi-word quoted strings
  // that the shell may have split across positions).
  const brief = remaining.join(" ").trim();
  const parsed = parseBrief(brief);

  const out = { verbatim: brief, parsed };
  const json = JSON.stringify(out, null, 2);

  if (outputPath) {
    writeFileSync(resolve(outputPath), json, "utf-8");
    console.info(`parse-brief result written to ${outputPath}`);
  } else {
    console.info(json);
  }
}
