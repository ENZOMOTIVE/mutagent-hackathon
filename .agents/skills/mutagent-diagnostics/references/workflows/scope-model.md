# Scope Model — Skill vs Agent + Agent-ID Identity

> **W11-07** — documents the scope-picker decision model and the agent-identity
> resolution system introduced in Wave-11.
>
> **Authority**: orchestrator-protocol.md Step 3a (runtime procedure) references
> this file for the full model.

---

## Scope Types

The diagnostic run has three scope modes:

| Scope | When to use | Config resolution |
|---|---|---|
| `skill` | Diagnosing a skill's operational traces (e.g. `mutagent-diagnostics`) | Looks up `config.agents[name=<entity>]` |
| `agent` | Diagnosing a named runtime agent (e.g. `search-agent`, `orchestrator`) | Looks up `config.agents[name=<entity>]` |
| `all-traces` | No named entity — run across all available traces | No identity lookup; name-based filter only |

---

## Invocation-Aware Scope Resolution

The orchestrator determines scope using this **decision tree** at Step 3a:

```
parse-brief result
    │
    ├── scopeType = "skill"  → use scope: skill directly (no AskUserQuestion)
    │
    ├── scopeType = "agent"  → use scope: agent directly (no AskUserQuestion)
    │
    └── scopeType = null     → AskUserQuestion: skill | agent | all-traces
                               (see orchestrator-protocol.md Step 3a for template)
```

**Named → direct**: when parse-brief extracts a `scopeType`, use it immediately.
No AskUserQuestion for scopes that are already resolvable from the brief.

**Null → ask**: when scope cannot be inferred, present the three-option picker
with concrete preview blocks (per `feedback_ask_user_question_with_previews`).

---

## Agent-ID Identity Map

The `config.agents[]` field (added W11-07) is an optional cross-platform identity
map that tells the skill HOW to find a named entity's traces on each observability
platform.

### Why this is needed

A single code-level agent may appear as:
- `"search-agent"` in application code
- `"search-v2"` as `trace.name` in Langfuse (due to versioned naming)
- `"search-svc"` as `service.name` in OpenTelemetry (due to service naming conventions)

Without an identity map, the skill falls back to name-based matching which may
miss traces or return traces from a different agent.

### Config shape

```yaml
# .mutagent-diagnostics/config.yaml
agents:
  - name: search-agent          # canonical code-level name (matches parse-brief.entity)
    langfuse:
      traceName: "search-v2"   # Langfuse trace.name override
      tags: ["production"]     # additional tag filter
      agentIdField: "metadata.agent_id"  # custom field override
    otel:
      serviceName: "search-svc"          # OTEL service.name
      resourceAttrs:
        deployment.env: "prod"           # additional resource attr filter
```

See `scripts/config/schema.ts` → `AgentIdentitySchema` for the TypeBox definition.

### Resolution Step (Step 3.7)

```typescript
import { resolveEntityIdentity } from "scripts/normalize/platforms/entity-context.ts";

// After parse-brief and scope picker (Step 3a):
const identity = resolveEntityIdentity(parsedInvocation.entity, config.agents);
if (identity) {
  entityContext.identity = identity;
}
```

`resolveEntityIdentity` performs a case-insensitive name lookup. When the entity is
not declared in `config.agents`, it returns `undefined` and the run proceeds with
name-based matching (no behavioral change from pre-W11-07).

### How identity pointers are used

After `EntityContext.identity` is populated:

| Platform | How identity is used |
|---|---|
| Langfuse | `identity.langfuse.traceName` overrides the trace name filter; `identity.langfuse.tags` added to query; `identity.langfuse.agentIdField` overrides the JSON field used for `agentId` extraction |
| OTel | `identity.otel.serviceName` filters by `service.name` resource attr; `identity.otel.resourceAttrs` added to span query |

When `identity` is absent: existing name-based matching behavior (backward-compatible).

---

## Escape Hatch: all-traces

When the operator selects `all-traces` (or explicitly passes `--scope all`):
- No entity identity lookup.
- No `skillAgentScope` filter applied.
- TraceFilter.skill_agent_scope remains empty.
- The run is an unfocused exploratory sweep.

Use this for initial investigations before a named entity is known.

---

## Backward Compatibility

- `config.agents` is OPTIONAL. Configs without it continue to work unchanged.
- `EntityContext.identity` is OPTIONAL. All downstream consumers that read
  `EntityContext` but do not use `identity` are unaffected.
- `ParsedInvocation.scopeType` + `entity` are new fields with TypeScript default
  `scopeType: null` — existing callers that deconstruct only the original fields
  continue to compile without changes.
