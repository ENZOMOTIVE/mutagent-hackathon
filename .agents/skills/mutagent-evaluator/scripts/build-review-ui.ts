/**
 * scripts/build-review-ui.ts — EV-045 `*review` annotation-UI renderer (Type A — DATA/template only).
 * ---------------------------------------------------------------------------
 * The Code-only half of the `*review` Hybrid (operation-inventory): a
 * DETERMINISTIC HTML template (like `render-report.ts`) that emits a
 * browser-based human-annotation interface + a labels-persistence merge. The
 * HITL half — a human clicking Pass/Fail/Defer in the browser — is the LLM-only
 * piece (`references/build-review-interface.md`).
 *
 * What it produces (build-review-interface.md):
 *   - one trace per screen, rendered in human-readable native form (escaped +
 *     collapsible), full trace accessible, color-coded by role;
 *   - binary Pass/Fail + a Defer button + a free-text notes field;
 *   - keyboard shortcuts (arrows · 1/2/D · U · Cmd+S · Cmd+Enter);
 *   - auto-save on every action (localStorage) + a labels export;
 *   - a trace counter + jump-to-id + labeled/unlabeled counts.
 *
 * Austerity: holds NO judge prompt, makes NO pass/fail decision (the HUMAN
 * decides). DETERMINISTIC: `renderReviewUi(traces, opts)` is byte-identical for
 * the same input — NO clock / random / network in the generator. The browser
 * stamps `labeledAt` at save time; the deterministic `mergeLabels` only
 * round-trips + dedups by traceId. Labels validate against `HumanLabel`
 * (`contracts/validation.ts`) → consumed by `*validate`.
 *
 * Subject-agnostic (EV-002): the subject name + any badges come from the caller
 * (the subject profile), never hard-coded.
 */
import type {
  DiscoveryAssumption,
  DiscoveryRef,
  EvalTrace,
  OutcomeVerdictValue,
  TraceObservation,
  VerdictBlock,
} from "./contracts/eval-types.ts";
import { type HumanLabel } from "./contracts/validation.ts";

/**
 * GA — the judge's adjudication for ONE trace, surfaced on the review screen so
 * the human can see WHY the judge decided/abstained and feed the calibration
 * loop (verify / eliminate the surfaced assumption). A compact projection of the
 * folded `CriterionVerdict` — refs / assumptions / blockedBy carried with NO drop.
 */
export interface ReviewAdjudication {
  criterionId: string;
  result: OutcomeVerdictValue;
  critique?: string;
  refs?: DiscoveryRef[];
  assumptions?: DiscoveryAssumption[];
  blockedBy?: VerdictBlock;
}

// ── HTML escape (sanitize rendered content — no raw LLM HTML reaches the DOM) ─
/** Escape into HTML text. Null-guarded (never throws on undefined). */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ReviewUiOptions {
  /** subject display name for the header badge (from the subject profile). */
  subjectName?: string;
  /** page title (defaults to a subject-agnostic label). */
  title?: string;
  /**
   * GA — the judge's adjudication per traceId (refs · assumptions · blockedBy ·
   * result). When present, each trace card surfaces the GA panel + verify/
   * eliminate capture. OPTIONAL — absent ⇒ the legacy label-only review screen.
   */
  adjudications?: Record<string, ReviewAdjudication>;
}

// ── per-trace native-format render (server-side, deterministic) ──────────────

/** Pretty-print an observation's payload as escaped, collapsible JSON. */
function renderObservation(o: TraceObservation, i: number): string {
  const kind = o.type === "TOOL" ? "tool" : esc(o.type);
  const name = esc(o.name ?? o.type);
  const payload = (() => {
    try {
      return esc(JSON.stringify({ input: o.input, output: o.output }, null, 2));
    } catch {
      return esc(String(o.output ?? ""));
    }
  })();
  return (
    `<details class="obs obs-${kind}">` +
    `<summary><span class="obs-idx">#${i + 1}</span> <code>${name}</code></summary>` +
    `<pre class="obs-body">${payload}</pre>` +
    `</details>`
  );
}

/** GA — render the judge's adjudication panel + verify/eliminate calibration
 *  capture for one trace. Surfaces refs · assumptions · blockedBy. */
function renderAdjudicationPanel(adj: ReviewAdjudication): string {
  const resultLabel = adj.result === "uncertain" ? "indeterminate" : adj.result;
  const refs =
    adj.refs && adj.refs.length > 0
      ? `<div class="ga-row"><span class="ga-k">refs</span> <code>${esc(
          adj.refs.map((r) => `${r.obs}${r.path ? "/" + r.path : ""}: "${r.value}"`).join(" · "),
        )}</code></div>`
      : "";
  const blockedBy =
    adj.blockedBy !== undefined
      ? `<div class="ga-row"><span class="ga-k">blocked by</span> <span class="badge meta">${esc(
          adj.blockedBy.kind,
        )}</span> ${esc(adj.blockedBy.text)}</div>`
      : "";
  // each surfaced assumption gets verify / eliminate calibration buttons.
  const assumptions =
    adj.assumptions && adj.assumptions.length > 0
      ? `<div class="ga-row"><span class="ga-k">assumptions</span><ul class="ga-assumptions">` +
        adj.assumptions
          .map(
            (a, ai) =>
              `<li>${esc(a.text)} <span class="badge meta">${esc(a.status)}</span>${
                a.kind !== undefined ? ` <span class="badge meta">${esc(a.kind)}</span>` : ""
              } ` +
              `<button class="calib verify" data-ai="${ai}" data-action="verify">Verify ✓</button> ` +
              `<button class="calib eliminate" data-ai="${ai}" data-action="eliminate">Eliminate ✗</button></li>`,
          )
          .join("") +
        `</ul></div>`
      : "";
  return (
    `<div class="ga-panel" data-criterion="${esc(adj.criterionId)}">` +
    `<div class="ga-head">judge adjudication: <span class="badge verdict-${esc(resultLabel)}">${esc(
      resultLabel,
    )}</span> <code>${esc(adj.criterionId)}</code></div>` +
    (adj.critique ? `<div class="ga-row"><span class="ga-k">critique</span> ${esc(adj.critique)}</div>` : "") +
    refs +
    assumptions +
    blockedBy +
    `</div>`
  );
}

/**
 * Render one trace as a card (native format: escaped text, collapsible tool
 * observations, color-coded role borders, full trace accessible). All cards are
 * emitted; the client shows exactly one at a time. When a GA adjudication is
 * supplied for the trace, the judge panel + verify/eliminate capture is surfaced.
 */
function renderTraceCard(
  trace: EvalTrace,
  index: number,
  subjectName: string,
  adj?: ReviewAdjudication,
): string {
  const prompt = esc(trace.input?.prompt ?? "");
  const response = esc(trace.output?.response ?? "");
  const obs = trace.observations.map(renderObservation).join("");
  const toolCount = trace.observations.filter((o) => o.type === "TOOL").length;
  const panel = adj !== undefined ? renderAdjudicationPanel(adj) : "";
  return (
    `<section class="trace-card" data-index="${index}" data-trace-id="${esc(trace.id)}" hidden>` +
    `<div class="card-head">` +
    `<span class="badge subject">${esc(subjectName)}</span>` +
    `<span class="badge tid">${esc(trace.id)}</span>` +
    `<span class="badge meta">${toolCount} tool call(s)</span>` +
    `</div>` +
    `<div class="role role-user"><h4>Input</h4><pre>${prompt}</pre></div>` +
    `<div class="role role-tool"><h4>Trace (${trace.observations.length} step(s))</h4>${obs || "<em>no observations</em>"}</div>` +
    `<div class="role role-assistant"><h4>Output</h4><pre>${response}</pre></div>` +
    panel +
    `</section>`
  );
}

// ── the deterministic HTML document ──────────────────────────────────────────

// Brand: the unified MutagenT design-system — SHARP corners (radius 0), SUBTLE
// non-black surfaces (purple is an ACCENT only), TONED status, NO glow. Tokens
// mirror @mutagent/templates/design-system/tokens.css (self-contained inline copy;
// the review UI is a standalone HTML doc with no bundled brand-asset read).
const STYLE = `
:root{--bg:#0a0a12;--surf:#14141d;--surf-2:#1a1a25;--fg:#d6dbe6;--fg-strong:#eef1f6;--mut:#8a8698;--bd:rgba(255,255,255,.09);--bstr:rgba(255,255,255,.16);--pass:#43c39a;--fail:#e06666;--defer:#e8a64d;--user:#45b8cc;--tool:#7E47D7;--asst:#43c39a;--fs:'Space Grotesk',system-ui,-apple-system,sans-serif;--fm:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box;border-radius:0}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--fs)}
header{position:sticky;top:0;background:var(--surf);border-bottom:1px solid var(--bstr);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:10}
header strong{color:var(--fg-strong)}
main{padding:16px;max-width:980px;margin:0 auto}
.badge{display:inline-block;padding:2px 8px;background:var(--surf-2);border:1px solid var(--bd);font-size:12px;font-family:var(--fm)}
.badge.subject{background:var(--surf-2);border-color:var(--bstr)}.badge.tid{font-family:var(--fm)}
.role{border-left:3px solid var(--bd);padding:4px 12px;margin:10px 0}
.role-user{border-color:var(--user)}.role-tool{border-color:var(--tool)}.role-assistant{border-color:var(--asst)}
.role h4{margin:4px 0;color:var(--mut);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em;font-family:var(--fm)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surf);border:1px solid var(--bd);padding:10px;margin:4px 0;font-family:var(--fm)}
details.obs{margin:4px 0;border:1px solid var(--bd);padding:4px 8px;background:var(--surf-2)}
details.obs-tool{border-left:3px solid var(--tool)}
summary{cursor:pointer}.obs-idx{color:var(--mut)}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{background:var(--surf-2);color:var(--fg);border:1px solid var(--bd);padding:6px 12px;cursor:pointer;font-size:13px;font-family:var(--fs)}
button:hover{border-color:var(--mut)}
button.pass{border-color:var(--pass)}button.pass.active{background:var(--pass);color:#0a0a12}
button.fail{border-color:var(--fail)}button.fail.active{background:var(--fail);color:#0a0a12}
button.defer{border-color:var(--defer)}button.defer.active{background:var(--defer);color:#0a0a12}
textarea{width:100%;min-height:54px;background:var(--surf);color:var(--fg);border:1px solid var(--bd);padding:8px;margin-top:8px;font:13px/1.4 var(--fm)}
.counter{color:var(--mut)}.kbd{font-family:var(--fm);color:var(--mut);font-size:11px}
input[type=text]{background:var(--surf);color:var(--fg);border:1px solid var(--bd);padding:5px 8px;width:140px;font-family:var(--fm)}
.ga-panel{border:1px solid var(--bd);border-left:3px solid var(--tool);padding:8px 12px;margin:10px 0;background:var(--surf-2)}
.ga-head{font-weight:600;margin-bottom:4px}.ga-row{margin:4px 0}.ga-k{color:var(--mut);text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-right:6px;font-family:var(--fm)}
.ga-assumptions{margin:4px 0;padding-left:18px}
.badge.verdict-pass{border-color:var(--pass);color:var(--pass)}.badge.verdict-fail{border-color:var(--fail);color:var(--fail)}.badge.verdict-indeterminate{border-color:var(--defer);color:var(--defer)}
button.calib{padding:2px 8px;font-size:11px}button.calib.verify.active{background:var(--pass);color:#0a0a12}button.calib.eliminate.active{background:var(--fail);color:#0a0a12}
`;

/**
 * The client controller: nav, label state (localStorage auto-save), keyboard
 * shortcuts, counter, jump-to-id, labels export. Embedded verbatim — it carries
 * NO trace data (the cards are server-rendered) and NO subject specifics. The
 * `STORAGE_KEY` is parameterized by a stable subject key so multiple subjects'
 * labels don't collide in one browser.
 */
function clientScript(storageKey: string): string {
  return `
const STORAGE_KEY=${JSON.stringify(storageKey)};
const CALIB_KEY=STORAGE_KEY+':calibration';
const cards=[...document.querySelectorAll('.trace-card')];
const ids=cards.map(c=>c.dataset.traceId);
let cur=0;
function loadLabels(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}}
function saveLabels(m){localStorage.setItem(STORAGE_KEY,JSON.stringify(m))}
// GA — calibration capture (verify/eliminate) lives in a SEPARATE store so the
// human-labels.json export stays HumanLabel-schema-clean (no smuggled fields).
function loadCalib(){try{return JSON.parse(localStorage.getItem(CALIB_KEY)||'{}')}catch{return {}}}
function saveCalib(m){localStorage.setItem(CALIB_KEY,JSON.stringify(m))}
let calib=loadCalib();
let labels=loadLabels();
let history=[];
function show(i){
  if(i<0)i=0;if(i>=cards.length)i=cards.length-1;cur=i;
  cards.forEach((c,k)=>c.hidden=k!==i);
  const id=ids[i];const rec=labels[id]||{};
  document.querySelectorAll('.verdict').forEach(b=>b.classList.toggle('active',b.dataset.v===rec.label));
  document.getElementById('notes').value=rec.notes||'';
  document.getElementById('jump').value=id;
  updateCounter();
}
function updateCounter(){
  const done=ids.filter(id=>labels[id]&&labels[id].label).length;
  const remaining=ids.length-done;
  document.getElementById('counter').textContent=(cur+1)+' of '+ids.length+' — '+done+' labeled, '+remaining+' remaining';
}
function setLabel(v){
  const id=ids[cur];
  const prev=labels[id]?{...labels[id]}:null;history.push({id,prev});
  labels[id]={traceId:id,label:v,notes:document.getElementById('notes').value,labeledAt:new Date().toISOString()};
  saveLabels(labels);show(cur); // auto-save on every action
}
function setNotes(){
  const id=ids[cur];const rec=labels[id]||{traceId:id};
  rec.notes=document.getElementById('notes').value;rec.labeledAt=new Date().toISOString();
  labels[id]=rec;saveLabels(labels); // auto-save notes too
}
function undo(){const h=history.pop();if(!h)return;if(h.prev)labels[h.id]=h.prev;else delete labels[h.id];saveLabels(labels);show(cur)}
function jumpTo(id){const i=ids.indexOf(id.trim());if(i>=0)show(i)}
function exportLabels(){
  const arr=Object.values(labels);
  const blob=new Blob([JSON.stringify(arr,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='human-labels.json';a.click();
}
// GA — capture a verify/eliminate calibration decision on a surfaced assumption.
function setCalib(traceId,criterionId,ai,action){
  const key=traceId+'#'+criterionId+'#'+ai;
  calib[key]={traceId,criterionId,assumptionIndex:Number(ai),action,decidedAt:new Date().toISOString()};
  saveCalib(calib);
}
function exportCalib(){
  const arr=Object.values(calib);
  const blob=new Blob([JSON.stringify(arr,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='calibration.json';a.click();
}
document.querySelectorAll('.calib').forEach(b=>b.addEventListener('click',()=>{
  const card=b.closest('.trace-card');const panel=b.closest('.ga-panel');
  setCalib(card.dataset.traceId,panel?panel.dataset.criterion:'',b.dataset.ai,b.dataset.action);
  b.classList.add('active');
}));
document.querySelectorAll('.verdict').forEach(b=>b.addEventListener('click',()=>setLabel(b.dataset.v)));
document.getElementById('notes').addEventListener('input',setNotes);
document.getElementById('prev').addEventListener('click',()=>show(cur-1));
document.getElementById('next').addEventListener('click',()=>show(cur+1));
document.getElementById('undo').addEventListener('click',undo);
document.getElementById('export').addEventListener('click',exportLabels);
{const ce=document.getElementById('export-calib');if(ce)ce.addEventListener('click',exportCalib);}
document.getElementById('jump').addEventListener('change',e=>jumpTo(e.target.value));
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT'){
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){setNotes();show(cur+1);e.preventDefault()}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){saveLabels(labels);e.preventDefault()}
    return;
  }
  if(e.key==='ArrowRight')show(cur+1);
  else if(e.key==='ArrowLeft')show(cur-1);
  else if(e.key==='1')setLabel('pass');
  else if(e.key==='2')setLabel('fail');
  else if(e.key.toLowerCase()==='d')setLabel('defer');
  else if(e.key.toLowerCase()==='u')undo();
  else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){saveLabels(labels);e.preventDefault()}
  else if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){show(cur+1);e.preventDefault()}
});
show(0);
`;
}

/**
 * Render the full annotation HTML document. DETERMINISTIC — byte-identical for
 * the same (traces, opts). The embedded client script carries the controls; the
 * trace cards are server-rendered (native format, escaped). Subject-agnostic.
 */
export function renderReviewUi(traces: EvalTrace[], opts: ReviewUiOptions = {}): string {
  const subjectName = opts.subjectName ?? "subject";
  const title = opts.title ?? `Trace review — ${subjectName}`;
  // stable storage key so labels namespace per subject (no clock/random).
  const storageKey = `mutagent-evaluator:review:${subjectName}`;
  const adj = opts.adjudications ?? {};
  const cards = traces
    .map((t, i) => renderTraceCard(t, i, subjectName, adj[t.id]))
    .join("");
  const empty = traces.length === 0 ? `<p><em>No traces to review.</em></p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    `<header><strong>${esc(title)}</strong>` +
    `<span id="counter" class="counter"></span>` +
    `<span class="controls">` +
    `<button id="prev">◀ Prev</button><button id="next">Next ▶</button>` +
    `<button class="verdict pass" data-v="pass">Pass</button>` +
    `<button class="verdict fail" data-v="fail">Fail</button>` +
    `<button class="verdict defer" data-v="defer">Defer</button>` +
    `<button id="undo">Undo</button>` +
    `<input type="text" id="jump" placeholder="jump to trace id" aria-label="jump to trace id">` +
    `<button id="export">Download labels</button>` +
    `<button id="export-calib">Download calibration</button>` +
    `<span class="kbd">← → nav · 1 Pass · 2 Fail · D Defer · U Undo · ⌘S Save · ⌘⏎ Save&amp;Next</span>` +
    `</span></header>` +
    `<main>${empty}${cards}<textarea id="notes" placeholder="notes — what went wrong / right"></textarea></main>` +
    `<script>${clientScript(storageKey)}</script></body></html>`
  );
}

// ── labels persistence merge (deterministic — the script's only state op) ────

/**
 * Merge incoming labels into existing, deduped by traceId, LAST-WRITE-WINS
 * (incoming overrides existing for the same trace). DETERMINISTIC: result is
 * sorted by traceId so re-merges are byte-identical (no clock/random). This is
 * the persistence the script owns; the browser EXPORTS labels, this folds them
 * into the canonical labels file `*validate` reads.
 */
export function mergeLabels(existing: HumanLabel[], incoming: HumanLabel[]): HumanLabel[] {
  const byId = new Map<string, HumanLabel>();
  for (const l of existing) byId.set(l.traceId, l);
  for (const l of incoming) byId.set(l.traceId, l); // incoming wins
  return [...byId.values()].sort((a, b) => a.traceId.localeCompare(b.traceId));
}

export interface LabelStats {
  total: number;
  labeled: number;
  unlabeled: number;
  pass: number;
  fail: number;
  defer: number;
}

/**
 * Count labels against a trace universe. `deferred` labels count as "labeled"
 * for progress but are NOT pass/fail ground truth (excluded from TPR/TNR by
 * `*validate`). PURE.
 */
export function labelStats(traceIds: string[], labels: HumanLabel[]): LabelStats {
  const byId = new Map(labels.map((l) => [l.traceId, l]));
  let pass = 0;
  let fail = 0;
  let defer = 0;
  let labeled = 0;
  for (const id of traceIds) {
    const l = byId.get(id);
    if (l === undefined) continue;
    labeled++;
    if (l.label === "pass") pass++;
    else if (l.label === "fail") fail++;
    else if (l.label === "defer") defer++;
  }
  return { total: traceIds.length, labeled, unlabeled: traceIds.length - labeled, pass, fail, defer };
}
