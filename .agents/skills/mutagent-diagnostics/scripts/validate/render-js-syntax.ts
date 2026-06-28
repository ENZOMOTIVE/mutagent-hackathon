/**
 * scripts/validate/render-js-syntax.ts
 * W12-02 (P7 / propose PR-050): Inline-JS syntax gate for RENDERED HTML.
 *
 * Data-shape gates (completeness-check, findings-contract) cannot catch
 * interactivity-breaking JavaScript — a single asymmetric-escape in a template
 * literal (W12-01: `/\r?\\n/` emitting a literal-CR regex) produces a
 * SyntaxError that silently kills the whole live-preview IIFE, so check/uncheck
 * + Copy go dead while every data gate still passes.
 *
 * This gate extracts every executable `<script>` body from a rendered HTML file
 * and parses each with `new Function(body)` — which throws on SyntaxError
 * WITHOUT executing the body (no DOM, no side effects). Non-executable scripts
 * (external `src=`, `application/ld+json`, `text/plain` payloads) are skipped.
 *
 * Export: `checkRenderJsSyntax(html): RenderJsSyntaxResult` (pure function).
 * CLI: `if (import.meta.main)` — exit 0 on all-parse, exit 1 + offending
 *   script index/snippet on any parse error.
 *
 * Type A — Pure Script (deterministic; CLI file read only).
 */

// ── Result shapes ─────────────────────────────────────────────────────────────

/** One inline-JS parse error, keyed to the script's position in the document. */
export interface RenderJsSyntaxError {
  /** 0-based index of the executable script among all parsed scripts. */
  scriptIndex: number;
  /** The SyntaxError message from `new Function`. */
  message: string;
  /** A short snippet of the offending body (first ~200 chars, single-lined). */
  snippet: string;
}

/** Outcome of the inline-JS syntax gate. */
export interface RenderJsSyntaxResult {
  /** True when every executable `<script>` body parses. */
  pass: boolean;
  /** Count of executable `<script>` bodies that were parsed. */
  scriptsChecked: number;
  /** Parse errors (empty when pass). */
  errors: RenderJsSyntaxError[];
}

// ── Script extraction ─────────────────────────────────────────────────────────

/**
 * `type` attribute values that mark a `<script>` as NON-executable data, not JS.
 * These bodies are intentionally not valid JS (JSON-LD, plain-text payloads) and
 * must NOT be parsed by this gate.
 */
const NON_JS_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "application/ld+json",
  "application/json",
  "text/plain",
  "text/template",
  "text/html",
]);

/** Matches a whole `<script ...>...</script>` element (greedy-safe, non-nested). */
const SCRIPT_ELEMENT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
/** Extracts a `src="..."` / `src='...'` attribute value. */
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']*)["']/i;
/** Extracts a `type="..."` / `type='...'` attribute value. */
const TYPE_ATTR_RE = /\btype\s*=\s*["']([^"']*)["']/i;

/**
 * Extract every EXECUTABLE inline-script body from a rendered HTML string.
 *
 * Skips:
 *   - external scripts (`<script src=...>`) — no inline body to parse
 *   - data scripts (`type` in NON_JS_SCRIPT_TYPES) — intentionally non-JS
 *   - empty / whitespace-only bodies
 *
 * Returns the bodies in document order.
 */
export function extractInlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  SCRIPT_ELEMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_ELEMENT_RE.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";

    // External script — no inline body to parse.
    if (SRC_ATTR_RE.test(attrs)) continue;

    // Non-executable data script (JSON-LD, text/plain payload, etc.).
    const typeMatch = TYPE_ATTR_RE.exec(attrs);
    if (typeMatch) {
      const declaredType = typeMatch[1].trim().toLowerCase();
      // Anything that isn't an explicit JS module/classic type is treated as
      // data when it appears in the NON_JS set; module/text-javascript fall
      // through to be parsed.
      if (NON_JS_SCRIPT_TYPES.has(declaredType)) continue;
    }

    if (body.trim().length === 0) continue;

    bodies.push(body);
  }
  return bodies;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/** Single-line, length-bounded snippet for error reporting. */
function snippetOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * W12-02: Parse every executable inline-script body in a rendered HTML document.
 * Pure function — same input, same output. Uses `new Function(body)` which
 * throws on SyntaxError WITHOUT executing the body.
 */
export function checkRenderJsSyntax(html: string): RenderJsSyntaxResult {
  const bodies = extractInlineScriptBodies(html);
  const errors: RenderJsSyntaxError[] = [];

  bodies.forEach((body, scriptIndex) => {
    try {
      // `new Function(body)` parses the body and throws on SyntaxError WITHOUT
      // executing it (no call site) — exactly the parse-only check we want.
      new Function(body);
    } catch (err) {
      errors.push({
        scriptIndex,
        message: err instanceof Error ? err.message : String(err),
        snippet: snippetOf(body),
      });
    }
  });

  return {
    pass: errors.length === 0,
    scriptsChecked: bodies.length,
    errors,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");

  const argv = process.argv.slice(2);
  const htmlPath = argv[0];

  if (!htmlPath) {
    process.stderr.write(
      "Usage: bun scripts/validate/render-js-syntax.ts <rendered-report.html>\n" +
        "\n" +
        "Parses every executable inline <script> body in a rendered HTML report\n" +
        "(via new Function — no execution). Exit 0 = all parse, Exit 1 = SyntaxError.\n"
    );
    process.exit(1);
  }

  let html: string;
  try {
    html = readFileSync(resolve(htmlPath), "utf8");
  } catch (err) {
    process.stderr.write(`Error reading ${htmlPath}: ${err}\n`);
    process.exit(1);
  }

  const result = checkRenderJsSyntax(html);

  if (result.pass) {
    process.stdout.write(
      `[render-js-syntax] PASS — ${result.scriptsChecked} inline script(s) parse cleanly.\n`
    );
    process.exit(0);
  } else {
    process.stderr.write(
      `[render-js-syntax] FAIL — ${result.errors.length} inline script(s) failed to parse ` +
        `(of ${result.scriptsChecked} checked):\n`
    );
    result.errors.forEach((e) => {
      process.stderr.write(`  script #${e.scriptIndex}: ${e.message}\n`);
      process.stderr.write(`    ${e.snippet}\n`);
    });
    process.exit(1);
  }
}
