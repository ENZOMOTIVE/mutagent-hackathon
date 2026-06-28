# WF-1.3 — Source Auth / Connection

> Phase 3 of onboarding: configure source connectivity.
> Prev: WF-1.2 | Next: WF-1.4

## WF-1.3a — Langfuse Auth

```
┌─────────────────────────────────────────────────────────────┐
│  Step 2 of 7 — Langfuse Connection                          │
│                                                             │
│  Checking .mutagentrc for LANGFUSE_* keys...                │
│                                                             │
│  ✓ LANGFUSE_SECRET_KEY found                               │
│  ✓ LANGFUSE_PUBLIC_KEY found                               │
│  ✓ LANGFUSE_HOST found (https://cloud.langfuse.com)        │
│                                                             │
│  Testing connection... ✓ Connected (12 traces found)        │
│                                                             │
│  [1] Continue with this config                              │
│  [2] Use a different host                                   │
└─────────────────────────────────────────────────────────────┘
```

### Keys Not Found Path

```
  ✗ LANGFUSE_SECRET_KEY not found in .mutagentrc
  
  Add the following to your .mutagentrc file:
  
    LANGFUSE_SECRET_KEY=sk-...
    LANGFUSE_PUBLIC_KEY=pk-...
    LANGFUSE_HOST=https://cloud.langfuse.com
  
  [1] I've added the keys — retry
  [2] Skip Langfuse, choose another source
```

## WF-1.3b — OTel Endpoint

```
┌─────────────────────────────────────────────────────────────┐
│  Step 2 of 7 — OTel Endpoint                                │
│                                                             │
│  OTel endpoint (from .mutagentrc or enter):                 │
│  > http://localhost:4318                                    │
│                                                             │
│  Testing connection... ✓ Jaeger reachable                   │
│                                                             │
│  [1] Continue                                               │
│  [2] Change endpoint                                        │
└─────────────────────────────────────────────────────────────┘
```

## WF-1.3c — Local JSONL File

```
┌─────────────────────────────────────────────────────────────┐
│  Step 2 of 7 — JSONL File Path                              │
│                                                             │
│  Path to your trace file (.jsonl or .ndjson):               │
│  > traces.jsonl                                             │
│                                                             │
│  ✓ File found (247 lines)                                   │
│                                                             │
│  [1] Continue                                               │
│  [2] Enter a different path                                 │
└─────────────────────────────────────────────────────────────┘
```

## Key Rules

- NEVER prompt for key values — only prompt for key NAMES to check in .mutagentrc
- Keys are referenced by name in config.yaml — never stored as values
