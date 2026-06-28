/**
 * scripts/load-profile-vocab.ts — EV-049 operator-supplied SubjectVocab injection.
 * ---------------------------------------------------------------------------
 * `inferVocab` (profile-subject.ts) cannot infer the SEMANTIC vocab fields from
 * traces alone — which tool is the "send" action, which are "recovery", the guard
 * counter attribute. It honestly leaves them empty (`sendTool=""`, etc.), and the
 * engine's honest-null path reports those signals as UNKNOWN rather than a false
 * `false`. This module is the LEAN injection seam: an operator passes a small
 * profile file (JSON or YAML) supplying those fields, and we OVERLAY them onto the
 * inferred-vocab base — WITHOUT hardcoding any subject name in the engine.
 *
 * Pure: parse + merge + TypeBox-validate. No clock / random / network.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  parseSubjectVocab,
  type SubjectVocab,
} from "./contracts/eval-types.ts";

/**
 * Overlay a partial vocab (the operator's profile) onto an inferred-vocab base.
 * Only fields PRESENT in `partial` override; everything else keeps the base
 * (inferred) value. Returns a fresh object (no mutation of either input).
 */
export function mergeVocab(
  base: SubjectVocab,
  partial: Partial<SubjectVocab>,
): SubjectVocab {
  return {
    recoveryTools: partial.recoveryTools ?? base.recoveryTools,
    eventTags: partial.eventTags ?? base.eventTags,
    sendTool: partial.sendTool ?? base.sendTool,
    guardCounterAttr:
      partial.guardCounterAttr !== undefined
        ? partial.guardCounterAttr
        : base.guardCounterAttr,
  };
}

/**
 * Load a profile file (`.json` or `.yaml`/`.yml`), overlay it onto `base`, and
 * VALIDATE the result against the SubjectVocab schema (fail-loud on a bad field
 * type — a malformed profile must never silently reach the determiner). A
 * missing file throws.
 */
export function loadProfileVocab(path: string, base: SubjectVocab): SubjectVocab {
  if (!existsSync(path)) {
    throw new Error(`load-profile-vocab: profile file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = /\.ya?ml$/i.test(path)
    ? (parseYaml(raw) as unknown)
    : (JSON.parse(raw) as unknown);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `load-profile-vocab: profile must be a JSON/YAML object of vocab fields: ${path}`,
    );
  }
  const merged = mergeVocab(base, parsed as Partial<SubjectVocab>);
  // Validate the merged result — overlaying a bad type (e.g. sendTool: 123) must
  // throw here, not corrupt the determiner's signals downstream.
  return parseSubjectVocab(merged);
}
