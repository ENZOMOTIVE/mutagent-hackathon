/**
 * scripts/resolve-ref.ts — GA-1/GA-2 the resolve-ref primitive (named CLI + lib).
 * ---------------------------------------------------------------------------
 * The single deterministic guard both GA edges ride:
 *   · GA-1 GATHER — an `observed` criterion's evidence refs must RE-RESOLVE
 *                   exact-match against the trace (else inferred-as-observed).
 *   · GA-2 BIND   — at judge time every criterion TERM (its referents) must
 *                   resolve to a grounded referent in the SITUATION trace; an
 *                   unbound term ⇒ indeterminate(factual-intent), NOT a fail.
 *
 * The pure core (`resolveRef` / `bindCriterionTerms` / `normalizeRefText`) lives
 * in the contract (`contracts/eval-types.ts`) so it is import-safe everywhere
 * (the gate `assertGroundingHonest` rides it too). This script RE-EXPORTS that
 * core under the spec's `resolve-ref` name, adds the BIND verdict-shaping helper,
 * and a thin CLI for ad-hoc resolution. PURE — no clock/random/network.
 */
import { readFileSync } from "node:fs";
import {
  AssumptionKind,
  OutcomeVerdict,
  bindCriterionTerms,
  resolveRef,
  type CriterionVerdict,
  type DiscoveryRef,
  type EvalTrace,
  type MinedCriterion,
  type VerdictBlock,
} from "./contracts/eval-types.ts";

export {
  bindCriterionTerms,
  normalizeRefText,
  resolveRef,
  type BindResult,
  type RefResolution,
} from "./contracts/eval-types.ts";

/**
 * GA-2 L1 — bind a criterion to a SITUATION before judging. Returns either
 * `{ bound: true }` (judge may proceed) or a ready-made INDETERMINATE verdict
 * (`uncertain` + `blockedBy: { kind: factual-intent }`) naming the unbound terms.
 * The judge NEVER returns a fail on an unbound term — abstention is the contract.
 * PURE.
 */
export function bindBeforeJudge(
  criterion: MinedCriterion,
  traceId: string,
  situation: EvalTrace[],
  extraTerms: DiscoveryRef[] = [],
): { bound: true } | { bound: false; verdict: CriterionVerdict } {
  const refs = criterion.discovery.evidence.refs;
  const res = bindCriterionTerms(refs, situation, extraTerms);
  if (res.bound) return { bound: true };
  const unboundList = res.unbound.map((r) => `${r.obs}/${r.path}:"${r.value}"`).join(", ");
  const blockedBy: VerdictBlock = {
    kind: AssumptionKind.FactualIntent,
    text: `unbound criterion term(s) — no referent in this situation: ${unboundList}`,
  };
  return {
    bound: false,
    verdict: {
      criterionId: criterion.id,
      traceId,
      result: OutcomeVerdict.Uncertain,
      confidence: 0,
      critique:
        "BIND failed (GA-2 L1): a term this criterion presupposes has no grounded " +
        `referent in the situation — abstaining (indeterminate), not failing. ${blockedBy.text}`,
      blockedBy,
    },
  };
}

// ── CLI: bun scripts/resolve-ref.ts <traces.json> <obs> <path> <value> ───────
declare const Bun: { argv: string[] } | undefined;

function main(): void {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const [tracesPath, obs, path, value] = argv;
  if (!tracesPath || obs === undefined || value === undefined) {
    console.error("usage: resolve-ref.ts <traces.json> <obs> <path> <value>");
    process.exit(2);
    return;
  }
  const raw = JSON.parse(readFileSync(tracesPath, "utf8")) as unknown;
  const traces = (Array.isArray(raw) ? raw : [raw]) as EvalTrace[];
  const ref: DiscoveryRef = { obs, path: path ?? "", value };
  const res = resolveRef(ref, traces);
  console.info(JSON.stringify(res, null, 2));
  process.exit(res.resolved ? 0 : 1);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  main();
}
