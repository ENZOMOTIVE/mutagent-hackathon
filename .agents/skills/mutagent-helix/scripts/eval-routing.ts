import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { parse as parseYaml } from "yaml";

import { loadConfig } from "./config-schema.ts";

// ---------------------------------------------------------------------------
// LLM-driven routing eval — closes spec pred3 ("a routing map/table + tests map
// utterances -> command") the OPERATOR'S way.
//
// pred3 asked for tests that resolve an utterance -> *command. The operator
// REJECTED a deterministic resolver (testing-theater for an LLM router) AND a
// spec amendment. The directive (verbatim): "do a LLM driven test, like a
// re-usable command to evaluate also routing (of orchestrator itself etc.)."
//
// So this module is a REUSABLE LLM-DRIVEN routing eval: feed utterances through
// the REAL LLM router (the orchestrator's ACTUAL routing behavior — same prompt
// it would use) and score the chosen *command against a labeled dataset.
//
// THE DI SPLIT (so the CI gate stays deterministic while the eval is real):
//   - DETERMINISTIC HARNESS (in `bun test`): the dataset loader + the categorical
//     exact-match grader + the aggregation. The router is an INJECTED function
//     (RouterFn). Tests inject a STUB → assert the pass/fail math. NO live LLM.
//   - REAL LLM ROUTER (on-demand, the CLI): `routeViaLLM` builds the routing
//     prompt from a RoutingContext (mirroring orchestrator.md's NL-routing +
//     routing.yaml intents), calls the model, and parses the answer to
//     one-of-the-closed-set-or-null. Non-deterministic → it produces a SCORED
//     REPORT, never a gate assertion.
//
// REUSABLE: every public function is parameterized on a RoutingContext (the
// command roster + utterances) and a closed command set — so the SAME harness
// evaluates the orchestrator's own routing today and any other routing table
// tomorrow (the evaluator skill absorbs/generalizes this in Loop-2 per the EQ
// goal). `routeViaLLM(utterance, ctx, …)` takes the routing table as an argument.
//
// MODEL INTENT IS SACRED (feedback_model_intent_sacred): the model is
// `config.models.default` OR an explicit `--model`. There is NO silent swap and
// NO retry-on-failure alternate-model fallback. If the chosen model/creds can't
// run, `routeViaLLM` THROWS — it never substitutes a different model. The CLI
// refuses to pick a model for you.
//
// GRADER: categorical EXACT-MATCH (got === expected). The command is a CLOSED set
// (7 for the orchestrator); a fuzzy LLM judge would be the wrong tool. A router
// that returns anything outside the set is normalized/rejected to null — never a
// new class.
//
// Design invariants (mirror scripts/handover-contract.ts + scripts/config-schema.ts):
//   - Pure functions + a thin CLI wrapper. The pure core has NO clock, NO random,
//     NO network. The ONLY network call is `routeViaLLM`, reached solely from the
//     CLI (never from the deterministic harness). Any report timestamp is a CLI
//     `--stamp` param, never a self-read clock — so the harness stays deterministic.
//   - Loaders read an INJECTED path (never the real `~/.mutagent`); `~` expansion
//     happens only in the thin CLI.
// ---------------------------------------------------------------------------

/** The orchestrator's CLOSED command set (normalized `*name`). Mirrors routing.yaml. */
export const ORCHESTRATOR_COMMANDS: readonly string[] = [
  "*spec",
  "*sync",
  "*evaluate",
  "*audit",
  "*diagnose",
  "*status",
  "*onboard",
  "*help",
] as const;

/** The per-command bucket key used for out-of-domain (null-expected) cases. */
export const NULL_BUCKET = "(out-of-domain)" as const;

// ── Dataset types + schema ───────────────────────────────────────────────────

/** One labeled eval case: a free-text utterance and its expected *command (or null). */
export interface EvalCase {
  utterance: string;
  /** The expected command (normalized `*name`) OR null for out-of-domain. */
  expected_command: string | null;
  /** true ⇒ a NOVEL paraphrase NOT in the routing table (held-out cohort). */
  held_out?: boolean;
  /** Optional human note (kept for auditability; ignored by the grader). */
  note?: string;
}

/** A labeled routing-eval dataset. */
export interface Dataset {
  version?: string;
  cases: EvalCase[];
}

// STRUCTURAL TypeBox schema (closed objects). expected_command is string|null at
// the structural layer; membership in the CLOSED command set is enforced
// separately in parseDataset (so the harness is reusable on any command set).
const EvalCaseSchema = Type.Object(
  {
    utterance: Type.String({ minLength: 1 }),
    expected_command: Type.Union([Type.Null(), Type.String({ minLength: 1 })]),
    held_out: Type.Optional(Type.Boolean()),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const DatasetSchema = Type.Object(
  {
    version: Type.Optional(Type.String()),
    cases: Type.Array(EvalCaseSchema),
  },
  { additionalProperties: false },
);
const DatasetChecker = TypeCompiler.Compile(DatasetSchema);

// ── RoutingContext types ─────────────────────────────────────────────────────

/** One command row of a routing table (mirrors routing.yaml `commands`). */
export interface RoutingCommand {
  /** Normalized `*name`. */
  command: string;
  stage?: string;
  description?: string;
  /** The NL utterances/intents that route to this command. */
  utterances: string[];
}

/** A routing table — the closed roster the router chooses from. Parameterizable. */
export interface RoutingContext {
  commands: RoutingCommand[];
}

/** The router's answer for one utterance. `command` is null ⇒ "route nowhere". */
export interface RouteResult {
  command: string | null;
  /** The model's raw text (audit trail); optional for stubs. */
  raw?: string;
}

/**
 * The INJECTED router. The deterministic harness calls this for every case; tests
 * inject a stub, the CLI injects the real `routeViaLLM`. Parameterized on the
 * RoutingContext so the SAME harness evaluates any routing table.
 */
export type RouterFn = (
  utterance: string,
  ctx: RoutingContext,
) => Promise<RouteResult>;

// ── Report types ─────────────────────────────────────────────────────────────

/** A cohort's aggregate accuracy. */
export interface CohortStat {
  n: number;
  passed: number;
  accuracy: number;
}

/** The scored routing-eval report. Pure aggregation — no clock/random. */
export interface RoutingReport {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  /** Per-EXPECTED-command rates (keyed by the closed set + NULL_BUCKET). */
  per_command: Record<string, { n: number; passed: number }>;
  /** In-distribution cohort (held_out !== true). */
  in_distribution: CohortStat;
  /** Held-out cohort (held_out === true) — the generalization measure. */
  held_out: CohortStat;
  /** Every mis-route, with the exact (utterance, expected, got) triple. */
  failures: Array<{ utterance: string; expected: string | null; got: string | null }>;
}

// ── Dataset loading (pure) ────────────────────────────────────────────────────

/**
 * Parse + validate a routing-eval dataset from YAML text. STRUCTURAL validation
 * (closed objects, required fields) via TypeBox, THEN a closed-set check on every
 * `expected_command` (null OR a member of `opts.validCommands`, default the
 * orchestrator's 7). THROWS on any violation — never silently coerces (a typo'd
 * label is a contract bug, not a 0-score case). Pure: no I/O, no clock.
 */
export function parseDataset(
  raw: string,
  opts: { validCommands?: readonly string[] } = {},
): Dataset {
  const validCommands = opts.validCommands ?? ORCHESTRATOR_COMMANDS;

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`routing-eval dataset: malformed YAML — ${String(err)}`);
  }

  if (!DatasetChecker.Check(parsed)) {
    const errs = [...DatasetChecker.Errors(parsed)]
      .map((e) => `${e.path === "" ? "/" : e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`routing-eval dataset: structural validation failed — ${errs}`);
  }

  const ds = parsed as Dataset;
  for (const c of ds.cases) {
    if (c.expected_command !== null && !validCommands.includes(c.expected_command)) {
      throw new Error(
        `routing-eval dataset: case '${c.utterance}' has expected_command ` +
          `'${c.expected_command}' which is not in the closed command set ` +
          `[${validCommands.join(", ")}] (and is not null)`,
      );
    }
  }
  return ds;
}

/**
 * Read + parse + validate a dataset from an INJECTED file path. The path is taken
 * verbatim (no `~` expansion — the CLI does that). Pure aside from the single file
 * read. Throws (via parseDataset) on a malformed/invalid dataset.
 */
export function loadDataset(
  datasetPath: string,
  opts: { validCommands?: readonly string[] } = {},
): Dataset {
  const raw = fs.readFileSync(datasetPath, "utf-8");
  return parseDataset(raw, opts);
}

// ── RoutingContext loading (pure) ─────────────────────────────────────────────

// The shape of routing.yaml's `commands` block (only the fields we read).
const RoutingYamlSchema = Type.Object(
  {
    commands: Type.Record(
      Type.String(),
      Type.Object(
        {
          stage: Type.Optional(Type.Union([Type.String(), Type.Number()])),
          utterances: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
const RoutingYamlChecker = TypeCompiler.Compile(RoutingYamlSchema);

/** Normalize a command name to its canonical `*name` form. */
function starCommand(name: string): string {
  const t = name.trim();
  return t.startsWith("*") ? t : `*${t}`;
}

/**
 * Read routing.yaml at an INJECTED path into a RoutingContext (the closed roster
 * + each command's utterances). This is the SAME map the orchestrator routes on,
 * so the eval measures ACTUAL routing behavior — not a parallel prompt. Pure
 * aside from the file read. Throws on a malformed routing file.
 */
export function loadRoutingContext(routingPath: string): RoutingContext {
  const raw = fs.readFileSync(routingPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`routing map: malformed YAML in ${routingPath} — ${String(err)}`);
  }
  if (!RoutingYamlChecker.Check(parsed)) {
    throw new Error(`routing map: ${routingPath} is missing a valid 'commands' block`);
  }

  const block = (parsed as { commands: Record<string, { stage?: string | number; utterances?: string[] }> })
    .commands;
  const commands: RoutingCommand[] = Object.entries(block).map(([name, body]) => ({
    command: starCommand(name),
    stage: body.stage === undefined ? undefined : String(body.stage),
    utterances: body.utterances ?? [],
  }));
  return { commands };
}

/** The closed command set (normalized `*name`) for a routing context. */
export function validCommandsFromContext(ctx: RoutingContext): string[] {
  return ctx.commands.map((c) => c.command);
}

// ── Prompt construction (pure) ────────────────────────────────────────────────

/**
 * Build the routing prompt the REAL router uses. It MIRRORS orchestrator.md's
 * NL-routing instruction + routing.yaml's per-command utterances/intents so the
 * eval scores the orchestrator's ACTUAL routing behavior (highest-confidence
 * match; on no match → route nowhere, never guess a stage). Pure + deterministic:
 * the same ctx yields the identical string (commands in ctx order). Reusable —
 * the roster is entirely derived from the passed RoutingContext.
 */
export function buildRoutingPrompt(ctx: RoutingContext): string {
  const lines: string[] = [];
  lines.push(
    "You are the MutagenT ADL orchestrator's natural-language intent ROUTER.",
    "Map the user's free-text request to EXACTLY ONE command from the closed set",
    "below — the command whose listed utterances/intents best match the request",
    "(highest-confidence match). You are a router only; never perform the work.",
    "",
    "Commands (the ONLY valid answers):",
  );
  for (const c of ctx.commands) {
    const stage = c.stage ? ` [stage ${c.stage}]` : "";
    const desc = c.description ? ` — ${c.description}` : "";
    lines.push(`- ${c.command}${stage}${desc}`);
    if (c.utterances.length > 0) {
      const sample = c.utterances.map((u) => `"${u}"`).join(", ");
      lines.push(`    utterances: ${sample}`);
    }
  }
  lines.push(
    "",
    "Rules:",
    "1. Choose exactly one command from the list above, by its token (e.g. *evaluate).",
    "2. If the request is OUT-OF-DOMAIN (it does not match any command's purpose),",
    "   answer exactly: none. Never guess a stage for an off-topic request.",
    "3. Respond with ONLY the chosen command token, or the single word none.",
    "   No explanation, no punctuation, no extra text.",
  );
  return lines.join("\n");
}

// ── Answer parsing (pure) ─────────────────────────────────────────────────────

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a router's raw answer to one of `validCommands` (normalized `*name`)
 * or null. Pure. Handles: leading `*`, surrounding whitespace/quotes/backticks,
 * mixed case, the words none/null/n-a/empty (⇒ null), and a single command token
 * embedded in a short sentence. ANYTHING outside the closed set (a hallucinated
 * command) ⇒ null — REJECTED, never coerced into a new class. An answer naming
 * TWO valid commands is ambiguous ⇒ null. Word-boundary aware so e.g. "helpful"
 * does not match "*help".
 */
export function parseRoutedCommand(
  raw: string | null,
  validCommands: readonly string[],
): string | null {
  if (raw === null) return null;
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (text === "" || text === "none" || text === "null" || text === "n/a") return null;

  const bare = validCommands.map((c) => c.replace(/^\*/, "").toLowerCase());

  // 1. exact match (with or without a leading `*`).
  const stripped = text.replace(/^\*/, "");
  const exactIdx = bare.indexOf(stripped);
  if (exactIdx >= 0) return validCommands[exactIdx];

  // 2. token scan — which valid commands appear as a `*token` or whole word.
  const found = new Set<string>();
  for (let i = 0; i < bare.length; i++) {
    const re = new RegExp(
      `(^|[^a-z0-9_*])\\*?${escapeRegExp(bare[i])}([^a-z0-9_]|$)`,
      "i",
    );
    if (re.test(text)) found.add(validCommands[i]);
  }
  if (found.size === 1) {
    const only = [...found][0];
    return only ?? null;
  }

  // zero matches OR ambiguous (>1) ⇒ reject.
  return null;
}

// ── The deterministic eval (pure given routerFn) ──────────────────────────────

/**
 * Run a routing eval: for every case, call the INJECTED router, normalize its
 * answer to the closed set (rejecting hallucinated commands to null), and grade
 * by categorical EXACT-MATCH (got === expected; null===null is a correct refusal).
 * Aggregates overall + per-command + in-distribution + held-out cohorts + the
 * exact failure triples.
 *
 * PURE GIVEN routerFn: no clock, no random, no network here. Cases run
 * sequentially in dataset order, so the report is deterministic for a
 * deterministic router (same dataset + same stub ⇒ deep-equal report).
 */
export async function runRoutingEval(
  dataset: Dataset,
  routerFn: RouterFn,
  ctx: RoutingContext,
): Promise<RoutingReport> {
  const validCommands = validCommandsFromContext(ctx);
  const per_command: Record<string, { n: number; passed: number }> = {};
  const failures: RoutingReport["failures"] = [];
  let passed = 0;
  let heldN = 0;
  let heldPassed = 0;
  let inN = 0;
  let inPassed = 0;

  for (const c of dataset.cases) {
    const result = await routerFn(c.utterance, ctx);
    const got = parseRoutedCommand(result.command, validCommands);
    const expected = c.expected_command;
    const ok = got === expected;

    const key = expected === null ? NULL_BUCKET : expected;
    let bucket = per_command[key];
    if (bucket === undefined) {
      bucket = { n: 0, passed: 0 };
      per_command[key] = bucket;
    }
    bucket.n += 1;
    if (ok) {
      bucket.passed += 1;
      passed += 1;
    } else {
      failures.push({ utterance: c.utterance, expected, got });
    }

    if (c.held_out === true) {
      heldN += 1;
      if (ok) heldPassed += 1;
    } else {
      inN += 1;
      if (ok) inPassed += 1;
    }
  }

  const total = dataset.cases.length;
  return {
    total,
    passed,
    failed: total - passed,
    accuracy: total === 0 ? 0 : passed / total,
    per_command,
    in_distribution: {
      n: inN,
      passed: inPassed,
      accuracy: inN === 0 ? 0 : inPassed / inN,
    },
    held_out: {
      n: heldN,
      passed: heldPassed,
      accuracy: heldN === 0 ? 0 : heldPassed / heldN,
    },
    failures,
  };
}

// ── The REAL LLM router (on-demand — NOT in the deterministic gate) ───────────

/** A minimal structural view of a LangChain chat model (mirrors the repo's call shape). */
interface ChatModelLike {
  invoke(input: unknown): Promise<{ content: unknown }>;
}
interface ChatGoogleCtor {
  new (opts: {
    model: string;
    temperature: number;
    maxOutputTokens?: number;
    apiKey?: string;
  }): ChatModelLike;
}

/** Options for the real router. `invoke` is an optional seam for focused testing. */
export interface RouteViaLLMOptions {
  /** The model id — `config.models.default` or an explicit `--model`. SACRED: no swap. */
  model: string;
  /** Provider credential (defaults to the matching env var). */
  apiKey?: string;
  /** Optional max output tokens. */
  maxOutputTokens?: number;
  /**
   * Optional injected transport — `(systemPrompt, utterance) => raw text`. When
   * absent, the real provider client is constructed. The harness never uses this;
   * it exists so the prompt→parse wiring can be exercised without a live call.
   */
  invoke?: (systemPrompt: string, utterance: string) => Promise<string>;
}

/** Coerce a LangChain message `content` (string | content-blocks) to plain text. */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
}

/** Detect the provider implied by a model id. Closed + explicit (no fuzzy guessing). */
function detectProvider(model: string): "google" | "unsupported" {
  return /^gemini/i.test(model) ? "google" : "unsupported";
}

/**
 * The REAL router: build the routing prompt from `ctx` (mirroring orchestrator.md
 * + routing.yaml), call the chosen model, and parse the answer to the closed set
 * or null. This is the operator's "LLM driven test" — only reached from the CLI,
 * never from the deterministic harness.
 *
 * MODEL INTENT IS SACRED: the model is exactly `opts.model`. If its provider is
 * not wired here, or its credentials are absent, this THROWS — it does NOT swap
 * to another model or provider, and it does NOT retry on a different model. The
 * repo's Google call shape (`@langchain/google-genai` ChatGoogleGenerativeAI,
 * temperature 0) is MIRRORED, not reinvented. The SDK is imported lazily so the
 * deterministic harness never loads a provider.
 */
export async function routeViaLLM(
  utterance: string,
  ctx: RoutingContext,
  opts: RouteViaLLMOptions,
): Promise<RouteResult> {
  const validCommands = validCommandsFromContext(ctx);
  const systemPrompt = buildRoutingPrompt(ctx);

  // Test/automation seam: an injected transport bypasses the live provider.
  if (opts.invoke) {
    const raw = await opts.invoke(systemPrompt, utterance);
    return { command: parseRoutedCommand(raw, validCommands), raw };
  }

  const provider = detectProvider(opts.model);
  if (provider === "unsupported") {
    throw new Error(
      `routeViaLLM: model '${opts.model}' has no provider wired in this harness ` +
        `(only Google/gemini-* is wired — the creds available for the routing ` +
        `eval). MODEL INTENT IS SACRED: this harness will NOT silently swap to a ` +
        `different model. Pass a supported --model, or wire its provider (mirror ` +
        `the repo's call shape) — never substitute.`,
    );
  }

  const apiKey = opts.apiKey ?? process.env.GOOGLE_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `routeViaLLM: GOOGLE_API_KEY is not set for model '${opts.model}'. Source ` +
        `the env first (set -a && source mutagent-core/.env && source mutagent/.env ` +
        `&& set +a). NOT substituting another provider (model intent is sacred).`,
    );
  }

  // Lazy import — the deterministic harness never loads the provider SDK.
  const mod = (await import("@langchain/google-genai")) as unknown as {
    ChatGoogleGenerativeAI: ChatGoogleCtor;
  };
  const client = new mod.ChatGoogleGenerativeAI({
    model: opts.model,
    temperature: 0, // routing is a classification — deterministic decoding
    ...(opts.maxOutputTokens !== undefined && { maxOutputTokens: opts.maxOutputTokens }),
    apiKey,
  });

  const response = await client.invoke([
    ["system", systemPrompt],
    ["human", utterance],
  ]);
  const raw = extractContentText(response.content);
  return { command: parseRoutedCommand(raw, validCommands), raw };
}

// ---------------------------------------------------------------------------
// CLI — the reusable "command to evaluate routing". On-demand, runs the REAL
// router and prints/writes a SCORED report. NOT part of the `bun test` gate.
//
//   bun run scripts/eval-routing.ts \
//     [--dataset <path>] [--routing <path>] [--model <id>] \
//     [--report <path>] [--stamp <iso>]
//
// Model resolution (model intent sacred): --model wins; else config.models.default
// from ~/.mutagent/config.yaml; else REFUSE (the harness never picks a model).
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(1));
  }
  return p;
}

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/** Best-effort read of config.models.default for DISPLAY (never throws; null if absent). */
function readConfigDefault(argv: string[]): string | null {
  const configPath = expandHome(getFlag(argv, "config") ?? "~/.mutagent/config.yaml");
  const cfg = loadConfig(path.resolve(configPath));
  if (cfg.ok && cfg.config.shared?.models?.default) {
    return cfg.config.shared.models.default;
  }
  return null;
}

/** The transparent model decision: WHAT ran, WHERE it came from, and the config default. */
interface ModelDecision {
  /** The model actually used (model intent is sacred — exactly this, no swap). */
  model: string;
  /** Where `model` came from. */
  source: "--model" | "config.models.default";
  /** config.models.default for transparency (may differ from `model` on an explicit override). */
  configDefault: string | null;
}

/**
 * Resolve the model: explicit --model wins (an intentional override, NOT a silent
 * swap), else config.models.default, else REFUSE (the harness never picks a model
 * for you). Always surfaces the config default too, so the report prints BOTH and
 * the model intent is fully transparent.
 */
function resolveModel(argv: string[]): ModelDecision {
  const configDefault = readConfigDefault(argv);
  const explicit = getFlag(argv, "model");
  if (explicit !== undefined && explicit !== "") {
    return { model: explicit, source: "--model", configDefault };
  }
  if (configDefault !== null) {
    return { model: configDefault, source: "config.models.default", configDefault };
  }
  throw new Error(
    "eval-routing: no model resolved. Pass --model <id>, or set " +
      "shared.models.default in ~/.mutagent/config.yaml. MODEL INTENT IS SACRED: " +
      "the harness will not pick a model for you.",
  );
}

function formatReport(
  report: RoutingReport,
  decision: ModelDecision,
  datasetPath: string,
): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const out: string[] = [];
  out.push("─".repeat(72));
  out.push("MutagenT LLM-driven routing eval — scored report");
  out.push("─".repeat(72));
  // Model intent is SACRED — print BOTH what ran AND the config default, so an
  // explicit --model override is fully transparent (never a silent swap).
  out.push(`model (ran):           ${decision.model}   [via ${decision.source}]`);
  out.push(`config.models.default: ${decision.configDefault ?? "(none / no ~/.mutagent/config.yaml)"}`);
  if (
    decision.source === "--model" &&
    decision.configDefault !== null &&
    decision.configDefault !== decision.model
  ) {
    out.push(
      `  note: --model EXPLICITLY overrode the config default ` +
        `'${decision.configDefault}' (intentional, not a silent swap).`,
    );
  }
  out.push(`dataset: ${datasetPath}`);
  out.push("");
  out.push(`OVERALL         ${report.passed}/${report.total}   accuracy ${pct(report.accuracy)}`);
  out.push(
    `  in-distribution ${report.in_distribution.passed}/${report.in_distribution.n}   ${pct(report.in_distribution.accuracy)}`,
  );
  out.push(
    `  held-out        ${report.held_out.passed}/${report.held_out.n}   ${pct(report.held_out.accuracy)}   (generalization)`,
  );
  out.push("");
  out.push("per-command:");
  for (const [cmd, s] of Object.entries(report.per_command)) {
    out.push(`  ${cmd.padEnd(18)} ${s.passed}/${s.n}   ${pct(s.n === 0 ? 0 : s.passed / s.n)}`);
  }
  if (report.failures.length > 0) {
    out.push("");
    out.push(`failures (${report.failures.length}):`);
    for (const f of report.failures) {
      out.push(`  "${f.utterance}"  expected=${f.expected ?? "null"}  got=${f.got ?? "null"}`);
    }
  }
  out.push("─".repeat(72));
  return out.join("\n");
}

async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const datasetPath = path.resolve(
    expandHome(getFlag(args, "dataset") ?? "tests/fixtures/routing-eval/dataset.yaml"),
  );
  const routingPath = path.resolve(expandHome(getFlag(args, "routing") ?? "routing.yaml"));
  const reportPath = getFlag(args, "report");
  const stamp = getFlag(args, "stamp"); // optional injected timestamp (no clock)

  const decision = resolveModel(args);
  const ctx = loadRoutingContext(routingPath);
  const dataset = loadDataset(datasetPath, { validCommands: validCommandsFromContext(ctx) });

  const report = await runRoutingEval(
    dataset,
    (utterance, c) => routeViaLLM(utterance, c, { model: decision.model }),
    ctx,
  );

  console.info(formatReport(report, decision, datasetPath));

  if (reportPath !== undefined) {
    const payload = {
      ...(stamp !== undefined && { stamp }),
      model: decision.model,
      model_source: decision.source,
      config_default: decision.configDefault,
      dataset: datasetPath,
      routing: routingPath,
      report,
    };
    fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(payload, null, 2)}\n`);
    console.info(`[eval-routing] wrote JSON report → ${reportPath}`);
  }

  return 0;
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  const argv = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  runCli(argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`[eval-routing] FAIL — ${String(err)}\n`);
      process.exit(1);
    });
}
