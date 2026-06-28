/**
 * scripts/code-eval.ts — P3 (EX-2): the v2 CODE-track primitive library.
 * ---------------------------------------------------------------------------
 * Code-class criteria (§5b `check_method: deterministic`, and the pre-filter
 * half of `hybrid`) are evaluated by DETERMINISTIC code-eval scripts the
 * evaluator agent runs via its Bash tool — NO LLM, ZERO judge tokens,
 * byte-identical across reruns (restores full C-PIN on code rows; closes M1/M2).
 *
 * This is a generic, SUBJECT-AGNOSTIC primitive set over the `EvalTrace` shape:
 *   - presence              — a field is present + non-empty
 *   - string-equality       — exact (optionally case-insensitive) match
 *   - format-validity       — a regex/format conformance check
 *   - schema-conformance    — an object carries the required keys
 *   - ref-integrity         — cross-stage: every value produced in stage A is
 *                             present in stage B's output (referential integrity)
 *   - recovery-after-failure — TEMPORAL: a failure marker on an observation MUST
 *                             be followed by a recovery tool LATER in the trace; an
 *                             un-recovered failure is a "silent drop" (FAIL).
 *   - tool-output-failure   — a named tool's success flag is false on any call (FAIL).
 * A per-subject extraction (check-method-router.ts) maps a code-class
 * MinedCriterion → one of these specs; the primitives themselves hold NO subject
 * literal — the field names, fail values, and tool names are all PARAMETERS, so
 * the temporal/tool primitives are reusable on ANY agent's failure modes (the
 * sample `send-failure-silent-drop` mode is just one parameterization).
 *
 * TWO-WORLDS BOUNDARY: this is the v2 code-track over `EvalTrace` +
 * `MinedCriterion`. It deliberately does NOT import the v1 audit world
 * (`run-deterministic.ts` / `contracts/types.ts` 6-value Track over RunBundle) —
 * the two stay disjoint.
 *
 * PURE + deterministic: no clock / random / network. Reading a trace field is
 * the only effect-free input; the verdict is a pure function of (spec, trace).
 */
import type { EvalTrace, TraceObservation } from "./contracts/eval-types.ts";

/** A single code-eval's binary, deterministic outcome. `detail` → verdict critique. */
export interface CodeEvalResult {
  result: "pass" | "fail";
  detail: string;
}

/**
 * Read a dotted path off an `EvalTrace`. Supports:
 *   - `output.response`, `input.prompt`        → navigate the trace object
 *   - `obs:<name>.<path>`                       → the named GENERATION observation's
 *                                                 output, then navigate (SV-1: per-stage
 *                                                 outputs live in the observations)
 * Returns undefined for any missing segment (tolerant — never throws). PURE.
 */
export function readTracePath(trace: EvalTrace, path: string): unknown {
  if (path.startsWith("obs:")) {
    const rest = path.slice(4);
    const dot = rest.indexOf(".");
    const name = dot === -1 ? rest : rest.slice(0, dot);
    const sub = dot === -1 ? "" : rest.slice(dot + 1);
    const obs = trace.observations.find(
      (o: TraceObservation) => o.name === name && typeof o.type === "string" && o.type.toUpperCase() === "GENERATION",
    );
    if (obs === undefined) return undefined;
    return sub.length === 0 ? obs.output : navigate(obs.output, sub);
  }
  return navigate(trace as unknown, path);
}

/** Navigate a dotted path through a plain object graph. Undefined on any gap. */
function navigate(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Coerce a value to a search "haystack" string for ref-integrity. */
function haystack(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/** Coerce a producer value to its set of string tokens (array → items; scalar → [it]). */
function tokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  if (value === undefined || value === null) return [];
  return [typeof value === "string" ? value : JSON.stringify(value)];
}

/**
 * Coerce a scalar trace value to a canonical string for EXACT equality compare
 * (used by the temporal/tool primitives). Booleans/numbers stringify (`false` →
 * "false", `0` → "0"); strings pass through; null/undefined → "" (so a missing
 * field never spuriously equals a non-empty `failEquals`); objects JSON-serialize.
 */
function coerce(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/** The `name` of an observation, or "" when unnamed. */
function obsName(o: TraceObservation): string {
  return typeof o.name === "string" ? o.name : "";
}

// ── The CodeEvalSpec union (one per primitive) ──────────────────────────────

export type CodeEvalSpec =
  | { primitive: "presence"; field: string }
  | { primitive: "string-equality"; field: string; expected: string; caseInsensitive?: boolean }
  | { primitive: "format-validity"; field: string; pattern: string }
  | { primitive: "schema-conformance"; field: string; requiredKeys: string[] }
  | { primitive: "ref-integrity"; producer: string; consumer: string }
  | {
      primitive: "recovery-after-failure";
      /** path read RELATIVE TO each observation (e.g. "output.status"). */
      failField: string;
      /** the coerced value at `failField` that marks an observation as a failure. */
      failEquals: string;
      /** observation `name`s that count as a recovery reaction AFTER the failure. */
      recoveryTools: string[];
    }
  | {
      primitive: "tool-output-failure";
      /** the observation `name` of the tool to inspect. */
      tool: string;
      /** path read RELATIVE TO the tool observation; `false` (bool/string) ⇒ failure. */
      successPath: string;
    };

function pass(detail: string): CodeEvalResult {
  return { result: "pass", detail };
}
function fail(detail: string): CodeEvalResult {
  return { result: "fail", detail };
}

/**
 * Run one code-eval over a trace → a deterministic binary verdict. Exhaustive on
 * the primitive union; an UNKNOWN primitive THROWS (no silent pass — a
 * misconfigured code-eval is a fail-loud error, never a fabricated success). PURE.
 */
export function runCodeEval(spec: CodeEvalSpec, trace: EvalTrace): CodeEvalResult {
  switch (spec.primitive) {
    case "presence": {
      const v = readTracePath(trace, spec.field);
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === "string" && v.length === 0) ||
        (Array.isArray(v) && v.length === 0);
      return empty ? fail(`'${spec.field}' is absent/empty`) : pass(`'${spec.field}' is present`);
    }
    case "string-equality": {
      const v = readTracePath(trace, spec.field);
      const s = typeof v === "string" ? v : haystack(v);
      const a = spec.caseInsensitive === true ? s.toLowerCase() : s;
      const b = spec.caseInsensitive === true ? spec.expected.toLowerCase() : spec.expected;
      return a === b
        ? pass(`'${spec.field}' equals expected`)
        : fail(`'${spec.field}'='${s}' != expected '${spec.expected}'`);
    }
    case "format-validity": {
      const v = readTracePath(trace, spec.field);
      const s = typeof v === "string" ? v : haystack(v);
      return new RegExp(spec.pattern).test(s)
        ? pass(`'${spec.field}' matches /${spec.pattern}/`)
        : fail(`'${spec.field}'='${s}' does not match /${spec.pattern}/`);
    }
    case "schema-conformance": {
      const v = readTracePath(trace, spec.field);
      if (v === null || typeof v !== "object") {
        return fail(`'${spec.field}' is not an object`);
      }
      const obj = v as Record<string, unknown>;
      const missing = spec.requiredKeys.filter((k) => obj[k] === undefined);
      return missing.length === 0
        ? pass(`'${spec.field}' has all required keys`)
        : fail(`'${spec.field}' missing keys: ${missing.join(", ")}`);
    }
    case "ref-integrity": {
      const producerTokens = tokens(readTracePath(trace, spec.producer));
      const hay = haystack(readTracePath(trace, spec.consumer));
      const missing = producerTokens.filter((t) => !hay.includes(t));
      return missing.length === 0
        ? pass(`all ${producerTokens.length} '${spec.producer}' value(s) present in '${spec.consumer}'`)
        : fail(`'${spec.consumer}' is missing producer value(s): ${missing.join(", ")}`);
    }
    case "recovery-after-failure": {
      // TEMPORAL: find the FIRST observation whose `failField` marks a failure, then
      // require a recovery-tool observation AFTER it. No failure ⇒ vacuously pass.
      let failIdx = -1;
      for (let i = 0; i < trace.observations.length; i++) {
        const v = navigate(trace.observations[i], spec.failField);
        if (v !== undefined && coerce(v) === spec.failEquals) {
          failIdx = i;
          break;
        }
      }
      if (failIdx === -1) {
        return pass(
          `no observation has '${spec.failField}'=='${spec.failEquals}' — no failure to recover from`,
        );
      }
      const recoverySet = new Set(spec.recoveryTools);
      const after = trace.observations.slice(failIdx + 1);
      const recovered = after.find((o) => recoverySet.has(obsName(o)));
      return recovered !== undefined
        ? pass(
            `failure at obs#${failIdx} ('${spec.failField}'=='${spec.failEquals}') was followed by ` +
              `recovery tool '${obsName(recovered)}'`,
          )
        : fail(
            `failure at obs#${failIdx} ('${spec.failField}'=='${spec.failEquals}') with NO recovery ` +
              `tool (${spec.recoveryTools.join(" | ")}) AFTER it — silent drop`,
          );
    }
    case "tool-output-failure": {
      const calls = trace.observations.filter((o) => obsName(o) === spec.tool);
      if (calls.length === 0) {
        return pass(`no '${spec.tool}' observation present — nothing to check`);
      }
      const failed = calls.filter((o) => {
        const v = navigate(o, spec.successPath);
        return v === false || coerce(v) === "false";
      });
      return failed.length === 0
        ? pass(`all ${calls.length} '${spec.tool}' call(s) report '${spec.successPath}' != false`)
        : fail(
            `'${spec.tool}' reports failure ('${spec.successPath}'==false) in ` +
              `${failed.length}/${calls.length} call(s)`,
          );
    }
    default: {
      // exhaustiveness: an unknown primitive is a fail-loud error.
      const unknown = spec as { primitive?: unknown };
      throw new Error(
        `runCodeEval: unknown code-eval primitive '${String(unknown.primitive)}'. ` +
          "Known: presence | string-equality | format-validity | schema-conformance | " +
          "ref-integrity | recovery-after-failure | tool-output-failure.",
      );
    }
  }
}
