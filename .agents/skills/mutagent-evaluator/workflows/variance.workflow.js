/**
 * workflows/variance.workflow.js  →  Tab-3 (Variance Trend)
 * ----------------------------------------------------------------------------
 * SELF-CONTAINED port of the variance-deviance-audit workflow (taken IN, not
 * referenced). Audits the SUBJECT for inter-run variance, MECE across
 * SKILL / AGENT / COMMAND scopes, and produces the 15-dim determinism trend.
 *
 * GENERIC + subject-agnostic: the subject path + prior-report are supplied via
 * args. Defaults are SYNTHETIC placeholders — NO production dataset / client is
 * named (design decision #10). The original hardcoded /Users home path + client
 * priors have been scrubbed to synthetic equivalents.
 *
 * COORDINATOR ROLE (executor ≠ reviewer): this workflow is run by the variance
 * coordinator, a role distinct from the audit executors. It obeys C-PIN (the
 * judge is pinned) and the byte-identity masking contract.
 *
 * JUDGE-EXECUTION SEAM: `agent()` / `parallel()` / `phase()` are the workflow-
 * harness DSL; they dispatch the pinned judge. The DETERMINISTIC 15-dim diff
 * itself is also available fully-wired as scripts/variance-compare.ts — this
 * workflow adds the MECE defect catalog + adversarial critique on top. Run via
 * the workflow harness, NOT standalone node.
 */
export const meta = {
  name: 'evaluator-variance',
  description:
    'Reproducible variance audit — MECE SKILL/AGENT/COMMAND defect catalog + 15-dim determinism trend → Tab-3',
  phases: [
    { title: 'Resolve', detail: 'resolve live subject path + prior artifacts at run time' },
    { title: 'Catalog', detail: 'parallel defect catalog per scope vs LIVE source' },
    { title: 'Reconcile', detail: 'MECE dedupe + cross-scope root-cause matrix' },
    { title: 'Critique', detail: 'adversarial completeness — missing variance sources' },
    { title: 'Synthesize', detail: 'assemble + render the Tab-3 fragment (15-dim trend)' },
  ],
}

let cfg = {}
if (args && typeof args === 'object') cfg = args
else if (typeof args === 'string' && args.trim()) { try { cfg = JSON.parse(args) } catch (e) { cfg = {} } }
const MODE = cfg.mode === 'validate' ? 'validate' : 'full'
const LABEL = cfg.label || 'ondemand'

// ── Phase 0 — Resolve live targets (robust to worktree drift) ───────────────
phase('Resolve')
const RESOLVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subjectPath', 'subjectPathOk', 'gitCommit', 'priorReportPath', 'priorReportOk', 'reproducible', 'notes'],
  properties: {
    subjectPath: { type: 'string' }, subjectPathOk: { type: 'boolean' },
    gitCommit: { type: 'string' },
    priorReportPath: { type: 'string' }, priorReportOk: { type: 'boolean' },
    reproducible: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const resolved = await agent(
  `Resolve the LIVE audit targets for the SUBJECT variance audit. Use Bash.\n` +
  `1) subjectPath: ${cfg.subjectPath ? `use "${cfg.subjectPath}"` : 'resolve the subject skill/agent root supplied by the harness'}. Confirm its orchestrator-protocol + a platform normalizer exist (subjectPathOk).\n` +
  `2) gitCommit: \`git -C <subjectPath> rev-parse --short HEAD\` (else "unknown").\n` +
  `3) priorReportPath: ${cfg.priorReport ? `use "${cfg.priorReport}"` : 'newest prior variance report supplied by the harness, if any'}; set priorReportOk.\n` +
  `4) reproducible = subjectPathOk && both key files exist. notes = anything that would make a re-run diverge.\nReturn ONLY the structured result.`,
  { label: 'resolve', phase: 'Resolve', schema: RESOLVE_SCHEMA },
)
log(`Resolve: subject ${resolved.subjectPathOk ? 'OK' : 'MISSING'} @ ${resolved.gitCommit} | prior ${resolved.priorReportOk ? 'found' : 'none'} | reproducible=${resolved.reproducible}`)

if (MODE === 'validate') {
  return {
    mode: 'validate', reproducible: resolved.reproducible,
    subjectPath: resolved.subjectPath, gitCommit: resolved.gitCommit,
    priorReportPath: resolved.priorReportPath, notes: resolved.notes,
    message: resolved.reproducible
      ? 'REPRODUCIBLE — live subject + prior artifacts resolved. Re-run with {mode:"full"} to regenerate the trend.'
      : 'NOT reproducible right now — see notes.',
  }
}
if (!resolved.reproducible) {
  log('Aborting full run — targets not resolvable.')
  return { aborted: true, reason: resolved.notes }
}

const SUBJECT = resolved.subjectPath

// Regression priors are GENERIC variance archetypes (NOT client findings). The
// original client-specific priors have been scrubbed to synthetic determinism
// archetypes so the workflow ships zero NDA content.
const PRIORS = `
PRIOR-RUN ARCHETYPES (re-VERIFY each against LIVE source at ${SUBJECT}; status CONFIRMED/FIXED/CHANGED; then find NEW). Synthetic archetypes, NOT a source of truth — live source wins.
[SKILL] no streaming large-file ingest (OOM risk); handover-contract names-only (no full Finding/Remedy/Assumption JSON-schema); completeness-gate misses the renderer's full deref contract; runMeta/awareness assembly is prose not a script.
[COMMAND] latency-unit heuristic short-circuits before the span guard; ingest can't stream; unguarded sessionId/escapeBadge dereferences in the renderer; sampler weak worst-bucket weighting with overstated confidence.
[AGENT] sample-n + analyzer-count recalled from memory not a rule; runMeta/stamps hand-shaped (wrong field names) → render crashes patched reactively; analyzer prompts boolean-coerced fields + no AssumptionSchema.
[CRITIC] no model/temperature/seed pin (dominant); cwd/timestamp/random unpinned; shared /tmp + existence-only gates (race/stale); no deterministic finding sort; apply-worker unaudited.
`

const DEFECT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scopeSummary', 'defects'],
  properties: {
    scopeSummary: { type: 'string' },
    defects: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id','scope','title','locus','class','expected','observed','varianceMechanism','severity','status','evidence','meceNote','remedy','verification'],
      properties: {
        id: { type: 'string' }, scope: { type: 'string', enum: ['SKILL','AGENT','COMMAND'] },
        title: { type: 'string' }, locus: { type: 'string' },
        class: { type: 'string', enum: ['missing-determinism','code-bug','prose-vs-script-gap','schema-contract-gap','agent-discretion','reactive-improvisation','gate-coverage-gap','capability-gap'] },
        expected: { type: 'string' }, observed: { type: 'string' }, varianceMechanism: { type: 'string' },
        severity: { type: 'string', enum: ['P1','P2','P3'] },
        status: { type: 'string', enum: ['CONFIRMED','FIXED','CHANGED','NEW'] },
        evidence: { type: 'string' }, meceNote: { type: 'string' }, remedy: { type: 'string' }, verification: { type: 'string' },
      } } },
  },
}

phase('Catalog')
const scopes = [
  { key: 'SKILL', brief: "the SUBJECT's DESIGN/SPEC layer: protocol prose, handover-contract, references, templates, config schema, gate COVERAGE, renderer DESIGN, missing scripts. NOT raw code bugs (COMMAND) nor agent judgment (AGENT)." },
  { key: 'AGENT', brief: "the AGENT ACTORS' runtime BEHAVIOR: judgment calls, improvisation, hand-shaping, protocol deviation, reactive fixes. NOT the code bug (COMMAND) nor the missing spec (SKILL)." },
  { key: 'COMMAND', brief: "the COMMANDS/SCRIPTS/CLIs themselves: scripts/*.ts, bash/jq, validators as CODE. CODE BUGS / implementation flaws in a runnable unit. NOT the design gap (SKILL) nor the agent workaround (AGENT)." },
]
const catalogs = await parallel(scopes.map(s => () =>
  agent(
    `You are the ${s.key}-scope auditor for a MECE master audit on INTER-RUN VARIANCE in the SUBJECT (live source at ${SUBJECT}, commit ${resolved.gitCommit}).\nSCOPE: ${s.brief}\n${PRIORS}\nTASK: Read the LIVE source for YOUR scope. Re-verify each prior archetype in your scope vs live source (status CONFIRMED/FIXED/CHANGED), then find NEW defects. Produce a VERBOSE, MUTUALLY-EXCLUSIVE, COLLECTIVELY-EXHAUSTIVE catalog for YOUR scope. Every defect: concrete varianceMechanism + determinism remedy + verification. ids ${s.key}-01.. . Stay strictly in scope; cross-ref via meceNote.`,
    { label: `catalog:${s.key}`, phase: 'Catalog', schema: DEFECT_SCHEMA, agentType: 'Explore' },
  ).then(r => ({ scope: s.key, ...r })),
))
const valid = catalogs.filter(Boolean)
log(`Cataloged ${valid.reduce((n,c)=>n+(c.defects?.length||0),0)} defects across ${valid.length} scopes`)

phase('Reconcile')
const RECON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defects','rootCauseMatrix','meceAttestation','exhaustivenessGaps'],
  properties: {
    defects: { type: 'array', items: { type: 'object' } },
    rootCauseMatrix: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['rootCause','skillDefect','agentDefect','commandDefect','note'], properties: { rootCause:{type:'string'}, skillDefect:{type:'string'}, agentDefect:{type:'string'}, commandDefect:{type:'string'}, note:{type:'string'} } } },
    meceAttestation: { type: 'string' }, exhaustivenessGaps: { type: 'array', items: { type: 'string' } },
  },
}
const reconciled = await agent(
  `MECE reconciliation auditor. 3 scope catalogs:\n${JSON.stringify(valid, null, 2)}\nMerge into ONE master list: every defect in EXACTLY ONE scope (code bug→COMMAND; missing/ambiguous spec→SKILL; agent judgment/improvisation→AGENT). Same root cause may spawn one defect per scope — keep all, link in rootCauseMatrix with honest '—'. Carry each defect's status. Renumber ids. Produce rootCauseMatrix, meceAttestation, exhaustivenessGaps.`,
  { label: 'reconcile', phase: 'Reconcile', schema: RECON_SCHEMA },
)

phase('Critique')
const CRIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['missingDefects','boundaryIssues','verdict'],
  properties: {
    missingDefects: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['scope','title','varianceMechanism','remedy'], properties: { scope:{type:'string'}, title:{type:'string'}, varianceMechanism:{type:'string'}, remedy:{type:'string'} } } },
    boundaryIssues: { type: 'array', items: { type: 'string' } }, verdict: { type: 'string' },
  },
}
const critique = await agent(
  `ADVERSARIAL completeness critic. Goal: minimise inter-run variance. Reconciled set:\n${JSON.stringify(reconciled, null, 2)}\nFind MISSING variance/deviance: LLM non-determinism (temperature/model drift/seed), environment (cwd/clock/file-order), analyzer parallelism races, prompt-cache effects, sampling determinism, silent gate bypasses, partial-failure recovery, apply-worker path, scope-boundary violations. Be skeptical + specific.`,
  { label: 'critique', phase: 'Critique', schema: CRIT_SCHEMA },
)

phase('Synthesize')
// Render the Tab-3 fragment using the EVALUATOR's own brand. The 15-dim trend is
// the byte-identity scorecard (scripts/variance-compare.ts is the deterministic
// engine for the diff; this workflow adds the MECE catalog narrative). NDA: NO
// client identity in the rendered output.
const synth = await agent(
  `Render the Tab-3 (Variance Trend) HTML fragment for the master-audit report. Use the EVALUATOR brand (dark theme + MUTAGENT tokens). NO client identity (synthetic names only). Run label: ${LABEL}; subject commit: ${resolved.gitCommit}.\n` +
  `INPUTS — reconciled:\n${JSON.stringify(reconciled, null, 2)}\nCritique (FOLD IN):\n${JSON.stringify(critique, null, 2)}\n` +
  `The fragment MUST contain: (1) a header "Variance Trend — Track-2" + the variance thesis + top-3 determinism controls; (2) the fixed 15-dimension determinism scorecard table (dimension · measure · target · divergence) — mark not-evaluated where the run-pair lacked the input; (3) the MECE SKILL/AGENT/COMMAND defect table; (4) the cross-scope root-cause matrix; (5) a Determinism Control Plan (controls grouped, mapped to defects). After writing, reply with: section count + defect count + path.`,
  { label: 'synthesize:tab3', phase: 'Synthesize' },
)
return { label: LABEL, gitCommit: resolved.gitCommit, defectCount: (reconciled.defects||[]).length, gaps: (critique.missingDefects||[]).length, synth }
