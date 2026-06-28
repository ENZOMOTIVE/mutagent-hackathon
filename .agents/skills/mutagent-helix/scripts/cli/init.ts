/**
 * scripts/cli/init.ts — @mutagent/helix installer.
 * Invoked as:  pnpx @mutagent/helix init
 *
 * Installs the Helix conductor + the bundled lifecycle-stage skills
 * (agentspec · diagnostics · evaluator) into the consumer's coding-agent config,
 * and links CLAUDE.md / AGENTS.md so the host boots Helix.
 *
 * Mirrors the @mutagent/diagnostics init discipline:
 *   - project-local install by DEFAULT (cwd/.claude); --global targets the home dir (W9-fix).
 *   - the child runs in the USER's invocation dir (no cwd override in the launcher).
 *   - offline + self-contained: every skill tree is bundled in this package, so init
 *     copies from the package — no network, no peer-install.
 *
 * Flags:
 *   --global   install into ~/.claude (default is <cwd>/.claude)
 *   --yes      non-interactive (assume yes); reserved for future multi-platform prompts
 *   --force    overwrite existing installed skill trees
 *   --json     emit only the InitDescriptor JSON (no human summary)
 *   --help     usage
 */

import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { toCodexAgentToml } from "./codex-transcode.ts";

// ── Types ─────────────────────────────────────────────────────────────────────
type Scope = "project" | "global";

interface SkillInstall {
  name: string;
  installed: boolean;
  skillPath: string;
  agentsCopied: number;
}

interface InitDescriptor {
  package: "@mutagent/helix";
  scope: Scope;
  projectRoot: string;
  claudeRoot: string;
  skills: SkillInstall[];
  claudeMdLinked: boolean;
  agentsMdLinked: boolean;
  codex: { skills: number; agents: number; skillsDir: string; agentsDir: string };
  nextAction: "boot";
  message: string;
}

// ── Package layout ──────────────────────────────────────────────────────────
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// .../.claude/skills/mutagent-helix/scripts/cli → up 5 to the package root
const PKG_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");

// The conductor skill + the lifecycle skills bundled in this package.
// helix carries the conductor surface (orchestrator.md + routing.yaml) assembled in.
const HELIX = "mutagent-helix";
const LIFECYCLE_SKILLS = [
  "mutagent-agentspec",
  "mutagent-diagnostics",
  "mutagent-evaluator",
] as const;

// Source skill-tree path inside the package for a given skill name.
function skillSrcDir(name: string): string {
  return name === HELIX
    ? join(PKG_ROOT, ".claude", "skills", HELIX)
    : join(PKG_ROOT, name, ".claude", "skills", name);
}

// Never carry dev-internal surfaces into a consumer, even when init runs from the
// repo (the published tarball is already scrubbed; this is defense-in-depth).
const COPY_DENY = [
  ".meta",
  ".engineeringrules",
  "internal",
  "node_modules",
  "__tests__",
  "tests",
  ".npmignore",
  ".DS_Store",
];
function copyFilter(src: string): boolean {
  const b = basename(src);
  if (COPY_DENY.includes(b)) return false;
  if (b.endsWith(".test.ts") || b.endsWith(".spec.ts")) return false;
  return true;
}

// ── Install one skill tree + its agents ──────────────────────────────────────
function installSkill(
  name: string,
  skillsDir: string,
  agentsDir: string,
  force: boolean
): SkillInstall {
  const src = skillSrcDir(name);
  const dest = join(skillsDir, name);
  const result: SkillInstall = {
    name,
    installed: false,
    skillPath: dest,
    agentsCopied: 0,
  };
  if (!existsSync(src)) {
    console.error(`  ✗ ${name}: source not found in package (${src})`);
    return result;
  }
  if (existsSync(dest) && !force) {
    console.info(`  • ${name}: already installed (use --force to overwrite) → ${dest}`);
  } else {
    mkdirSync(skillsDir, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true, filter: copyFilter });
  }
  result.installed = existsSync(join(dest, "SKILL.md"));

  // Agents: each skill ships its sub-agent contracts at assets/agents/*.md.
  const agentsSrc = join(src, "assets", "agents");
  if (existsSync(agentsSrc)) {
    mkdirSync(agentsDir, { recursive: true });
    for (const f of readdirSync(agentsSrc)) {
      if (!f.endsWith(".md")) continue;
      copyFileSync(join(agentsSrc, f), join(agentsDir, f));
      result.agentsCopied++;
    }
  }
  console.info(
    `  ${result.installed ? "✓" : "✗"} ${name} → ${dest}` +
      (result.agentsCopied ? ` (+${result.agentsCopied} agent${result.agentsCopied > 1 ? "s" : ""})` : "")
  );
  return result;
}

// Copy the orchestrator's deterministic engine scripts into the installed helix
// skill so `orchestrator.md`'s `<helix-skill>/scripts/*.ts` references resolve
// (the *sync indexer, render-roster, dispatch/gate, etc.). The engine lands
// alongside the bundled `scripts/cli/` — cpSync MERGES, never clobbers cli/.
// Runtime deps (@sinclair/typebox · yaml) are NOT installed here; if the engine
// is invoked without them the orchestrator degrades to its in-prose path.
function copyEngineScripts(helixDest: string): void {
  const src = join(PKG_ROOT, "mutagent-orchestrator", "scripts");
  if (!existsSync(src)) return;
  cpSync(src, join(helixDest, "scripts"), { recursive: true, force: true, filter: copyFilter });
}

// Assemble the conductor surface into the installed helix skill so it is
// self-contained post-install (SKILL.md → ./orchestrator.md, ./routing.yaml,
// ./scripts/*.ts engine).
function assembleHelixConductor(skillsDir: string): void {
  const dest = join(skillsDir, HELIX);
  const pairs: Array<[string, string]> = [
    [join(PKG_ROOT, "mutagent-orchestrator", "orchestrator.md"), join(dest, "orchestrator.md")],
    [join(PKG_ROOT, "mutagent-orchestrator", "routing.yaml"), join(dest, "routing.yaml")],
  ];
  for (const [from, to] of pairs) {
    if (existsSync(from)) copyFileSync(from, to);
  }
  copyEngineScripts(dest);
}

// ── CLAUDE.md / AGENTS.md linkage (non-destructive) ──────────────────────────
const BOOT_MARKER = "<!-- @mutagent/helix boot -->";
function helixBootBlock(orchestratorPath: string, extra = ""): string {
  return `${BOOT_MARKER}
# Helix — MutagenT ADL conductor

This project has the Helix orchestrator installed. To boot it, read and adopt the agent
definition at \`${orchestratorPath}\` (run its activation-instructions: persona → system index →
ADL dashboard), then await a \`*command\`.

Trigger: \`*mutagent\` · \`/mutagent-helix\` · \`boot\`.${extra}
${BOOT_MARKER}
`;
}

// Codex normalizes long output into concise Markdown; this forces literal template stamping.
const CODEX_DASHBOARD_RULE = `

DASHBOARD RENDERING — HARD RULE (Codex): on \`*mutagent\`/\`boot\`/\`*help\`/\`*status\`, output the
orchestrator's \`help-display-template\` VERBATIM inside a fenced \`text\` code block. Preserve its
EXACT shape — the boxed MUTAGENT header (box-drawing chars), every panel (lifecycle · system index ·
setup/onboarding · state), and the command roster. Replace ONLY the \`{placeholder}\` tokens with
live values; change NOTHING else. Do NOT summarize, shorten, paraphrase, drop panels, or convert it
to Markdown headings/tables/bullets unless the operator explicitly asks for a condensed view.`;

// Upsert the managed boot block: create the file, replace the marked block (so a
// re-run updates routing), or append it — never clobber the user's other content.
function upsertBootBlock(path: string, block: string): "created" | "updated" | "appended" {
  if (!existsSync(path)) {
    writeFileSync(path, block);
    return "created";
  }
  const cur = readFileSync(path, "utf8");
  const re = new RegExp(`${BOOT_MARKER}[\\s\\S]*?${BOOT_MARKER}\\n?`);
  if (re.test(cur)) {
    const next = cur.replace(re, block);
    if (next !== cur) writeFileSync(path, next);
    return "updated";
  }
  writeFileSync(path, cur.replace(/\s*$/, "") + "\n\n" + block);
  return "appended";
}

function linkClaudeAgents(configRoot: string): { claudeMd: boolean; agentsMd: boolean } {
  mkdirSync(configRoot, { recursive: true });
  // Runtime-NATIVE boot routing: Claude reads CLAUDE.md → .claude/ ; Codex reads
  // AGENTS.md → its native .agents/skills/ (+ the literal-dashboard hard rule).
  const c = upsertBootBlock(
    join(configRoot, "CLAUDE.md"),
    helixBootBlock(".claude/skills/mutagent-helix/orchestrator.md")
  );
  const a = upsertBootBlock(
    join(configRoot, "AGENTS.md"),
    helixBootBlock(".agents/skills/mutagent-helix/orchestrator.md", CODEX_DASHBOARD_RULE)
  );
  console.info(`  ✓ CLAUDE.md (${c}) → .claude/skills/mutagent-helix/orchestrator.md`);
  console.info(
    `  ✓ AGENTS.md (${a}) → .agents/skills/mutagent-helix/orchestrator.md (+ Codex dashboard hard-rule)`
  );
  return { claudeMd: c !== "appended", agentsMd: a !== "appended" };
}

// ── Install for Codex (always PROJECT-LOCAL, in the dir init runs in) ─────────
// Codex loads skills from `.agents/skills/` and auto-loads spawnable subagents
// from project `.codex/agents/*.toml`. We write both: the skill trees (agents
// ride along intact in assets/agents/) → .agents/skills/, AND each agent .md
// transcoded to the correct FLAT Codex .toml → .codex/agents/.
interface CodexInstall {
  agentsSkillsDir: string;
  codexAgentsDir: string;
  skillsInstalled: number;
  agentsTranscoded: number;
}

function installCodex(projectRoot: string, force: boolean): CodexInstall {
  const agentsSkillsDir = join(projectRoot, ".agents", "skills"); // Codex native skill location
  const codexAgentsDir = join(projectRoot, ".codex", "agents"); // Codex project custom agents
  let skillsInstalled = 0;
  let agentsTranscoded = 0;

  // 1) Skills → .agents/skills/<name>/ (same tree, agents intact in assets/agents/)
  mkdirSync(agentsSkillsDir, { recursive: true });
  for (const name of [HELIX, ...LIFECYCLE_SKILLS]) {
    const src = skillSrcDir(name);
    if (!existsSync(src)) continue;
    const dest = join(agentsSkillsDir, name);
    if (!existsSync(dest) || force) {
      cpSync(src, dest, { recursive: true, force: true, filter: copyFilter });
    }
    if (existsSync(join(dest, "SKILL.md"))) skillsInstalled++;
  }
  // assemble the conductor surface into the Codex helix skill too
  const helixDest = join(agentsSkillsDir, HELIX);
  for (const f of ["orchestrator.md", "routing.yaml"]) {
    const from = join(PKG_ROOT, "mutagent-orchestrator", f);
    if (existsSync(from)) copyFileSync(from, join(helixDest, f));
  }
  copyEngineScripts(helixDest);

  // 2) Agents → .codex/agents/<name>.toml (flat Codex-native transcode, intact)
  mkdirSync(codexAgentsDir, { recursive: true });
  for (const name of LIFECYCLE_SKILLS) {
    const agentsSrc = join(skillSrcDir(name), "assets", "agents");
    if (!existsSync(agentsSrc)) continue;
    for (const f of readdirSync(agentsSrc)) {
      if (!f.endsWith(".md")) continue;
      const toml = toCodexAgentToml(readFileSync(join(agentsSrc, f), "utf8"));
      writeFileSync(join(codexAgentsDir, f.replace(/\.md$/, ".toml")), toml);
      agentsTranscoded++;
    }
  }
  console.info(
    `  ✓ Codex → ${skillsInstalled} skills in .agents/skills/ · ${agentsTranscoded} agents in .codex/agents/*.toml`
  );
  return { agentsSkillsDir, codexAgentsDir, skillsInstalled, agentsTranscoded };
}

// ── main ──────────────────────────────────────────────────────────────────────
function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      global: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.info(
      `pnpx @mutagent/helix init [--global] [--yes] [--force] [--json]\n` +
        `  installs the Helix conductor + lifecycle skills (agentspec · diagnostics · evaluator)\n` +
        `  and links CLAUDE.md / AGENTS.md. Default scope is project-local (<cwd>/.claude).`
    );
    process.exit(0);
  }

  const scope: Scope = values.global ? "global" : "project";
  const projectRoot = process.cwd();
  const configRoot = scope === "global" ? join(homedir(), ".claude") : join(projectRoot, ".claude");
  const skillsDir = join(configRoot, "skills");
  const agentsDir = join(configRoot, "agents");

  if (!values.json) {
    console.info(`\n🧬 Installing @mutagent/helix (${scope}-scope) → ${configRoot}\n`);
  }

  const skills: SkillInstall[] = [];
  // Conductor first, then the lifecycle skills.
  skills.push(installSkill(HELIX, skillsDir, agentsDir, !!values.force));
  assembleHelixConductor(skillsDir);
  for (const name of LIFECYCLE_SKILLS) {
    skills.push(installSkill(name, skillsDir, agentsDir, !!values.force));
  }

  // CLAUDE/AGENTS linkage lands at the config root (project: <cwd>; global: ~/.claude).
  const linkRoot = scope === "global" ? configRoot : projectRoot;
  const { claudeMd, agentsMd } = linkClaudeAgents(linkRoot);

  // Codex install — ALWAYS, project-local (the dir init runs in), alongside Claude.
  const codex = installCodex(projectRoot, !!values.force);

  const installedCount = skills.filter((s) => s.installed).length;
  const descriptor: InitDescriptor = {
    package: "@mutagent/helix",
    scope,
    projectRoot,
    claudeRoot: configRoot,
    skills,
    claudeMdLinked: claudeMd || existsSync(join(linkRoot, "CLAUDE.md")),
    agentsMdLinked: agentsMd || existsSync(join(linkRoot, "AGENTS.md")),
    codex: {
      skills: codex.skillsInstalled,
      agents: codex.agentsTranscoded,
      skillsDir: codex.agentsSkillsDir,
      agentsDir: codex.codexAgentsDir,
    },
    nextAction: "boot",
    message:
      `Installed ${installedCount}/${skills.length} skills (Claude: .claude/ · Codex: .agents/skills/ + ` +
      `${codex.agentsTranscoded} agents in .codex/agents/). Boot via *mutagent (or /mutagent-helix).`,
  };

  if (values.json) {
    console.log(JSON.stringify(descriptor, null, 2));
  } else {
    console.info(`\n✅ ${descriptor.message}\n`);
  }

  // Fail loud if the conductor itself did not install.
  const helixOk = skills.find((s) => s.name === HELIX)?.installed === true;
  process.exit(helixOk && installedCount > 0 ? 0 : 1);
}

main();
