# build-review-interface — a browser annotation UI to collect human labels

> **Source:** absorbed from `mutagent-system/.memory/features/evals-skills-source/skills/build-review-interface/SKILL.md`.
> **Loaded by:** `*review` (EV-045), rendered by `scripts/build-review-ui.ts`. Load on demand.
> **Sibling refs:** `error-analysis.md` (what to look for) · `validate-evaluator.md` (the labels feed TPR/TNR).

Build an HTML page that loads traces from a data source, shows ONE trace at a time with Pass/Fail
buttons, a notes field, and Next/Previous navigation, and persists labels to a local file. The
human labels it collects are the ground truth `*validate` calibrates the judge against
(`HumanLabel`, `scripts/contracts/validation.ts`).

## How this maps onto the evaluator (the Hybrid, EV-045)

| Piece | Type | Who |
|-------|------|-----|
| **Render the annotation HTML + labels persistence** | Code-only (deterministic template, like `render-report.ts`) | `scripts/build-review-ui.ts` |
| **A human labels traces in the browser** | HITL gate | a domain expert |

**Autonomy caveat (afkloop):** in the autonomous loop NO human labels in-browser. The UI is BUILT +
deterministically smoke-tested (DOM structure asserted) and surfaced as an artifact; `*validate`
proceeds on whatever labels exist and marks criteria with < ~60 labels `unvalidated` (bias-corrected,
never blocking on a human — see `validate-evaluator.md`).

## Data display (render in the most human-readable form for the domain)
- **Native format**: emails look like emails, markdown rendered, code highlighted, JSON
  pretty-printed + collapsible, tables as tables, URLs clickable.
- **Collapse repetitive elements** (a shared system prompt → a `<details>` toggle).
- **Extract + surface key metadata** (subject id, channel, session id) as a prominent header/badge.
- **Color-code by role/status** (left-border colors for user / assistant / tool / system).
- **Group related elements** (a tool call + its response visually linked).
- **Highlight what matters** (bold prices/dates/names; hierarchy via size + spacing).
- **Show the full trace** — all intermediate steps accessible, collapsed by default.
- **Sanitize rendered content** — strip raw HTML from LLM outputs before rendering; disable images
  in rendered markdown (tracking-pixel risk).

## Feedback collection (trace-level, not span-level)
- Binary **Pass / Fail** buttons as the primary action (visually distinct: color + size).
- Free-text **notes** field.
- **Defer** button for uncertain cases.
- **Auto-save on every action** — labels persist without an explicit save.
- (Later, once failure categories exist, predefined failure-mode tags can be added as checkboxes —
  NOT in the initial build.)

## Navigation & status
Next/Previous (buttons + arrow keys) · trace counter ("12 of 87 remaining") · jump-to-id · labeled
vs unlabeled counts.

## Keyboard shortcuts
```
Arrow keys = Navigate     1 = Pass     2 = Fail
D = Defer     U = Undo     Cmd+S = Save     Cmd+Enter = Save and next
```

## Selecting traces to load
The app accepts traces from any source; keep sampling OUTSIDE the app in `scripts/sample-traces.ts`
(start with the balanced ✓/✗ mix). The app is a pure renderer + label collector.

## Testing
After building, verify with Playwright (the human-run path):
- **Visual review** — screenshots with representative data: visual hierarchy clear? all data in
  native format (no raw JSON blobs / unrendered markdown)? professional + clean? responsive?
- **Functional test** — load app → click Pass (label saved) → click Fail + note (both saved) →
  Defer (recorded) → navigate (buttons + keyboard) → counter updates → reload → labels persist →
  expand collapsed sections → every keyboard shortcut fires its action.

In this skill the **deterministic DOM-structure smoke test** (`tests/build-review-ui.test.ts`)
asserts the controls + handlers + persistence shape exist without a browser dep, so the gate stays
austere; the Playwright workflow above is the human-run visual/functional verification.

## Design checklist
- [ ] Same layout, controls, terminology on every trace
- [ ] Pass/Fail buttons visually distinct
- [ ] Keyboard shortcuts work for all primary actions
- [ ] Full trace accessible even when sections are collapsed
- [ ] Labels persist automatically (no explicit save)
- [ ] Trace-level annotation as the default
- [ ] All data rendered in its native format

## Anti-patterns
- **Span-level annotation by default** — judge the whole trace.
- **Explicit-save-only** — auto-save or labels get lost.
- **Raw unrendered data** (JSON blobs, unescaped LLM HTML) — render native + sanitize.
- **Sampling logic inside the app** — keep it in `sample-traces.ts` (separable, testable).
