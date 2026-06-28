/**
 * scripts/contracts/flow-graph.ts — W3-OWN contracts (EV-032 / EV-037).
 * ---------------------------------------------------------------------------
 * The information-flow graph (EV-032) + the expected-flow profile (EV-037) the
 * W3 context-flow audit reasons over. DELIBERATELY a SEPARATE contract file from
 * `contracts/eval-types.ts` (the shared W1 surface) and `contracts/types.ts`
 * (the v1 auditor surface): the flow-graph is a NEW W3 capability, kept disjoint
 * so the shared types stay frozen while this grows (mirrors the eval-types.ts
 * rationale).
 *
 * Design invariants (mirror the package's pure-core style):
 *   - Pure data shapes + categorical constants (no magic strings).
 *   - SUBJECT-AGNOSTIC: a flow-graph names producers/consumers by the trace's
 *     OWN observation names; the expected-flow's dispatch/UI vocabulary is
 *     SUPPLIED (auto-gen EV-049 or authored) — never a module constant.
 *   - No clock / random / network: a flow-graph is a pure function of a trace.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── Edge kind (no magic strings) ─────────────────────────────────────────────
export const FlowEdgeKind = {
  /** A producer's output value reaches a later consumer's input (EV-028). */
  Threaded: "threaded",
  /** The producer is a sub-agent DISPATCH; the edge is a context handoff (EV-029). */
  Handoff: "handoff",
} as const;
export type FlowEdgeKindValue = (typeof FlowEdgeKind)[keyof typeof FlowEdgeKind];

/**
 * One node in the flow-graph: a single trace observation viewed as a
 * producer/consumer of named data slots.
 *   - `produces` / `consumes` are the top-level slot KEYS of the observation's
 *     output / input (deterministic structural extraction). A primitive payload
 *     surfaces as the sentinel slot `VALUE_SLOT` / `TEXT_SLOT`.
 *   - `isHandoff` marks a sub-agent dispatch (name ∈ injected dispatchToolNames).
 */
export interface FlowNode {
  id: string;
  index: number;
  type: string;
  name: string;
  produces: string[];
  consumes: string[];
  isHandoff: boolean;
}

/** A data-handoff edge: producer slot `slot` at `from` reached consumer `to`. */
export interface FlowEdge {
  from: string;
  to: string;
  slot: string;
  kind: FlowEdgeKindValue;
}

/** A producer slot whose value NEVER reached a downstream consumer (EV-028 candidate). */
export interface UnthreadedOutput {
  node: string;
  name: string;
  slot: string;
}

/** The full information-flow graph for ONE trace. PURE function of the trace. */
export interface FlowGraph {
  traceId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  unthreadedOutputs: UnthreadedOutput[];
}

/** Sentinel slot names for primitive (non-object) payloads. NOT subject vocab. */
export const VALUE_SLOT = "_value";
export const TEXT_SLOT = "_text";

// ── Expected-flow profile (EV-037) ───────────────────────────────────────────
/**
 * One expected producer→consumer threading the subject SHOULD exhibit. Names are
 * the subject's OWN tool/step names (supplied, never hardcoded). `slot` is
 * optional — when present the diff also requires that slot to thread.
 */
export interface ExpectedFlowEdge {
  fromTool: string;
  toTool: string;
  slot?: string;
}

/**
 * The agent-shaped expected-flow spec (EV-037). SUBJECT-AGNOSTIC: every field is
 * supplied by the subject profile (auto-gen EV-049 or authored), so the audit
 * diffs ACTUAL flow-graph vs EXPECTED without any subject constant in the engine.
 *   - `dispatchToolNames` — which tool names are sub-agent dispatches (EV-029).
 *   - `edges`             — producer→consumer threadings the subject should have.
 *   - `expectedUiSlots`   — slots that SHOULD be rendered in the subject's HTML
 *                            artifact (EV-039/040, the operator's missing-data case).
 */
export interface ExpectedFlow {
  dispatchToolNames: string[];
  edges: ExpectedFlowEdge[];
  expectedUiSlots: string[];
}

/** Diff of an actual flow-graph against an expected-flow (deterministic). */
export interface ExpectedFlowDiff {
  satisfied: ExpectedFlowEdge[];
  missing: ExpectedFlowEdge[];
}

// ── TypeBox guards (closed objects — auditable boundary) ─────────────────────
export const FlowNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    index: Type.Integer({ minimum: 0 }),
    type: Type.String({ minLength: 1 }),
    name: Type.String(),
    produces: Type.Array(Type.String()),
    consumes: Type.Array(Type.String()),
    isHandoff: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const FlowEdgeSchema = Type.Object(
  {
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    slot: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal(FlowEdgeKind.Threaded),
      Type.Literal(FlowEdgeKind.Handoff),
    ]),
  },
  { additionalProperties: false },
);

export const UnthreadedOutputSchema = Type.Object(
  {
    node: Type.String({ minLength: 1 }),
    name: Type.String(),
    slot: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const FlowGraphSchema = Type.Object(
  {
    traceId: Type.String(),
    nodes: Type.Array(FlowNodeSchema),
    edges: Type.Array(FlowEdgeSchema),
    unthreadedOutputs: Type.Array(UnthreadedOutputSchema),
  },
  { additionalProperties: false },
);
export type FlowGraphStatic = Static<typeof FlowGraphSchema>;

export const ExpectedFlowEdgeSchema = Type.Object(
  {
    fromTool: Type.String({ minLength: 1 }),
    toTool: Type.String({ minLength: 1 }),
    slot: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ExpectedFlowSchema = Type.Object(
  {
    dispatchToolNames: Type.Array(Type.String({ minLength: 1 })),
    edges: Type.Array(ExpectedFlowEdgeSchema),
    expectedUiSlots: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ExpectedFlowStatic = Static<typeof ExpectedFlowSchema>;

/**
 * Validate + narrow an unknown value to `ExpectedFlow` (guarded-parse style).
 * THROWS with the first schema error — a malformed authored/loaded expected-flow
 * must never silently reach the audit.
 */
export function parseExpectedFlow(value: unknown): ExpectedFlow {
  if (!Value.Check(ExpectedFlowSchema, value)) {
    const first = [...Value.Errors(ExpectedFlowSchema, value)][0];
    const where = first?.path ?? "(root)";
    const msg = first?.message ?? "does not match ExpectedFlow";
    throw new Error(`parseExpectedFlow: invalid expected-flow at ${where}: ${msg}`);
  }
  return value;
}

/** An empty expected-flow (no constraints) — the EV-049 pre-authoring default. */
export const EMPTY_EXPECTED_FLOW: ExpectedFlow = {
  dispatchToolNames: [],
  edges: [],
  expectedUiSlots: [],
};
