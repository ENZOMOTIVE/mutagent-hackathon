/**
 * workflows/audit.workflow.js  →  the 4-tab master-audit harness (Mode A)
 * ----------------------------------------------------------------------------
 * The harness COMPOSES the workflows the evaluator already ships — it does not
 * rebuild what exists. It:
 *   1. runs the DETERMINISTIC spine (scripts/cli/audit-run.ts) to produce the
 *      Tab-1 deterministic rows + the two-track scorecard + the base report;
 *   2. dispatches the PINNED JUDGE over the Tab-1 judge rows (decision / data /
 *      trajectory lenses) against the subject behavior-tree;
 *   3. composes Tab-2 via data-leak.workflow.js (self-contained);
 *   4. composes Tab-3 via variance.workflow.js (self-contained);
 *   5. composes Tab-4 via the methodology-critic lens;
 *   6. stamps the final 4-tab HTML from the EVALUATOR's own brand asset.
 *
 * GENERIC: every subject-specific input is supplied via args (subject · runId ·
 * bundleDir). Defaults are SYNTHETIC. NO production dataset is named.
 *
 * JUDGE-EXECUTION SEAM: the `agent()` calls dispatch the pinned judge. The
 * deterministic spine (step 1) is fully wired and runnable standalone via
 * `audit-run.ts`; the judge tabs are the documented seams. Run via the workflow
 * harness, NOT standalone node.
 */
export const meta = {
  name: 'evaluator-audit',
  description: 'Compose the 4-tab master-audit (eval-matrix · data-leak · variance · methodology) from a subject profile + run-bundle',
  phases: [
    { title: 'Deterministic spine', detail: 'audit-run.ts → Tab-1 deterministic rows + two-track scorecard' },
    { title: 'Judge rows', detail: 'pinned judge over Tab-1 trace-cross-ref / trajectory-diff rows' },
    { title: 'Compose tabs', detail: 'data-leak (Tab-2) · variance (Tab-3) · methodology (Tab-4)' },
    { title: 'Render', detail: 'stamp the 4-tab HTML from the evaluator brand' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}

const SUBJECT = A.subject || 'sample-agent'
const RUN_ID = A.runId || '<run-id>'
const BUNDLE_DIR = A.bundleDir || '<run-bundle-dir>'
const PKG = A.pkgRoot || '.'          // the evaluator package root
const GEN = A.generatedAt || '1970-01-01T00:00:00.000Z'
const STYLEREF = `${PKG}/assets/brand/theme.css`

// ── Phase 1 — deterministic spine (fully wired script) ──────────────────────
phase('Deterministic spine')
const spine = await agent(
  `Run the DETERMINISTIC spine for the master audit. Use Bash:\n` +
  `  bash ${PKG}/scripts/cli/run.sh ${PKG}/scripts/cli/audit-run.ts ${RUN_ID} --subject ${SUBJECT} --bundle-dir ${BUNDLE_DIR} --subjects-root ${PKG}/subjects --generated-at ${GEN}\n` +
  `This writes <bundle>/audit/scorecard.json (two-track GATE+TREND) + <bundle>/audit/master-audit.html (the base report). Return the parsed JSON the script prints (subject, runId, criteria, deterministicRows, judgeRows, gateRunPass, scorecard, report).`,
  { label: 'spine:audit-run', phase: 'Deterministic spine' },
)
log(`spine: ${spine && spine.criteria} criteria, ${spine && spine.deterministicRows} deterministic + ${spine && spine.judgeRows} judge rows; gateRunPass=${spine && spine.gateRunPass}`)

// ── Phase 2 — pinned judge over the Tab-1 judge rows ────────────────────────
phase('Judge rows')
const judge = await agent(
  `PINNED JUDGE (model id + temperature=0, recorded; mask output). Read ${PKG}/subjects/${SUBJECT}/behavior-tree.yaml and the run-bundle at ${BUNDLE_DIR}. For each Tab-1 judge row (checkMethod trace-cross-ref or trajectory-diff in ${PKG}/subjects/${SUBJECT}/eval-matrix.yaml), apply the matching lens:\n` +
  `  - decision rows → ${PKG}/lenses/decision-lens.md\n` +
  `  - data rows     → ${PKG}/lenses/data-lens.md\n` +
  `  - trajectory rows → ${PKG}/lenses/trajectory-lens.md\n` +
  `Compare expected-decision vs observed-decision at each behavior-tree node. Emit one masked verdict per row (pass/fail + evidence + rationale). NEVER fabricate — an unobservable decision is a fail, not a pass.`,
  { label: 'judge:tab1', phase: 'Judge rows' },
)

// ── Phase 3 — compose Tab-2, Tab-3, Tab-4 ──────────────────────────────────
phase('Compose tabs')
const tab2 = await workflow({ scriptPath: `${PKG}/workflows/data-leak.workflow.js`, args: { subjectRoot: A.subjectRoot, bundleDirs: [BUNDLE_DIR], outDir: `${BUNDLE_DIR}/audit`, styleRef: STYLEREF, generatedAt: GEN } })
const tab3 = await workflow({ scriptPath: `${PKG}/workflows/variance.workflow.js`, args: { subjectPath: A.subjectRoot, label: RUN_ID, mode: A.varianceMode || 'full' } })
const tab4 = await agent(
  `Tab-4 methodology critic (ADVISORY, not pass/fail; pinned + masked). Run ${PKG}/lenses/methodology-critic-lens.md over: ${PKG}/subjects/${SUBJECT}/behavior-tree.yaml + ${PKG}/subjects/${SUBJECT}/methodology-review.yaml + the run trajectory at ${BUNDLE_DIR}. Emit ranked process self-feedback (MR-1..9). Write the Tab-4 HTML fragment to ${BUNDLE_DIR}/audit/tab4-methodology.html using the evaluator brand (${STYLEREF}). Return { written, mrFindings }.`,
  { label: 'compose:tab4', phase: 'Compose tabs' },
)

// ── Phase 4 — final render (inline the tab fragments into the base report) ──
phase('Render')
const render = await agent(
  `Stamp the FINAL 4-tab master-audit HTML. Use Bash to read the base report at ${spine && spine.report}, inline the three composed fragments (${BUNDLE_DIR}/audit/tab2-data-leak.html, the Tab-3 fragment from the variance workflow, ${BUNDLE_DIR}/audit/tab4-methodology.html) into panels t2/t3/t4, and overwrite ${spine && spine.report}. The brand (dark theme + MUTAGENT wordmark) comes from ${PKG}/assets/brand/theme.css — already embedded by the base renderer. Verify: 4 tab buttons, every panel non-empty, NO client identity in the output. Return { report, tabs: 4, ok }.`,
  { label: 'render:final', phase: 'Render' },
)

return { subject: SUBJECT, runId: RUN_ID, spine, judge, tab2, tab3, tab4, render }
