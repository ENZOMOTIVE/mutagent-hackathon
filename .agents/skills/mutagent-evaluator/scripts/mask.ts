/**
 * scripts/mask.ts
 * ---------------------------------------------------------------------------
 * Byte-identity masking (decision #10 / R10). The audit is itself deterministic:
 * runId / timestamps / absolute-paths are masked so two audits on one bundle
 * (or two runs on byte-identical source) produce a BYTE-IDENTICAL scorecard.
 *
 * "byte-identical across runs" is only testable AFTER masking the declared
 * injected fields (the byte-identity masking contract). This module IS that
 * contract — a versioned, ordered set of deterministic substitutions.
 *
 * Pure, deterministic: no clock, no random, no network. Same input string ->
 * byte-identical output string, always.
 */

/** Versioned masking set. Bump VERSION when adding/reordering patterns. */
export const MASK_SET_VERSION = "v1";

export interface MaskRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * The ordered masking rules. ORDER MATTERS — earlier rules run first. ISO
 * timestamps are masked before bare dates so the longer pattern wins.
 *
 * NOTE: every pattern uses the global flag so replaceAll-style semantics apply.
 */
export const MASK_RULES: readonly MaskRule[] = [
  // ISO-8601 timestamps (with optional ms + Z/offset) -> stable sentinel
  {
    id: "iso-timestamp",
    pattern:
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
    replacement: "<TS>",
  },
  // epoch-millis (13-digit) and epoch-seconds (10-digit) -> sentinel
  { id: "epoch-millis", pattern: /\b\d{13}\b/g, replacement: "<EPOCHMS>" },
  { id: "epoch-seconds", pattern: /\b\d{10}\b/g, replacement: "<EPOCHS>" },
  // runId of the canonical form name-YYYYMMDD-HHMMSS -> sentinel
  {
    id: "runid-dated",
    pattern: /\b[a-z0-9][a-z0-9-]*-\d{8}-\d{6}\b/gi,
    replacement: "<RUNID>",
  },
  // UUID v4-ish -> sentinel
  {
    id: "uuid",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "<UUID>",
  },
  // absolute POSIX home paths -> sentinel (strips machine-specific roots)
  {
    id: "abs-home-path",
    pattern: /\/(?:Users|home)\/[^\s"'`]+/g,
    replacement: "<ABSPATH>",
  },
  // bare YYYY-MM-DD dates -> sentinel (after iso-timestamp so it only hits
  // standalone dates)
  { id: "bare-date", pattern: /\b\d{4}-\d{2}-\d{2}\b/g, replacement: "<DATE>" },
  // short git sha (7-12 hex) -> sentinel
  { id: "git-sha", pattern: /\b[0-9a-f]{7,12}\b/g, replacement: "<SHA>" },
];

/**
 * Mask a string deterministically. Applies every rule in order.
 */
export function maskString(input: string): string {
  let out = input;
  for (const rule of MASK_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Deeply mask a JSON value: strings are masked, objects/arrays recursed. Object
 * keys are sorted so key-ordering can never cause a spurious byte difference
 * (the masked form is canonicalized).
 */
export function maskValue(value: unknown): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[maskString(key)] = maskValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical masked serialization of a JSON value. Two values that differ ONLY in
 * masked fields (runId / timestamps / abs-paths) serialize byte-identically.
 */
export function maskedCanonicalJson(value: unknown): string {
  return JSON.stringify(maskValue(value), null, 2);
}

// CLI entrypoint: `run.sh scripts/mask.ts <file.json|->` masks stdin or a file
// and prints the canonical masked JSON. Documented integration point: this is
// the masking spine the variance comparator calls.
declare const Bun: { argv: string[] } | undefined;
async function main(): Promise<void> {
  const argv =
    typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const target = argv[0];
  let raw: string;
  if (!target || target === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    const { readFileSync } = await import("node:fs");
    raw = readFileSync(target, "utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    process.stdout.write(maskedCanonicalJson(parsed) + "\n");
  } catch {
    // Not JSON — mask as a plain string.
    process.stdout.write(maskString(raw));
  }
}

// import.meta.main is true only when executed directly (not when imported).
const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
