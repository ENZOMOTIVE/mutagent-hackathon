/**
 * scripts/judge-provider.ts — EV-050 in-house judge transport (the default substrate).
 * ---------------------------------------------------------------------------
 * The in-house AI-SDK judge: the @langchain/google-genai ChatGoogleGenerativeAI
 * shape proven in the orchestrator's eval-routing.ts (temp 0, model resolved
 * from --model | config.models.default, THROW on unsupported/missing creds).
 * Re-implemented here (sealed-sibling: the SHAPE is mirrored, the orchestrator
 * module is never imported).
 *
 * DI split (model intent sacred): construction asserts a supported model + creds
 * SYNCHRONOUSLY — no swap, no silent fallback. The provider SDK is imported
 * LAZILY, only when the returned JudgeInvoke is actually CALLED, so the
 * deterministic gate (which never calls it) never loads a provider. The CLI /
 * an opt-in integration seam are the only callers of the returned function.
 */
import type { JudgeInvoke } from "./determine-outcome.ts";

/** A minimal ctor shape for ChatGoogleGenerativeAI (avoids a type-time SDK dep). */
interface ChatGoogleCtor {
  new (opts: { model: string; temperature: number; apiKey: string }): {
    invoke: (messages: [string, string][]) => Promise<{ content: unknown }>;
  };
}

/** Detect the provider implied by a model id. Closed + explicit (no fuzzing). */
export function detectProvider(model: string): "google" | "unsupported" {
  return /^gemini/i.test(model) ? "google" : "unsupported";
}

/** Assert the model has a wired provider. THROWS (no swap) if not — model intent sacred. */
export function assertSupportedModel(model: string): void {
  if (detectProvider(model) === "unsupported") {
    throw new Error(
      `judge-provider: model '${model}' has no provider wired (only Google/` +
        "gemini-* is wired). MODEL INTENT IS SACRED: this will NOT silently swap " +
        "to another model/provider. Pass a supported --model, or wire its " +
        "provider (mirror the repo call shape) — never substitute.",
    );
  }
}

/** Assert creds are present. Takes the key EXPLICITLY (env-independent → testable). */
export function assertCreds(apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "judge-provider: GOOGLE_API_KEY is not set. Source the env first " +
        "(set -a && source mutagent-core/.env && source mutagent/.env && set +a). " +
        "NOT substituting another provider (model intent is sacred).",
    );
  }
  return apiKey;
}

export interface ModelDecision {
  model: string;
  source: "--model" | "config.models.default";
}

/**
 * Resolve the judge model: explicit --model wins (an intentional override, NOT
 * a silent swap), else config.models.default, else REFUSE. PURE — the caller
 * passes the values; this never reads a file or env.
 */
export function resolveJudgeModel(opts: {
  model?: string;
  configDefault?: string;
}): ModelDecision {
  if (opts.model !== undefined && opts.model !== "") {
    return { model: opts.model, source: "--model" };
  }
  if (opts.configDefault !== undefined && opts.configDefault !== "") {
    return { model: opts.configDefault, source: "config.models.default" };
  }
  throw new Error(
    "resolveJudgeModel: no model resolved. Pass --model <id>, or set " +
      "shared.models.default. MODEL INTENT IS SACRED: the harness will not pick " +
      "a model for you.",
  );
}

/** Coerce a LangChain message `content` (string | content-blocks) to plain text. */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
}

export interface InHouseJudgeOptions {
  model: string;
  /** explicit key; falls back to process.env.GOOGLE_API_KEY when omitted. */
  apiKey?: string;
}

/**
 * Build the in-house JudgeInvoke. Asserts model + creds SYNCHRONOUSLY (so a
 * misconfiguration fails fast, in the caller, not deep in an async call). The
 * SDK is imported LAZILY inside the returned function — the gate never reaches
 * that path. temperature is pinned to 0 (C-PIN: byte-identical reruns).
 */
export function createInHouseJudge(opts: InHouseJudgeOptions): JudgeInvoke {
  assertSupportedModel(opts.model);
  const apiKey = assertCreds(opts.apiKey ?? process.env.GOOGLE_API_KEY);

  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    // Lazy import — the deterministic harness never loads the provider SDK.
    const mod = (await import("@langchain/google-genai")) as unknown as {
      ChatGoogleGenerativeAI: ChatGoogleCtor;
    };
    const client = new mod.ChatGoogleGenerativeAI({
      model: opts.model,
      temperature: 0, // judging is a classification — pinned deterministic decoding
      apiKey,
    });
    const response = await client.invoke([
      ["system", systemPrompt],
      ["human", userPrompt],
    ]);
    return extractContentText(response.content);
  };
}
