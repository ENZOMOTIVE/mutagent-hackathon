/**
 * scripts/substrate.ts — EV-050 framework-substrate selection.
 * ---------------------------------------------------------------------------
 * The W1 DEFAULT substrate is **agent-dispatch** (scripts/agent-dispatch.ts):
 * verdicts are produced by parent-session-dispatched eval-judge / error-analyst
 * leaf subagents reasoning on the HOST runtime (Claude Code, diagnostics-style
 * mass-dispatch) and read back from verdict FILES — the default path calls NO
 * provider SDK. The onboarding choice (PRD §7.9) stays a real fork; this picks
 * the DEFAULT the spine + dogfood build against, and STRUCTURES the rest as
 * seams rather than hardcoding any single transport:
 *
 *   - agent-dispatch (DEFAULT) → a verdict-file-backed JudgeInvoke; the LLM
 *                      reasoning happens in dispatched subagents on the host,
 *                      NOT in a script. Requires `verdictDir` (where the
 *                      dispatched subagents wrote their verdict files).
 *   - in-house       (OPTIONAL) → a live LLM JudgeInvoke (google-genai shape);
 *                      kept, not deleted — DEMOTED from default. For the CI /
 *                      code-based export path that wants a provider call.
 *   - code-based     → objective checks over tool outputs; runs WITHOUT an LLM
 *                      judge → judgeForSubstrate THROWS (deterministic code).
 *   - user-framework → an EXPORT target (Vitest/promptfoo/Braintrust/…); the
 *                      evaluator emits to it at onboarding → not a live judge.
 *
 * Why agent-dispatch is the default (operator correction 2026-06-19): the
 * Evaluator's functions must be performed BY an Evaluator agent on Claude Code
 * itself, mass-dispatched for throughput (mirror diagnostics), NOT by a script
 * calling Gemini. In-house Gemini remains a real onboarding option (EV-050) but
 * is no longer the spine default. Model intent stays sacred either way — the
 * host's pinned model for agent-dispatch, the asserted provider model in-house.
 */
import { Substrate, type SubstrateValue } from "./contracts/eval-types.ts";
import { createInHouseJudge } from "./judge-provider.ts";
import { createAgentDispatchJudge } from "./agent-dispatch.ts";
import type { JudgeInvoke } from "./determine-outcome.ts";

const KNOWN_SUBSTRATES: ReadonlySet<string> = new Set([
  Substrate.AgentDispatch,
  Substrate.InHouse,
  Substrate.UserFramework,
  Substrate.CodeBased,
]);

/** Resolve the substrate choice; default = agent-dispatch. Unknown → THROW (no silent default). */
export function resolveSubstrate(choice?: string): SubstrateValue {
  if (choice === undefined || choice === "") return Substrate.AgentDispatch;
  if (!KNOWN_SUBSTRATES.has(choice)) {
    throw new Error(
      `resolveSubstrate: unknown substrate '${choice}'. Choose one of ` +
        `{${[...KNOWN_SUBSTRATES].join(", ")}}.`,
    );
  }
  return choice as SubstrateValue;
}

export interface SubstrateDescription {
  kind: SubstrateValue;
  /** true for transports that yield a live JudgeInvoke (agent-dispatch · in-house);
   *  false for the seams (code-based · user-framework). */
  liveJudge: boolean;
  /** the verdict transport: where the judge text comes from. */
  transport: "agent-dispatch" | "provider-sdk" | "code" | "export";
  /** true ONLY for the in-house provider-SDK path (the others never call a provider). */
  callsProvider: boolean;
  note: string;
}

/** Describe a substrate (which one provides a live judge, and via what transport). */
export function describeSubstrate(s: SubstrateValue): SubstrateDescription {
  switch (s) {
    case Substrate.AgentDispatch:
      return {
        kind: s,
        liveJudge: true,
        transport: "agent-dispatch",
        callsProvider: false,
        note: "Claude Code agent-dispatch (DEFAULT) — verdicts from host-runtime subagents (verdict files), no provider",
      };
    case Substrate.InHouse:
      return {
        kind: s,
        liveJudge: true,
        transport: "provider-sdk",
        callsProvider: true,
        note: "in-house AI-SDK judge (OPTIONAL — demoted from default; provider-SDK call)",
      };
    case Substrate.CodeBased:
      return {
        kind: s,
        liveJudge: false,
        transport: "code",
        callsProvider: false,
        note: "objective code-checks over tool outputs — no LLM judge",
      };
    case Substrate.UserFramework:
    default:
      return {
        kind: s,
        liveJudge: false,
        transport: "export",
        callsProvider: false,
        note: "export target (user's eval framework) — emit, not a live judge",
      };
  }
}

export interface SubstrateJudgeConfig {
  substrate: SubstrateValue;
  /** agent-dispatch: the dir the dispatched subagents wrote their verdict files into. */
  verdictDir?: string;
  /** in-house: the resolved (pinned) provider model. */
  model?: string;
  apiKey?: string;
}

/**
 * Return a live `JudgeInvoke` for the substrate.
 *   - agent-dispatch (DEFAULT) → a verdict-file-backed judge (requires verdictDir);
 *     NO provider is loaded.
 *   - in-house (OPTIONAL) → the google-genai judge (requires a resolved model —
 *     model intent sacred; createInHouseJudge asserts it).
 *   - code-based / user-framework → SEAMS; THROW (no live judge to return).
 */
export function judgeForSubstrate(cfg: SubstrateJudgeConfig): JudgeInvoke {
  if (cfg.substrate === Substrate.AgentDispatch) {
    if (cfg.verdictDir === undefined || cfg.verdictDir === "") {
      throw new Error(
        "judgeForSubstrate(agent-dispatch): a verdictDir is required — it is the " +
          "directory the parent session's dispatched eval-judge / error-analyst " +
          "subagents wrote their verdict files into. PREP → dispatch → collect, " +
          "then aggregate (references/workflows/orchestrator-protocol.md).",
      );
    }
    return createAgentDispatchJudge({ verdictDir: cfg.verdictDir });
  }
  if (cfg.substrate === Substrate.InHouse) {
    if (cfg.model === undefined || cfg.model === "") {
      throw new Error(
        "judgeForSubstrate(in-house): a model is required (model intent sacred). " +
          "Resolve it via resolveJudgeModel() and pass it through.",
      );
    }
    return createInHouseJudge({ model: cfg.model, ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}) });
  }
  if (cfg.substrate === Substrate.CodeBased) {
    throw new Error(
      "judgeForSubstrate(code-based): code-based evals run WITHOUT an LLM judge — " +
        "there is no live judge to return. Run the deterministic code-checks " +
        "instead (this is a seam, not a live-judge path).",
    );
  }
  throw new Error(
    "judgeForSubstrate(user-framework): the user's framework is an EXPORT seam, " +
      "not a live judge. Emit the suite to the framework at onboarding; do not " +
      "expect a JudgeInvoke here.",
  );
}
