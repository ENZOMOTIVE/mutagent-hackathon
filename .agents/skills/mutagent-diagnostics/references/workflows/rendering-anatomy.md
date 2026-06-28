# Rendering Anatomy — mutagent-diagnostics Report

> **PRD-CC-12** · Canonical anatomy doc for the per-finding panel, per-remedy card,
> decisions panel, and live-preview. Authoritative reading for anyone extending the renderer.
>
> Visual contract: open the F-DESIGN-EXAMPLE Issue Card in the live design-contract report
> and read this doc alongside it.

---

## Overview

The gold-standard report is a multi-tab HTML document rendered by
`scripts/report/render.ts` from a fully-enriched `RenderInput` (produced by
`scripts/enrich/build-render-input.ts`). The template is
`assets/templates/report.html.tpl`.

The renderer is **fail-loud**: it throws (non-zero exit) when 3 or more of the 4
internal render shapes (`diagnosedEntity` / `bigStat` / `hourlyHeatmap` / `signalCensus`)
are absent. Never call the renderer on raw findings — always run the enricher first.

Tab layout:

| Tab ID | Name | Visibility |
|--------|------|-----------|
| `t0` | Methodology [INTERNAL] | NODE-STRIPPED on `--audience client` |
| `t1` | Overview | Always visible |
| `t2..tN+1` | F-NNN (one per finding) | Always visible |
| `tdecisions` | Decisions | Always visible |

---

## §1 — Overview Tab (`t1`)

### 1.1 Entity Card

Source: `RenderInput.diagnosedEntity` (type `EntityContext` from `scripts/normalize/trace.ts`).

| Field | Display | Notes |
|-------|---------|-------|
| `name` | Heading | Required. Renderer WARNS when absent on non-meta reports. |
| `entityType` | Chip | `agent` / `skill` / `service` / `unknown` |
| `model` | Chip | e.g., `claude-haiku-3.5` |
| `codeAccess` | Boolean pill | `true` = direct edit access; `false` = hypothesis-pending on remedy targets |
| `applyTarget` | Dashed row | Symbolic path to agent definition |
| `systemPrompt` | Always-collapsed `<details>` | PII — explicit click to expand regardless of size |
| `toolInventory` | Expandable list | Per-tool stats (call count, error rate); > 1 KB collapses |
| `inputSample` | Expandable | Sample user inputs |

### 1.2 Big-Stat Row (6 tiles)

Source: `RenderInput.bigStat`. Six tiles laid out in a responsive grid:

| Tile | Field | Color threshold |
|------|-------|----------------|
| Latency p50 | `latencyP50Ms` | green < 500ms, yellow < 2000ms, red >= 2000ms |
| Latency p95 | `latencyP95Ms` | same thresholds |
| Latency max | `latencyMaxMs` | same thresholds |
| Cost / window | `totalCostUsd` | muted <= $10, yellow > $10, red > $50 |
| Traces | `traceCount` | always muted |
| Error rate | `errorRate` | green < 5%, yellow < 20%, red >= 20% |

All CSS uses existing brand vars: `var(--p)` (purple), `var(--c)` (cyan), `var(--g)` (green),
`var(--y)` (yellow), `var(--r)` (red). Zero new hex colors.

### 1.3 24h Latency Heatmap

Source: `RenderInput.hourlyHeatmap` (24-entry array, one per UTC hour).
Color encodes avg latency; number in each cell = trace count.

### 1.4 Findings Summary Table

Lists all findings with severity, title, WHAT/WHY/WHERE taxonomy, and a link to the finding
tab.

---

## §2 — Finding Panel (`t2..tN+1`)

Each finding occupies its own tab. The panel renders the following blocks in order:

### 2.1 Finding Header

```
[SEVERITY BADGE]  [Finding title — story-led sentence]
WHAT: <chip>  WHY: <chip>  WHERE: <chip>  APPLY: <chip>  AUDIENCE: <chip>
```

- Severity badge: `CRIT` (red), `HIGH` (orange), `MED` (yellow), `INFO` (muted).
- AUDIENCE chip: `PRODUCT` / `META` / `CORE` — NODE-STRIPPED on `--audience client` when META/CORE.

### 2.2 Feedback Block (`feedbackSources[]`)

**Position:** between Problem and Evidence. Only rendered when `finding.feedbackSources` is
non-empty.

**Layout:** a bordered card with header "Feedback grounding" (NO emojis — D9) followed by
one row per source entry.

| Source type | CSS class | Color |
|-------------|-----------|-------|
| `chat` | `.fb-chat` | `var(--c)` (cyan border + left stripe) |
| `trace-score` | `.fb-score` | `var(--y)` (yellow border + left stripe) |
| `external` | `.fb-external` | `var(--p)` (purple border + left stripe) |

Label text (exact — D9 forbids emojis):
- `chat` → "Operator chat"
- `trace-score` → "Langfuse trace score"
- `external` → "External feedback platform"

### 2.3 Problem Statement

Free text. The finding's `problem` field. Rendered as a prose paragraph.

### 2.4 Evidence Block

Source: `finding.evidence` (array of evidence entries). Rendered as a list of evidence
bullets. When empty, the block is hidden.

### 2.5 Why-Chain

Source: `finding.whyChain` (ordered causal chain). Rendered as a numbered list.
The deepest step carries `isOrigin: true` — rendered with a distinct "root cause" marker.

### 2.6 Assumptions Block

Source: `finding.assumptions` (array). Rendered as a pill list:

| Pill type | When |
|-----------|------|
| `verified` (green) | Assumption confirmed by trace evidence |
| `unverified` (yellow) | Plausible but no direct evidence |
| `hypothesis-pending` (red) | Requires further investigation — always present on `codeAccess: false` entities |

On `codeAccess: false` entities: a disclaimer block is prepended:
"Code access not available — conclusions are hypothesis-pending until source review."

### 2.7 Coverage Proof Widget

Source: `finding.coverageProof` (type `CoverageProof` from `scripts/normalize/trace.ts`).

Layout: confidence badge + 4 per-dimension rows.

```
[HIGH / MEDIUM / LOW confidence badge]
latency:          coveredBuckets / populationBuckets  (coveragePct%)
score:            coveredBuckets / populationBuckets  (coveragePct%)
temporal:         coveredBuckets / populationBuckets  (coveragePct%)
tool-trajectory:  coveredBuckets / populationBuckets  (coveragePct%)
```

Low confidence (< 70%): shows a yellow caveat banner. Never blocks render.
This widget is WARN-only — low confidence is surfaced, not suppressed.

---

## §3 — Remedy Card

Each finding has one or more remedies. Each remedy is a `.remedy-card` element.

### 3.1 Remedy Header

```
[TOP-RIGHT CHECKBOX  .remedy-cb  data-id="{remedyId}"]
[★ RANK BADGE]  Remedy title
Meta strip: rank · applyTarget · cost · correctness · targetClass · changeType  [pills]
```

The checkbox is the ONLY selection mechanism. No per-remedy Copy buttons (D2 — there is
ONE global Copy button on the Decisions tab).

### 3.2 Two-Rationale Blocks (D1 — ALWAYS VISIBLE)

```
[PURPLE block]  Why this remedy
  <rationale text>

[CYAN block]  Why this works
  <whyWorks text>
```

Both blocks are ALWAYS visible. Neither is collapsible. If either field is absent on the
finding, the renderer falls back to a placeholder ("Rationale not provided" / "Mechanism
not provided") — never hides the block.

### 3.3 Apply Target Row

Source: `remedy.applyTarget`. Rendered as a dashed-border row below the rationale blocks:

```
Apply target:  <applyTarget>  [targetClass pill]  [changeType pill]
```

Only rendered when `applyTarget` is present.

### 3.4 Diff Grid (D3 — ALWAYS VISIBLE)

Two-column layout: **Before** (left) and **After** (right). Always visible — no collapsibles.
When `remedy.diff` is absent the columns render as empty placeholders.

### 3.5 Apply Plan + Instructions (D4 — side-by-side, ALWAYS VISIBLE)

A 2-column grid below the diff:

| Column | Source |
|--------|--------|
| Apply plan | `remedy.plan` (ordered steps) |
| Apply instructions | `remedy.applyInstructions[]` (exact commands / diffs) |

Both columns are always visible.

### 3.6 Feedback Textarea (D7)

```
<textarea class="remedy-notes" placeholder="Notes / override..."></textarea>
```

Free-text override box per remedy. Content is merged into the master Copy bundle.

---

## §4 — Decisions Tab (`tdecisions`)

### 4.1 Live Preview (`#lp-body`)

```
<textarea id="lp-body" readonly></textarea>
```

Auto-updates on every checkbox toggle and every keystroke in any `.remedy-notes` or general
feedback box. The content is the master plan markdown bundle aggregated from:
- All checked remedies (full remedy markdown)
- All `.remedy-notes` content for checked remedies
- General feedback textarea content

### 4.2 Meta Row (`#lp-meta`)

Shows: `<N> remedies · <M> chars` (updates live).

### 4.3 Global Copy Button (D2 — ONE sticky button)

```
<button id="copy-decisions">Copy to Clipboard</button>
```

ONE button only. Reads `#lp-body.value` and writes to clipboard. No modal, no preview
button, no second master button. Sticky at the bottom of the Decisions tab.

### 4.4 General Feedback Textarea

Free-text box for overall feedback (not remedy-specific). Merged into the Copy bundle.

### 4.5 Decisions Sync (D10)

The Decisions Panel content is mirrored inside the design view AND on the Decisions tab.
State is synced via JS (general feedback textarea + changelog).

---

## §5 — Methodology Tab (`t0`) [INTERNAL]

Visible only on internal reports (`--audience internal` or default). NODE-STRIPPED on
`--audience client` — not display-hidden, actually removed from the DOM so operator
metadata never reaches end-user reports.

Contents:
- Mermaid sequence diagram (orchestrator → scripts → analyzers, with timestamps).
- Graded decision log (all `runMeta.decisions[]` entries with step, choice, rationale, timestamp).
- Signal census (signals detected, their types, and Tier-0 coverage).
- Wave-6 methodology checklist stamp results.

---

## §6 — Self-Diagnosis Report Mode

When `isMetaReport: true` (produced by `scripts/self-diagnostics/dispatch.ts`):

- A forced `SELF-DIAGNOSIS` banner is prepended to every finding tab.
- The entity card shows `entityType: skill`, `codeAccess: true`, and the skill's `applyTarget`.
- The Decisions tab Decisions row includes a header: "Subject: skill source (skill maintainer mode)".
- `--audience client` is REFUSED — self-diag is always internal.

---

## §7 — CSS and Brand Variables

All new CSS uses ONLY these existing brand vars:

| Var | Color | Usage |
|-----|-------|-------|
| `var(--p)` | Purple | `rationale` block, external feedback border, `META` audience badge |
| `var(--c)` | Cyan | `whyWorks` block, chat feedback border |
| `var(--g)` | Green | `verified` assumption pill, recommended remedy glow |
| `var(--y)` | Yellow | `unverified` pill, score feedback border, low-coverage caveat |
| `var(--r)` | Red | `hypothesis-pending` pill, refused-gate banner |
| Surface/border tokens | Neutral | Card backgrounds, dividers |

Zero new hex colors. Zero emoji on structural labels (D9).

---

## §8 — Extending the Renderer

When adding a new block to the finding panel or remedy card:

1. Add the field to the appropriate type in `scripts/normalize/trace.ts` (optional for
   backward-compat).
2. Add a render function in `scripts/report/render.ts` following the existing
   `renderFeedbackBlock` / `renderAssumptionsBlock` pattern.
3. Use brand vars only — no new hex colors.
4. Update the enricher (`scripts/enrich/build-render-input.ts`) if the block needs
   aggregated data.
5. Add a test in `scripts/report/render.test.ts` covering the with/without fallback cases.
6. Update this doc (§2 or §3) with the new block's position and source fields.
