/**
 * scripts/profile-subject.ts — EV-049 subject auto-gen (NEVER hand-authored).
 * ---------------------------------------------------------------------------
 * Generate a subject profile from a trace sample (code/platform/trace
 * exploration). For sample this is the EV-049 "scroll the traces, infer the
 * invoked tools" path: the 35-tool inventory falls out of
 * observations[].type=="TOOL" (sample-findings §1). Also infers the event-kind
 * taxonomy, the observation-count clusters, and a platform marker.
 *
 * This is the PURE trace-exploration core (a distinct file from the v1
 * cli/profile-subject.ts, which profiles a skill/agent from its source for the
 * `*audit` surface). PURE + deterministic: tools ranked by frequency then name;
 * no clock / random / network.
 */
import {
  classifyEvent,
} from "./determine-outcome.ts";
import {
  UNCLASSIFIED_EVENT,
  parseSubjectVocab,
  type EvalTrace,
  type EventTagRule,
  type SubjectVocab,
} from "./contracts/eval-types.ts";
import { buildFlowGraph } from "./flow-graph.ts";
import {
  parseExpectedFlow,
  type ExpectedFlow,
  type ExpectedFlowEdge,
  type FlowGraph,
} from "./contracts/flow-graph.ts";

export interface ToolStat {
  name: string;
  count: number;
}

export interface SubjectProfile {
  subjectName: string;
  traceCount: number;
  toolInventory: ToolStat[];
  /**
   * The SUBJECT VOCABULARY the engine reads (EV-002 / EV-049). Either AUTHORED
   * (passed to `profileSubject`) or best-effort auto-generated from the traces.
   * The determiner reads its tag→kind rules / tool names from HERE, never from a
   * module constant.
   */
  vocab: SubjectVocab;
  /** event-kind distribution over the sample (counts), keyed by the vocab kinds. */
  eventTaxonomy: Record<string, number>;
  /** observation-count -> number of traces with that count (discrete clusters). */
  obsCountClusters: Record<number, number>;
  platform: string;
  /**
   * The agent-shaped EXPECTED-FLOW spec (EV-037) the context-flow audit diffs
   * against. AUTHORED when supplied (validated) — the canonical path for
   * fidelity — else best-effort auto-generated from the traces (EV-049): the
   * modal producer→consumer threadings the subject normally exhibits. The
   * semantic fields the trace alone can't carry (which tools DISPATCH sub-agents
   * · which slots the subject's HTML SHOULD render) are left empty with a TODO,
   * exactly like the vocab's recovery/send/guard fields.
   */
  expectedFlow: ExpectedFlow;
}

/** Tool inventory ranked by frequency desc, then name asc (deterministic). */
export function inferToolInventory(traces: EvalTrace[]): ToolStat[] {
  const counts = new Map<string, number>();
  for (const t of traces) {
    for (const o of t.observations) {
      if (o.type === "TOOL" && typeof o.name === "string") {
        counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : a.name.localeCompare(b.name)));
}

function promptOf(trace: EvalTrace): string {
  return typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
}

/**
 * Pull a single message's textual content out of the loosely-typed payload. The
 * AI-SDK / Langfuse shape carries `content` either as a plain string OR as an
 * array of content parts (`{type:"text", text}` / `{text}`). Returns the joined
 * text, or "" when nothing textual is present. PURE — read-only narrowing.
 */
function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Coerce an observation `input` to a message list. The AI-SDK GENERATION span
 * carries its prompt EITHER as a bare message array (`[{role,content},…]`) OR as
 * `{messages:[…]}`. Returns the message array, or `[]` when the input is neither
 * shape. PURE — read-only narrowing over the `unknown` payload.
 */
function messagesOf(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    const m = (input as { messages?: unknown }).messages;
    if (Array.isArray(m)) return m;
  }
  return [];
}

/**
 * RECONSTRUCT the subject's SYSTEM PROMPT from the trace batch (UI-14). The agent
 * never hands us its prompt in the trace-only path, but every LLM call carries it:
 * each GENERATION observation's `input` is the message list sent to the model, and
 * its first `role:"system"` message IS the system prompt. We scan observations in
 * order and return the FIRST non-empty system-message content found across the
 * batch (deterministic: trace order, then observation order).
 *
 * Handles the langfuse / AI-SDK shapes: `input` as a bare message array OR
 * `{messages:[…]}`; the system `content` as a string OR an array of text parts.
 *
 * NEVER confabulates: when no observation carries a `role:"system"` message the
 * function returns `undefined` (the caller keeps the prompt UNAVAILABLE). PURE —
 * no clock / random / network.
 */
export function inferSystemPrompt(traces: EvalTrace[]): string | undefined {
  for (const t of traces) {
    for (const o of t.observations) {
      for (const msg of messagesOf(o.input)) {
        if (msg && typeof msg === "object" && (msg as { role?: unknown }).role === "system") {
          const text = messageContentText((msg as { content?: unknown }).content).trim();
          if (text.length > 0) return text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Auto-infer the subject's event-tag rules from the traces (EV-049,
 * subject-agnostic extraction). Scans each prompt for opening tags `<{name}` and
 * collects the distinct tag names, ranked by per-trace presence (desc) then name
 * (asc). Tags present in EVERY trace are treated as ubiquitous WRAPPERS (e.g. a
 * `<current_time>` envelope) and dropped — they don't partition the sample into
 * event kinds. Each surviving tag becomes a `{kind: tag, tag}` rule.
 *
 * TODO(EV-049): stem-collapse (e.g. `opportunity_update` → `opportunity`) needs
 * subject semantics the trace alone doesn't carry — supply an AUTHORED vocab
 * (profileSubject's 2nd arg) when canonical kind names matter.
 */
export function inferEventTags(traces: EvalTrace[]): EventTagRule[] {
  const presence = new Map<string, number>();
  for (const t of traces) {
    const prompt = promptOf(t);
    const seen = new Set<string>();
    for (const m of prompt.matchAll(/<([a-zA-Z][\w-]*)/g)) seen.add(m[1]);
    for (const tag of seen) presence.set(tag, (presence.get(tag) ?? 0) + 1);
  }
  const total = traces.length;
  return [...presence.entries()]
    .filter(([, n]) => total <= 1 || n < total) // drop ubiquitous wrappers
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([tag]) => ({ kind: tag, tag }));
}

/**
 * Best-effort auto-generated subject vocab when no AUTHORED vocab is supplied.
 * Event tags are inferred from the traces; the SEMANTIC fields (which tools are
 * "recovery" / which tool is the "send" action / the guard counter attribute)
 * are left empty with a TODO — they need subject semantics the trace alone
 * doesn't carry, so they are supplied via an authored vocab until that inference
 * lands. The ENGINE reads the vocab off the profile either way (EV-002).
 */
function inferVocab(traces: EvalTrace[]): SubjectVocab {
  return {
    recoveryTools: [], // TODO(EV-049): infer recovery-tool semantics from traces.
    eventTags: inferEventTags(traces),
    sendTool: "", // TODO(EV-049): infer the primary send-action tool from traces.
    guardCounterAttr: null, // TODO(EV-049): infer the guard counter attribute.
  };
}

/** Event-kind distribution over the sample, using the subject's tag rules. */
export function inferEventTaxonomy(
  traces: EvalTrace[],
  vocab: SubjectVocab,
): Record<string, number> {
  const tax: Record<string, number> = { [UNCLASSIFIED_EVENT]: 0 };
  for (const rule of vocab.eventTags) tax[rule.kind] = 0;
  for (const t of traces) {
    const kind = classifyEvent(promptOf(t), vocab);
    tax[kind] = (tax[kind] ?? 0) + 1;
  }
  return tax;
}

/** Name-keyed expected-flow edges from one graph's THREADED data-handoffs. */
export function expectedEdgesFromGraph(graph: FlowGraph): ExpectedFlowEdge[] {
  const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const out: ExpectedFlowEdge[] = [];
  for (const e of graph.edges) {
    const fromTool = nameById.get(e.from) ?? "";
    const toTool = nameById.get(e.to) ?? "";
    if (fromTool.length === 0 || toTool.length === 0) continue; // unnamed → not normative
    out.push({ fromTool, toTool, slot: e.slot });
  }
  return out;
}

/**
 * Auto-infer the subject's EXPECTED-FLOW from the trace sample (EV-049,
 * subject-agnostic). The expected threadings = the UNION of producer→consumer
 * data-handoffs actually observed across the sample (deduped, deterministically
 * ordered) — the "normal" flow that SHOULD keep happening (a regression
 * baseline). The semantic fields the trace cannot carry are left empty with a
 * TODO: `dispatchToolNames` (which tools dispatch sub-agents) and
 * `expectedUiSlots` (which slots the subject's HTML artifact SHOULD render) need
 * subject semantics — supply an AUTHORED expected-flow when they matter.
 */
export function inferExpectedFlow(traces: EvalTrace[]): ExpectedFlow {
  const seen = new Map<string, ExpectedFlowEdge>();
  for (const t of traces) {
    const graph = buildFlowGraph(t);
    for (const edge of expectedEdgesFromGraph(graph)) {
      const key = `${edge.fromTool}␟${edge.toTool}␟${edge.slot ?? ""}`;
      if (!seen.has(key)) seen.set(key, edge);
    }
  }
  const edges = [...seen.values()].sort((a, b) =>
    a.fromTool !== b.fromTool
      ? a.fromTool.localeCompare(b.fromTool)
      : a.toTool !== b.toTool
        ? a.toTool.localeCompare(b.toTool)
        : (a.slot ?? "").localeCompare(b.slot ?? ""),
  );
  return {
    dispatchToolNames: [], // TODO(EV-037): infer sub-agent dispatch semantics; authored until then.
    edges,
    expectedUiSlots: [], // TODO(EV-037): the HTML render slots aren't in agent traces; authored.
  };
}

/** Discrete observation-count clusters: obsCount -> #traces (sample's 4/14/28/44). */
function inferObsClusters(traces: EvalTrace[]): Record<number, number> {
  const clusters: Record<number, number> = {};
  for (const t of traces) {
    const n = t.observations.length;
    clusters[n] = (clusters[n] ?? 0) + 1;
  }
  return clusters;
}

/** Platform marker from generation-span names (closed, explicit — no fuzzing). */
export function inferPlatform(traces: EvalTrace[]): string {
  for (const t of traces) {
    for (const o of t.observations) {
      const name = typeof o.name === "string" ? o.name : "";
      if (/^ai\.generateText\b/.test(name) || /^agent\.step\./.test(name)) {
        return "vercel-ai-sdk";
      }
    }
  }
  return "unknown";
}

/** The subject name = the (uniform) trace.name, else "unknown-subject". */
function inferSubjectName(traces: EvalTrace[]): string {
  const first = traces.find((t) => typeof t.name === "string" && t.name.length > 0);
  return first?.name ?? "unknown-subject";
}

/**
 * Assemble the full subject profile. PURE + deterministic. The subject VOCAB is
 * AUTHORED when supplied (validated against the schema) — the canonical path for
 * fidelity — else best-effort auto-inferred from the traces (EV-049). The engine
 * reads its subject vocabulary off `profile.vocab` (EV-002), never a module
 * constant.
 */
export function profileSubject(
  traces: EvalTrace[],
  authoredVocab?: SubjectVocab,
  authoredFlow?: ExpectedFlow,
): SubjectProfile {
  const vocab =
    authoredVocab !== undefined ? parseSubjectVocab(authoredVocab) : inferVocab(traces);
  const expectedFlow =
    authoredFlow !== undefined ? parseExpectedFlow(authoredFlow) : inferExpectedFlow(traces);
  return {
    subjectName: inferSubjectName(traces),
    traceCount: traces.length,
    toolInventory: inferToolInventory(traces),
    vocab,
    eventTaxonomy: inferEventTaxonomy(traces, vocab),
    obsCountClusters: inferObsClusters(traces),
    platform: inferPlatform(traces),
    expectedFlow,
  };
}
