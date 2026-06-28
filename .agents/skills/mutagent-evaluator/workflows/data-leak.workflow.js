/**
 * workflows/data-leak.workflow.js  →  Tab-2 (Data-Leak)
 * ----------------------------------------------------------------------------
 * SELF-CONTAINED port of the mdiag-master-audit workflow (taken IN, not
 * referenced). Audits a run-bundle for OPERATIONAL / CONTRACT-BOUNDARY +
 * UI/render + DATA-CORRECTNESS leaks — data a component produces that the next
 * component's contract drops, OR a renderer slot with no producer.
 *
 * GENERIC + subject-agnostic: every subject-specific path is supplied via args
 * (subjectRoot · bundleDirs · styleRef). Defaults are SYNTHETIC (sample-agent /
 * sample-email-agent / sample-tenant) — NO production dataset is named (design
 * decision #10). The original client identities (and any /Users home paths) have
 * been scrubbed.
 *
 * JUDGE-EXECUTION SEAM: the `agent(...)` / `parallel(...)` / `phase(...)` calls
 * are the workflow-harness DSL (Workflow({scriptPath})). They dispatch the
 * pinned judge. This file is the deterministic harness around those seams; the
 * judge does the reading. Run via the workflow harness, NOT standalone node.
 */
export const meta = {
  name: 'evaluator-data-leak',
  description:
    'Self-contained data-leak audit of a run-bundle + agent context-flow (operational/contract-boundary · UI/render · data-correctness+signal-selection · context-flow EV-028/029) → Tab-2 graph',
  phases: [
    { title: 'Audit dimensions', detail: 'parallel: operational/contract-boundary · UI/render · data-correctness+signal-selection · context-flow (EV-028/029)' },
    { title: 'Synthesize', detail: 'merge leaks → master list + Tab-2 HTML fragment' },
  ],
}

// ── Params: synthetic defaults, overridable via args ──────────────────────────
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}

// SUBJECT root + the run-bundle(s) under audit — supplied by the harness. The
// defaults are SYNTHETIC placeholders, never a real client path.
const SUBJECT = A.subjectRoot || '<subject-skill-root>'
const REPORTS = A.bundleDirs || ['<run-bundle-dir>']
const OUT = A.outDir || '<audit-out-dir>'
const STYLEREF = A.styleRef || '<brand-style-ref>'   // evaluator's own assets/brand/theme.css
const GEN = A.generatedAt || '1970-01-01T00:00:00Z'  // injected; masked for byte-identity

// ── Agent context-flow inputs (EV-028/029) — SUBJECT-AGNOSTIC, supplied ──────
// The deterministic flow-graph(s) (EV-032) + expected-flow (EV-037) the
// context-flow dimension reasons over. `contextFlowCandidates` is the
// deterministic PREP bundle (scripts/flow-graph.ts: unthreaded outputs = EV-028
// candidates · lossy handoffs = EV-029 candidates) the judge ADJUDICATES. All
// names come from these structures — NEVER a subject constant in the prompt.
const FLOWGRAPHS = A.flowGraphs || []                 // EV-032 graphs for the audited traces
const EXPECTEDFLOW = A.expectedFlow || { dispatchToolNames: [], edges: [], expectedUiSlots: [] }
const CFCANDIDATES = A.contextFlowCandidates || []    // per-trace contextFlowCandidates output
const CFLENS = A.contextFlowLens || '<context-flow-lens-ref>'  // lenses/context-flow-lens.md
// Profile-supplied expected-UI-slot list (EV-039/040) — de-hardcodes the
// diagnostics-specific renderer slots into a subject-agnostic list.
const UISLOTS = (EXPECTEDFLOW.expectedUiSlots && EXPECTEDFLOW.expectedUiSlots.length)
  ? EXPECTEDFLOW.expectedUiSlots
  : (A.expectedUiSlots || [])
// Deterministic EV-039 audit (scripts/ui-slots.ts auditUiSlots) per bundle:
// { computedNotRendered, orphanSlots, findings } — the HTML-artifact missing-data
// case made first-class. The judge ADJUDICATES these + the EV-040 faithfulness.
const UISLOTAUDIT = A.uiSlotAudit || []

const LEAK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    summary: { type: 'string' },
    leaks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'short id e.g. OP-1 / UI-2 / DC-3' },
          title: { type: 'string' },
          locus: { type: 'string', enum: ['C2C', 'UI'], description: 'C2C=lost between components; UI=produced but not drawn' },
          cls: { type: 'string', enum: ['A', 'B'], description: 'A=contract too narrow; B=producer not run/threaded' },
          producer: { type: 'string', description: 'the component/script that should emit it' },
          whyNotProduced: { type: 'string' },
          formalStructure: { type: 'string', enum: ['none', 'partial', 'exists'], description: 'is a schema/contract defined for this handoff?' },
          severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
          whatsLost: { type: 'string' },
          evidence: { type: 'string', description: 'file:line or command output proving it' },
        },
        required: ['id', 'title', 'locus', 'cls', 'producer', 'whyNotProduced', 'formalStructure', 'severity', 'whatsLost', 'evidence'],
      },
    },
  },
  required: ['dimension', 'summary', 'leaks'],
}

phase('Audit dimensions')

const REPLIST = REPORTS.join(' , ')

// The three audit dimensions. Prompts are GENERIC: they reference the SUBJECT
// root + the run-bundle(s) supplied in args, and name only the canonical
// pipeline stages (normalize → tier0 → slice → sample → enrich → render) and the
// well-known artifact shapes — never a client-specific path or dataset.
const DIMS = [
  {
    key: 'operational',
    prompt: `You are auditing the SUBJECT skill (root: ${SUBJECT}) for OPERATIONAL / CONTRACT-BOUNDARY data leaks — data a component produces that the next component's contract drops, OR a renderer slot with no producer. READ-ONLY (grep/read; never edit).

Run these concrete checks and emit ONE leak per real finding (ground each in an actual grep/read — no speculation). SUBJECT-AGNOSTIC: where a check names slots, use the PROFILE-SUPPLIED expected-UI-slot list below, NOT any hardcoded name. Checks 2-6 apply when the SUBJECT is a data-pipeline (skip the ones that don't map to this subject's shape).

EXPECTED-UI-SLOTS (EV-037, profile-supplied):
${JSON.stringify(UISLOTS, null, 2)}

1. For EACH expected-UI-slot the renderer dereferences, grep the orchestrator protocol + scripts for a step that PRODUCES/threads it. If none → leak (cls B, locus UI, formalStructure exists).
2. Read the Finding/Remedy/Assumption interfaces — are required fields (rationale/whyWorks/applyTarget/applyInstructions/assumptions) OPTIONAL? If yes → leak (cls A, formalStructure partial).
3. Is there a findings-contract / required-field validator? If absent → leak (cls B, formalStructure none — the enabler).
4. grep the enricher for the fail-loud threshold ('missing.length >= N'). If N>=3 → single-section silent-drop leak (cite the line).
5. grep the platform normalizer for an 'import.meta.main' CLI entrypoint. If absent → the extractor has no CLI transport → leak.
6. Read the signal-census builder — does it rank candidate signals by frequency only (severity unused)? If yes → signal-selection leak.

Return the LEAK_SCHEMA object with dimension="operational".`,
  },
  {
    key: 'ui-render',
    prompt: `You are auditing the GENERATED HTML artifact(s) in the run-bundle(s) for UI/render data-leaks — the operator's FIRST-CLASS "HTML-artifact missing-data" case: a value the agent COMPUTED that is ABSENT from the HTML it produced is a missing-data leak. Bundle dirs: ${REPLIST}. READ-ONLY. SUBJECT-AGNOSTIC — the slots to check come from the PROFILE-SUPPLIED expected-UI-slot list, NOT any hardcoded slot name.

EXPECTED-UI-SLOTS (EV-037, profile-supplied — the slots the subject's HTML SHOULD render):
${JSON.stringify(UISLOTS, null, 2)}

DETERMINISTIC EV-039 AUDIT (scripts/ui-slots.ts auditUiSlots, per bundle — { computedNotRendered, orphanSlots, findings }). ADJUDICATE these (they are CANDIDATES; confirm + severity):
${JSON.stringify(UISLOTAUDIT, null, 2)}

Checks (ground EACH in a read of the artifact — emit one leak per real finding):
1. computed-but-not-rendered (EV-039): for each slot in computedNotRendered (and any expected-UI-slot you can confirm was computed in the trace/runMeta/intermediate output yet does NOT appear in the HTML) → leak (locus UI, cls B, formalStructure=exists). This is the operator's exact case.
2. orphan slot (EV-039): for each slot in orphanSlots (the HTML references the slot but NO producer computed it) → drawn-but-empty leak (locus UI).
3. render defect: grep each report HTML for an inline-JS split-regex with a raw CR byte inside the literal — that SyntaxError kills the copy/clipboard export → leak (HIGH).
HTML-ONLY PATH (first-class, no longer a mere fallback): if a <dir> has the published HTML but NO intermediate render-input file, audit the RENDERED values directly — read the HTML's drawn values for each expected-UI-slot. Note in evidence that you audited the published HTML.

Return LEAK_SCHEMA with dimension="ui-render".`,
  },
  {
    key: 'data-correctness',
    prompt: `You are auditing DATA-CORRECTNESS — rendered-value FAITHFULNESS (EV-040): for ANY subject's HTML artifact, is a value present in BOTH the computed data AND the rendered HTML the SAME value, or was it ALTERED / TRUNCATED / re-derived in the UI? Primary bundle dir: ${REPORTS[0]}. READ-ONLY. SUBJECT-AGNOSTIC — spot-check the PROFILE-SUPPLIED expected-UI-slots, NOT hardcoded slot names.

EXPECTED-UI-SLOTS (EV-037, profile-supplied):
${JSON.stringify(UISLOTS, null, 2)}

DETERMINISTIC EV-039 AUDIT (auditUiSlots — `faithful` findings already mean computed==rendered verbatim; focus your judgment on the NUANCED EV-040 cases the deterministic check can't settle — truncation, rounding, unit-swap, re-derivation):
${JSON.stringify(UISLOTAUDIT, null, 2)}

Checks (ground EACH in a read of the computed source + the rendered artifact):
1. Faithfulness (EV-040): for each expected-UI-slot present in BOTH the computed data (trace/runMeta/intermediate) AND the HTML, compare the two values VERBATIM. Identical → note faithful (NO leak). Altered / truncated / rounded / re-derived ad hoc instead of threaded from the script-of-record → leak (locus UI).
2. Scope-skew: if a rendered aggregate (a count/rate/average) is computed over a small worst-N slice but presented as whole-population → scope-skew leak (cite the slice size vs the population).
3. Silent drop: a computed value that is null/absent in the HTML while the rest of the artifact implies it should be present → entity/section silent-drop leak.
HTML-ONLY PATH (first-class): if no intermediate computed file exists, audit faithfulness from the published HTML + any run stamps directly; note you audited the rendered values.

Return LEAK_SCHEMA with dimension="data-correctness".`,
  },
  {
    key: 'context-flow',
    prompt: `You are auditing the SUBJECT agent's CONTEXT-FLOW (EV-028 tool-result threading + EV-029 sub-agent handoff completeness). Score over the DETERMINISTIC flow-graph (EV-032) + expected-flow (EV-037) supplied below — NOT a raw trace. Follow the context-flow lens at ${CFLENS} (read it). READ-ONLY. SUBJECT-AGNOSTIC: every tool/slot name comes from these structures — invent none.

The flow-graph generalizes the v1 data-pipeline leak SHAPE to an AGENT: an unthreaded tool result is the agent analogue of a runMeta slot a renderer dereferences with no producer; a lossy sub-agent handoff is the analogue of a contract field dropped at a component boundary.

Adjudicate the CANDIDATES (these are candidates — decide which are TRUE leaks + severity; a fully-threaded, expectation-meeting graph yields ZERO leaks):
1. EV-028 — for each candidate in contextFlowCandidates[].unthreadedOutputs {node,name,slot}: was the dropped producer slot one a later step NEEDED (and silently re-derived / proceeded without)? → leak (locus C2C, cls B). A legitimate side-effect/log with no consumer → NOT a leak.
2. EV-029 — for each contextFlowCandidates[].lossyHandoffs {fromTool,toTool,slot?}: confirm the expected producer→consumer threading is genuinely absent in flowGraph.edges (not merely renamed). An incomplete dispatch brief that handed a child stale/missing context → leak (locus C2C, cls B). Cite the dispatch node + missing slot.
Severity HIGH when the dropped/incomplete context changed the agent's action; ground EVERY leak in flow-graph node ids + slot names (evidence field).

EXPECTED-FLOW (EV-037):
${JSON.stringify(EXPECTEDFLOW, null, 2)}

FLOW-GRAPHS (EV-032, one per audited trace):
${JSON.stringify(FLOWGRAPHS, null, 2)}

DETERMINISTIC CANDIDATES (per trace):
${JSON.stringify(CFCANDIDATES, null, 2)}

Return LEAK_SCHEMA with dimension="context-flow".`,
  },
]

const dimResultsRaw = await parallel(
  DIMS.map((d) => () => agent(d.prompt, { label: `audit:${d.key}`, phase: 'Audit dimensions', schema: LEAK_SCHEMA })),
)
const dimResults = (dimResultsRaw || []).filter(Boolean)

const allLeaks = dimResults.flatMap((r) => (r.leaks || []).map((l) => ({ ...l, dimension: r.dimension })))
log(`collected ${allLeaks.length} leaks across ${dimResults.length} dimensions`)

// ── Metrics (deterministic — human-level observability) ──
const tally = (key) => allLeaks.reduce((m, l) => ((m[l[key]] = (m[l[key]] || 0) + 1), m), {})
const metrics = {
  totalLeaks: allLeaks.length,
  dimensions: dimResults.length,
  bySeverity: tally('severity'),
  byLocus: tally('locus'),
  byClass: tally('cls'),
  byFormalStructure: tally('formalStructure'),
  byDimension: tally('dimension'),
}

phase('Synthesize')

const merged = JSON.stringify({ generatedAt: GEN, dimensions: dimResults.map((r) => ({ dimension: r.dimension, summary: r.summary })), leaks: allLeaks }, null, 2)
const metricsJson = JSON.stringify(metrics, null, 2)

// The synthesizer renders the Tab-2 fragment using the EVALUATOR's own brand
// (assets/brand/theme.css — supplied as STYLEREF). NDA: NO client name in the
// rendered output. The fragment is a <section> the audit.workflow.js inlines.
const synth = await agent(
  `Render the Tab-2 (Data-Leak) HTML fragment for the master-audit report. Use the EVALUATOR brand stylesheet at ${STYLEREF} (dark theme + MUTAGENT tokens) — do NOT invent new styling. NO client identity in the output (synthetic names only).

WRITE the fragment to ${OUT}/tab2-data-leak.html. It MUST contain, populated from THIS run's data:
 1. A section header "Data-Leak Graph" + a one-line verdict on the headline leaks.
 2. A METRICS row of stat tiles (.big-stat) using the EXACT numbers from the metrics JSON (total leaks, HIGH/MED/LOW, C2C/UI, by dimension).
 3. A bird's-eye PIPELINE SPINE (raw → normalize → tier0 → slicer → wave6 → analyzer → aggregate → validator → enrich → render) with each leak as a RED-DASHED leaf off its producing stage.
 4. The master leak table — columns: ID · Dimension · Locus(C2C/UI) · Producer · Why not produced · Formal structure · What's lost · Sev. One row per leak.
 5. A per-dimension detail subsection — ONE subsection per dimension actually present in the merged leak JSON (operational · ui-render · data-correctness · context-flow · any others) — listing each leak with file:line (or flow-graph node:slot) evidence + proposed fix.

METRICS JSON (use exact numbers):
${metricsJson}

MERGED LEAK JSON:
${merged}

Return JSON: { written, leakCount, sections }.`,
  {
    label: 'synthesize:tab2',
    phase: 'Synthesize',
    schema: {
      type: 'object', additionalProperties: false,
      properties: { written: { type: 'string' }, leakCount: { type: 'number' }, sections: { type: 'number' } },
      required: ['written', 'leakCount', 'sections'],
    },
  },
)

return { dimensions: dimResults.length, totalLeaks: allLeaks.length, metrics, synth }
