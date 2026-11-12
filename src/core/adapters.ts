import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { Harness, HarnessId } from "../shared/types.ts";

export function adapters(home = os.homedir()): Harness[] {
  const actualHome = home === os.homedir();
  const configHome = actualHome
    ? process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    : path.join(home, ".config");
  const ds = actualHome
    ? process.env.DSH_HOME || path.join(home, ".dsh")
    : path.join(home, ".dsh");
  const agents = actualHome
    ? process.env.DSH_AGENTS_HOME || path.join(home, ".agents")
    : path.join(home, ".agents");
  return [
    {
      id: "deepseek",
      name: "DeepSeek Harness",
      home: ds,
      instructions: path.join(ds, "AGENTS.md"),
      skills: path.join(ds, "skills"),
      sharedSkills: [path.join(agents, "skills")],
      note: "Skills 由文件监听刷新；指令通过文件操作或恢复会话刷新。新会话可确保加载。",
    },
    {
      id: "opencode",
      name: "OpenCode",
      home: path.join(configHome, "opencode"),
      instructions: path.join(configHome, "opencode", "AGENTS.md"),
      skills: path.join(configHome, "opencode", "skills"),
      sharedSkills: [
        path.join(home, ".agents/skills"),
        path.join(home, ".claude/skills"),
      ],
      note: "已适配 OpenCode V2 原生目录。指令在后续请求前刷新；运行中的会话是否已加载需单独验证。",
    },
  ].map((h) => ({
    ...h,
    id: h.id as HarnessId,
    version: null,
    installed: fs.existsSync(h.home),
  }));
}
let versions: Record<string, string | null> | null = null;
export function harnessVersions() {
  if (versions) return versions;
  versions = {};
  for (const [id, exe] of [
    ["deepseek", "dsh"],
    ["opencode", "opencode"],
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
  return {
    instructions: path.join(dir, "AGENTS.md"),
    skills: path.join(
      dir,
      harness === "deepseek" ? ".dsh/skills" : ".opencode/skills",
    ),
  };
}
