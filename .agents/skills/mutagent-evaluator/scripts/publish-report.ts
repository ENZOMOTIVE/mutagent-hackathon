/**
 * scripts/publish-report.ts — UI-13: the publish-time STRIPPER (client-safe HTML).
 * ---------------------------------------------------------------------------
 * The eval-report (`render-eval-report.ts`) is INTERNAL-grade: it carries a §5
 * Self-Eval [INTERNAL] calibration panel + `data-strip="strip-for-client"` markers
 * + raw triggering INPUT (§2) and verbatim EVIDENCE (§4) that may contain PII when
 * the source batch was NOT pre-sanitized. Those markers were declarative ONLY — no
 * code enforced them. This module enforces them:
 *
 *   stripForClient(html, opts) →
 *     ALWAYS removes  · the §5 internal panel (`<section id="t5">…`)
 *                     · the internal tab-button (`.tab-btn.internal`)
 *                     · every `data-strip="strip-for-client"` node
 *     PII gate (unless opts.assumeSanitized) →
 *                     · BLANKS the raw triggering inputs embedded in the §2 ledger
 *                       data blob (`data-pii="ledger"` script: `"input":"…"` → "")
 *                     · REDACTS the §4 verbatim-evidence regions (`data-pii="evidence"`)
 *
 * The result is a CLIENT-SAFE HTML string: no §5/INTERNAL content, and (by default)
 * no raw PII dumped onto the public tabs. Pass `{ assumeSanitized: true }` (CLI:
 * `--assume-sanitized`) ONLY for a batch you have CONFIRMED carries no PII — then the
 * raw input + verbatim evidence are preserved.
 *
 * PURE + deterministic: a string→string transform, no clock/random, no I/O (the CLI
 * wrapper at the bottom does the read/write). Idempotent: stripping an already-
 * stripped HTML is a no-op (the markers are gone, the regexes match nothing).
 */

export interface StripOptions {
  /** When TRUE, the batch is asserted PII-free: raw input + verbatim evidence are
   *  PRESERVED (only the §5 internal panel is stripped). DEFAULT false — the PII
   *  gate redacts raw input + evidence so an un-sanitized batch never leaks. */
  assumeSanitized?: boolean;
}

/** The placeholder substituted for a redacted PII region (publish, un-sanitized). */
export const PII_REDACTION =
  "⟨redacted on publish — raw content withheld; re-run with --assume-sanitized for a confirmed-PII-free batch⟩";

/**
 * Strip the INTERNAL surfaces (and, unless `assumeSanitized`, the raw PII) from a
 * rendered eval-report → a client-safe HTML string. See the module header.
 */
export function stripForClient(html: string, opts: StripOptions = {}): string {
  let out = html;

  // 1) ALWAYS — remove the §5 Self-Eval [INTERNAL] panel (whole <section id="t5">).
  out = out.replace(/<section\b[^>]*\bid="t5"[^>]*>[\s\S]*?<\/section>/g, "");

  // 2) ALWAYS — remove the internal tab-button (.tab-btn.internal → data-tab="t5").
  out = out.replace(/<button\b[^>]*\bclass="tab-btn internal"[^>]*>[\s\S]*?<\/button>/g, "");

  // 3) ALWAYS — remove every node explicitly marked `data-strip="strip-for-client"`
  //    (tag-agnostic; matches the element + its content). Any leftover after (1).
  out = out.replace(
    /<(\w+)\b[^>]*\bdata-strip="strip-for-client"[^>]*>[\s\S]*?<\/\1>/g,
    "",
  );

  // 4) PII GATE — unless the batch is asserted sanitized, scrub the raw PII.
  if (opts.assumeSanitized !== true) {
    // 4a) BLANK the raw triggering INPUTs embedded in the §2 ledger data blob. The
    //     blob is the `data-pii="ledger"` <script>; within it, every `"input":"…"`
    //     JSON value (the verbatim user/agent prompt) is emptied. The JSON-string
    //     pattern `"(?:[^"\\]|\\.)*"` correctly spans escaped quotes.
    out = out.replace(
      /(<script\b[^>]*\bdata-pii="ledger"[^>]*>)([\s\S]*?)(<\/script>)/g,
      (_m, open: string, body: string, close: string) =>
        open + body.replace(/"input":"(?:[^"\\]|\\.)*"/g, '"input":""') + close,
    );

    // 4b) REDACT the §4 verbatim-evidence regions (`data-pii="evidence"`): replace
    //     the element's INNER content with the redaction placeholder (keep the tags
    //     so the layout is intact). No nested same-tag inside these cells.
    out = out.replace(
      /(<(\w+)\b[^>]*\bdata-pii="evidence"[^>]*>)[\s\S]*?(<\/\2>)/g,
      (_m, open: string, _tag: string, close: string) => open + PII_REDACTION + close,
    );
  }

  return out;
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
//
// bun scripts/publish-report.ts <report.html> [out.client.html] [--assume-sanitized]
// Reads a rendered eval-report, strips the INTERNAL surfaces (+ PII unless the flag),
// and writes the client-safe HTML. Default out = `<input>.client.html`.

declare const Bun: { argv: string[] } | undefined;

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [inputPath, outArg] = positional;
  if (!inputPath) {
    console.error(
      "usage: publish-report.ts <report.html> [out.client.html] [--assume-sanitized]",
    );
    process.exit(2);
    return;
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const assumeSanitized = flags.has("--assume-sanitized");
  const html = readFileSync(inputPath, "utf8");
  const client = stripForClient(html, { assumeSanitized });
  const outPath = outArg ?? inputPath.replace(/\.html$/i, "") + ".client.html";
  writeFileSync(outPath, client);
  console.info(
    JSON.stringify(
      {
        input: inputPath,
        output: outPath,
        assumeSanitized,
        strippedInternalPanel: !client.includes('id="t5"'),
        piiGated: !assumeSanitized,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
