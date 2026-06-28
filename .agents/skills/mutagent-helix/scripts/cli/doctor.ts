/**
 * scripts/cli/doctor.ts — @mutagent/helix runtime probe.
 * Invoked as:  pnpx @mutagent/helix doctor
 *
 * Reports what Helix sees: which skills are installed in the consumer's .claude,
 * how many agents are present, and whether CLAUDE.md / AGENTS.md are linked.
 * Read-only — never writes. Mirrors the diagnostics doctor discipline.
 *
 * Flags:
 *   --global   probe ~/.claude (default is <cwd>/.claude)
 *   --json     emit only the DoctorReport JSON
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

interface SkillProbe {
  name: string;
  present: boolean;
  hasSkillMd: boolean;
}

interface DoctorReport {
  package: "@mutagent/helix";
  scope: "project" | "global";
  claudeRoot: string;
  skills: SkillProbe[];
  agentCount: number;
  claudeMd: boolean;
  agentsMd: boolean;
  healthy: boolean;
}

const EXPECTED_SKILLS = [
  "mutagent-helix",
  "mutagent-agentspec",
  "mutagent-diagnostics",
  "mutagent-evaluator",
] as const;

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      global: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const scope = values.global ? "global" : "project";
  const configRoot = scope === "global" ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
  const skillsDir = join(configRoot, "skills");
  const agentsDir = join(configRoot, "agents");
  const linkRoot = scope === "global" ? configRoot : process.cwd();

  const skills: SkillProbe[] = EXPECTED_SKILLS.map((name) => {
    const dir = join(skillsDir, name);
    return {
      name,
      present: existsSync(dir),
      hasSkillMd: existsSync(join(dir, "SKILL.md")),
    };
  });

  const agentCount = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).length
    : 0;
  const claudeMd = existsSync(join(linkRoot, "CLAUDE.md"));
  const agentsMd = existsSync(join(linkRoot, "AGENTS.md"));
  const healthy = skills.every((s) => s.hasSkillMd) && agentCount > 0;

  const report: DoctorReport = {
    package: "@mutagent/helix",
    scope,
    claudeRoot: configRoot,
    skills,
    agentCount,
    claudeMd,
    agentsMd,
    healthy,
  };

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(healthy ? 0 : 1);
  }

  console.info(`\n🧬 @mutagent/helix doctor (${scope}-scope) — ${configRoot}\n`);
  for (const s of skills) {
    console.info(`  ${s.hasSkillMd ? "✓" : "✗"} ${s.name}${s.hasSkillMd ? "" : s.present ? " (no SKILL.md)" : " (missing)"}`);
  }
  console.info(`  ${agentCount > 0 ? "✓" : "✗"} agents: ${agentCount} installed`);
  console.info(`  ${claudeMd ? "✓" : "•"} CLAUDE.md ${claudeMd ? "linked" : "not found"}`);
  console.info(`  ${agentsMd ? "✓" : "•"} AGENTS.md ${agentsMd ? "linked" : "not found"}`);
  // Codex side (project-local)
  const aSkills = join(process.cwd(), ".agents", "skills");
  const cAgents = join(process.cwd(), ".codex", "agents");
  const codexSkills = existsSync(aSkills)
    ? readdirSync(aSkills).filter((d) => existsSync(join(aSkills, d, "SKILL.md"))).length
    : 0;
  const codexAgents = existsSync(cAgents) ? readdirSync(cAgents).filter((f) => f.endsWith(".toml")).length : 0;
  console.info(`  ${codexSkills > 0 ? "✓" : "•"} Codex: ${codexSkills} skills (.agents/skills) · ${codexAgents} agents (.codex/agents/*.toml)`);
  console.info(`\n${healthy ? "✅ healthy — boot with *mutagent" : "⚠ incomplete — run: pnpx @mutagent/helix init"}\n`);
  process.exit(healthy ? 0 : 1);
}

main();
