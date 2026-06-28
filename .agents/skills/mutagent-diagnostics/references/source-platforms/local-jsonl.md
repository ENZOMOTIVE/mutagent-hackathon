# Local JSONL — Source Platform Reference

> For `.jsonl` / `.ndjson` trace files on the local filesystem.
> No CLI needed — pure file reads.
>
> The ensure-cli gate (PR-021 — `references/workflows/onboarding.md` Phase 2)
> reports `status: not-required` for this source: there is no platform CLI to
> install. Filtering is client-side via `grep`/`jq` (see below). Tooling docs:
> `jq` — https://jqlang.github.io/jq/manual/ (optional, for advanced filtering).

## Format

One JSON object per line. Flexible schema — unknown fields are ignored.

Minimal required fields for a trace:
```json
{"id": "tr_001", "messages": [...], "startTime": "2026-05-27T10:00:00Z"}
```

## Fetching traces (filter examples)

```bash
# All traces with errors:
grep '"hasError":true' traces.jsonl

# By agent ID:
grep '"agentId":"search-agent"' traces.jsonl

# By time window (using jq):
jq 'select(.startTime >= "2026-05-20")' traces.jsonl

# With feedback:
grep '"hasFeedback":true' traces.jsonl
```

## Filter/Search Support

See `references/filter-search-matrix.md`. All filtering is post-read client-side. Full grep/jq support on all dimensions. Semantic search not supported.

## Normalization

Normalizer: `scripts/normalize/platforms/local-jsonl.ts`

```typescript
import { normalizeLocalJsonlFile } from "scripts/normalize/platforms/local-jsonl.ts";
const traces = normalizeLocalJsonlFile(fileContent);
```
