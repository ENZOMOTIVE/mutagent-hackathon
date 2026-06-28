# Diagnostics Audit — {{AUDIT_ID}}

**Generated**: {{GENERATED_AT}}
**Skill version**: mutagent-diagnostics v{{SKILL_VERSION}}

## Summary

| Field | Value |
|-------|-------|
| Source platform | `{{SOURCE_PLATFORM}}` |
| Target platform | `{{TARGET_PLATFORM}}` |
| Target class | `{{TARGET_CLASS}}` |
| Remedy type | `{{REMEDY_TYPE}}` |
| Diagnosed at hash | `{{DIAGNOSED_AT_HASH}}` |
| Applied at hash | `{{APPLIED_AT_HASH}}` |
| Stale check | {{STALE_STATUS}} |

## Findings Applied

{{FINDINGS_TABLE}}

## Before State

```json
{{BEFORE_STATE_JSON}}
```

## After State

```json
{{AFTER_STATE_JSON}}
```

## Idempotency Key

`{{IDEMPOTENCY_KEY}}`

## PR / Branch

{{PR_LINK}}

## Lint + Typecheck Gate

- Lint: {{LINT_STATUS}}
- Typecheck: {{TYPECHECK_STATUS}}

## Notes

{{NOTES}}
