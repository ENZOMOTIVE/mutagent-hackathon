# WF-2.4 — HTML Report + Findings

> Primary output of a diagnostics run.
> Rendered via `scripts/report/render.ts` using `assets/templates/report.html.tpl`.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  mutagent-diagnostics — Report                                  │
│  Generated: 2026-05-27 10:42 | Source: langfuse | 73 traces    │
├─────────────────────────────────────────────────────────────────┤
│  [3 CRITICAL]  [1 WARNING]  [0 OK]  [73 traces]               │
├─────────────────────────────────────────────────────────────────┤
│  Discovered Checks                                              │
│  ┌──────────────┬──────────┬──────────┬─────────┐              │
│  │ Check        │ Pattern  │ Severity │ Found   │              │
│  ├──────────────┼──────────┼──────────┼─────────┤              │
│  │ Error spike  │ P-001    │ critical │ ✓ yes   │              │
│  │ Latency p95  │ P-002    │ critical │ ✓ yes   │              │
│  │ Low feedback │ P-003    │ warning  │ ✓ yes   │              │
│  └──────────────┴──────────┴──────────┴─────────┘              │
├─────────────────────────────────────────────────────────────────┤
│  Findings                                                       │
│  ▼ [CRITICAL] Tool call timeout causing search failures         │
│    WHAT: tool-timeout  WHY: env-config  WHERE: tool-invocation  │
│    Evidence: ▸ 8 traces, latency p95 = 45s                     │
│    Root cause: SEARCH_TIMEOUT env var missing → default 5s     │
│    ─────────────────────────────────────────────────────────    │
│    REMEDY: Set SEARCH_TIMEOUT=30000 in .mutagentrc             │
│    Target: local-claude (config)                                │
│    [ Copy markdown ] [ Accept fix ]                             │
│                                                                 │
│  ▶ [CRITICAL] Prompt hallucination on empty product list...     │
│  ▶ [WARNING] Feedback cluster: 3 sessions scored <2/5...        │
└─────────────────────────────────────────────────────────────────┘
│  [ Copy as Markdown ]                                           │
└─────────────────────────────────────────────────────────────────┘
```

## Finding Card Layers (4 layers per PR-014)

1. **Header**: severity badge + title + WHAT/WHY/WHERE taxonomy chips (collapsed by default)
2. **Evidence**: trace IDs, message excerpts, score values, timestamps
3. **RCA chain**: recursive why-chain until origin (no fixed depth)
4. **Remedy**: target platform, change type, copy button, Accept/Dismiss actions

## HITL Interaction

- **Copy markdown**: copies finding + remedy as markdown to clipboard
- **Accept fix**: triggers apply-worker for this specific finding (→ WF-3.1)
- **Dismiss**: marks finding as dismissed (recorded in audit)

## Report File

Report is written to: `.mutagent-diagnostics/reports/report-<timestamp>.html`
Path is printed to console:
```
  Report written to: .mutagent-diagnostics/reports/report-2026-05-27T10-42.html
  Opening in browser...
```
