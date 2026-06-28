# Cloud REST — Target Platform Reference

> Apply target: Remote cloud services accessed via REST API (e.g., Langfuse, hosted OTel, custom agent API).
> Target class: `remote`
> Apply branch: remote (read-before-write required; idempotency required; HITL gate for all mutations)

## Classification

| Dimension | Value |
|-----------|-------|
| Target class | `remote` |
| Mutability | REST mutations via idempotent API calls |
| Isolation | No local isolation — all changes are live |

## Key Constraints

- **Read before write (PR-003)**: always GET the resource before PATCH/PUT/DELETE
- **Idempotency (PR-012)**: use `uuidgen` client-side idempotency keys for all mutations; retry-safe
- **HITL gate (PR-014)**: ALL remote mutations require user confirmation via HITL HTML before execution
- **No destructive ops without gate**: DELETE operations require explicit `AskUserQuestion` in Claude Code; numbered chat-multi-choice elsewhere

## Supported Services

| Service | Auth | Base URL |
|---------|------|----------|
| Langfuse | `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` | `https://cloud.langfuse.com` or self-hosted |
| Custom REST Agent | Bearer token | User-configured |

## How Remedies Are Applied

1. **GET resource** — confirm current state matches expected (read-before-write)
2. **Render HITL HTML** — show proposed change to user
3. **User confirms** — via AskUserQuestion (Claude Code) or numbered chat option
4. **PATCH/POST** with idempotency key — execute mutation
5. **Verify** — re-GET to confirm applied state
6. **Emit audit** — `audit.json` + `audit.md` per PR-013

## Idempotency Pattern

```typescript
const idempotencyKey = crypto.randomUUID(); // uuidgen equivalent

await fetch(`${baseUrl}/api/resource`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify(patch),
});
```

## Auth Configuration

Keys are referenced by name only — never inline values. From `.mutagentrc`:
```
LANGFUSE_SECRET_KEY=<key>
LANGFUSE_PUBLIC_KEY=<key>
LANGFUSE_HOST=https://cloud.langfuse.com
```

## Remedy Categories

- **Score annotation**: POST score to a trace (e.g., flag false positive in Langfuse)
- **Trace annotation**: add metadata tag to a trace
- **Dataset update**: add or update evaluation dataset entries
- **Config sync**: update remote agent config via REST API

## Audit

```json
{
  "targetPlatform": "cloud-rest",
  "targetClass": "remote",
  "remedyType": "score-annotation",
  "idempotencyKey": "<uuid>",
  "resourceUrl": "https://cloud.langfuse.com/api/...",
  "before": {},
  "after": {},
  "diagnosedAtHash": "<git-hash>",
  "appliedAtHash": "<git-hash>"
}
```
