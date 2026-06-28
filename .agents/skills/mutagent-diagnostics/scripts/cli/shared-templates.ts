/**
 * scripts/cli/shared-templates.ts
 *
 * Offline resolver for the BUNDLED shared install-time templates.
 *
 * These templates (self-diagnosis-contract, spec.yaml, team.yaml, iter-handover,
 * wave-dashboard) were historically peer-installed from `@mutagent/templates`.
 * For the npm public release of `@mutagent/diagnostics` they are bundled directly
 * into the skill tree at `<skill-root>/assets/templates/shared/`, so the package
 * is fully self-contained — `init` works offline with NO dependency on
 * `@mutagent/templates`.
 *
 * Resolution mirrors `report/render.ts::defaultTemplatePath()`: resolve relative
 * to this script's own directory so it is CWD-independent. From `scripts/cli/`
 * the skill root is two levels up, then `assets/templates/shared`.
 */

import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";

/** Canonical bundled-shared-templates filenames (provenance: @mutagent/templates). */
export const SHARED_TEMPLATE_FILES = [
  "self-diagnosis-contract.v0.1.0.yaml.tpl",
  "spec.yaml.tpl",
  "team.yaml.tpl",
  "iter-N-handover.md.tpl",
  "wave-N-dashboard.html.tpl",
] as const;

export type SharedTemplateFile = (typeof SHARED_TEMPLATE_FILES)[number];

/**
 * Resolve this script's directory in both Bun and Node, with no `import.meta.url`
 * fallback surprises (mirrors the pattern used across the skill's CLI scripts).
 */
function scriptDir(): string {
  return (
    import.meta.dirname ??
    dirname(import.meta.url.replace(/^file:\/\//, ""))
  );
}

/**
 * Absolute path to the bundled shared-templates directory:
 * `<skill-root>/assets/templates/shared`.
 *
 * From `scripts/cli/` the skill root is `../..`.
 */
export function sharedTemplatesDir(): string {
  return join(scriptDir(), "..", "..", "assets", "templates", "shared");
}

/**
 * Absolute path to a single bundled shared template by filename.
 * Does NOT assert existence — callers that need a hard guarantee should use
 * `assertSharedTemplatesPresent()` first (the prepublish guard does).
 */
export function sharedTemplatePath(file: SharedTemplateFile): string {
  return join(sharedTemplatesDir(), file);
}

/**
 * True only if the bundled shared-templates directory exists AND contains every
 * canonical template file. Used by the prepublish guard to prove the package is
 * self-contained before it ships.
 */
export function assertSharedTemplatesPresent(): {
  ok: boolean;
  dir: string;
  missing: string[];
} {
  const dir = sharedTemplatesDir();
  if (!existsSync(dir)) {
    return { ok: false, dir, missing: [...SHARED_TEMPLATE_FILES] };
  }
  const present = new Set(readdirSync(dir));
  const missing = SHARED_TEMPLATE_FILES.filter((f) => !present.has(f));
  return { ok: missing.length === 0, dir, missing };
}
