# OpenTelemetry — Source Platform Reference

> CLI-first per OQ-1.
> Upstream docs: https://opentelemetry.io/docs/
> **Official tooling/protocol docs: https://opentelemetry.io/docs/specs/otlp/**
>
> NOTE: OpenTelemetry has **no single canonical CLI** — trace access is
> backend-specific (Jaeger / Tempo / Honeycomb), each with its own API/CLI.
> Onboarding therefore treats OTel as `status: not-required` in the ensure-cli
> gate (PR-021 — `references/workflows/onboarding.md` Phase 2): there is nothing
> to install, so the skill links these docs and proceeds via the REST/curl fetch
> shown below. Per-backend docs:
> - Jaeger: https://www.jaegertracing.io/docs/
> - Tempo (Grafana): https://grafana.com/docs/tempo/
> - Honeycomb: https://docs.honeycomb.io/

## Access patterns

OTel spans are accessed via an OTLP-compatible backend. Common options:
- Jaeger: https://www.jaegertracing.io/
- Tempo (Grafana): https://grafana.com/docs/tempo/
- Honeycomb: https://www.honeycomb.io/

## Auth

Set in `.mutagentrc` per your backend:
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer sk-...
```

## CLI Operation Manual (Jaeger example)

```bash
# List traces (Jaeger UI API)
curl -s "http://localhost:16686/api/traces?service=my-agent&limit=100" | jq .

# Fetch specific trace
curl -s "http://localhost:16686/api/traces/{traceId}" | jq .

# Filter by error
curl -s "http://localhost:16686/api/traces?service=my-agent&tags=%7B%22error%22%3A%22true%22%7D"
```

## Filter/Search Support

See `references/filter-search-matrix.md`. Key: most OTel filtering is client-side post-fetch grep because CLI tooling varies per backend. `span.status.code == 2` = ERROR.

## Normalization

Normalizer: `scripts/normalize/platforms/otel.ts`

Input: array of OTel spans (OTLP JSON format)
Output: canonical `TraceBody`
