# Bundled shared templates (self-contained)

These install-time-copy templates were historically distributed via the peer
package `@mutagent/templates`. As of the npm public release of
`@mutagent/diagnostics`, they are **bundled directly into this package** so the
skill ships fully self-contained — `init` works offline from the package alone,
with **no peer-install and no dependency on `@mutagent/templates`**.

| File | Purpose |
|------|---------|
| `self-diagnosis-contract.v0.1.0.yaml.tpl` | Frozen v0.1.0 contract schema a target repo declares to opt into structured 10-category reports |
| `spec.yaml.tpl` | afkloop goal + termination-gate spec scaffold |
| `team.yaml.tpl` | actor/verifier team scaffold |
| `iter-N-handover.md.tpl` | per-iteration dispatch-brief scaffold |
| `wave-N-dashboard.html.tpl` | operator-facing wave dashboard scaffold |

## Resolution

Runtime code locates this directory via `sharedTemplatesDir()` in
`scripts/cli/shared-templates.ts` (canonical path
`<skill-root>/assets/templates/shared/`), mirroring how `report/render.ts`
resolves `assets/templates/report.html.tpl`. Because the directory lives inside
the shipped skill tree, the cross-platform installer (`init`) copies it as part
of the normal skill-directory copy — no separate fetch step is required.

> Tier-2 runtime asset. Ships with the package. Do NOT move under `internal/`
> (that path is stripped on publish).
