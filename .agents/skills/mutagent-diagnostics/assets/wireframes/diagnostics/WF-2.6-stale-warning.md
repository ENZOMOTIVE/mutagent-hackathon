# WF-2.6 — Stale Diagnosis Warning

> Shown when the user tries to apply a fix, but the codebase has changed since diagnosis.
> `scripts/stale-detector.ts` detects this by comparing git hashes.

## Trigger

User clicks "Accept fix" on a finding card in WF-2.4, but `stale-detector.ts` returns `stale=true`.

## Display

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠ Stale Diagnosis                                              │
│                                                                 │
│  The codebase has changed since this diagnosis was run.         │
│                                                                 │
│  Diagnosed at: abc1234f (2026-05-27 09:00)                     │
│  Current HEAD: f4e2a991 (2026-05-27 10:42)                     │
│  Changed files: 3                                               │
│                                                                 │
│  Applying fixes from a stale diagnosis may be incorrect.        │
│                                                                 │
│  [1] Re-run diagnostics on current HEAD (recommended)           │
│  [2] Apply anyway (I know what I'm doing)                      │
│  [3] Cancel                                                     │
└─────────────────────────────────────────────────────────────────┘
```

## On "Re-run" (Recommended)

→ Restart diagnostics from WF-2.1 with the same filters as the original run
→ Previous report is archived to `.mutagent-diagnostics/reports/archived/`

## On "Apply Anyway"

→ Proceed to WF-3.1 with a `stale=true` flag in the audit record
→ Audit.json will record `staleCheck.status = "stale-override"`
→ PR title will include "(stale diagnosis)" suffix for visibility

## Hash Comparison Logic

```typescript
// scripts/stale-detector.ts
const diagnosedHash = audit.diagnosedAtHash;  // hash at diagnosis time
const currentHash   = getCurrentGitHash();    // HEAD at apply time

if (diagnosedHash !== currentHash) {
  const changedFiles = getChangedFiles(diagnosedHash, currentHash);
  return { stale: true, diagnosedHash, currentHash, changedFiles };
}
return { stale: false };
```
