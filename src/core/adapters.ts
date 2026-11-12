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

const skillReading: Record<HarnessId | "codexLegacy", HarnessId[]> = {
  deepseek: ["deepseek"],
  opencode: ["opencode"],
  codex: ["codex", "deepseek", "opencode"],
  claude: ["claude", "opencode"],
  codexLegacy: ["codex"],
};
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
  const skillDirs = {
    deepseek: path.join(ds, "skills"),
    opencode: path.join(roots.opencode, "skills"),
    codex: path.join(home, ".agents/skills"),
    claude: path.join(claude, "skills"),
    codexLegacy: path.join(codex, "skills"),
  };
  return harnessIds.map((id) => ({
    id,
    name: harnessNames[id],
    home: roots[id],
    instructions: instructions[id],
    skills:
      id === "codex"
        ? path.join(home, ".agents/skills")
        : path.join(roots[id], "skills"),
    sharedSkills: [
      ...new Set([
        ...Object.entries(skillDirs)
          .filter(
            ([key, dir]) =>
              dir !== skillDirs[id] &&
              (id !== "deepseek" ||
                key !== "codex" ||
                agents === path.join(home, ".agents")) &&
              (id !== "opencode" ||
                key !== "claude" ||
                claude === path.join(home, ".claude")) &&
              skillReading[key as keyof typeof skillReading].includes(id),
          )
          .map(([, dir]) => dir),
        ...(id === "deepseek" ? [path.join(agents, "skills")] : []),
        ...(id === "opencode" ? [path.join(home, ".claude/skills")] : []),
      ]),
    ],
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

export type SkillReader = {
  dir: string;
  readers: HarnessId[];
  legacy?: boolean;
};
// Default discovery roots; plugins/custom roots are outside placement guarantees.
export function skillReaders(home: string, projectDir?: string): SkillReader[] {
  const hs = adapters(home);
  const root = (id: HarnessId) =>
    projectDir
      ? projectTargets(id, projectDir).skills
      : hs.find((h) => h.id === id)!.skills;
  const shared = projectDir
    ? root("codex")
    : hs.find((h) => h.id === "deepseek")!.sharedSkills.at(-1)!;
  const entries: SkillReader[] = [
    { dir: root("deepseek"), readers: skillReading.deepseek },
    { dir: root("opencode"), readers: skillReading.opencode },
    {
      dir: root("codex"),
      readers: skillReading.codex.filter((h) => h !== "deepseek"),
    },
    { dir: shared, readers: ["deepseek"] },
    {
      dir: root("claude"),
      readers:
        !projectDir && root("claude") !== path.join(home, ".claude/skills")
          ? ["claude"]
          : skillReading.claude,
    },
    {
      dir: projectDir ? root("claude") : path.join(home, ".claude/skills"),
      readers: ["opencode"],
    },
  ];
  entries.push({
    dir: projectDir
      ? path.join(projectDir, ".codex/skills")
      : hs.find((h) => h.id === "codex")!.sharedSkills[0],
    readers: skillReading.codexLegacy,
    legacy: true,
  });
  const merged = new Map<string, SkillReader>();
  for (const e of entries) {
    const old = merged.get(e.dir);
    merged.set(e.dir, {
      ...e,
      legacy: old ? Boolean(old.legacy && e.legacy) : e.legacy,
      readers: [...new Set([...(old?.readers || []), ...e.readers])],
    });
  }
  return [...merged.values()];
}
// DeepSeek keeps the highest-rank copy of a name and OpenCode keys skills by
// directory name, so same-named copies collapse there (docs/adapters.md, v0.3).
// Codex lists every copy; Claude is unverified and treated as listing them.
const collapsesCopies: HarnessId[] = ["deepseek", "opencode"];
export function placeSkills(
  selected: HarnessId[],
  readers: SkillReader[],
): SkillReader[] {
  if (!selected.length) return [];
  let best: SkillReader[] | undefined;
  let bestScore: number[] = [];
  for (let mask = 1; mask < 2 ** readers.length; mask++) {
    const dirs = readers.filter((_, i) => mask & (2 ** i));
    const counts = harnessIds.map(
      (h) => dirs.filter((d) => d.readers.includes(h)).length,
    );
    if (selected.some((h) => !counts[harnessIds.indexOf(h)])) continue;
    const score = [
      counts.reduce(
        (sum, n, i) =>
          sum +
          (collapsesCopies.includes(harnessIds[i]) ? 0 : Math.max(0, n - 1)),
        0,
      ),
      counts.reduce(
        (sum, n, i) => sum + (!selected.includes(harnessIds[i]) && n ? 1 : 0),
        0,
      ),
      dirs.filter((d) => d.legacy).length,
      dirs.length,
    ];
    const different = score.findIndex((n, i) => n !== bestScore[i]);
    if (!best || (different >= 0 && score[different] < bestScore[different])) {
      best = dirs;
      bestScore = score;
    }
  }
  if (!best) throw new Error("技能读取目录无法覆盖所选 Harness");
  return best;
}
