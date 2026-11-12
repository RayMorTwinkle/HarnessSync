import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  harnessIds,
  harnessNames,
  type Harness,
  type HarnessId,
} from "../shared/types.ts";

export function adapters(home = os.homedir()): Harness[] {
  const local = home === os.homedir();
  const conf = local
    ? process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    : path.join(home, ".config");
  const ds = local
    ? process.env.DSH_HOME || path.join(home, ".dsh")
    : path.join(home, ".dsh");
  const agents = local
    ? process.env.DSH_AGENTS_HOME || path.join(home, ".agents")
    : path.join(home, ".agents");
  const codex = local
    ? process.env.CODEX_HOME || path.join(home, ".codex")
    : path.join(home, ".codex");
  const claude = local
    ? process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")
    : path.join(home, ".claude");
  const override = path.join(codex, "AGENTS.override.md");
  const hasOverride =
    fs.existsSync(override) &&
    fs.statSync(override).isFile() &&
    fs.statSync(override).size > 0;
  const roots = {
    deepseek: ds,
    opencode: path.join(conf, "opencode"),
    codex,
    claude,
  };
  const instructions = {
    deepseek: path.join(ds, "AGENTS.md"),
    opencode: path.join(conf, "opencode/AGENTS.md"),
    codex: hasOverride ? override : path.join(codex, "AGENTS.md"),
    claude: path.join(claude, "CLAUDE.md"),
  };
  const sources: Record<HarnessId, Harness["instructionSources"]> = {
    deepseek: [
      { path: instructions.deepseek, kind: "main", active: true },
      { path: path.join(agents, "AGENTS.md"), kind: "shared", active: true },
    ],
    opencode: [{ path: instructions.opencode, kind: "main", active: true }],
    codex: [
      {
        path: path.join(codex, "AGENTS.md"),
        kind: "main",
        active: !hasOverride,
      },
      { path: override, kind: "override", active: hasOverride },
    ],
    claude: [{ path: instructions.claude, kind: "main", active: true }],
  };
  const rules = path.join(claude, "rules");
  if (fs.existsSync(rules)) {
    const walk = (dir: string, depth = 0) => {
      if (depth > 6) return;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.isFile() && e.name.endsWith(".md"))
            sources.claude.push({ path: p, kind: "rules", active: true });
        }
      } catch {
        /* scanner separately reports inaccessible known roots */
      }
    };
    walk(rules);
  }
  return harnessIds.map((id) => ({
    id,
    name: harnessNames[id],
    home: roots[id],
    instructions: instructions[id],
    skills:
      id === "codex"
        ? path.join(home, ".agents/skills")
        : path.join(roots[id], "skills"),
    sharedSkills:
      id === "deepseek"
        ? [path.join(agents, "skills")]
        : id === "opencode"
          ? [path.join(home, ".agents/skills"), path.join(claude, "skills")]
          : id === "codex"
            ? [path.join(codex, "skills")]
            : [],
    instructionSources: sources[id],
    version: null,
    installed: fs.existsSync(roots[id]),
    note: {
      deepseek: "Skills 由目录监听刷新；指令在文件操作或恢复会话时刷新。",
      opencode: "适配 OpenCode V2；原生指令在后续请求前刷新。",
      codex:
        "使用共享 .agents/skills；兼容旧 .codex/skills 扫描。全局 override 存在时优先。",
      claude: "使用原生 CLAUDE.md 和 .claude/skills，兼容本机较早版本。",
    }[id],
  }));
}
let versions: Record<string, string | null> | null = null;
export function harnessVersions() {
  if (versions) return versions;
  versions = {};
  for (const [id, exe] of [
    ["deepseek", "dsh"],
    ["opencode", "opencode"],
    ["codex", "codex"],
    ["claude", "claude"],
  ]) {
    try {
      versions[id] = execFileSync(exe, ["--version"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      versions[id] = null;
    }
  }
  return versions;
}
export function projectTargets(harness: HarnessId, dir: string) {
  const folders = {
    deepseek: ".dsh/skills",
    opencode: ".opencode/skills",
    codex: ".agents/skills",
    claude: ".claude/skills",
  };
  return {
    instructions: path.join(
      dir,
      harness === "claude" ? "CLAUDE.md" : "AGENTS.md",
    ),
    skills: path.join(dir, folders[harness]),
  };
}
export const sharedInstructionPeers: HarnessId[] = [
  "deepseek",
  "opencode",
  "codex",
];
