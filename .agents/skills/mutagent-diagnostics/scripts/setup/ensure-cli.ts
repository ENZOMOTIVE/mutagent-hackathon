/**
 * scripts/setup/ensure-cli.ts
 * Source-platform-general "ensure-cli(platform)" helper (PR-021).
 * Type A — Pure Script: detection + decision are side-effect-free.
 *
 * Purpose (operator directive): source platforms (Langfuse, OTel, …) are usually
 * driven via a CLI during onboarding. Most CLIENTS will NOT have that CLI installed.
 * Onboarding must therefore:
 *   1. point the user at the official CLI docs, and
 *   2. when the CLI is missing, OFFER to install it —
 *      but the install MUST be checked + approved by the user first.
 *      NEVER auto-install under any code path.
 *
 * This module is the reusable core. It exposes:
 *   - CLI_SPECS                — per-platform CLI metadata (binary, install cmd, docs link)
 *   - isCliInstalled(binary)   — pure probe (`command -v <binary>`), no install
 *   - planCliEnsure(platform)  — decision object: detected? what to install? docs link?
 *                                NO side effects, NO install. (approval happens upstream)
 *   - runCliInstall(spec)      — runs the documented install command.
 *                                ⚠ Callers MUST gate this behind explicit user approval.
 *                                This function does NOT ask — it assumes approval was given.
 *
 * The approval prompt itself is platform-portable and lives in the onboarding caller
 * (AskUserQuestion on Claude Code; chat y/N fallback elsewhere) — NOT here. This keeps
 * the detect/decision layer pure and testable without any ASK runtime.
 */

import { execSync } from "child_process";
import type { SourcePlatform } from "../normalize/trace.ts";

/**
 * Injectable PATH probe: given a binary name, returns whether it is on PATH.
 * Named type alias (not an inline function type) so the binary param has a home
 * without tripping the base no-unused-vars rule on inline arrow-type params.
 */
// eslint-disable-next-line no-unused-vars
export type CliProbe = (binary: string) => boolean;

// ── Per-platform CLI specification ────────────────────────────────────────────

export interface CliSpec {
  /** Source platform this CLI serves. */
  platform: SourcePlatform;
  /**
   * Binary name probed on PATH (`command -v <bin>`). `null` for platforms that
   * need NO CLI (pure file reads) — `planCliEnsure` short-circuits to "not-required".
   */
  binary: string | null;
  /** Human-readable CLI/tooling name for prompts. */
  label: string;
  /**
   * The documented install command, or `null` when no installable CLI exists
   * (e.g. OTel — backend-specific tooling; or file-only platforms).
   */
  installCommand: string | null;
  /** Official CLI / tooling docs URL. Always present (operator: must link the docs). */
  docsUrl: string;
  /**
   * Extra guidance when the CLI is absent and no install is possible (REST / file
   * fallback). Shown alongside the docs link so the user can proceed without the CLI.
   */
  fallbackNote: string;
}

/**
 * Source-platform CLI specs. Langfuse is the first concrete instance (operator-provided
 * docs link). Other platforms link their official tooling docs where one exists, else
 * carry a clear TODO in `docsUrl` and a `null` installCommand (file-only / backend-specific).
 */
export const CLI_SPECS: Readonly<Record<SourcePlatform, CliSpec>> = {
  langfuse: {
    platform: "langfuse",
    binary: "langfuse",
    label: "Langfuse CLI",
    installCommand: "pip install langfuse",
    // Operator-provided (Wave-6):
    docsUrl: "https://langfuse.com/docs/api-and-data-platform/features/cli",
    fallbackNote:
      "Without the CLI the skill falls back to the Langfuse public REST API " +
      "(GET /api/public/traces) — see references/source-platforms/langfuse.md (CLI vs REST).",
  },
  otel: {
    platform: "otel",
    // No single canonical OTel CLI — tooling is backend-specific (Jaeger/Tempo/Honeycomb).
    binary: null,
    label: "OpenTelemetry tooling (backend-specific)",
    installCommand: null,
    docsUrl: "https://opentelemetry.io/docs/specs/otlp/",
    fallbackNote:
      "OTel has no single CLI — traces are pulled from your OTLP backend " +
      "(Jaeger / Tempo / Honeycomb) via its own API. The skill fetches via REST/curl. " +
      "See references/source-platforms/otel.md.",
  },
  "local-jsonl": {
    platform: "local-jsonl",
    // Pure file reads — no CLI required.
    binary: null,
    label: "Local JSONL (no CLI required)",
    installCommand: null,
    // No platform CLI docs — this is a local-file source. Link the skill's own reference.
    docsUrl: "references/source-platforms/local-jsonl.md",
    fallbackNote:
      "Local JSONL needs no CLI — the skill reads .jsonl/.ndjson files directly. " +
      "Filtering is client-side via grep/jq.",
  },
  "claude-code": {
    platform: "claude-code",
    // Pure file reads of ~/.claude/projects/**/*.jsonl — no CLI required.
    binary: null,
    label: "Claude Code transcripts (no CLI required)",
    installCommand: null,
    docsUrl: "https://code.claude.com/docs/en/data-usage",
    fallbackNote:
      "Claude Code transcripts are local JSONL files — no CLI required. " +
      "See references/source-platforms/claude-code-transcripts.md.",
  },
  codex: {
    platform: "codex",
    binary: "codex",
    label: "Codex CLI",
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    fallbackNote:
      "Codex transcripts are local JSONL files under ~/.codex/sessions/ — the CLI is " +
      "only needed to PRODUCE them, not to read them. The skill reads the files directly. " +
      "See references/source-platforms/codex-transcripts.md.",
  },
};

// ── Decision result ───────────────────────────────────────────────────────────

export type CliEnsureStatus =
  /** Platform needs no CLI (file-only / backend-specific) — nothing to do. */
  | "not-required"
  /** CLI binary already found on PATH. */
  | "present"
  /** CLI missing AND an install command exists — caller must ASK before installing. */
  | "missing-installable"
  /** CLI missing AND no install command exists — caller must surface REST/file fallback. */
  | "missing-no-installer";

export interface CliEnsurePlan {
  platform: SourcePlatform;
  status: CliEnsureStatus;
  /** The CLI spec (always present, even for not-required platforms). */
  spec: CliSpec;
  /**
   * The install command the caller should run IF the user approves.
   * `null` for not-required / present / missing-no-installer.
   */
  installCommand: string | null;
  /**
   * Whether running the install requires explicit user approval.
   * ALWAYS true when status is "missing-installable". The caller MUST NOT run
   * `runCliInstall` unless it has obtained explicit approval. There is no path
   * where this is false for an installable-but-missing CLI.
   */
  approvalRequired: boolean;
  /** Official docs link to show the user (operator: always link the docs). */
  docsUrl: string;
  /** Human-readable guidance string (docs + install or fallback). */
  guidance: string;
}

// ── Pure probe ────────────────────────────────────────────────────────────────

/**
 * Probe whether a CLI binary is on PATH. Pure read — never installs anything.
 * Uses `command -v` (POSIX builtin) with stdio suppressed; no shell metachar
 * injection because `binary` comes from the closed CLI_SPECS table, never user input.
 *
 * @param binary - The binary name to probe (from a CliSpec).
 * @returns true if found on PATH, false otherwise.
 */
export function isCliInstalled(binary: string): boolean {
  try {
    execSync(`command -v ${binary}`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── Decision (no side effects, no install) ────────────────────────────────────

/**
 * Decide what onboarding should do about the source platform's CLI.
 * PURE: probes PATH (a read) and returns a plan. NEVER installs. NEVER asks.
 *
 * The returned plan tells the caller:
 *   - whether a CLI is even needed (`not-required`),
 *   - whether it is already present (`present`),
 *   - whether it is missing-but-installable (`missing-installable` → caller MUST ask
 *     for approval, THEN call `runCliInstall`),
 *   - or missing-with-no-installer (`missing-no-installer` → caller shows REST/file fallback).
 *
 * @param platform - The chosen source platform.
 * @param probe - Injectable PATH probe (defaults to isCliInstalled) — enables
 *                deterministic unit tests without touching the real PATH.
 */
export function planCliEnsure(
  platform: SourcePlatform,
  probe: CliProbe = isCliInstalled
): CliEnsurePlan {
  const spec = CLI_SPECS[platform];

  // Platforms with no binary need no CLI at all.
  if (spec.binary === null) {
    return {
      platform,
      status: "not-required",
      spec,
      installCommand: null,
      approvalRequired: false,
      docsUrl: spec.docsUrl,
      guidance:
        `${spec.label} — no CLI required.\n` +
        `Docs: ${spec.docsUrl}\n` +
        `${spec.fallbackNote}`,
    };
  }

  const present = probe(spec.binary);
  if (present) {
    return {
      platform,
      status: "present",
      spec,
      installCommand: null,
      approvalRequired: false,
      docsUrl: spec.docsUrl,
      guidance:
        `${spec.label} detected on PATH (\`${spec.binary}\`).\n` +
        `Docs: ${spec.docsUrl}`,
    };
  }

  // Missing. Is there an installer?
  if (spec.installCommand !== null) {
    return {
      platform,
      status: "missing-installable",
      spec,
      installCommand: spec.installCommand,
      // INVARIANT: installable-but-missing ALWAYS requires approval. Never auto-install.
      approvalRequired: true,
      docsUrl: spec.docsUrl,
      guidance:
        `${spec.label} (\`${spec.binary}\`) is NOT installed.\n` +
        `Official docs: ${spec.docsUrl}\n` +
        `Suggested install: ${spec.installCommand}\n` +
        `(You will be asked to approve before anything is installed. ` +
        `Decline to continue with the REST/file fallback instead.)`,
    };
  }

  return {
    platform,
    status: "missing-no-installer",
    spec,
    installCommand: null,
    approvalRequired: false,
    docsUrl: spec.docsUrl,
    guidance:
      `${spec.label} is not installed and has no single install command.\n` +
      `Docs: ${spec.docsUrl}\n` +
      `${spec.fallbackNote}`,
  };
}

// ── Install (caller-gated — assumes approval already obtained) ─────────────────

export interface CliInstallResult {
  ok: boolean;
  command: string;
  /** stdout/stderr of the install command (truncated). */
  output: string;
  error?: string;
}

/**
 * Run a CLI's documented install command.
 *
 * ⚠ APPROVAL CONTRACT: this function does NOT ask the user. It assumes the caller
 * has ALREADY obtained explicit user approval (AskUserQuestion / chat y/N). Calling
 * this without prior approval violates the no-silent-install rule. The onboarding
 * flow in cli/init.ts is the only sanctioned caller and it always asks first.
 *
 * Throws if `plan.installCommand` is null (nothing to install) — a programming error
 * that should never reach here for a non-installable plan.
 *
 * @param plan - A `missing-installable` plan from planCliEnsure.
 * @returns Structured result; never throws on install failure (collected in `error`).
 */
export function runCliInstall(plan: CliEnsurePlan): CliInstallResult {
  if (plan.installCommand === null) {
    throw new Error(
      `runCliInstall called for platform "${plan.platform}" with no install command ` +
      `(status: ${plan.status}). This is a caller bug — only "missing-installable" ` +
      `plans are installable.`
    );
  }
  const command = plan.installCommand;
  try {
    const output = execSync(command, {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 300000, // generous — CLI installs (pip/npm) can be slow
    });
    return { ok: true, command, output: String(output).slice(0, 4000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, command, output: "", error: message };
  }
}
