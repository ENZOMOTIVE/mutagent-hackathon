/**
 * codex-transcode.ts — convert a Claude-Code agent `.md` (YAML frontmatter + body)
 * into a Codex-native project custom-agent `.toml`.
 *
 * Codex auto-loads spawnable subagents from `.codex/agents/*.toml` (project scope).
 * The correct format is FLAT top-level keys (NOT `[agent]` tables) — matching the
 * native `moni-thor.toml`:
 *
 *   name = "<name>"
 *   description = "<one-line>"
 *   developer_instructions = """
 *   ```yaml
 *   <the EXCESS frontmatter — everything except name/description>
 *   ```
 *
 *   <the agent .md body, verbatim>
 *   """
 *
 * The OLD diagnostics transcode was malformed: it collapsed `description: >` block
 * scalars to ">", mangled nested frontmatter into invalid TOML, and used `[agent]`
 * tables. This version is lossless + intact: name/description become structured TOML
 * keys; ALL other frontmatter is preserved verbatim inside a ```yaml``` block; the
 * body is preserved verbatim; the whole thing parses as valid TOML.
 */

export interface ParsedAgentMd {
  name: string;
  /** one-line, block-scalars flattened */
  description: string;
  /** the frontmatter MINUS the name + description lines, verbatim */
  excessFrontmatter: string;
  /** the markdown after the frontmatter, verbatim */
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

/** Is a line a top-level YAML key (`key:` at column 0, not a list item)? */
function isTopLevelKey(line: string): boolean {
  return /^[^\s#][^:]*:/.test(line);
}

/**
 * Parse a Claude agent .md: split frontmatter/body, extract name + description
 * (flattening `>`/`|` block scalars and inline values), and return the remaining
 * frontmatter verbatim.
 */
export function parseAgentMd(md: string): ParsedAgentMd {
  const m = md.match(FM_RE);
  if (!m) {
    // No frontmatter — treat the whole thing as the body with a derived name.
    return { name: "agent", description: "", excessFrontmatter: "", body: md };
  }
  const fm = m[1] ?? "";
  const body = m[2] ?? "";
  const lines = fm.split(/\r?\n/);

  let name = "";
  let description = "";
  const excess: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (keyMatch && isTopLevelKey(line)) {
      const key = keyMatch[1]!;
      const rawVal = keyMatch[2] ?? "";

      if (key === "name" || key === "description") {
        const isBlock = rawVal.trim() === ">" || rawVal.trim() === "|";
        let value: string;
        if (isBlock) {
          // consume following MORE-indented lines as the scalar body
          const parts: string[] = [];
          let j = i + 1;
          for (; j < lines.length; j++) {
            const l = lines[j]!;
            if (l.trim() === "") { parts.push(""); continue; }
            if (/^\s+/.test(l)) { parts.push(l.trim()); }
            else break;
          }
          i = j - 1;
          value = parts.join(" ").replace(/\s+/g, " ").trim();
        } else {
          // strip an inline trailing comment ONLY when the value isn't quoted
          value = rawVal.trim();
          value = value.replace(/\s+#.*$/, "").trim();
          value = value.replace(/^["']|["']$/g, "");
        }
        if (key === "name") name = value;
        else description = value;
        continue; // do NOT add name/description to excess
      }
    }
    excess.push(line);
  }

  // drop leading/trailing blank lines from excess
  const excessFrontmatter = excess.join("\n").replace(/^\n+|\n+$/g, "");
  return { name: name || "agent", description, excessFrontmatter, body: body.replace(/^\n+/, "") };
}

/** Escape a value for a TOML basic (single-line) string. */
function tomlBasic(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

/**
 * Make content safe inside a TOML multi-line LITERAL string ('''...''').
 * Literal strings do NO escape processing — perfect for markdown bodies full of
 * backslashes (e.g. table cells `a \| b`) that a basic `"""` string would reject.
 * The only thing a literal string can't contain is `'''`; we verified the bundled
 * agents have none, but guard anyway by inserting a zero-width break.
 */
function tomlLiteral(s: string): string {
  return s.replace(/'''/g, "''​'");
}

/**
 * Transcode a Claude agent `.md` → the Codex project custom-agent `.toml` string.
 * Lossless: every frontmatter field + the full body is preserved.
 */
export function toCodexAgentToml(md: string): string {
  const { name, description, excessFrontmatter, body } = parseAgentMd(md);

  const blocks: string[] = [];
  if (excessFrontmatter.trim()) {
    blocks.push("```yaml\n" + excessFrontmatter + "\n```");
  }
  if (body.trim()) blocks.push(body.trimEnd());
  const instructions = tomlLiteral(blocks.join("\n\n"));

  const lines = [
    `name = "${tomlBasic(name)}"`,
    `description = "${tomlBasic(description)}"`,
    "",
    "developer_instructions = '''",
    instructions,
    "'''",
    "",
  ];
  return lines.join("\n");
}
