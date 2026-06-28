/**
 * scripts/source-map.ts — P2 §5a: the source-map (topology) artifact.
 * ---------------------------------------------------------------------------
 * The FIRST step of every `*discover` run: MAP the source before mining. The map
 * = the entity/feature/stage topology + the per-stage I/O schema. It reuses the
 * existing `profileSubject` topology (subject name · platform · tool inventory ·
 * event taxonomy) and ADDS the per-stage I/O view derived from the GENERATION
 * observations.
 *
 * SCHEMA-VARIANCE TOLERANT (SV-1, the P1 discipline): production sources carry a
 * null trace-level `.output` (real I/O lives in the GENERATION observations) and
 * ≥2 coexisting prompt-template shapes. This mapper reads the GENERATION obs,
 * tolerates a bare-string output (no object keys) without aborting, and counts
 * the null-trace-output traces as an honest SV-1 signal.
 *
 * GENERIC: stage ids + I/O keys are DATA-DERIVED from the traces — NO client
 * topology / field / template literal is hard-coded. PURE + deterministic
 * (stages ranked by count desc then id asc; keys sorted) — no clock/random.
 */
import { profileSubject, type ToolStat } from "./profile-subject.ts";
import type { EvalTrace, TraceObservation } from "./contracts/eval-types.ts";

/** One pipeline stage's I/O topology (a GENERATION observation, by name). */
export interface StageIO {
  /** the stage id = the GENERATION observation name (else "generation"). */
  id: string;
  /** distinct input-object keys seen for this stage across the batch (sorted). */
  inputKeys: string[];
  /** distinct output-object keys seen for this stage across the batch (sorted). */
  outputKeys: string[];
  /** how many traces exhibit this stage. */
  count: number;
}

/** The source-map artifact: topology + per-stage I/O, SV-1-tolerant. */
export interface SourceMap {
  subjectName: string;
  platform: string;
  traceCount: number;
  /** SV-1 signal: # traces whose trace-level output was null/absent. */
  nullOutputTraces: number;
  toolInventory: ToolStat[];
  eventTaxonomy: Record<string, number>;
  /** the per-stage I/O topology (GENERATION observations). */
  stages: StageIO[];
}

function isGeneration(o: TraceObservation): boolean {
  return typeof o.type === "string" && o.type.toUpperCase() === "GENERATION";
}

/** Distinct object keys of a value, or [] when it is not a plain object. */
function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

interface StageAcc {
  inputKeys: Set<string>;
  outputKeys: Set<string>;
  traceIds: Set<string>;
}

/**
 * Build the source-map from a trace batch. Reuses `profileSubject` for the
 * subject/topology fields and derives the per-stage I/O from the GENERATION
 * observations. PURE + deterministic.
 */
export function buildSourceMap(traces: EvalTrace[]): SourceMap {
  const profile = profileSubject(traces);

  const stages = new Map<string, StageAcc>();
  let nullOutputTraces = 0;

  for (const t of traces) {
    if (t.output === null || t.output === undefined) nullOutputTraces += 1;
    for (const o of t.observations) {
      if (!isGeneration(o)) continue;
      const id = typeof o.name === "string" && o.name.length > 0 ? o.name : "generation";
      const acc = stages.get(id) ?? { inputKeys: new Set(), outputKeys: new Set(), traceIds: new Set() };
      for (const k of objectKeys(o.input)) acc.inputKeys.add(k);
      for (const k of objectKeys(o.output)) acc.outputKeys.add(k);
      acc.traceIds.add(t.id);
      stages.set(id, acc);
    }
  }

  const stageList: StageIO[] = [...stages.entries()]
    .map(([id, acc]) => ({
      id,
      inputKeys: [...acc.inputKeys].sort(),
      outputKeys: [...acc.outputKeys].sort(),
      count: acc.traceIds.size,
    }))
    .sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : a.id.localeCompare(b.id)));

  return {
    subjectName: profile.subjectName,
    platform: profile.platform,
    traceCount: profile.traceCount,
    nullOutputTraces,
    toolInventory: profile.toolInventory,
    eventTaxonomy: profile.eventTaxonomy,
    stages: stageList,
  };
}
