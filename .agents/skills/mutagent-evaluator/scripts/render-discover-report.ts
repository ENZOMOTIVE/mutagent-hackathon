/**
 * scripts/render-discover-report.ts — SHIPPED `*discover` report renderer.
 * ---------------------------------------------------------------------------
 * The SHIPPED replacement for the EXCLUDED run-local Python `render-carousel.py`.
 * Reads a discover `criteria.json` (FULL `MinedCriterion[]` — the real `*discover`
 * AGGREGATE output, `aggregateDiscover().criteria`) + OPTIONAL companion artifacts
 * (`grounding-check.json`, `triage-summary.json`, `sent-dist.json`, `verdicts/`,
 * `dataset-candidates.json`, a subject `profile`) and emits a self-contained,
 * EVALUATOR-GRADE `report.html` with sticky-nav tabs (mirrors `render-eval-report.ts`):
 *
 *   ① Overview      — entity card (subject · reconstructed system prompt · tools ·
 *                     code-access) + a coverage FUNNEL (ingested → triaged → deep-read
 *                     → criteria mined, drawn with embedded mermaid) + the send-tool
 *                     distribution + saturation status.
 *   ② Criteria      — one expandable card per criterion: statement · HOW-TO-DETECT
 *                     (plain language) · grounding (observed/inferred) · severity ·
 *                     check-method chip (CODE / JUDGE / HYBRID) · the `codeEval` spec
 *                     (primitive + params) for CODE/HYBRID criteria · evidence refs
 *                     {obs,path,value} · typed assumptions · prevalence · raw-JSON
 *                     toggle · a mutually-exclusive HITL keep/revise/retire control +
 *                     a notes box. A decisions PANEL collects every choice into a
 *                     copy-paste TASK DEFINITION (markdown) with a clipboard export.
 *   ③ Proof-of-work — the determiner deep-read verdicts (per-trace ✓/✗ + cited reason
 *                     + confidence) read from `verdicts/`.
 *   ④ Dataset       — the dataset-candidates (the held-out derivation seed).
 *
 * Brand: rendered from the evaluator's OWN bundled `assets/brand/theme.css` (the
 * unified design-system tokens — dark · SHARP corners · ≥11px font floor; every size
 * steps off the `--fs-*` scale, NO ad-hoc px) + report-component CSS referencing
 * those SAME tokens. Self-contained — no external script/CDN dependency (the coverage
 * funnel is a native segmented stage strip; the Criteria tab is a paged carousel).
 *
 * DETERMINISTIC + null-guarded: the ONLY non-deterministic input is the injected
 * `generatedAt`, so two renders of the same input are BYTE-IDENTICAL after the
 * `mask.ts` generatedAt mask (C-PIN). The HITL control is client-state-only — its
 * default (unchecked radios · empty task-definition) is static, so byte-identity holds.
 * PURE except `renderDiscoverReport`'s brand file reads (theme.css + wordmark.html) —
 * never spawns a process / opens a file.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeEvalSpec } from "./code-eval.ts";
import {
  Grounding,
  type DiscoveryAssumption,
  type DiscoveryRef,
  type EvalTrace,
  type MinedCriterion,
} from "./contracts/eval-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(HERE, "..", "assets", "brand");

/** HTML-escape (null-guarded — no throw on undefined). Mirrors render-eval-report.ts. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Embed a JSON value into an inline <script> safely (neutralise `</script>`). */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null).replaceAll("<", "\\u003c");
}

/**
 * WS-6 — reconstruct the subject's SYSTEM PROMPT from a raw trace. The discover
 * `profile` usually carries no `systemPrompt`, but the agent's static system message
 * rides on every LLM-call observation as the first `role:"system"` message — so it is
 * RECOVERABLE from the trace batch, not confabulated. The discover-side entity hero
 * renders it COLLAPSED when `profile.systemPrompt` is set.
 *
 * VERBATIM MIRROR of `reconstructSystemPrompt` in `render-eval-report.ts` (the canonical
 * WS-6 extractor ws1-eval built). Kept here — rather than imported — so the SELF-CONTAINED
 * discover renderer does not pull the whole eval scoring pipeline (eval-matrix · matrix-judge ·
 * evaluate · route-failures · source-map) in for one pure function. KEEP IN SYNC: any logic
 * change to either copy must be applied to BOTH (do not let the two extractors diverge).
 *
 * Scans, in priority order: (1) each observation's `input` — a bare messages ARRAY
 * OR a `{messages:[…]}` wrapper; (2) the trace-level `input` in those same two shapes.
 * Returns the FIRST `role:"system"` message's text. Returns `undefined` when no system
 * message exists — the caller then leaves the prompt UNAVAILABLE (NEVER fabricated).
 * PURE, read-only over the trace.
 */
export function reconstructSystemPrompt(t: EvalTrace): string | undefined {
  // content → text: a message content is a string OR an array of {type,text} parts.
  const contentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part !== null && typeof part === "object"
            ? String((part as { text?: unknown }).text ?? "")
            : typeof part === "string"
              ? part
              : "",
        )
        .join("");
    }
    return "";
  };
  // scan a message ARRAY for the first role:"system" → its (non-empty) content text.
  const fromMessages = (msgs: unknown): string | undefined => {
    if (!Array.isArray(msgs)) return undefined;
    for (const m of msgs) {
      if (m !== null && typeof m === "object" && (m as { role?: unknown }).role === "system") {
        const txt = contentText((m as { content?: unknown }).content).trim();
        if (txt.length > 0) return txt;
      }
    }
    return undefined;
  };
  // a container is either a bare messages array OR a {messages:[…]} wrapper.
  const fromContainer = (c: unknown): string | undefined => {
    const direct = fromMessages(c);
    if (direct !== undefined) return direct;
    if (c !== null && typeof c === "object" && !Array.isArray(c)) {
      return fromMessages((c as { messages?: unknown }).messages);
    }
    return undefined;
  };
  for (const o of t.observations ?? []) {
    const hit = fromContainer((o as { input?: unknown }).input);
    if (hit !== undefined) return hit;
  }
  return fromContainer((t as { input?: unknown }).input);
}

/** The OPTIONAL GA `grounding-check.json` summary shape (a subset — null-tolerant). */
export interface GroundingCheckSummary {
  totalCriteria?: number;
  observed?: number;
  inferred?: number;
  diffResults?: { id: string; decision?: string; grounding?: string; reason?: string }[];
}

/** OPTIONAL subject profile (a subset of the M1 `SubjectProfile`) — drives the entity card. */
export interface DiscoverProfile {
  identity?: string;
  entityType?: string;
  purpose?: string;
  tools?: string[];
  skill?: string;
  scope?: string;
  /** rendered COLLAPSED in the entity card; never confabulated. */
  systemPrompt?: string;
  harness?: string;
  /** `given` (code access) vs `reconstructed` (from traces) — drives the code-access chip. */
  provenance?: "given" | "reconstructed";
  version?: string;
  inferredFields?: string[];
}

/** OPTIONAL `triage-summary.json` — the cheap-triage census over the WHOLE batch. */
export interface TriageSummary {
  total?: number;
  sendTool?: string;
  sentDist?: Record<string, number>;
  sendSucc?: Record<string, number>;
  eventTax?: Record<string, number>;
  eventTags?: string[];
  /** reconstructed entity census — tool name → #traces that invoked it (observed call-frequency). */
  toolCensus?: Record<string, number>;
  /** total tool-call volume observed across the batch. */
  sends?: number;
  /** mean observations per trace (observed). */
  obsAvg?: number;
  /** OPTIONAL reliability roll-ups across the batch — the send-health / recovery /
   *  outbound-guard signals the gating criteria are mined FROM. Each field optional. */
  totals?: {
    sends?: number;
    failedSends?: number;
    hardFails?: number;
    tracesWithRecovery?: number;
    tracesWithOutboundGuard?: number;
  };
}

/** OPTIONAL `sent-dist.json` — the send/succeed distribution (+ per-trace rows). */
export interface SentDistSummary {
  dist?: Record<string, number>;
  sendSucc?: Record<string, number>;
  byTrace?: { traceId: string; sent?: string; succ?: string; tools?: number; event?: string }[];
}

/** OPTIONAL determiner deep-read verdict (one per trace; filename = trace id). */
export interface DeterminerVerdict {
  traceId: string;
  result?: string;
  critique?: string;
  confidence?: number;
}

/** OPTIONAL dataset candidate (the held-out derivation seed). */
export interface DatasetCandidate {
  id: string;
  tuple?: Record<string, unknown>;
  query?: string;
  source?: string;
  originTraceId?: string;
  /** deterministic provenance — which EV-052 selector nominated it ("data link"). */
  selectedBy?: string;
  /** LLM-authored "why this is high-value as a held-out test" (the judgment). */
  rationale?: string;
}

export interface DiscoverReportInput {
  subject: { name: string; source?: string };
  criteria: MinedCriterion[];
  /** OPTIONAL GA summary — drives the grounding strip + per-card diff note. */
  grounding?: GroundingCheckSummary | null;
  /** OPTIONAL subject profile — drives the Overview entity card. */
  profile?: DiscoverProfile | null;
  /** OPTIONAL cheap-triage census — drives the coverage funnel + send distribution. */
  triage?: TriageSummary | null;
  /** OPTIONAL send/succeed distribution — supplements the funnel. */
  sentDist?: SentDistSummary | null;
  /** OPTIONAL determiner verdicts — drive the Proof-of-work tab. */
  verdicts?: DeterminerVerdict[] | null;
  /** OPTIONAL dataset candidates — drive the Dataset tab. */
  dataset?: DatasetCandidate[] | null;
  /** the ISO timestamp stamped into the header (masked by mask.ts for C-PIN). */
  generatedAt: string;
  batchId?: string;
}

// ── severity ordering (CRIT → LOW) for a deterministic, severity-first sort ──
const SEVERITY_RANK: Record<string, number> = { CRIT: 0, HIGH: 1, MED: 2, LOW: 3 };

/** Stable severity-then-id ordering (DETERMINISTIC — no clock, no input order dep). */
export function sortCriteria(criteria: MinedCriterion[]): MinedCriterion[] {
  return [...criteria].sort((a, b) => {
    const sa = SEVERITY_RANK[a.metadata.severity] ?? 9;
    const sb = SEVERITY_RANK[b.metadata.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function refRow(r: DiscoveryRef): string {
  return (
    `<div class="ref"><span class="ref-obs">${esc(r.obs)}</span>` +
    `<span class="ref-path">${esc(r.path)}</span>` +
    `<span class="ref-val">${esc(r.value)}</span></div>`
  );
}

function assumptionRow(a: DiscoveryAssumption, cid?: string, idx?: number): string {
  const kind = a.kind ? `<span class="asm-kind">${esc(a.kind)}</span>` : "";
  // The carousel's 2nd HITL axis: adjudicate each surfaced assumption independently.
  const cal =
    cid !== undefined && idx !== undefined
      ? `<span class="asm-cal" data-asm="${esc(cid)}:${idx}">` +
        `<label><input type="radio" name="asm-${esc(cid)}-${idx}" value="verify">verify</label>` +
        `<label><input type="radio" name="asm-${esc(cid)}-${idx}" value="eliminate">eliminate</label>` +
        `</span>`
      : "";
  return (
    `<li class="asm"><span class="asm-status asm-${esc(a.status)}">${esc(a.status)}</span>` +
    `${kind}<span class="asm-text">${esc(a.text)}</span>${cal}</li>`
  );
}

/** Map the 3-value `check_method` router to its substrate LABEL (CODE / JUDGE / HYBRID). */
function checkMethodLabel(cm: string): string {
  if (cm === "deterministic") return "CODE";
  if (cm === "hybrid") return "HYBRID";
  return "JUDGE";
}

/** A one-line, plain-language description of a `codeEval` primitive (the deterministic check). */
function codeEvalPlain(spec: CodeEvalSpec): string {
  switch (spec.primitive) {
    case "presence":
      return `field \`${spec.field}\` must be present and non-empty.`;
    case "string-equality":
      return `field \`${spec.field}\` must equal \`${spec.expected}\`${spec.caseInsensitive ? " (case-insensitive)" : ""}.`;
    case "format-validity":
      return `field \`${spec.field}\` must match the pattern \`${spec.pattern}\`.`;
    case "schema-conformance":
      return `field \`${spec.field}\` must contain the keys: ${spec.requiredKeys.join(", ")}.`;
    case "ref-integrity":
      return `every value from \`${spec.producer}\` must re-appear in \`${spec.consumer}\`.`;
    case "recovery-after-failure":
      return `if \`${spec.failField}\` == \`${spec.failEquals}\` on a step, a recovery tool (${spec.recoveryTools.join(" | ")}) must fire AFTER it — else a silent drop.`;
    case "tool-output-failure":
      return `tool \`${spec.tool}\` output at \`${spec.successPath}\` must not signal failure (false).`;
    default:
      return "deterministic code-check.";
  }
}

/** Render the executable `codeEval` spec — the primitive + its params (deterministic check). PURE. */
export function renderCodeEvalSpec(spec: CodeEvalSpec): string {
  const params = Object.entries(spec)
    .filter(([k]) => k !== "primitive")
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `<div class="ce-param"><span class="ce-k">${esc(k)}</span><span class="ce-v">${esc(val)}</span></div>`;
    })
    .join("");
  return (
    `<div class="ce-block">` +
    `<div class="ce-h">deterministic check · <span class="ce-prim">${esc(spec.primitive)}</span></div>` +
    `<div class="ce-plain">${esc(codeEvalPlain(spec))}</div>` +
    `<div class="ce-params">${params}</div>` +
    `</div>`
  );
}

/** HOW-TO-DETECT — plain language, derived from check_method + codeEval + judge inputs. */
function howToDetect(c: MinedCriterion): string {
  const cm = c.metadata.check_method;
  const inputs = (c.metadata.judge_inputs ?? c.judgeInputs ?? []).join(", ") || "the output";
  if (c.codeEval) {
    const lead = cm === "hybrid" ? "Code pre-filter, then an LLM judge confirms — " : "Deterministic code-check — ";
    return `${lead}${codeEvalPlain(c.codeEval)}`;
  }
  if (cm === "hybrid") {
    return `Code pre-filter then an LLM judge reads ${inputs} and decides pass/fail against the statement.`;
  }
  if (cm === "deterministic") {
    return `Deterministic check over ${inputs} (codeEval spec pending — see notice below).`;
  }
  return `An LLM judge reads ${inputs} and decides pass/fail against the statement (critique-before-verdict).`;
}

/** One criterion → one expandable card. PURE. */
export function renderCriterionCard(
  c: MinedCriterion,
  diff?: { decision?: string; reason?: string },
): string {
  const md = c.metadata;
  const dr = c.discovery;
  const ev = dr.evidence;
  const grounded = ev.grounding === Grounding.Observed;
  const cm = md.check_method;
  const needsCode = cm === "deterministic" || cm === "hybrid";
  const refsHtml =
    ev.refs.length > 0
      ? `<div class="refs">${ev.refs.map(refRow).join("")}</div>`
      : `<div class="refs-na">no structured refs</div>`;
  const asmHtml =
    dr.assumptions.length > 0
      ? `<ul class="asms">${dr.assumptions.map((a, i) => assumptionRow(a, c.id, i)).join("")}</ul>`
      : `<div class="asms-na">no recorded assumptions</div>`;
  const diffNote =
    diff !== undefined
      ? `<div class="diffnote diff-${esc(diff.decision ?? "")}"><span class="dn-k">GA-11</span> ` +
        `<span class="dn-d">${esc(diff.decision ?? "")}</span> ` +
        `<span class="dn-r">${esc(diff.reason ?? "")}</span></div>`
      : "";
  const codeEvalHtml = c.codeEval
    ? renderCodeEvalSpec(c.codeEval)
    : needsCode
      ? `<div class="ce-missing">⚠ check-method is ${esc(checkMethodLabel(cm))} but no <code>codeEval</code> spec is attached (producer gap — the deterministic check is not yet wired).</div>`
      : "";
  const rawJson = esc(JSON.stringify(c, null, 2));
  const cid = esc(c.id);

  return `<article class="card sev-${esc(md.severity)}" data-grounding="${esc(ev.grounding)}" data-severity="${esc(md.severity)}" data-dimension="${esc(md.dimension)}">
  <header class="card-h">
    <span class="cid">${cid}</span>
    <span class="sev sev-${esc(md.severity)}">${esc(md.severity)}</span>
    <span class="grounding gr-${esc(ev.grounding)}">${esc(ev.grounding)}</span>
    <span class="cmeth cm-${esc(cm)}">${esc(checkMethodLabel(cm))}</span>
  </header>
  <p class="statement">${esc(c.statement)}</p>
  <div class="howto"><span class="howto-k">how to detect</span> <span class="howto-v">${esc(howToDetect(c))}</span></div>
  <div class="meta-row">
    <span class="chip"><span class="ck">level</span> ${esc(md.level)}</span>
    <span class="chip"><span class="ck">class</span> ${esc(md.dimension)}</span>
    <span class="chip"><span class="ck">check</span> ${esc(md.check_method)}</span>
    <span class="chip"><span class="ck">flag</span> ${esc(md.flag)}</span>
    <span class="chip"><span class="ck">prevalence</span> ${esc(ev.prevalence)}</span>
  </div>
  ${diffNote}
  ${codeEvalHtml}
  <div class="ev-block">
    <div class="ev-h">grounding: ${grounded ? "OBSERVED" : esc(ev.grounding).toUpperCase()} · why: ${esc(dr.why_problem)}</div>
    ${refsHtml}
  </div>
  <div class="asm-block">
    <div class="asm-h">typed assumptions</div>
    ${asmHtml}
  </div>
  ${
    dr.targets || dr.reasoning
      ? `<div class="prov-block">
    ${dr.targets ? `<div class="prov-row"><span class="prov-k">targets</span><span class="prov-v">${esc(dr.targets)}</span></div>` : ""}
    ${dr.reasoning ? `<div class="prov-row"><span class="prov-k">why&nbsp;mined</span><span class="prov-v">${esc(dr.reasoning)}</span></div>` : ""}
  </div>`
      : ""
  }
  <div class="hitl" data-hitl="${cid}">
    <div class="hitl-h">decision</div>
    <div class="hitl-opts">
      <label class="hitl-opt keep"><input type="radio" name="hitl-${cid}" value="keep"><span>keep</span></label>
      <label class="hitl-opt revise"><input type="radio" name="hitl-${cid}" value="revise"><span>revise</span></label>
      <label class="hitl-opt retire"><input type="radio" name="hitl-${cid}" value="retire"><span>retire</span></label>
    </div>
    <textarea class="hitl-note" data-hitl-note="${cid}" rows="2" placeholder="notes — what to change / why retire…"></textarea>
  </div>
  <details class="raw"><summary>raw JSON</summary><pre class="raw-pre">${rawJson}</pre></details>
</article>`;
}

// ════════════════════════════════════════════════════════════════════════════
// HITL — the copy-paste TASK DEFINITION (markdown). PURE + mirrored in the client
// script (the live in-browser builder produces byte-identical text). Tested directly.
// ════════════════════════════════════════════════════════════════════════════

export interface DecisionRow {
  id: string;
  decision: "keep" | "revise" | "retire";
  note?: string;
  severity?: string;
  checkMethod?: string;
  statement?: string;
}

const DECISION_ACTION: Record<DecisionRow["decision"], string> = {
  keep: "KEEP — promote this criterion into the suite as-is.",
  revise: "REVISE — edit the statement/detection before promoting; see note.",
  retire: "RETIRE — drop this criterion from the suite; see note.",
};

/** Build the operator copy-paste TASK DEFINITION markdown from the picked decisions. PURE. */
export function buildDecisionMarkdown(args: {
  subject: string;
  generatedAt: string;
  decisions: DecisionRow[];
}): string {
  const head =
    `# Discover — HITL Task Definition\n` +
    `- subject: ${args.subject}\n` +
    `- generated: ${args.generatedAt}\n` +
    `- decisions: ${args.decisions.length}\n`;
  if (args.decisions.length === 0) {
    return `${head}\n_No decisions yet — pick keep/revise/retire on a criterion._\n`;
  }
  const blocks = args.decisions.map((d) => {
    const note = d.note && d.note.trim().length > 0 ? d.note.trim() : "(none)";
    return (
      `## ${d.id} — ${d.decision.toUpperCase()}\n` +
      `- severity: ${d.severity ?? "—"}\n` +
      `- check-method: ${d.checkMethod ?? "—"}\n` +
      `- statement: ${d.statement ?? "—"}\n` +
      `- note: ${note}\n` +
      `- action: ${DECISION_ACTION[d.decision]}\n`
    );
  });
  return `${head}\n${blocks.join("\n")}`;
}

/** A small grounding-summary strip (rendered iff a grounding-check is supplied). */
// ── Overview tab ─────────────────────────────────────────────────────────────

function entityCard(
  subject: { name: string; source?: string },
  profile: DiscoverProfile | null | undefined,
  triage: TriageSummary | null | undefined,
): string {
  const p = profile ?? {};
  const t = triage ?? {};
  const codeAccess = p.provenance === "given";
  const accessChip = codeAccess
    ? `<span class="acc acc-given">code access ✓</span>`
    : `<span class="acc acc-recon">reconstructed (no code access)</span>`;

  // ── tools: a GIVEN profile.tools manifest first; else the triage TOOL CENSUS
  //    (reconstructed observed call-frequency across the whole batch — the entity
  //    signal that almost always EXISTS even when no profile was captured). ──
  const census = t.toolCensus && Object.keys(t.toolCensus).length > 0 ? t.toolCensus : null;
  const sendToolName = t.sendTool;
  const toolChip = (name: string, n?: number): string =>
    `<span class="tool-chip${name === sendToolName ? " tool-send" : ""}">${esc(name)}${n !== undefined ? ` <span class="tool-n">${esc(n)}</span>` : ""}</span>`;
  let toolsHtml: string;
  let toolsLabel = "tools";
  if (p.tools && p.tools.length > 0) {
    toolsHtml = `<div class="tools">${p.tools.map((tn) => toolChip(tn)).join("")}</div>`;
  } else if (census) {
    toolsHtml = `<div class="tools">${Object.entries(census)
      .sort((a, b) => b[1] - a[1])
      .map(([tn, n]) => toolChip(tn, n))
      .join("")}</div>`;
    toolsLabel = "tools · observed call-frequency (reconstructed)";
  } else if (sendToolName) {
    toolsHtml = `<div class="tools">${toolChip(sendToolName)}</div>`;
  } else {
    toolsHtml = `<div class="na">tools not captured</div>`;
  }

  // ── reconstructed stat tiles from the triage census ──
  const ss = t.sendSucc;
  const succRate = (() => {
    if (!ss) return null;
    const ok = ss.succeeded ?? ss["true"] ?? 0;
    const bad = ss.failed ?? ss["false"] ?? 0;
    const tot = ok + bad;
    return tot > 0 ? Math.round((ok / tot) * 100) : null;
  })();
  const statTiles: Array<[string, string]> = [];
  if (t.total !== undefined) statTiles.push(["traces", String(t.total)]);
  if (census) statTiles.push(["tools", String(Object.keys(census).length)]);
  if (t.sends !== undefined) statTiles.push(["tool calls", String(t.sends)]);
  if (t.obsAvg !== undefined) statTiles.push(["obs / trace", String(t.obsAvg)]);
  if (succRate !== null) statTiles.push(["send ok", succRate + "%"]);
  if (t.eventTax) statTiles.push(["event kinds", String(Object.keys(t.eventTax).length)]);
  const statsHtml =
    statTiles.length > 0
      ? `<div class="ec-stats">${statTiles.map(([l, v]) => `<div class="ecs"><div class="ecs-v">${esc(v)}</div><div class="ecs-l">${esc(l)}</div></div>`).join("")}</div>`
      : "";

  // ── event taxonomy chips (what kinds of inputs the agent handled) ──
  const evHtml =
    t.eventTax && Object.keys(t.eventTax).length > 0
      ? `<div class="ec-sp-h">event taxonomy</div><div class="tools">${Object.entries(t.eventTax)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `<span class="tool-chip">${esc(k)} <span class="tool-n">${esc(n)}</span></span>`)
          .join("")}</div>`
      : "";

  const facts = [
    ["entity", p.entityType],
    ["purpose", p.purpose],
    ["scope", p.scope],
    ["harness", p.harness],
    ["skill", p.skill],
    ["version", p.version],
  ]
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `<div class="ec-c"><div class="ec-k">${esc(k)}</div><div class="ec-v">${esc(v)}</div></div>`)
    .join("");

  const sysPromptHtml =
    p.systemPrompt && p.systemPrompt.trim().length > 0
      ? `<div class="ec-sp-h">system prompt</div><details class="sysprompt"><summary>reconstructed system prompt · ${p.systemPrompt.length} chars</summary><pre class="sp-pre">${esc(p.systemPrompt)}</pre></details>`
      : "";

  const honesty = !codeAccess
    ? `<div class="ec-honesty">⊙ reconstructed from ${t.total !== undefined ? esc(t.total) + " " : ""}traces — the tool census &amp; event taxonomy are <b>observed</b> call-frequencies, not a declared manifest; no source / system-prompt access.${p.inferredFields && p.inferredFields.length ? " inferred: " + p.inferredFields.map(esc).join(", ") : ""}</div>`
    : "";

  const head = `<header class="entity-h">
    <span class="ent-name">${esc(p.identity ?? subject.name)}</span>
    ${accessChip}
    ${subject.source ? `<span class="ent-src">${esc(subject.source)}</span>` : ""}
  </header>`;

  // bare fallback ONLY when there is genuinely NOTHING (no profile, no census, no triage).
  const hasAnything = Boolean(
    facts || (p.tools && p.tools.length) || census || sendToolName || statTiles.length > 0 || p.systemPrompt,
  );
  if (!hasAnything) {
    return `<section class="entity">
  ${head}
  <div class="na">trace-only subject — no tool / event census available in this batch</div>
</section>`;
  }

  return `<section class="entity">
  ${head}
  ${statsHtml}
  ${facts ? `<div class="ec-grid">${facts}</div>` : ""}
  <div class="ec-tools-h">${esc(toolsLabel)}</div>
  ${toolsHtml}
  ${evHtml}
  ${sysPromptHtml}
  ${honesty}
</section>`;
}

function coverageFunnel(input: DiscoverReportInput): string {
  const ingested = input.triage?.total ?? input.sentDist?.byTrace?.length;
  const triaged = input.triage?.total;
  const deepRead = input.verdicts?.length;
  const mined = input.criteria.length;
  const seg = (label: string, v: number | undefined): string =>
    `<div class="fseg"><div class="fseg-v">${v === undefined ? "—" : esc(v)}</div><div class="fseg-l">${esc(label)}</div></div>`;
  const arrow = `<div class="farrow">→</div>`;
  const v = input.verdicts ?? [];
  let pass = 0,
    fail = 0,
    other = 0;
  for (const r of v) {
    if (r.result === "pass") pass++;
    else if (r.result === "fail") fail++;
    else other++;
  }
  const pills =
    v.length > 0
      ? `<div class="fpills"><span class="fpill ok">${pass} pass</span><span class="fpill bad">${fail} fail</span>${other > 0 ? `<span class="fpill">${other} uncertain</span>` : ""}</div>`
      : "";
  return `<div class="funnel2">
  <div class="panel-h">coverage funnel</div>
  <div class="fstages">${seg("ingested", ingested)}${arrow}${seg("triaged", triaged)}${arrow}${seg("deep-read", deepRead)}${arrow}${seg("criteria", mined)}</div>
  ${pills}
</div>`;
}

function sendDistribution(input: DiscoverReportInput): string {
  const dist = input.sentDist?.dist ?? input.triage?.sentDist;
  const succ = input.sentDist?.sendSucc ?? input.triage?.sendSucc;
  const tax = input.triage?.eventTax;
  if (!dist && !succ && !tax) return "";
  const kv = (obj: Record<string, number> | undefined): string =>
    obj
      ? Object.entries(obj)
          .map(([k, v]) => `<div class="dd"><span class="dd-k">${esc(k)}</span><span class="dd-v">${esc(v)}</span></div>`)
          .join("")
      : `<div class="na">—</div>`;
  return `<div class="send-dist">
  <div class="panel-h">send-tool distribution</div>
  <div class="dist-grid">
    <div class="dist-col"><div class="dist-col-h">sent</div>${kv(dist)}</div>
    <div class="dist-col"><div class="dist-col-h">send succeeded</div>${kv(succ)}</div>
    ${tax ? `<div class="dist-col"><div class="dist-col-h">event taxonomy</div>${kv(tax)}</div>` : ""}
  </div>
</div>`;
}

function saturationStrip(input: DiscoverReportInput): string {
  const v = input.verdicts ?? [];
  let pass = 0;
  let fail = 0;
  let other = 0;
  for (const r of v) {
    if (r.result === "pass") pass++;
    else if (r.result === "fail") fail++;
    else other++;
  }
  const observed = input.criteria.filter((c) => c.discovery.evidence.grounding === Grounding.Observed).length;
  return `<div class="sat">
  <span class="sat-k">saturation</span>
  <span class="sat-pill">${input.criteria.length} criteria mined</span>
  <span class="sat-pill gr-observed">${observed} observed</span>
  ${v.length > 0 ? `<span class="sat-pill">${v.length} deep-read</span><span class="sat-pill ok">${pass} pass</span><span class="sat-pill bad">${fail} fail</span>${other > 0 ? `<span class="sat-pill">${other} uncertain</span>` : ""}` : ""}
</div>`;
}

/**
 * The Overview HEADLINE — the decision summary an operator reads first: a one-line
 * yield/risk lede + scannable big-stat tiles. Mirrors the eval report's lead-with-the-
 * verdict treatment (parity gap closed). DERIVED purely from criteria (+ optional
 * verdicts/triage) — invents nothing.
 */
function overviewHeadline(input: DiscoverReportInput): string {
  const crit = input.criteria;
  const total = crit.length;
  const sub = { code: 0, hybrid: 0, judge: 0 };
  const sev: Record<string, number> = { CRIT: 0, HIGH: 0, MED: 0, LOW: 0 };
  for (const c of crit) {
    const cm = c.metadata.check_method;
    if (cm === "deterministic") sub.code++;
    else if (cm === "hybrid") sub.hybrid++;
    else sub.judge++;
    sev[c.metadata.severity] = (sev[c.metadata.severity] ?? 0) + 1;
  }
  const observed = crit.filter((c) => c.discovery.evidence.grounding === Grounding.Observed).length;
  const highPlus = (sev.CRIT ?? 0) + (sev.HIGH ?? 0);
  const runnable = sub.code + sub.hybrid; // tier-0 executable (0 judge tokens)
  const v = input.verdicts ?? [];
  let drFail = 0;
  for (const r of v) if (r.result === "fail") drFail++;

  const tiles: Array<[string, string, string]> = [
    ["criteria mined", String(total), ""],
    ["code-eval", String(runnable), "ok"],
    ["judge-eval", String(sub.judge), ""],
    ["HIGH / CRIT", String(highPlus), highPlus > 0 ? "warn" : ""],
    ["deep-read fails", v.length > 0 ? String(drFail) : "—", drFail > 0 ? "fail" : ""],
    ["observed", `${observed}/${total}`, "ok"],
  ];
  const tilesHtml = tiles
    .map(([l, val, kind]) => `<div class="s${kind ? " " + kind : ""}"><div class="v">${esc(val)}</div><div class="l">${esc(l)}</div></div>`)
    .join("");

  const riskCls = drFail > 0 ? "fail" : "skip";
  const lede =
    `Discovery mined <strong>${total}</strong> actionable criteria` +
    (input.triage?.total ? ` over <strong>${esc(input.triage.total)}</strong> traces` : "") +
    `: <strong>${runnable}</strong> run deterministically (code/hybrid — 0 judge tokens), <strong>${sub.judge}</strong> via grounded judge. ` +
    `<strong>${highPlus}</strong> are HIGH/CRIT severity` +
    (v.length > 0
      ? `; deep-read of <strong>${v.length}</strong> surfaced <strong>${drFail}</strong> observed failure${drFail === 1 ? "" : "s"}.`
      : ".");

  return (
    `<div class="verdict ${riskCls}">` +
    `<div style="font-size:var(--fs-lg);font-weight:700;color:var(--fg-strong);margin-bottom:4px">Discovery Yield</div>` +
    `<p style="color:var(--fg);margin:0">${lede}</p></div>` +
    `<div class="big-stat">${tilesHtml}</div>`
  );
}

/** severity × substrate breakdown — the keep/retire decision table (CODE/HYBRID/JUDGE per severity). */
function severitySubstrateTable(input: DiscoverReportInput): string {
  const order = ["CRIT", "HIGH", "MED", "LOW"];
  const subOf = (cm: string): "CODE" | "HYBRID" | "JUDGE" =>
    cm === "deterministic" ? "CODE" : cm === "hybrid" ? "HYBRID" : "JUDGE";
  const grid: Record<string, { CODE: number; HYBRID: number; JUDGE: number }> = {};
  for (const s of order) grid[s] = { CODE: 0, HYBRID: 0, JUDGE: 0 };
  for (const c of input.criteria) {
    const g = grid[c.metadata.severity] ?? (grid[c.metadata.severity] = { CODE: 0, HYBRID: 0, JUDGE: 0 });
    g[subOf(c.metadata.check_method)]++;
  }
  const rows = order
    .filter((s) => grid[s] && grid[s].CODE + grid[s].HYBRID + grid[s].JUDGE > 0)
    .map((s) => {
      const g = grid[s];
      const tot = g.CODE + g.HYBRID + g.JUDGE;
      return `<tr><td><span class="sev sev-${s}">${s}</span></td><td>${g.CODE || "·"}</td><td>${g.HYBRID || "·"}</td><td>${g.JUDGE || "·"}</td><td><strong>${tot}</strong></td></tr>`;
    })
    .join("");
  return `<div class="panel-h">severity × substrate</div>
  <table><thead><tr><th>severity</th><th>CODE</th><th>HYBRID</th><th>JUDGE</th><th>total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * The CHIP LEGEND — an explicit, compact key for EVERY vocabulary the report uses
 * (grounding · substrate · severity · the HITL decision states) so a reader never has
 * to infer what a chip means. Mirrors the eval report's `verdictLegend` / `.vlegend`
 * treatment (bordered surf-2 block · cyan left-accent · ▾ header · key+gloss rows).
 * The chips REUSE the same classes the cards render (`.grounding` · `.cmeth` · `.sev`)
 * so the legend is a true visual key, not a re-description. PURE.
 */
function discoverLegend(): string {
  const group = (title: string, rows: string): string =>
    `<div class="dl-g"><div class="dl-gh">${esc(title)}</div>${rows}</div>`;
  const item = (chip: string, v: string): string =>
    `<div class="dl-item">${chip}<span class="dl-v">${esc(v)}</span></div>`;

  const grounding = group(
    "grounding",
    item(
      `<span class="grounding gr-observed">observed</span>`,
      "backed by concrete trace evidence — structured refs{obs,path,value} pin it to a real value.",
    ) +
      item(
        `<span class="grounding gr-inferred">inferred</span>`,
        "reasoned from the batch but not pinned to a specific observed value — a hypothesis to verify.",
      ),
  );

  const substrate = group(
    "substrate · how it's checked",
    item(`<span class="cmeth cm-deterministic">CODE</span>`, "deterministic code-check — runs at tier-0, 0 judge tokens.") +
      item(`<span class="cmeth cm-hybrid">HYBRID</span>`, "code pre-filter, then an LLM judge confirms the pass/fail.") +
      item(`<span class="cmeth cm-llm-judge">JUDGE</span>`, "an LLM judge reads the output and decides pass/fail (critique-before-verdict)."),
  );

  const severity = group(
    "severity",
    item(`<span class="sev sev-CRIT">CRIT</span>`, "gating — a failure blocks certification of the run.") +
      item(`<span class="sev sev-HIGH">HIGH</span>`, "gating — a failure blocks certification of the run.") +
      item(`<span class="sev sev-MED">MED</span>`, "non-gating — tracked, but does not block on its own.") +
      item(`<span class="sev sev-LOW">LOW</span>`, "non-gating — minor / advisory signal."),
  );

  const hitl = group(
    "HITL decision · your review",
    item(`<span class="dl-k keep">keep</span>`, "promote this criterion into the suite as-is.") +
      item(`<span class="dl-k revise">revise</span>`, "edit the statement / detection before promoting.") +
      item(`<span class="dl-k retire">retire</span>`, "drop this criterion from the suite."),
  );

  const foot =
    `<div class="dl-foot"><span class="dl-fk">codeEval primitives</span> ` +
    `presence · string-equality · format-validity · schema-conformance · ref-integrity · ` +
    `recovery-after-failure · tool-output-failure — each CODE / HYBRID card shows the exact primitive + its params.</div>`;

  return (
    `<div class="dlegend"><div class="dl-h">▾ legend — what every chip &amp; state means</div>` +
    `<div class="dl-groups">${grounding}${substrate}${severity}${hitl}</div>${foot}</div>`
  );
}

/**
 * Reliability CENSUS — the send-health / recovery / outbound-guard roll-ups from the
 * triage `totals` block. Surfaced because the gating criteria (send-failure-recovery,
 * outbound-guard-discipline, send-delivery-success) are mined from EXACTLY these
 * signals — leaving them out left real artifact data invisible. Rendered iff
 * `triage.totals` carries at least one field. DERIVED — invents nothing; honest skip
 * when the block is absent. PURE.
 */
function reliabilityTotals(input: DiscoverReportInput): string {
  const t = input.triage?.totals;
  if (!t) return "";
  const tiles: Array<[string, number | undefined, string]> = [
    ["sends", t.sends, ""],
    ["failed sends", t.failedSends, (t.failedSends ?? 0) > 0 ? "warn" : ""],
    ["hard fails", t.hardFails, (t.hardFails ?? 0) > 0 ? "fail" : ""],
    ["traces w/ recovery", t.tracesWithRecovery, "ok"],
    ["traces w/ outbound guard", t.tracesWithOutboundGuard, ""],
  ].filter(([, v]) => v !== undefined) as Array<[string, number, string]>;
  if (tiles.length === 0) return "";
  const cells = tiles
    .map(([l, v, k]) => `<div class="rt${k ? " " + k : ""}"><div class="rt-v">${esc(String(v))}</div><div class="rt-l">${esc(l)}</div></div>`)
    .join("");
  return `<div class="reliab">
  <div class="panel-h">reliability census · the signals the gating criteria were mined from</div>
  <div class="rt-grid">${cells}</div>
</div>`;
}

/** Section header for a tab — h2 title (themed) + a one-line orientation description. */
function tabHead(num: string, title: string, desc: string): string {
  return `<h2>${num} ${esc(title)}</h2>\n  <div class="tabdesc">${esc(desc)}</div>`;
}

function overviewTab(input: DiscoverReportInput): string {
  // Entity-on-top arrangement (parity with render-eval-report's overviewTab, where
  // `entityHero` renders FIRST under the tab header): the subject hero anchors the
  // page, THEN the discovery-yield headline + severity mix + funnel.
  return `<section id="t1" class="panel active">
  ${tabHead("①", "Overview", "What discovery found — yield, severity mix, and the trace coverage funnel. Start here.")}
  ${entityCard(input.subject, input.profile, input.triage)}
  ${overviewHeadline(input)}
  ${severitySubstrateTable(input)}
  ${discoverLegend()}
  ${saturationStrip(input)}
  ${coverageFunnel(input)}
  ${reliabilityTotals(input)}
  ${sendDistribution(input)}
  <div class="note"><span class="tag">★ METHODOLOGY</span>Criteria are mined from a failure-weighted deep-read to saturation. Code/hybrid evals run deterministically (0 judge tokens); judge evals carry structured <code>refs{obs,path,value}</code>. Review &amp; HITL each criterion below — your picks persist in this browser and export as a task definition.</div>
</section>`;
}

// ── Criteria tab ─────────────────────────────────────────────────────────────

function criteriaTab(input: DiscoverReportInput): string {
  const sorted = sortCriteria(input.criteria);
  const diffById = new Map<string, { decision?: string; reason?: string }>();
  for (const d of input.grounding?.diffResults ?? []) {
    diffById.set(d.id, { decision: d.decision, reason: d.reason });
  }
  const cardsHtml =
    sorted.length > 0
      ? `<div class="cards" id="crit-cards">${sorted.map((c) => renderCriterionCard(c, diffById.get(c.id))).join("")}</div>`
      : `<div class="empty">no discovered criteria in this batch</div>`;

  // Paged carousel nav — one eval at a time (‹ › / dots / keyboard), enabled by JS;
  // without JS the cards render as a plain stack (graceful degrade).
  const carNav =
    sorted.length > 1
      ? `<div class="cariar" id="car-nav">
    <button class="car-btn" id="car-prev" type="button">‹ prev</button>
    <button class="car-btn" id="car-next" type="button">next ›</button>
    <span class="car-count" id="car-count">1 / ${sorted.length}</span>
    <span class="car-hint">← → to navigate · dots tint when decided</span>
    <div class="car-dots" id="car-dots">${sorted.map((c, i) => `<button class="car-dot${i === 0 ? " on" : ""}" data-idx="${i}" data-cid="${esc(c.id)}" title="${esc(c.id)}" type="button"></button>`).join("")}</div>
  </div>`
      : "";

  return `<section id="t2" class="panel">
  ${tabHead("②", "Criteria", "The mined evals — reviewed one at a time, carousel-style. Adjudicate each from an AI-engineer / domain-expert lens (keep · revise · retire, plus verify/eliminate per assumption); picks persist and export as a task definition.")}
  ${discoverLegend()}
  <div class="hitl-panel">
    <div class="panel-h">HITL · keep / revise / retire — collected task definition</div>
    <div class="hitl-bar">
      <span id="hitl-count" class="hitl-count">0 decisions</span>
      <button id="hitl-copy" class="hitl-copy" type="button">copy task definition</button>
      <span id="hitl-copied" class="hitl-copied"></span>
    </div>
    <pre id="hitl-md" class="hitl-md"></pre>
  </div>
  ${carNav}
  ${cardsHtml}
</section>`;
}

// ── Proof-of-work tab ────────────────────────────────────────────────────────

function proofTab(input: DiscoverReportInput): string {
  const v = input.verdicts ?? [];
  const proofHead = tabHead("③", "Proof-of-work", "The per-trace deep-read verdicts the criteria were mined from — the evidence trail (✗ failures first).");
  if (v.length === 0) {
    return `<section id="t3" class="panel">\n  ${proofHead}\n  <div class="empty">no determiner verdicts supplied</div></section>`;
  }
  const ordered = [...v].sort((a, b) => {
    const ra = a.result === "fail" ? 0 : a.result === "pass" ? 2 : 1;
    const rb = b.result === "fail" ? 0 : b.result === "pass" ? 2 : 1;
    if (ra !== rb) return ra - rb;
    return a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0;
  });
  const rows = ordered
    .map((r) => {
      const ok = r.result === "pass";
      const mark = ok ? "✓" : r.result === "fail" ? "✗" : "•";
      const conf = typeof r.confidence === "number" ? `<span class="pv-conf">conf ${r.confidence.toFixed(2)}</span>` : "";
      return `<article class="pcard res-${esc(r.result ?? "na")}">
    <header class="pc-h"><span class="pv-mark">${mark}</span><span class="pv-tid">${esc(r.traceId)}</span><span class="pv-res">${esc(r.result ?? "—")}</span>${conf}</header>
    <div class="pv-crit">${esc(r.critique ?? "")}</div>
  </article>`;
    })
    .join("");
  return `<section id="t3" class="panel">
  ${proofHead}
  <div class="panel-h">proof-of-work · determiner deep-read verdicts (${v.length})</div>
  <div class="pcards">${rows}</div>
</section>`;
}

// ── Dataset tab ──────────────────────────────────────────────────────────────

function datasetTab(input: DiscoverReportInput): string {
  const d = input.dataset ?? [];
  const dsHead = tabHead("④", "Dataset", "Failure & uncertain traces distilled into held-out dataset candidates for the eval suite.");
  if (d.length === 0) {
    return `<section id="t4" class="panel">\n  ${dsHead}\n  <div class="empty">no dataset candidates supplied</div></section>`;
  }
  const rows = d
    .map((c) => {
      const tuple = c.tuple
        ? Object.entries(c.tuple)
            .map(([k, v]) => `<span class="dc-tup"><span class="dc-tk">${esc(k)}</span>${esc(String(v))}</span>`)
            .join("")
        : "";
      const why = (c.rationale ?? "").trim();
      const whyBlock = why
        ? `<div class="dc-why"><span class="dc-why-k">why high-value</span><span class="dc-why-v">${esc(why)}</span></div>`
        : `<div class="dc-why dc-why-pending"><span class="dc-why-k">why high-value</span><span class="dc-why-v">— rationale not authored at selection (held-out cases must carry a written justification)</span></div>`;
      const prov = (c.selectedBy ?? "").trim();
      const provBlock = prov
        ? `<div class="dc-prov"><span class="dc-prov-k">selected by</span><span class="dc-prov-v">${esc(prov)}</span></div>`
        : "";
      return `<article class="dcard">
    <header class="dc-h"><span class="dc-id">${esc(c.id)}</span>${tuple}${c.source ? `<span class="dc-src">${esc(c.source)}</span>` : ""}${c.originTraceId ? `<span class="dc-origin">${esc(c.originTraceId)}</span>` : ""}</header>
    ${whyBlock}
    ${provBlock}
    <details class="dc-q"><summary>query · ${(c.query ?? "").length} chars</summary><pre class="dc-pre">${esc(c.query ?? "")}</pre></details>
  </article>`;
    })
    .join("");
  return `<section id="t4" class="panel">
  ${dsHead}
  <div class="panel-h">dataset candidates · held-out derivation seed (${d.length})</div>
  <div class="dcards">${rows}</div>
</section>`;
}

// ── client script (tab wiring + HITL builder) ────────────────────────────────

function clientScript(meta: { subject: string; generatedAt: string }, criteriaMeta: Record<string, { severity: string; checkMethod: string; statement: string }>): string {
  return `
(function(){
  var CM=${jsonForScript(criteriaMeta)};
  var SUBJECT=${jsonForScript(meta.subject)};
  var GEN=${jsonForScript(meta.generatedAt)};
  var ACTION={keep:"KEEP — promote this criterion into the suite as-is.",revise:"REVISE — edit the statement/detection before promoting; see note.",retire:"RETIRE — drop this criterion from the suite; see note."};
  function wireTabs(){
    var btns=document.querySelectorAll('nav.tabs button');
    var panels=document.querySelectorAll('main .panel');
    btns.forEach(function(b){b.addEventListener('click',function(){
      var key=b.getAttribute('data-tab');
      btns.forEach(function(x){x.classList.remove('active');});
      panels.forEach(function(p){p.classList.remove('active');});
      b.classList.add('active');
      var p=document.getElementById(key);if(p)p.classList.add('active');
    });});
  }
  function asmPicksFor(id){
    var out=[];
    document.querySelectorAll('.asm-cal input[name^="asm-'+id+'-"]:checked').forEach(function(r){
      var m=r.name.match(/-(\\d+)$/);out.push('#'+(m?m[1]:'?')+':'+r.value);
    });
    return out;
  }
  function markDots(){
    document.querySelectorAll('#car-dots .car-dot').forEach(function(dt){
      var cid=dt.getAttribute('data-cid');
      var picked=cid&&document.querySelector('input[name="hitl-'+cid+'"]:checked');
      dt.classList.toggle('dec',!!picked);
    });
  }
  function buildMd(){
    var ids=Object.keys(CM).sort();
    var decisions=[];
    ids.forEach(function(id){
      var picked=document.querySelector('input[name="hitl-'+id.replace(/"/g,'')+'"]:checked');
      if(!picked)return;
      var noteEl=document.querySelector('textarea[data-hitl-note="'+id.replace(/"/g,'')+'"]');
      decisions.push({id:id,decision:picked.value,note:noteEl?noteEl.value:'',meta:CM[id],asm:asmPicksFor(id)});
    });
    var head='# Discover — HITL Task Definition\\n- subject: '+SUBJECT+'\\n- generated: '+GEN+'\\n- decisions: '+decisions.length+'\\n';
    var md;
    if(decisions.length===0){md=head+'\\n_No decisions yet — pick keep/revise/retire on a criterion._\\n';}
    else{
      var blocks=decisions.map(function(d){
        var note=(d.note&&d.note.trim().length>0)?d.note.trim():'(none)';
        var m=d.meta||{};
        return '## '+d.id+' — '+d.decision.toUpperCase()+'\\n'+
          '- severity: '+(m.severity||'—')+'\\n'+
          '- check-method: '+(m.checkMethod||'—')+'\\n'+
          '- statement: '+(m.statement||'—')+'\\n'+
          (d.asm&&d.asm.length?('- assumptions: '+d.asm.join(', ')+'\\n'):'')+
          '- note: '+note+'\\n'+
          '- action: '+ACTION[d.decision]+'\\n';
      });
      md=head+'\\n'+blocks.join('\\n');
    }
    var pre=document.getElementById('hitl-md');if(pre)pre.textContent=md;
    var cnt=document.getElementById('hitl-count');if(cnt)cnt.textContent=decisions.length+' decision'+(decisions.length===1?'':'s');
    markDots();
    return md;
  }
  function wireHitl(){
    var LSKEY='mutagent-discover-hitl:'+SUBJECT+':'+GEN;
    function saveState(){
      try{
        var st={};
        document.querySelectorAll('.hitl input[type="radio"]:checked').forEach(function(r){
          var id=r.name.replace(/^hitl-/,'');(st[id]=st[id]||{}).decision=r.value;
        });
        document.querySelectorAll('.hitl-note').forEach(function(t){
          var id=t.getAttribute('data-hitl-note');if(t.value){(st[id]=st[id]||{}).note=t.value;}
        });
        document.querySelectorAll('.asm-cal input[type="radio"]:checked').forEach(function(r){
          var m=r.name.match(/^asm-(.+)-(\\d+)$/);if(!m)return;var id=m[1];(st[id]=st[id]||{});st[id].asm=(st[id].asm||{});st[id].asm[m[2]]=r.value;
        });
        localStorage.setItem(LSKEY,JSON.stringify(st));
      }catch(e){}
    }
    function restoreState(){
      try{
        var raw=localStorage.getItem(LSKEY);if(!raw)return;var st=JSON.parse(raw);
        Object.keys(st).forEach(function(id){
          var d=st[id]||{};
          if(d.decision){var r=document.querySelector('input[name="hitl-'+id+'"][value="'+d.decision+'"]');if(r)r.checked=true;}
          if(d.note){var t=document.querySelector('textarea[data-hitl-note="'+id+'"]');if(t)t.value=d.note;}
          if(d.asm){Object.keys(d.asm).forEach(function(k){var a=document.querySelector('input[name="asm-'+id+'-'+k+'"][value="'+d.asm[k]+'"]');if(a)a.checked=true;});}
        });
      }catch(e){}
    }
    restoreState();
    document.querySelectorAll('.hitl input[type="radio"]').forEach(function(r){r.addEventListener('change',function(){saveState();buildMd();});});
    document.querySelectorAll('.hitl-note').forEach(function(t){t.addEventListener('input',function(){saveState();buildMd();});});
    document.querySelectorAll('.asm-cal input[type="radio"]').forEach(function(r){r.addEventListener('change',function(){saveState();buildMd();});});
    var copy=document.getElementById('hitl-copy');
    if(copy)copy.addEventListener('click',function(){
      var md=buildMd();
      var done=function(){var s=document.getElementById('hitl-copied');if(s){s.textContent='copied ✓';setTimeout(function(){s.textContent='';},2000);}};
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(md).then(done,done);}else{done();}
    });
    buildMd();
  }
  function wireCarousel(){
    var container=document.getElementById('crit-cards');
    if(!container)return;
    var cards=Array.prototype.slice.call(container.querySelectorAll('.card'));
    if(cards.length<2)return;
    container.classList.add('carousel-on');
    var dots=Array.prototype.slice.call(document.querySelectorAll('#car-dots .car-dot'));
    var cnt=document.getElementById('car-count');
    var cur=0;
    function show(i){
      if(i<0)i=cards.length-1;if(i>=cards.length)i=0;cur=i;
      cards.forEach(function(c,j){c.classList.toggle('on',j===i);});
      dots.forEach(function(d,j){if(j===i)d.classList.add('on');else d.classList.remove('on');});
      if(cnt)cnt.textContent=(i+1)+' / '+cards.length;
    }
    var prev=document.getElementById('car-prev'),next=document.getElementById('car-next');
    if(prev)prev.addEventListener('click',function(){show(cur-1);});
    if(next)next.addEventListener('click',function(){show(cur+1);});
    dots.forEach(function(d){d.addEventListener('click',function(){show(parseInt(d.getAttribute('data-idx'),10)||0);});});
    document.addEventListener('keydown',function(e){
      var t2=document.querySelector('nav.tabs button[data-tab="t2"]');
      if(!t2||!t2.classList.contains('active'))return;
      var tag=(e.target&&e.target.tagName)||'';if(tag==='TEXTAREA'||tag==='INPUT')return;
      if(e.key==='ArrowLeft'){show(cur-1);}else if(e.key==='ArrowRight'){show(cur+1);}
    });
    show(0);
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',function(){wireTabs();wireHitl();wireCarousel();});}
  else{wireTabs();wireHitl();wireCarousel();}
})();`;
}

const REPORT_CSS = `
/* WS-4 — discover-local font-scale bump. The shared brand scale (11/12/13/14/16/19/22)
   reads too small in this report's dense mono captions/labels/foot. Bump the smallest
   tiers +2px, taper to +1px at the headings — monotonic (no inversions), sits ~+2px
   above the evaluator report at the small end, equal at the very top. */
:root{--fs-2xs:13px;--fs-xs:14px;--fs-sm:15px;--fs-md:16px;--fs-lg:17px;--fs-xl:20px;--fs-2xl:23px}
main{max-width:1180px;margin:0 auto;padding:14px 18px 64px}
/* tabs — match the EVALUATOR / diagnostics unified treatment (underline-active, void
   background, NO border-box, NO shadow) instead of the old bordered-button box. */
nav.tabs{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--border);padding:0 12px;margin:0 0 16px;overflow-x:auto;white-space:nowrap}
nav.tabs button{font-size:var(--fs-xs);font-weight:500;color:var(--muted);background:none;border:none;border-bottom:3px solid transparent;padding:10px 12px;cursor:pointer;letter-spacing:.01em;font-family:inherit;transition:all .15s}
nav.tabs button:hover{color:var(--fg-strong);background:var(--surf)}
nav.tabs button.active{color:var(--primary-soft);border-bottom-color:var(--primary);font-weight:600}
.panel{display:none}
.panel.active{display:block}
.panel-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.06em;color:var(--cyan);margin:14px 0 8px}
.na{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);border:1px dashed var(--border-strong);padding:4px 8px}
.gstrip{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:9px 13px;border:1px solid var(--border);background:var(--surf-2);margin:0 0 16px}
.gstrip .gs-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.gstrip .gs-v{font-family:var(--mono);font-size:var(--fs-sm);font-weight:700;color:var(--fg-strong);margin-right:6px}
.gr-observed{color:var(--cyan)}
.gr-inferred{color:var(--warn)}
.gr-hypothesis-pending{color:var(--dim)}
/* entity HERO — surface/contrast converged to render-eval-report's .hero/.hero-top
 * (border-strong frame · solid primary left-accent · surf-2 header band) so the
 * subject card reads with the SAME contrast as the eval report's entity hero. */
.entity{border:1px solid var(--border-strong);border-left:3px solid var(--primary);background:var(--surf);padding:14px 16px;margin:10px 0 14px}
.entity-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:-14px -16px 12px;padding:11px 14px;background:var(--surf-2);border-bottom:1px solid var(--border)}
.entity-h .ent-name{font-size:var(--fs-lg);font-weight:700;color:var(--fg-strong)}
.entity-h .ent-src{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
.acc{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 8px;border:1px solid var(--border-strong);text-transform:uppercase;letter-spacing:.04em}
.acc-given{color:var(--pass)}
.acc-recon{color:var(--warn)}
.ec-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:10px}
.ec-c{border:1px solid var(--border);background:var(--surf-2);padding:6px 9px}
.ec-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.ec-v{font-size:var(--fs-xs);color:var(--fg);margin-top:2px;line-height:1.5}
.ec-tools-h,.ec-sp-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--cyan);margin:8px 0 5px}
.tools{display:flex;gap:5px;flex-wrap:wrap}
/* tool-census chips carry a subtle CYAN accent (was flat grey) — mirrors the eval
 * report's accented entity tool-chips; the send-tool gets a stronger PRIMARY emphasis
 * so it stands out as the entity's headline action. */
.tool-chip{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan);border:1px solid var(--cyan);padding:2px 7px;background:rgba(69,184,204,.08)}
.tool-send{color:var(--fg-strong);border-color:var(--primary);background:rgba(126,71,215,.14);font-weight:700}
.sysprompt summary,.raw summary,.dc-q summary,.sp-pre{font-family:var(--mono);font-size:var(--fs-2xs)}
.sysprompt summary{color:var(--muted);cursor:pointer;padding:4px 0}
.sp-pre,.raw-pre,.dc-pre,.pv-crit{white-space:pre-wrap;word-break:break-word}
.sp-pre{color:var(--fg);background:var(--surf-2);border:1px solid var(--border);padding:8px;margin-top:5px;max-height:340px;overflow:auto;font-size:var(--fs-2xs)}
.sat{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
.sat-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.sat-pill{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 8px;border:1px solid var(--border-strong);color:var(--fg)}
.sat-pill.ok{color:var(--pass)}
.sat-pill.bad{color:var(--fail)}
.send-dist{margin:12px 0}
.dist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.dist-col{border:1px solid var(--border);background:var(--surf);padding:9px 11px}
.dist-col-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--primary-soft);margin-bottom:6px}
.dd{display:flex;justify-content:space-between;font-family:var(--mono);font-size:var(--fs-2xs);padding:2px 0;border-bottom:1px solid var(--border)}
.dd-k{color:var(--muted)}
.dd-v{color:var(--fg-strong);font-weight:700}
.hitl-panel{border:1px solid var(--border);border-left:3px solid var(--cyan);background:var(--surf);padding:12px 14px;margin-bottom:16px;position:sticky;top:46px;z-index:10}
.hitl-bar{display:flex;gap:10px;align-items:center;margin:6px 0 8px}
.hitl-count{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
.hitl-copy{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--fg-strong);background:var(--surf-2);border:1px solid var(--border-strong);padding:5px 11px;cursor:pointer}
.hitl-copy:hover{border-color:var(--cyan);color:var(--cyan)}
.hitl-copied{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--pass)}
.hitl-md{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);background:var(--surf-2);border:1px solid var(--border);padding:9px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;margin:0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px}
.card{border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surf);padding:13px 15px}
.card.sev-CRIT{border-left-color:var(--fail)}
.card.sev-HIGH{border-left-color:var(--warn)}
.card.sev-MED{border-left-color:var(--primary-soft)}
.card.sev-LOW{border-left-color:var(--border-strong)}
.card-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:7px}
.card-h .cid{font-family:var(--mono);font-size:var(--fs-sm);font-weight:700;color:var(--fg-strong)}
.sev{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 7px;border:1px solid var(--border-strong)}
.sev-CRIT{color:var(--fail)}
.sev-HIGH{color:var(--warn)}
.sev-MED{color:var(--primary-soft)}
.sev-LOW{color:var(--muted)}
.grounding{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 7px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--border)}
.cmeth{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 7px;border:1px solid var(--border-strong);letter-spacing:.04em}
.cm-deterministic{color:var(--pass)}
.cm-llm-judge{color:var(--primary-soft)}
.cm-hybrid{color:var(--cyan)}
.statement{font-size:var(--fs-sm);color:var(--fg);line-height:1.55;margin:0 0 8px}
.howto{font-size:var(--fs-xs);line-height:1.5;margin:0 0 9px;border:1px solid var(--border);background:var(--surf-2);padding:6px 9px}
.howto-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--cyan);margin-right:5px}
.howto-v{color:var(--fg)}
.meta-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}
.chip{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);border:1px solid var(--border);padding:2px 7px;white-space:nowrap}
.chip .ck{color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-right:4px}
.diffnote{font-family:var(--mono);font-size:var(--fs-2xs);padding:5px 9px;border:1px solid var(--border);background:var(--surf-2);margin-bottom:9px;line-height:1.5}
.diffnote .dn-k{font-weight:700;color:var(--cyan)}
.diffnote .dn-d{font-weight:700;color:var(--fg-strong);text-transform:uppercase;margin:0 5px}
.diffnote .dn-r{color:var(--muted)}
.ce-block{border:1px solid var(--border);border-left:2px solid var(--pass);background:var(--surf-2);padding:7px 10px;margin-bottom:9px}
.ce-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--pass);margin-bottom:4px}
.ce-prim{color:var(--fg-strong)}
.ce-plain{font-size:var(--fs-xs);color:var(--fg);line-height:1.5;margin-bottom:5px}
.ce-params{display:flex;flex-direction:column;gap:3px}
.ce-param{display:grid;grid-template-columns:auto 1fr;gap:8px;font-family:var(--mono);font-size:var(--fs-2xs)}
.ce-k{color:var(--muted)}
.ce-v{color:var(--fg);word-break:break-word}
.ce-missing{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--warn);border:1px dashed var(--warn);padding:6px 9px;margin-bottom:9px;line-height:1.5}
.ev-block,.asm-block{border-top:1px solid var(--border);padding-top:8px;margin-top:8px}
.ev-h,.asm-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--cyan);margin-bottom:6px;line-height:1.5}
.asm-h{color:var(--primary-soft)}
.refs{display:flex;flex-direction:column;gap:4px}
.ref{display:grid;grid-template-columns:auto auto 1fr;gap:8px;font-family:var(--mono);font-size:var(--fs-2xs);align-items:baseline}
.ref .ref-obs{color:var(--cyan);font-weight:600}
.ref .ref-path{color:var(--muted)}
.ref .ref-val{color:var(--fg);white-space:pre-wrap;word-break:break-word}
.refs-na,.asms-na{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);border:1px dashed var(--border-strong);padding:4px 8px}
.asms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.asm{display:flex;gap:7px;align-items:baseline;font-size:var(--fs-xs);line-height:1.5}
.asm-status{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:1px 6px;border:1px solid var(--border);text-transform:uppercase;white-space:nowrap}
.asm-verified{color:var(--pass)}
.asm-unverified{color:var(--warn)}
.asm-hypothesis{color:var(--muted)}
.asm-eliminated{color:var(--dim)}
.asm-kind{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim);text-transform:uppercase}
.asm-text{color:var(--fg)}
.hitl{border-top:1px solid var(--border);margin-top:9px;padding-top:8px}
.hitl-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--warn);margin-bottom:5px}
.hitl-opts{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.hitl-opt{display:inline-flex;gap:5px;align-items:center;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);border:1px solid var(--border-strong);padding:4px 9px;cursor:pointer}
.hitl-opt input{margin:0;cursor:pointer}
.hitl-opt.keep:hover{border-color:var(--pass)}
.hitl-opt.revise:hover{border-color:var(--warn)}
.hitl-opt.retire:hover{border-color:var(--fail)}
.hitl-note{width:100%;box-sizing:border-box;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);background:var(--surf-2);border:1px solid var(--border);padding:6px;resize:vertical}
.raw{margin-top:8px}
.raw summary{color:var(--muted);cursor:pointer;padding:3px 0}
.raw-pre{font-size:var(--fs-2xs);color:var(--fg);background:var(--surf-2);border:1px solid var(--border);padding:8px;margin-top:5px;max-height:300px;overflow:auto}
.pcards,.dcards{display:flex;flex-direction:column;gap:9px}
.pcard{border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surf);padding:9px 12px}
.pcard.res-pass{border-left-color:var(--pass)}
.pcard.res-fail{border-left-color:var(--fail)}
.pc-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:5px}
.pv-mark{font-family:var(--mono);font-size:var(--fs-sm);font-weight:700}
.pcard.res-pass .pv-mark{color:var(--pass)}
.pcard.res-fail .pv-mark{color:var(--fail)}
.pv-tid{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg-strong);font-weight:700}
.pv-res{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;color:var(--muted)}
.pv-conf{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--cyan)}
.pv-crit{font-size:var(--fs-xs);color:var(--fg);line-height:1.55}
.dcard{border:1px solid var(--border);border-left:3px solid var(--primary-soft);background:var(--surf);padding:9px 12px}
.dc-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.dc-id{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--fg-strong)}
.dc-tup{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--fg);border:1px solid var(--border);padding:1px 6px}
.dc-tk{color:var(--muted);margin-right:4px}
.dc-src,.dc-origin{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
/* WS-5 — explicit "why this held-out item is high-value" (the authored judgment)
   + the deterministic selector provenance ("data link"). The why is the headline. */
.dc-why{display:flex;gap:8px;align-items:baseline;margin:2px 0 6px;padding:7px 9px;background:var(--primary-bg,rgba(126,71,215,.08));border-left:3px solid var(--primary)}
.dc-why-k{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--primary-soft);font-weight:700}
.dc-why-v{flex:1 1 auto;font-size:var(--fs-sm);color:var(--fg);line-height:1.5}
.dc-why-pending{background:var(--warn-bg);border-left-color:var(--warn)}
.dc-why-pending .dc-why-k{color:var(--warn)}
.dc-why-pending .dc-why-v{color:var(--muted);font-style:italic}
.dc-prov{display:flex;gap:8px;align-items:baseline;margin:0 0 6px}
.dc-prov-k{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.dc-prov-v{flex:1 1 auto;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);line-height:1.45}
.dc-q summary{color:var(--muted);cursor:pointer}
.dc-pre{font-size:var(--fs-2xs);color:var(--fg);background:var(--surf-2);border:1px solid var(--border);padding:8px;margin-top:5px;max-height:260px;overflow:auto}
.empty{font-family:var(--mono);font-size:var(--fs-sm);color:var(--dim);border:1px dashed var(--border-strong);padding:16px;text-align:center}
/* ── parity upgrade (2026-06-25): per-tab orientation, status-tinted tiles, card provenance, callouts, footer ── */
/* tab-orientation banner — converged to the eval report's .tabdesc (full border +
 * 3px cyan left-accent on a surf-2 surface) for identical contrast. */
.tabdesc{font-family:var(--mono);border:1px solid var(--border);border-left:3px solid var(--cyan);background:var(--surf-2);padding:7px 11px;font-size:var(--fs-xs);color:var(--fg);opacity:.92;line-height:1.5;margin:8px 0 12px}
/* big-stat status-acuity — every tile gets a left-accent base (neutral tiles =
 * border-strong), status tiles tint the FULL frame + left-accent. Byte-for-byte the
 * eval report's .big-stat treatment (render-eval-report REPORT_CSS). */
/* ALIGNMENT FIX: theme.css ships .big-stat as content-sized flex (min-width:96px) →
 * ragged tile widths + drifting heights. Override to an EQUAL-column grid so every
 * tile is the same width AND height (grid row-stretch). Mirrored in render-eval-report. */
.big-stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;align-items:start}
/* margin:0 — neutralize the global .warn/.crit callout utility (theme.css margin:14px 0)
   leaking into the .s.warn status-modifier tile (was dropping that one tile +14px). */
.big-stat .s{min-width:0;min-height:84px;margin:0;display:flex;flex-direction:column;justify-content:center}
.big-stat .s .v{line-height:1.15}
.big-stat .s{border-left:4px solid var(--border-strong)}
.big-stat .s.ok{border-color:var(--pass);border-left-color:var(--pass);background:var(--pass-bg)}
.big-stat .s.ok .v{color:var(--pass)}
.big-stat .s.warn{border-color:var(--warn);border-left-color:var(--warn);background:var(--warn-bg)}
.big-stat .s.warn .v{color:var(--warn)}
.big-stat .s.fail{border-color:var(--fail);border-left-color:var(--fail);background:var(--fail-bg)}
.big-stat .s.fail .v{color:var(--fail)}
.prov-block{border-top:1px solid var(--border);padding-top:8px;margin-top:8px}
.prov-row{display:grid;grid-template-columns:auto 1fr;gap:8px;font-size:var(--fs-xs);line-height:1.5;margin-bottom:4px}
.prov-k{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--primary-soft);white-space:nowrap}
.prov-v{color:var(--fg);word-break:break-word}
.note{border-left:3px solid var(--recommend);background:var(--recommend-bg);padding:7px 11px;margin:14px 0;font-size:var(--fs-xs);line-height:1.55;color:var(--fg)}
.note .tag{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;color:var(--recommend);margin-right:6px}
.foot{margin-top:26px;color:var(--dim);font-size:var(--fs-2xs);border-top:1px solid var(--border);padding-top:12px;font-family:var(--mono);line-height:1.6}
/* ── paged carousel (Criteria tab) — restored from the original render-carousel ── */
.cariar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 14px;padding:7px 11px;border:1px solid var(--border);background:var(--surf-2);position:sticky;top:46px;z-index:9}
.car-btn{font-family:var(--mono);font-size:var(--fs-sm);font-weight:700;color:var(--fg-strong);background:var(--surf);border:1px solid var(--border-strong);padding:3px 11px;cursor:pointer;line-height:1.2}
.car-btn:hover{border-color:var(--cyan);color:var(--cyan)}
.car-count{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted)}
.car-hint{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--dim)}
.car-dots{display:flex;gap:5px;flex-wrap:wrap;margin-left:auto}
.car-dot{width:10px;height:10px;border:1px solid var(--border-strong);background:transparent;cursor:pointer;padding:0}
.car-dot.on{background:var(--primary-soft);border-color:var(--primary-soft)}
.car-dot.dec{border-color:var(--pass);box-shadow:inset 0 0 0 2px var(--pass)}
.cards.carousel-on{display:block}
.cards.carousel-on .card{display:none}
.cards.carousel-on .card.on{display:block;animation:fade .18s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.asm-cal{display:inline-flex;gap:4px;margin-left:8px}
.asm-cal label{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);border:1px solid var(--border);padding:1px 6px;cursor:pointer;display:inline-flex;gap:3px;align-items:center}
.asm-cal label:hover{border-color:var(--cyan);color:var(--cyan)}
.asm-cal input{margin:0;cursor:pointer}
/* ── segmented coverage funnel (native big-number stages, no external renderer) ── */
.funnel2{margin:14px 0}
.fstages{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
.fseg{flex:1 1 110px;border:1px solid var(--border);background:var(--surf-2);padding:10px 12px;text-align:center}
.fseg-v{font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;color:var(--fg-strong);line-height:1.1}
.fseg-l{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-top:3px}
.farrow{display:flex;align-items:center;color:var(--dim);font-size:var(--fs-lg)}
.fpills{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.fpill{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 9px;border:1px solid var(--border-strong);color:var(--fg)}
.fpill.ok{color:var(--pass);border-color:var(--pass)}
.fpill.bad{color:var(--fail);border-color:var(--fail)}
/* ── entity hero — reconstructed from the triage census ── */
.ec-stats{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px}
.ecs{background:var(--surf-2);border:1px solid var(--border);padding:7px 12px;min-width:76px}
.ecs-v{font-family:var(--mono);font-size:var(--fs-lg);font-weight:700;color:var(--fg-strong);line-height:1.1}
.ecs-l{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-top:2px}
.tool-n{color:var(--fg-strong);font-weight:700}
.ec-honesty{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);border-top:1px dashed var(--border-strong);margin-top:9px;padding-top:7px;line-height:1.5}
.ec-honesty b{color:var(--fg)}
/* ── chip legend — parity with render-eval-report's verdictLegend (.vlegend): bordered
 *    surf-2 block · cyan left-accent · ▾ header · key-chip + plain-gloss rows. Chips
 *    reuse the SAME .grounding/.cmeth/.sev classes the cards render (true visual key). ── */
.dlegend{border:1px solid var(--border);border-left:3px solid var(--cyan);background:var(--surf-2);padding:9px 12px;margin:12px 0}
.dlegend .dl-h{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.05em;color:var(--cyan);margin-bottom:7px}
.dlegend .dl-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(252px,1fr));gap:4px 22px}
.dlegend .dl-gh{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:5px 0 3px}
.dlegend .dl-item{display:flex;gap:8px;align-items:baseline;margin:3px 0;line-height:1.4}
.dlegend .dl-item>:first-child{flex:0 0 auto;min-width:80px;text-align:center}
.dlegend .dl-v{font-size:var(--fs-2xs);color:var(--fg);opacity:.9}
.dlegend .dl-k{font-family:var(--mono);font-size:var(--fs-2xs);font-weight:700;padding:2px 7px;border:1px solid;letter-spacing:.04em;text-transform:uppercase}
.dlegend .dl-k.keep{color:var(--pass);border-color:var(--pass)}
.dlegend .dl-k.revise{color:var(--warn);border-color:var(--warn)}
.dlegend .dl-k.retire{color:var(--fail);border-color:var(--fail)}
.dlegend .dl-foot{font-family:var(--mono);font-size:var(--fs-2xs);color:var(--muted);border-top:1px dashed var(--border-strong);margin-top:8px;padding-top:7px;line-height:1.5}
.dlegend .dl-foot .dl-fk{color:var(--primary-soft);text-transform:uppercase;letter-spacing:.04em;margin-right:6px}
/* ── reliability census — send-health roll-ups from triage.totals (status-tinted tiles) ── */
.reliab{margin:12px 0}
.rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.rt{border:1px solid var(--border);border-top:3px solid var(--border-strong);background:var(--surf);padding:9px 11px;margin:0}
.rt-v{font-family:var(--mono);font-size:var(--fs-lg);font-weight:700;color:var(--fg-strong);line-height:1.1}
.rt-l{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-top:3px}
.rt.ok{border-top-color:var(--pass)}.rt.ok .rt-v{color:var(--pass)}
.rt.warn{border-top-color:var(--warn)}.rt.warn .rt-v{color:var(--warn)}
.rt.fail{border-top-color:var(--fail)}.rt.fail .rt-v{color:var(--fail)}
`;

/**
 * Render the full self-contained discover `report.html`. PURE except the brand
 * file reads. DETERMINISTIC (severity-then-id card order; the only varying input
 * is `generatedAt`, masked by mask.ts → byte-identical reruns / C-PIN).
 */
export function renderDiscoverReport(input: DiscoverReportInput): string {
  const theme = readFileSync(join(BRAND_DIR, "theme.css"), "utf8");
  const wordmark = readFileSync(join(BRAND_DIR, "wordmark.html"), "utf8");

  const headerTitle = "evaluator · Discover Report";
  const headerMeta =
    `<span class="mk">subject</span> <span class="mv">${esc(input.subject.name)}</span>` +
    `<span class="sep">·</span><span class="mk">generated</span> <span class="mv">${esc(input.generatedAt)}</span>` +
    (input.batchId ? `<span class="sep">·</span><span class="mk">batch</span> <span class="mv">${esc(input.batchId)}</span>` : "");
  const header = wordmark
    .replaceAll("{{HEADER_TITLE}}", esc(headerTitle))
    .replaceAll("{{HEADER_META}}", headerMeta);

  // criterion meta for the client HITL markdown builder (deterministic).
  const criteriaMeta: Record<string, { severity: string; checkMethod: string; statement: string }> = {};
  for (const c of sortCriteria(input.criteria)) {
    criteriaMeta[c.id] = {
      severity: c.metadata.severity,
      checkMethod: c.metadata.check_method,
      statement: c.statement,
    };
  }

  const nav = `<nav class="tabs">
  <button class="active" data-tab="t1">① Overview</button>
  <button data-tab="t2">② Criteria</button>
  <button data-tab="t3">③ Proof-of-work</button>
  <button data-tab="t4">④ Dataset</button>
</nav>`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(headerTitle)} — ${esc(input.subject.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${theme}
${REPORT_CSS}
</style>
</head>
<body>
${header}
${nav}
<main>
${overviewTab(input)}
${criteriaTab(input)}
${proofTab(input)}
${datasetTab(input)}
<div class="foot">🧬 MutagenT evaluator · *discover · ${esc(input.criteria.length)} criteria · grounded refs{obs,path,value} · typed assumptions · inline HITL keep/revise/retire (persisted in-browser) · pinned judge + temp 0 (C-PIN — byte-identical reruns)</div>
</main>
<script>${clientScript({ subject: input.subject.name, generatedAt: input.generatedAt }, criteriaMeta)}</script>
</body>
</html>
`;
}

// ── CLI entrypoint — the *discover AGGREGATE path drives this post-aggregate ──
//
// Usage: bun scripts/render-discover-report.ts <criteria.json> <out.html> [grounding-check.json] [subjectName]
// Reads the FULL MinedCriterion[] criteria.json + an OPTIONAL grounding-check.json
// and writes the self-contained report.html. Returns the out path. Companion
// artifacts (triage-summary.json, sent-dist.json, verdicts/, dataset-candidates.json)
// are AUTO-DISCOVERED next to criteria.json when present (best-effort, null-tolerant).

declare const Bun: { argv: string[] } | undefined;

export interface WriteDiscoverReportArgs {
  criteriaPath: string;
  outPath: string;
  groundingPath?: string;
  /** OPTIONAL companion artifacts — read when supplied; absent ⇒ degrade gracefully. */
  profilePath?: string;
  triagePath?: string;
  sentDistPath?: string;
  verdictsDir?: string;
  datasetPath?: string;
  subjectName?: string;
  subjectSource?: string;
  generatedAt?: string;
}

export interface DiscoverIo {
  readFile: (p: string) => string;
  writeFile: (p: string, s: string) => void;
  /** OPTIONAL — list a directory (verdicts/). Absent ⇒ the Proof-of-work tab degrades. */
  readDir?: (p: string) => string[];
}

function safeParse<T>(io: DiscoverIo, path: string | undefined): T | null {
  if (path === undefined) return null;
  try {
    return JSON.parse(io.readFile(path)) as T;
  } catch {
    return null;
  }
}

/**
 * Read the criteria (+ optional companions) JSON via injected io, render, and write
 * the report.html to `outPath`. Returns the out path. SHARED by the CLI + the
 * AGGREGATE wiring (`aggregate-discover.ts`). The fs side-effects live HERE;
 * `renderDiscoverReport` stays pure-given-input. Only paths that are SUPPLIED are
 * read (so an injected io exposing just criteria/grounding stays valid).
 */
export function writeDiscoverReportFromFiles(
  args: WriteDiscoverReportArgs,
  io: DiscoverIo,
): string {
  const criteria = JSON.parse(io.readFile(args.criteriaPath)) as MinedCriterion[];
  const grounding = safeParse<GroundingCheckSummary>(io, args.groundingPath);
  const profile = safeParse<DiscoverProfile>(io, args.profilePath);
  const triage = safeParse<TriageSummary>(io, args.triagePath);
  const sentDist = safeParse<SentDistSummary>(io, args.sentDistPath);
  const dataset = safeParse<DatasetCandidate[]>(io, args.datasetPath);

  let verdicts: DeterminerVerdict[] | null = null;
  if (args.verdictsDir !== undefined && io.readDir) {
    try {
      const files = io.readDir(args.verdictsDir).filter((f) => f.endsWith(".verdict.json"));
      verdicts = files
        .map((f) => {
          const traceId = f.replace(/\.verdict\.json$/, "");
          const v = safeParse<Omit<DeterminerVerdict, "traceId">>(io, join(args.verdictsDir as string, f));
          return v ? { traceId, ...v } : null;
        })
        .filter((v): v is DeterminerVerdict => v !== null);
    } catch {
      verdicts = null;
    }
  }

  const html = renderDiscoverReport({
    subject: { name: args.subjectName ?? "discover-subject", ...(args.subjectSource ? { source: args.subjectSource } : {}) },
    criteria: Array.isArray(criteria) ? criteria : [],
    grounding,
    profile,
    triage,
    sentDist,
    verdicts,
    dataset: Array.isArray(dataset) ? dataset : null,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
  });
  io.writeFile(args.outPath, html);
  return args.outPath;
}

/** One per-trace `triage.json` entry (the cheap signals ingest-triage writes). */
interface TriageEntry {
  eventKind?: string;
  nObs?: number;
  sentMessage?: unknown;
  sendSucceeded?: unknown;
  nSends?: number;
  nFailedSends?: number;
  nHardFails?: number;
  recoveryPresent?: boolean;
  hasOutboundGuard?: boolean;
  toolNames?: string[];
}

/**
 * Build the `triage-summary.json` CENSUS (the coverage-funnel + entity source) from the
 * per-trace `triage.json` array. The shipped ingest writes `triage.json` (per-trace
 * signals) but NOT this batch census, so the funnel/deep-read-fails degrade to em-dash
 * unless this is produced. PURE — pure aggregation, no clock/random/network.
 */
export function buildTriageSummary(triage: TriageEntry[], sendTool = "sendMessage"): TriageSummary {
  const inc = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
  const toolCensus: Record<string, number> = {};
  const sentDist: Record<string, number> = {}, sendSucc: Record<string, number> = {}, eventTax: Record<string, number> = {};
  let sends = 0, failedSends = 0, hardFails = 0, recovery = 0, guards = 0, obsTotal = 0;
  for (const t of triage) {
    for (const nm of new Set(t.toolNames ?? [])) inc(toolCensus, nm);
    inc(sentDist, t.sentMessage === true ? "true" : t.sentMessage === false ? "false" : "unknown");
    inc(sendSucc, t.sendSucceeded === true ? "true" : t.sendSucceeded === false ? "false" : "n/a");
    if (t.eventKind) inc(eventTax, t.eventKind);
    sends += t.nSends ?? 0; failedSends += t.nFailedSends ?? 0; hardFails += t.nHardFails ?? 0;
    if (t.recoveryPresent) recovery++; if (t.hasOutboundGuard) guards++; obsTotal += t.nObs ?? 0;
  }
  return {
    total: triage.length,
    sendTool,
    sentDist, sendSucc, eventTax,
    eventTags: Object.keys(eventTax),
    toolCensus: Object.fromEntries(Object.entries(toolCensus).sort((a, b) => b[1] - a[1])),
    sends,
    obsAvg: triage.length ? Math.round((10 * obsTotal) / triage.length) / 10 : 0,
    totals: { sends, failedSends, hardFails, recovery, outboundGuards: guards },
  };
}

/**
 * SHIPPED discover RUN composer — the analogue of run-evaluate's `writeRunReport`.
 * Given a run DIR, ensure `triage-summary.json` exists (built from `triage.json` when
 * absent) then render the FULL report with EVERY companion wired (funnel + Proof-of-work
 * + Dataset + entity profile). This is the CANONICAL render: it GUARANTEES a complete
 * report by default rather than the minimal `writeDiscoverReport` degrade-to-em-dash that
 * a producer-forgot-companions caller hits. Companions absent on disk degrade gracefully
 * (safeParse → null). Use THIS from the *discover flow, not bare `writeDiscoverReport`.
 */
export function writeDiscoverRunReport(
  args: { dir: string; subjectName?: string; subjectSource?: string; generatedAt?: string },
  io: DiscoverIo,
): string {
  const { dir } = args;
  const triageSummaryPath = join(dir, "triage-summary.json");
  // build the census from triage.json when the summary is absent (so the funnel fills).
  let hasSummary = false;
  try { io.readFile(triageSummaryPath); hasSummary = true; } catch { hasSummary = false; }
  if (!hasSummary) {
    try {
      const triage = JSON.parse(io.readFile(join(dir, "triage.json"))) as TriageEntry[];
      if (Array.isArray(triage)) io.writeFile(triageSummaryPath, JSON.stringify(buildTriageSummary(triage), null, 2));
    } catch { /* no triage.json → funnel degrades gracefully */ }
  }
  return writeDiscoverReportFromFiles(
    {
      criteriaPath: join(dir, "criteria.json"),
      outPath: join(dir, "report.html"),
      groundingPath: join(dir, "grounding-check.json"),
      triagePath: triageSummaryPath,
      verdictsDir: join(dir, "verdicts"),
      datasetPath: join(dir, "dataset-candidates.json"),
      profilePath: join(dir, "subject-profile.json"),
      ...(args.subjectName ? { subjectName: args.subjectName } : {}),
      ...(args.subjectSource ? { subjectSource: args.subjectSource } : {}),
      ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
    },
    io,
  );
}

function main(): void {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const [criteriaPath, outPath, groundingPath, subjectName] = argv;
  if (!criteriaPath || !outPath) {
    console.error(
      "usage: render-discover-report.ts <criteria.json> <out.html> [grounding-check.json] [subjectName]",
    );
    process.exit(2);
    return;
  }
  // auto-discover companion artifacts next to criteria.json (best-effort).
  const dir = dirname(criteriaPath);
  const sib = (name: string): string => join(dir, name);
  const exists = (p: string): boolean => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const verdictsDir = (() => {
    try {
      readdirSync(sib("verdicts"));
      return sib("verdicts");
    } catch {
      return undefined;
    }
  })();

  const out = writeDiscoverReportFromFiles(
    {
      criteriaPath,
      outPath,
      ...(groundingPath ? { groundingPath } : exists(sib("grounding-check.json")) ? { groundingPath: sib("grounding-check.json") } : {}),
      ...(exists(sib("subject-profile.json")) ? { profilePath: sib("subject-profile.json") } : {}),
      ...(exists(sib("triage-summary.json")) ? { triagePath: sib("triage-summary.json") } : {}),
      ...(exists(sib("sent-dist.json")) ? { sentDistPath: sib("sent-dist.json") } : {}),
      ...(verdictsDir ? { verdictsDir } : {}),
      ...(exists(sib("dataset-candidates.json")) ? { datasetPath: sib("dataset-candidates.json") } : {}),
      ...(subjectName ? { subjectName } : {}),
    },
    {
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, s) => writeFileSync(p, s),
      readDir: (p) => readdirSync(p),
    },
  );
  console.info(JSON.stringify({ report: out }, null, 2));
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  main();
}
