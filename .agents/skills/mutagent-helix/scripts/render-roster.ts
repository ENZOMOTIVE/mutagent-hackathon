import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// render-roster — dashboard *command roster generator for mutagent-system.
//
// §9.4.6 (LOCKED 2026-06-24): `routing.yaml` is the SINGLE SOURCE OF TRUTH for
// command visibility. Each command carries `visibility: shown | glimpse |
// internal`; this script READS those flags and DETERMINISTICALLY renders the
// dashboard roster blocks — exactly like scripts/sync-index.ts renders the
// SYSTEM panel from the on-disk topology. The orchestrator drops the rendered
// text into the `{command_roster}` placeholder of `help-display-template`.
//
//   - shown    → rendered in the visible roster (Lifecycle / State & Setup).
//   - glimpse  → rendered under the "=== Evaluator ===" section (evaluator
//                branches — "what the evaluator can also do", NOT standalone ADL
//                stages). NB: the enum value "glimpse" is an implementation-only
//                visibility directive; it is NEVER rendered as operator UI text.
//   - internal → HIDDEN from the roster, but STILL invocable by name. Visibility
//                is DISPLAY-ONLY; routing resolution (scripts/dispatch.ts +
//                routing.yaml route targets) is untouched.
//
// A companion test (tests/render-roster.test.ts) asserts roster ==
// routing-visibility, so `*spec`-style drift ("in routing, 0× in the roster")
// cannot recur. Parsing logic is EXPORTED + pure (routing path injected) so it
// is unit-testable; main() only parses args + prints.
//
// No clock, no network, no env reads — same routing.yaml in, same roster out.
// ---------------------------------------------------------------------------

export type Visibility = "shown" | "glimpse" | "internal";

export interface CommandVisibility {
  /** Canonical command name WITHOUT the leading `*` (e.g. "spec", "build-evals"). */
  name: string;
  /** The §9.4.6 visibility class. Unknown/missing flags default to "internal". */
  visibility: Visibility;
  /** Routing owner: "orchestrator-internal", a route_target, or a forward-intent owning_skill. */
  owner: string;
  /** Where the command is declared in routing.yaml. */
  source: "owned" | "forward_intent";
}

const VALID_VISIBILITY = new Set<Visibility>(["shown", "glimpse", "internal"]);

/** Coerce a raw flag to a Visibility; anything unknown/missing => "internal" (safe-hidden). */
function coerceVisibility(raw: unknown): Visibility {
  return typeof raw === "string" && VALID_VISIBILITY.has(raw as Visibility)
    ? (raw as Visibility)
    : "internal";
}

// Default routing.yaml: this file's sibling-of-parent (scripts/ -> orchestrator/).
function defaultRoutingPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "routing.yaml");
}

/** The committed routing.yaml path (the single source of truth). */
export const DEFAULT_ROUTING_PATH = defaultRoutingPath();

interface RoutingYaml {
  commands?: Record<
    string,
    { route_target?: string; visibility?: unknown } | null
  >;
  forward_intents?: Array<{
    owning_skill?: string;
    commands?: Record<string, { visibility?: unknown } | null>;
  }>;
}

/**
 * Parse routing.yaml and return the visibility class of every command (owned +
 * forward-intent), sorted by name for deterministic output. Pure: the path is a
 * parameter so tests can point at fixtures.
 */
export function loadCommandVisibility(
  routingPath: string = DEFAULT_ROUTING_PATH,
): CommandVisibility[] {
  const parsed = parseYaml(fs.readFileSync(routingPath, "utf-8")) as RoutingYaml;
  const out: CommandVisibility[] = [];

  for (const [name, def] of Object.entries(parsed.commands ?? {})) {
    out.push({
      name,
      visibility: coerceVisibility(def?.visibility),
      owner: def?.route_target ?? "orchestrator-internal",
      source: "owned",
    });
  }

  for (const group of parsed.forward_intents ?? []) {
    const owner = group.owning_skill ?? "unknown";
    for (const [name, def] of Object.entries(group.commands ?? {})) {
      out.push({
        name,
        visibility: coerceVisibility(def?.visibility),
        owner,
        source: "forward_intent",
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// PRESENTATION layer. Visibility (above) decides INCLUSION; this map decides
// LAYOUT (which block, order, one-liner, route tag). It is NOT a second source
// of truth for visibility — every NON-internal command in routing.yaml MUST
// have an entry here, else renderRoster THROWS (caught by the drift test). No
// internal command is listed here (they are filtered out before lookup).
// ---------------------------------------------------------------------------

type Block = "lifecycle" | "evaluator" | "state";

interface Presentation {
  block: Block;
  order: number;
  summary: string;
  /** Optional right-side route annotation, e.g. "[→ evaluator]". */
  tag?: string;
}

const DISPLAY: Readonly<Record<string, Presentation>> = {
  // ── Lifecycle (① SPEC ▶ ③ EVALUATE ▶ ④ DIAGNOSE ▶ ⑤ IMPROVE) ──────────────
  spec: {
    block: "lifecycle",
    order: 1,
    summary: "Capture WHAT a new agent IS → portable, validated agentspec.yaml",
    tag: "[→ agentspec]",
  },
  discover: {
    block: "lifecycle",
    order: 2,
    summary: "Mine eval criteria from traces → grow the eval suite",
    tag: "[→ evaluator]",
  },
  evaluate: {
    block: "lifecycle",
    order: 3,
    summary: "Run evals vs a skill/agent → success/failure + verdict (judge only)",
    tag: "[→ evaluator]",
  },
  diagnose: {
    block: "lifecycle",
    order: 4,
    summary: "RCA + causal chains on routed failures → ranked remedies",
    tag: "[→ diagnostics]",
  },
  // ── Evaluator (glimpse) — branches under EVALUATE, NOT standalone stages ──
  "build-evals": {
    block: "evaluator",
    order: 1,
    summary: "Build one judge per criterion",
  },
  "build-dataset": {
    block: "evaluator",
    order: 2,
    summary: "Synthesize test cases (coverage)            (HITL)",
  },
  review: {
    block: "evaluator",
    order: 3,
    summary: "Human label-capture UI (feeds *validate)    (HITL)",
  },
  validate: {
    block: "evaluator",
    order: 4,
    summary: "Calibrate a judge vs human labels (TPR/TNR)  (HITL)",
  },
  // ── State & Setup ─────────────────────────────────────────────────────────
  sync: {
    block: "state",
    order: 1,
    summary: "Explore + index the topology of skills/agents",
  },
  status: {
    block: "state",
    order: 2,
    summary: "Where are we — active stage · last verdict · pending gates",
  },
  onboard: {
    block: "state",
    order: 3,
    summary: "Unified onboarding + config (.mutagent/config.yaml)   (alias *config)",
  },
  help: {
    block: "state",
    order: 4,
    summary: "Show this dashboard",
  },
};

// Operator-facing section headers. NOTE: the `glimpse` visibility tier maps to
// the clean "=== Evaluator ===" header — the §9.4.6 enum value "glimpse" is an
// IMPLEMENTATION directive (routing.yaml `visibility:`), NEVER rendered as UI
// text. Likewise "shown"/"internal"/"visibility" must never surface here.
const BLOCK_HEADERS: Readonly<Record<Block, string>> = {
  lifecycle: "=== Lifecycle ===",
  evaluator: "=== Evaluator ===",
  state: "=== State & Setup ===",
};

const BLOCK_ORDER: readonly Block[] = ["lifecycle", "evaluator", "state"];

/** The ⑤ IMPROVE note, rendered as a continuation under the Lifecycle block. */
const GATED_APPLY_NOTE =
  "                   (⑤ IMPROVE = gated apply, downstream of *diagnose — never auto-applies)";

// Dot-leader column width for the `*label .... summary` rows.
const DOT_COL = 18;

function formatRow(name: string, p: Presentation): string {
  const label = `*${name}`;
  const lead = `${label} `;
  const dots = ".".repeat(Math.max(3, DOT_COL - lead.length));
  const body = `${lead}${dots} ${p.summary}`;
  return p.tag ? `${body}   ${p.tag}` : body;
}

/**
 * Render the visible roster from a command-visibility list. INTERNAL commands
 * are filtered out; SHOWN + GLIMPSE commands are grouped into their block and
 * ordered. A non-internal command with no DISPLAY entry is a drift error and
 * THROWS (the test catches it).
 */
export function renderRoster(commands: CommandVisibility[]): string {
  const visible = commands.filter((c) => c.visibility !== "internal");

  for (const c of visible) {
    if (!(c.name in DISPLAY)) {
      throw new Error(
        `render-roster: non-internal command "*${c.name}" is missing presentation metadata in DISPLAY. ` +
          `Add it (block/order/summary) or mark it visibility:internal in routing.yaml.`,
      );
    }
  }

  const lines: string[] = [];
  for (const block of BLOCK_ORDER) {
    const rows = visible
      .filter((c) => DISPLAY[c.name]!.block === block)
      .sort((a, b) => DISPLAY[a.name]!.order - DISPLAY[b.name]!.order);
    if (rows.length === 0) continue;

    if (lines.length > 0) lines.push("");
    lines.push(BLOCK_HEADERS[block]);
    for (const c of rows) lines.push(formatRow(c.name, DISPLAY[c.name]!));
    if (block === "lifecycle") lines.push(GATED_APPLY_NOTE);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper. Flags: --json (visibility list only) · <routing.yaml>
// positional override (defaults to the sibling routing.yaml).
// ---------------------------------------------------------------------------
function main(argv: string[]): void {
  const args = argv.slice(2);
  const jsonOnly = args.includes("--json");
  const positional = args.find((a) => !a.startsWith("--"));
  const routingPath = positional ? path.resolve(positional) : DEFAULT_ROUTING_PATH;

  const commands = loadCommandVisibility(routingPath);

  if (jsonOnly) {
    console.info(JSON.stringify(commands, null, 2));
    return;
  }
  console.info(renderRoster(commands));
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  main(argv);
}
