/**
 * scripts/context/build-diagnosis-context.ts
 * W18-context: the DETERMINISTIC (no-LLM) diagnosis-context assembler.
 *
 * Produces a rich, GROUNDED, source-aware "lens" about the diagnosed entity that
 * each Analyzer reads + understands BEFORE it searches the traces for failure
 * modes. The lens answers "what IS this thing?" (name · scope · model · purpose ·
 * tools · config · FULL system prompt · source code when accessible) so the
 * analyzer corroborates against a factual baseline rather than starting blind.
 *
 * Type A — Pure Script (content-derived only — NO LLM, NO clock, NO random).
 * Same inputs ⇒ byte-identical `diagnosis-context.md`.
 *
 * ── GROUNDING CONTRACT (operator principle, PR-026 / PR-018) ──────────────────
 * The context is EXTRACTED FACT ONLY. We NEVER seed it with a guess or assumption
 * (e.g. NOT "prompt is uncached", NOT "latency caused by X"). The analyzer will
 * CORROBORATE whatever we give it, so an unverified hint becomes a self-fulfilling
 * error. Every fact carries a `provenance` tag naming where it came from. The one
 * operator-supplied field (`--purpose`) is explicitly labeled "operator-stated"
 * so it is never mistaken for a trace-extracted fact. Anything we cannot ground
 * is OMITTED — there is deliberately no field for inferred/derived claims.
 */

import type { EntityContext, ToolInventoryEntry, TraceBody } from "../normalize/trace.ts";
import { extractFullSystemPrompt, sanitize } from "../normalize/platforms/entity-context.ts";
import type { FullSystemPrompt } from "../normalize/platforms/entity-context.ts";

// ── provenance ────────────────────────────────────────────────────────────────

/**
 * Where a fact in the diagnosis-context came from. Every section is tagged so the
 * analyzer (and any reader) can trace each fact to its origin. There is NO
 * `inferred` value by design — un-grounded claims are omitted, not labeled.
 */
export type Provenance =
  /** Extracted by a normalizer from the source platform's traces. */
  | "trace-extracted"
  /** Read verbatim from accessible source code (SKILL.md, agent def, references). */
  | "source-code"
  /** Supplied by the operator at invocation (e.g. --purpose). NOT trace-derived. */
  | "operator-stated";

/** A single source-code document included verbatim in the lens (codeAccess case). */
export interface SourceDocument {
  /** Logical label, e.g. "SKILL.md", "references/principles.md", "agent definition". */
  label: string;
  /** Relative path the document was read from (for grounding citation). */
  path: string;
  /** FULL, verbatim (PII-sanitized) document content. Never distilled. */
  content: string;
  /** UTF-8 byte length of `content`. */
  sizeBytes: number;
}

/**
 * The structured diagnosis-context. Mirrors what the markdown renderer emits, so
 * a consumer that wants structured data (not markdown) can use this directly.
 * Optional fields are ABSENT when the underlying fact could not be grounded.
 */
export interface DiagnosisContext {
  /** Display name of the diagnosed entity. provenance: trace-extracted. */
  name: string;
  /** agent | tool | skill | model. provenance: trace-extracted. */
  scope: EntityContext["entityType"];
  /** Whether source code was accessible for this run. */
  codeAccess: boolean;
  /** Source-platform provenance string (e.g. "langfuse-export"). */
  source: string;
  /** Model identifier, when the trace carried one. provenance: trace-extracted. */
  model?: string;
  /** Operator-stated purpose (--purpose). provenance: operator-stated. */
  purpose?: string;
  /** Aggregated tool inventory. provenance: trace-extracted. */
  toolInventory?: ToolInventoryEntry[];
  /** Tool messages skipped for lack of a toolName (inventory undercount). */
  toolSkippedCount?: number;
  /** Tools with no latency coverage. */
  toolsWithoutLatency?: number;
  /**
   * FULL untruncated system prompt extracted from the traces. Present for the
   * no-codeAccess (client) case especially, where it is the PRIMARY ground truth.
   * provenance: trace-extracted.
   */
  systemPrompt?: FullSystemPrompt;
  /**
   * Verbatim source documents (skill: SKILL.md + key references; agent: the agent
   * definition / config). Empty / absent when there is no codeAccess.
   * provenance: source-code.
   */
  sourceDocuments?: SourceDocument[];
  /**
   * Where remedies apply, when known from the EntityContext (e.g. skill assets).
   * provenance: trace-extracted (carried on EntityContext).
   */
  applyTarget?: string;
}

// ── inputs ───────────────────────────────────────────────────────────────────

/**
 * Inputs to the assembler. The `entityContext` + `traces` are produced upstream
 * by the per-platform normalizer (Step 3.7). `sourceDocuments` are read by the
 * CLI (or a caller) from accessible source code — the PURE function does no fs.
 * `purpose` is the optional operator-stated lens.
 */
export interface BuildDiagnosisContextInput {
  /** The normalizer-produced EntityContext (name · scope · model · tools · …). */
  entityContext: EntityContext;
  /** Normalized traces — used to extract the FULL system prompt. */
  traces: TraceBody[];
  /**
   * Verbatim source documents to embed (codeAccess case). The CALLER decides
   * which docs are relevant per scope (skill → SKILL.md + references; agent →
   * agent def). Content is sanitized here before embedding. Absent → none.
   */
  sourceDocuments?: Array<{ label: string; path: string; content: string }>;
  /** Operator-stated purpose. Labeled operator-stated; never trace-derived. */
  purpose?: string;
}

// ── assembler (pure) ───────────────────────────────────────────────────────────

/**
 * Assemble the structured DiagnosisContext from upstream-extracted facts.
 * DETERMINISTIC + pure: no fs, no clock, no LLM. Same inputs ⇒ identical output.
 *
 * Source-aware: when `codeAccess` is true the full source documents the caller
 * supplied are embedded verbatim; the FULL system prompt is ALWAYS extracted
 * from the traces and included when present (it is the primary ground truth for
 * the no-codeAccess client case).
 */
export function buildDiagnosisContext(
  input: BuildDiagnosisContextInput
): DiagnosisContext {
  const { entityContext: ec, traces, sourceDocuments, purpose } = input;

  const ctx: DiagnosisContext = {
    name: ec.name,
    scope: ec.entityType,
    codeAccess: ec.codeAccess,
    source: ec.source,
  };

  if (ec.model) ctx.model = ec.model;
  if (ec.applyTarget) ctx.applyTarget = ec.applyTarget;

  // Operator-stated purpose — labeled as such, never extracted/inferred.
  const trimmedPurpose = purpose?.trim();
  if (trimmedPurpose) ctx.purpose = trimmedPurpose;

  // Tool inventory (trace-extracted) — carry the coverage caveats too.
  if (ec.toolInventory && ec.toolInventory.length > 0) {
    ctx.toolInventory = ec.toolInventory;
  }
  if (ec.skippedCount !== undefined) ctx.toolSkippedCount = ec.skippedCount;
  if (ec.toolsWithoutLatency !== undefined) {
    ctx.toolsWithoutLatency = ec.toolsWithoutLatency;
  }

  // FULL untruncated system prompt from the traces — the lens, not the 220c card.
  const sys = extractFullSystemPrompt(traces);
  if (sys) ctx.systemPrompt = sys;

  // Source documents (codeAccess): embed verbatim + sanitized. We DO NOT gate on
  // ec.codeAccess here — the CALLER controls what it passes; if a caller supplies
  // docs we trust them, and the codeAccess flag is surfaced separately. This keeps
  // the pure function honest (it reports exactly what it was given).
  if (sourceDocuments && sourceDocuments.length > 0) {
    ctx.sourceDocuments = sourceDocuments.map((d) => {
      const clean = sanitize(d.content);
      return {
        label: d.label,
        path: d.path,
        content: clean,
        sizeBytes: Buffer.byteLength(clean, "utf8"),
      };
    });
  }

  return ctx;
}

// ── markdown renderer (pure, deterministic) ────────────────────────────────────

/** Provenance badge appended to each section heading for grounding. */
function badge(p: Provenance): string {
  return `_(provenance: ${p})_`;
}

/** Render the FULL system-prompt section, distinguishing absent vs redacted. */
function renderSystemPrompt(sys: FullSystemPrompt | undefined): string {
  const heading = `## System Prompt (FULL, untruncated) ${badge("trace-extracted")}`;
  if (!sys) {
    return [
      heading,
      "",
      "_No system prompt found in the traces. The system prompt may live in the " +
        "agent/skill config rather than the trace input. This is recorded as " +
        "ABSENT — not as a hypothesis about why._",
    ].join("\n");
  }
  if (sys.fullyRedacted) {
    return [
      heading,
      "",
      "_System prompt was PRESENT in the traces but consisted entirely of " +
        "secrets/PII and was fully redacted. Recorded as present-but-redacted._",
      "",
      `- origin: \`${sys.origin}\` (trace index ${sys.traceIndex})`,
    ].join("\n");
  }
  return [
    heading,
    "",
    `- origin: \`${sys.origin}\` (trace index ${sys.traceIndex})`,
    `- size: ${sys.sizeBytes} bytes · ~${sys.tokensApprox} tokens`,
    "",
    "```text",
    sys.text,
    "```",
  ].join("\n");
}

/** Render the tool-inventory table (with coverage caveats). */
function renderToolInventory(ctx: DiagnosisContext): string {
  const heading = `## Tool Inventory ${badge("trace-extracted")}`;
  if (!ctx.toolInventory || ctx.toolInventory.length === 0) {
    return [heading, "", "_No tool usage observed in the traces._"].join("\n");
  }
  const rows = ctx.toolInventory.map((t) => {
    const avg = t.avgLatencyMs !== undefined ? `${t.avgLatencyMs}ms` : "—";
    const p95 = t.p95LatencyMs !== undefined ? `${t.p95LatencyMs}ms` : "—";
    return `| \`${t.name}\` | ${t.callCount} | ${t.callsPerTrace} | ${avg} | ${p95} |`;
  });
  const lines = [
    heading,
    "",
    "| tool | calls | calls/trace | avg latency | p95 latency |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
  ];
  const caveats: string[] = [];
  if (ctx.toolSkippedCount) {
    caveats.push(
      `_${ctx.toolSkippedCount} tool-ish message(s) had no resolvable toolName — ` +
        `inventory undercounts by this amount._`
    );
  }
  if (ctx.toolsWithoutLatency) {
    caveats.push(
      `_${ctx.toolsWithoutLatency} tool(s) had no latency sample — latency columns ` +
        `incomplete for those._`
    );
  }
  if (caveats.length > 0) {
    lines.push("", ...caveats);
  }
  return lines.join("\n");
}

/** Render embedded source documents verbatim (codeAccess case). */
function renderSourceDocuments(docs: SourceDocument[] | undefined): string {
  const heading = `## Source Code ${badge("source-code")}`;
  if (!docs || docs.length === 0) {
    return [
      heading,
      "",
      "_No source code accessible for this entity (client / no-codeAccess run). " +
        "The system prompt above is the primary ground truth._",
    ].join("\n");
  }
  const blocks = docs.map((d) =>
    [
      `### ${d.label}`,
      `_path: \`${d.path}\` · ${d.sizeBytes} bytes (verbatim)_`,
      "",
      "````markdown",
      d.content,
      "````",
    ].join("\n")
  );
  return [heading, "", ...blocks].join("\n\n");
}

/**
 * Render the DiagnosisContext to deterministic markdown — the `diagnosis-context.md`
 * the analyzer MANDATORY-PRE-READs. Pure: same input ⇒ byte-identical markdown.
 *
 * Section order is fixed: identity → purpose → system prompt → tools → source code.
 * Every section carries a provenance badge so each fact is traceable to origin.
 */
export function renderDiagnosisContextMarkdown(ctx: DiagnosisContext): string {
  const lines: string[] = [];

  lines.push(`# Diagnosis Context — ${ctx.name}`);
  lines.push("");
  lines.push(
    "> GROUNDED LENS for the Analyzer. Read this BEFORE searching the traces for " +
      "failure modes. Every fact below is directly EXTRACTED (trace / source / " +
      "operator-stated) and tagged with its provenance. NOTHING here is a guess or " +
      "hypothesis — do not treat any line as a pre-diagnosed conclusion."
  );
  lines.push("");

  // ── Identity ──
  lines.push(`## Identity ${badge("trace-extracted")}`);
  lines.push("");
  lines.push(`- name: \`${ctx.name}\``);
  lines.push(`- scope: \`${ctx.scope}\``);
  lines.push(`- code access: \`${ctx.codeAccess}\``);
  lines.push(`- source platform: \`${ctx.source}\``);
  lines.push(`- model: ${ctx.model ? `\`${ctx.model}\`` : "_not present in traces_"}`);
  if (ctx.applyTarget) lines.push(`- apply target: \`${ctx.applyTarget}\``);
  lines.push("");

  // ── Purpose (operator-stated) ──
  lines.push(`## Purpose ${badge("operator-stated")}`);
  lines.push("");
  if (ctx.purpose) {
    lines.push(`> ${ctx.purpose}`);
    lines.push("");
    lines.push(
      "_Operator-supplied at invocation. Treat as stated intent, NOT as a " +
        "trace-verified fact._"
    );
  } else {
    lines.push("_No operator-stated purpose supplied (--purpose omitted)._");
  }
  lines.push("");

  // ── System prompt ──
  lines.push(renderSystemPrompt(ctx.systemPrompt));
  lines.push("");

  // ── Tool inventory ──
  lines.push(renderToolInventory(ctx));
  lines.push("");

  // ── Source code ──
  lines.push(renderSourceDocuments(ctx.sourceDocuments));
  lines.push("");

  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync, writeFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  /** Collect a repeatable flag: --doc <label>:<path> (may appear multiple times). */
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };

  const entityContextPath = get("--entity-context");
  const tracesPath = get("--traces");
  const outPath = get("--output");
  const purpose = get("--purpose");
  // --doc <label>:<path> — repeatable; embeds the file verbatim (codeAccess case).
  const docSpecs = getAll("--doc");

  if (!entityContextPath || !tracesPath || !outPath) {
    process.stderr.write(
      "Usage: bun scripts/context/build-diagnosis-context.ts " +
        "--entity-context <f> --traces <f> --output <diagnosis-context.md> " +
        "[--purpose <text>] [--doc <label>:<path> ...]\n"
    );
    process.exit(1);
  }

  try {
    const entityContext = JSON.parse(
      readFileSync(resolve(entityContextPath), "utf8")
    ) as EntityContext;
    const traces = JSON.parse(
      readFileSync(resolve(tracesPath), "utf8")
    ) as TraceBody[];

    const sourceDocuments = docSpecs.map((spec) => {
      // Split on the FIRST colon only — paths may contain colons on some systems,
      // but the label is always the leading token.
      const sep = spec.indexOf(":");
      if (sep < 0) {
        throw new Error(`--doc must be '<label>:<path>', got: ${spec}`);
      }
      const label = spec.slice(0, sep);
      const path = spec.slice(sep + 1);
      const content = readFileSync(resolve(path), "utf8");
      return { label, path, content };
    });

    const ctx = buildDiagnosisContext({
      entityContext,
      traces,
      sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : undefined,
      purpose,
    });
    const md = renderDiagnosisContextMarkdown(ctx);
    writeFileSync(resolve(outPath), md, "utf8");
    process.stdout.write(`diagnosis-context.md written to: ${outPath}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}
