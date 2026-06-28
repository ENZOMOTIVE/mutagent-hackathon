/**
 * scripts/lint/template-inline-js.ts
 * R-007-B: Template inline-JS TypeScript lint.
 *
 * Walks assets/templates/*.html and *.html.tpl and extracts every <script> block whose
 * type attribute is empty or "text/javascript" (i.e. executable scripts,
 * NOT type="application/ld+json" or similar data blocks).
 *
 * Rejects TypeScript-specific patterns:
 *   - Type annotations:      `: string`, `: number`, `: boolean`, `: HTMLElement`,
 *                            `: HTMLInputElement`, `: any`, `: void`
 *   - Type assertions:       `as SomeType` (capital-letter identifiers)
 *   - Interfaces:            `interface Foo {`
 *   - Type aliases:          `type Foo =`
 *   - Generic functions:     `function f<T>(`
 *
 * Exit 0 = all templates pass.
 * Exit 1 = at least one pattern found — prints actionable error with file + line.
 *
 * Usage: bun scripts/lint/template-inline-js.ts [--templates-dir <path>]
 *        Defaults to assets/templates/ relative to this script's location.
 *        Scans *.html and *.html.tpl files (R-015-A: added .html.tpl support).
 *
 * Type A — Pure Script (no LLM, no agent ops, deterministic lint only).
 */

import { readFileSync, readdirSync } from "fs";
import { resolve, dirname as pathDirname, join, basename } from "path";

// ── Forbidden TypeScript patterns in inline executable <script> blocks ─────────

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Type annotations: `: string`, `: number`, `: boolean`, `: any`, `: void`
  {
    pattern: /:\s*(string|number|boolean|any|void)\b/,
    label: "TypeScript type annotation (: string|number|boolean|any|void)",
  },
  // HTML element type annotations: `: HTMLElement`, `: HTMLInputElement`
  {
    pattern: /:\s*(HTMLElement|HTMLInputElement)\b/,
    label: "TypeScript DOM type annotation (: HTMLElement | HTMLInputElement)",
  },
  // Type assertions: `as HTMLElement`, `as SomeUpperCaseIdentifier`
  {
    pattern: /\bas\s+[A-Z][a-zA-Z]+\b/,
    label: "TypeScript type assertion (as SomeType)",
  },
  // Interface declarations: `interface Foo {`
  {
    pattern: /\binterface\s+\w+\s*\{/,
    label: "TypeScript interface declaration",
  },
  // Type alias declarations: `type Foo =`
  {
    pattern: /\btype\s+\w+\s*=/,
    label: "TypeScript type alias",
  },
  // Generic function syntax: `function f<T>(`
  {
    pattern: /\bfunction\s+\w+\s*<[A-Za-z][\w,\s]*>\s*\(/,
    label: "TypeScript generic function",
  },
];

// ── Script block extraction ────────────────────────────────────────────────────

interface ScriptBlock {
  content: string;
  startLine: number;  // 1-indexed, line of the opening <script> tag
}

/**
 * Extract all executable <script> blocks from an HTML string.
 * Executable = type attribute is absent, empty, or "text/javascript".
 * Explicitly EXCLUDES type="application/ld+json" and other non-executable types.
 */
function extractExecutableScriptBlocks(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  // Match <script ...> ... </script> (non-greedy, handles multiline)
  const scriptTagRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptTagRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const content = match[2] ?? "";

    // Extract type attribute value
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]*)["']?/i);
    const typeValue = typeMatch ? typeMatch[1].toLowerCase() : "";

    // Skip non-executable script blocks
    if (typeValue && typeValue !== "text/javascript") {
      continue;
    }

    // Calculate starting line number
    const before = html.slice(0, match.index);
    const startLine = (before.match(/\n/g)?.length ?? 0) + 1;

    blocks.push({ content, startLine });
  }
  return blocks;
}

// ── R-015-A: Literal newline inside JS string literal ─────────────────────────

/**
 * Detect lines where a JS string literal (single- or double-quoted) contains a
 * raw LF — i.e., the quote is opened but not closed before end-of-line.
 * Such strings cause `SyntaxError: Unexpected token ILLEGAL` in all browsers.
 *
 * Algorithm per line:
 *  1. Strip properly-closed string literals (handles \' and \\ escapes inside)
 *     so their closing quotes don't produce false positives.
 *  2. After stripping, any remaining quote at end-of-line = unclosed string
 *     spanning a literal newline.
 *
 * Limitation: does not handle template literals (`\`...\``) or regex literals —
 * acceptable for a regression guard on simple browser-executable template JS.
 */
function detectLiteralNewlinesInBlock(
  block: ScriptBlock,
  filePath: string
): LintError[] {
  const errors: LintError[] = [];
  const lines = block.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Strip complete single-quoted strings (including internal \'  and \\ escapes)
    let stripped = line.replace(/'(?:[^'\\]|\\.)*'/g, "__STR__");
    // Strip complete double-quoted strings
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, "__STR__");

    // After stripping matched pairs, an unclosed quote at EOL = literal newline in string
    const singleUnclosed = /'[^']*$/.test(stripped);
    const doubleUnclosed = /"[^"]*$/.test(stripped);

    if (singleUnclosed || doubleUnclosed) {
      errors.push({
        file: filePath,
        scriptStartLine: block.startLine,
        contentLine: i + 1,
        absoluteLine: block.startLine + i,
        pattern:
          "Literal newline inside JS string literal (use '\\n' escape instead — R-015-A)",
        match: line.trim().slice(0, 120),
      });
    }
  }

  return errors;
}

// ── Main lint runner ───────────────────────────────────────────────────────────

interface LintError {
  file: string;
  scriptStartLine: number;
  contentLine: number;    // line within the script block content (1-indexed)
  absoluteLine: number;   // approximate line in the HTML file
  pattern: string;
  match: string;
}

function lintTemplateFile(filePath: string): LintError[] {
  const html = readFileSync(filePath, "utf8");
  const blocks = extractExecutableScriptBlocks(html);
  const errors: LintError[] = [];

  for (const block of blocks) {
    // Check TypeScript-specific forbidden patterns (line by line)
    const lines = block.content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            file: filePath,
            scriptStartLine: block.startLine,
            contentLine: lineIdx + 1,
            absoluteLine: block.startLine + lineIdx,
            pattern: label,
            match: line.trim().slice(0, 120),
          });
        }
      }
    }
    // R-015-A: check for literal newlines inside single/double-quoted string literals
    errors.push(...detectLiteralNewlinesInBlock(block, filePath));
  }
  return errors;
}

function resolveTemplatesDir(args: string[]): string {
  const flagIdx = args.indexOf("--templates-dir");
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    return resolve(args[flagIdx + 1]);
  }
  // Default: assets/templates/ relative to this script (scripts/lint/ → ../.. → skill root)
  const scriptDir = import.meta.dirname ?? pathDirname(import.meta.url.replace("file://", ""));
  return join(scriptDir, "..", "..", "assets", "templates");
}

// ── Entrypoint ─────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const templatesDir = resolveTemplatesDir(args);

  let htmlFiles: string[];
  try {
    htmlFiles = readdirSync(templatesDir)
      .filter((f) => f.endsWith(".html") || f.endsWith(".html.tpl"))
      .map((f) => join(templatesDir, f));
  } catch (err) {
    process.stderr.write(`[template-inline-js] ERROR: Could not read templates directory: ${templatesDir}\n  ${err}\n`);
    process.exit(1);
  }

  if (htmlFiles.length === 0) {
    process.stdout.write(`[template-inline-js] No .html files found in ${templatesDir} — nothing to lint.\n`);
    process.exit(0);
  }

  const allErrors: LintError[] = [];

  for (const file of htmlFiles) {
    const errors = lintTemplateFile(file);
    allErrors.push(...errors);
  }

  if (allErrors.length === 0) {
    process.stdout.write(
      `[template-inline-js] PASS — ${htmlFiles.length} template(s) checked, 0 TypeScript patterns found.\n`
    );
    process.exit(0);
  }

  // Report errors
  process.stderr.write(
    `[template-inline-js] FAIL — TypeScript patterns found in inline <script> blocks.\n` +
    `Templates must use plain JavaScript only (no TypeScript syntax in browser-executed script tags).\n\n`
  );

  for (const err of allErrors) {
    process.stderr.write(
      `  ${basename(err.file)}:${err.absoluteLine} — ${err.pattern}\n` +
      `    Line: ${err.match}\n`
    );
  }

  process.stderr.write(
    "\n" + allErrors.length + " error(s) found in " + new Set(allErrors.map((e) => e.file)).size + " file(s).\n" +
    "FIX: Remove TypeScript syntax and literal newlines from inline <script type=\"text/javascript\"> blocks.\n" +
    "  Type annotations: remove ': Type' suffixes\n" +
    "  Type assertions: replace 'x as HTMLElement' with plain 'x'\n" +
    "  Interfaces/types: move to a separate .ts compilation step\n" +
    "  Literal newlines: replace join('\\n') spanning two lines with join('\\\\n') on one line (R-015-A)\n"
  );
  process.exit(1);
}

// Export for testing
export { extractExecutableScriptBlocks, lintTemplateFile, detectLiteralNewlinesInBlock, FORBIDDEN_PATTERNS };
export type { ScriptBlock, LintError };
