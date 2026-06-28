/**
 * scripts/flow-graph.ts — EV-032 trace → information-flow graph (THE FOUNDATION).
 * ---------------------------------------------------------------------------
 * Deterministic adapter: an `EvalTrace` (events + TOOL observations + sub-agent
 * dispatches) → a subject-agnostic information-flow graph. Nodes are the trace's
 * observations viewed as producers/consumers of named data slots; edges are the
 * data handoffs (a producer's output value that reaches a later consumer's input).
 *
 * This is what "lets the evaluator SEE an agent's context-flow": the context-flow
 * audit (EV-028 tool-result threading · EV-029 sub-agent handoff completeness)
 * reasons over THIS structured graph instead of the raw trace, and the
 * deterministic `diffExpectedFlow` flags which expected threadings are missing
 * (the Code-only half of the Hybrid; the judge interprets severity).
 *
 * SUBJECT-AGNOSTIC: producers/consumers are named by the trace's OWN observation
 * names; the only subject vocabulary (which tool names are sub-agent dispatches)
 * is SUPPLIED via opts (auto-gen EV-049 / authored EV-037), never a constant.
 *
 * PURE + deterministic: no clock / random / network; same trace → same graph.
 * Threading is a deterministic CONTENT-OVERLAP signal (a producer's emitted
 * value string appears verbatim in a later consumer's serialized input).
 */
import type { EvalTrace, TraceObservation } from "./contracts/eval-types.ts";
import {
  EMPTY_EXPECTED_FLOW,
  FlowEdgeKind,
  TEXT_SLOT,
  VALUE_SLOT,
  type ExpectedFlow,
  type ExpectedFlowDiff,
  type ExpectedFlowEdge,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type UnthreadedOutput,
} from "./contracts/flow-graph.ts";

/** Options for `buildFlowGraph`. All optional → standalone-pure default. */
export interface FlowGraphOptions {
  /**
   * Tool/step names that are sub-agent DISPATCHES (EV-029). A node with one of
   * these names produces a context HANDOFF rather than a plain tool result.
   * SUPPLIED by the subject profile — never a module constant.
   */
  dispatchToolNames?: string[];
  /**
   * Minimum length of a producer slot's value string for it to count as a
   * threadable token (avoids trivial `true`/`1`/`""` matches). Default 12.
   */
  minThreadLen?: number;
}

const DEFAULT_MIN_THREAD_LEN = 12;

/** Stable node id by position. */
function nodeId(index: number): string {
  return `n${index}`;
}

/** Top-level slot keys of a payload. Primitive → a single sentinel slot. */
function slotKeysOf(payload: unknown, primitiveSlot: string): string[] {
  if (payload === undefined || payload === null) return [];
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return Object.keys(payload as Record<string, unknown>).sort();
  }
  // primitive or array → one opaque value slot
  return [primitiveSlot];
}

/** The string value of a producer slot (for content-overlap threading). */
function slotValueString(payload: unknown, slot: string): string {
  if (slot === VALUE_SLOT || slot === TEXT_SLOT) {
    return typeof payload === "string" ? payload : safeJson(payload);
  }
  if (payload !== null && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[slot];
    return typeof v === "string" ? v : safeJson(v);
  }
  return "";
}

/** Deterministic JSON serialization (sorted keys), tolerant of cycles. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? sortObject(v as Record<string, unknown>)
        : v,
    );
  } catch {
    return "";
  }
}

function sortObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

/** The serialized consumer-input string for a node (what later context carries). */
function consumerText(o: TraceObservation): string {
  if (o.input === undefined) return "";
  return typeof o.input === "string" ? o.input : safeJson(o.input);
}

/** Build one node from an observation. */
function toNode(o: TraceObservation, index: number, dispatch: Set<string>): FlowNode {
  const name = typeof o.name === "string" ? o.name : "";
  return {
    id: nodeId(index),
    index,
    type: typeof o.type === "string" ? o.type : "UNKNOWN",
    name,
    produces: slotKeysOf(o.output, VALUE_SLOT),
    consumes: slotKeysOf(o.input, TEXT_SLOT),
    isHandoff: name.length > 0 && dispatch.has(name),
  };
}

/**
 * Build the information-flow graph for a trace. PURE + deterministic.
 *
 * Edges are emitted when a producer slot's value string (length ≥ minThreadLen)
 * appears verbatim in a LATER node's serialized input — the deterministic
 * "this output was threaded into that context" signal. A producer slot that
 * matched NO downstream consumer is recorded in `unthreadedOutputs` (the EV-028
 * candidate the judge then adjudicates).
 */
export function buildFlowGraph(
  trace: EvalTrace,
  opts: FlowGraphOptions = {},
): FlowGraph {
  const dispatch = new Set(opts.dispatchToolNames ?? []);
  const minLen = opts.minThreadLen ?? DEFAULT_MIN_THREAD_LEN;
  const obs = trace.observations ?? [];
  const nodes = obs.map((o, i) => toNode(o, i, dispatch));

  // Pre-serialize every node's consumer-input once (O(n) not O(n²·serialize)).
  const consumerTexts = obs.map((o) => consumerText(o));

  const edges: FlowEdge[] = [];
  const unthreaded: UnthreadedOutput[] = [];

  for (let p = 0; p < nodes.length; p += 1) {
    const producer = nodes[p];
    for (const slot of producer.produces) {
      const value = slotValueString(obs[p].output, slot).trim();
      if (value.length < minLen) continue; // trivial value → not a threadable token
      let threaded = false;
      for (let c = p + 1; c < nodes.length; c += 1) {
        if (consumerTexts[c].includes(value)) {
          edges.push({
            from: producer.id,
            to: nodes[c].id,
            slot,
            kind: producer.isHandoff ? FlowEdgeKind.Handoff : FlowEdgeKind.Threaded,
          });
          threaded = true;
        }
      }
      if (!threaded) {
        unthreaded.push({ node: producer.id, name: producer.name, slot });
      }
    }
  }

  return {
    traceId: trace.id,
    nodes,
    edges,
    unthreadedOutputs: unthreaded,
  };
}

/**
 * Diff an actual flow-graph against an expected-flow (EV-037). DETERMINISTIC: an
 * expected edge `fromTool → toTool [slot]` is SATISFIED iff the graph has an edge
 * from a node named `fromTool` to a node named `toTool` (matching `slot` when the
 * expected edge pins one). Missing edges are the lossy-handoff / dropped-thread
 * candidates the context-flow judge then adjudicates (EV-028/029). This is the
 * Code-only half of the Hybrid — it decides nothing about severity.
 */
export function diffExpectedFlow(
  graph: FlowGraph,
  expected: ExpectedFlow = EMPTY_EXPECTED_FLOW,
): ExpectedFlowDiff {
  const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const satisfied: ExpectedFlowEdge[] = [];
  const missing: ExpectedFlowEdge[] = [];

  for (const exp of expected.edges) {
    const hit = graph.edges.some((e) => {
      const fromName = nameById.get(e.from);
      const toName = nameById.get(e.to);
      if (fromName !== exp.fromTool || toName !== exp.toTool) return false;
      return exp.slot === undefined || e.slot === exp.slot;
    });
    if (hit) satisfied.push(exp);
    else missing.push(exp);
  }

  return { satisfied, missing };
}

/**
 * The deterministic context-flow CANDIDATE leaks the EV-028/029 judge then
 * adjudicates (Code-only PREP, the deterministic half of the Hybrid):
 *   - `unthreadedOutputs` — producer slots whose value never reached a consumer
 *     (EV-028 tool-result-threading candidates).
 *   - `lossyHandoffs`     — expected-flow edges ABSENT from the actual graph
 *     (EV-029 sub-agent-handoff-completeness candidates: the dispatch brief did
 *     not carry the context the expected-flow says the child needs).
 * This DECIDES NOTHING about severity or whether a candidate is a true leak —
 * that is the context-flow lens' judgment over this structured bundle.
 */
export interface ContextFlowCandidates {
  unthreadedOutputs: UnthreadedOutput[];
  lossyHandoffs: ExpectedFlowEdge[];
}

export function contextFlowCandidates(
  graph: FlowGraph,
  expected: ExpectedFlow = EMPTY_EXPECTED_FLOW,
): ContextFlowCandidates {
  return {
    unthreadedOutputs: graph.unthreadedOutputs,
    lossyHandoffs: diffExpectedFlow(graph, expected).missing,
  };
}
