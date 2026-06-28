# Diagnostics Workflow — Full Procedure

> **SUPERSEDED-BY: `references/workflows/orchestrator-protocol.md` (canonical Steps 1–12)**
>
> This file is retained for anchor compatibility only. The authoritative step-by-step
> execution protocol (Steps 1–12: config detection → score-scale probe → NL translation
> → Tier-0 scan → slicing → analyzer dispatch → RCA → enricher → render → HITL →
> apply gate → self-diagnostics) lives in `orchestrator-protocol.md`.
>
> Load `orchestrator-protocol.md` for execution. Load this file only for the legacy DAG
> quick-reference below.

## Diagnostics DAG (quick-reference)

```
1. fetch traces (filtered)
   ↓
2. Tier 0 static scan (tier0-scan.ts)
   ↓
3. Dynamic-cluster or window-based slicing (slicer.ts)
   ↓
4. N parallel analyzers (≤5) — each gets a slice
   ↓
5. Aggregate findings (cross-analyzer dedup + cluster correlation)
   ↓
6. RCA layer (WHAT/WHY/WHERE + recursive whys + remedy chain)
   ↓
7. Render HTML report (render.ts)
   ↓
8. Emit report path → await operator markdown copy-back
   ↓
9. AskUserQuestion (final apply gate) → spawn BG apply-worker
```

For step-level detail on every node above, see `orchestrator-protocol.md`.
