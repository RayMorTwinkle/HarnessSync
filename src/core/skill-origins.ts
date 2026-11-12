import fs from "node:fs";
import path from "node:path";
import { exists } from "./files.ts";
import type { DiscoveredSkill, Harness } from "../shared/types.ts";

type Origin = Pick<DiscoveredSkill, "origin" | "originReason" | "sourceUrl">;
export function originDetector(harnesses: Harness[], warnings: string[]) {
  const rules = harnesses.flatMap((h) => [
    ...(h.id === "claude"
      ? [
          {
            root: path.join(h.skills, "synced"),
            origin: "platform" as const,
            originReason: "Claude 云端同步技能，会由 Claude 覆写",
          },
          {
            root: path.join(h.home, "plugins"),
            origin: "platform" as const,
            originReason: "Claude Code 插件托管技能",
          },
        ]
      : []),
    ...[h.skills, ...h.sharedSkills].map((root) => ({
      root: path.join(root, ".system"),
      origin: "system" as const,
      originReason: "工具内置系统技能目录",
    })),
  ]);
  const locks = new Map<string, Record<string, any>>();
  return (entryPath: string, root: string, name: string): Origin => {
    const canonical = fs.realpathSync(entryPath);
    const rule = rules.find((r) =>
      [entryPath, canonical].some(
        (p) => p === r.root || p.startsWith(r.root + path.sep),
      ),
    );
    if (rule) return { origin: rule.origin, originReason: rule.originReason };
    for (let dir = path.dirname(entryPath); ; dir = path.dirname(dir)) {
      if (exists(path.join(dir, ".codex-system-skills.marker")))
        return {
          origin: "system",
          originReason: "Codex 系统技能标记 .codex-system-skills.marker",
        };
      for (const filename of [
        ".skill-lock.json",
        "skill-lock.json",
        "skills-lock.json",
      ]) {
        const lock = path.join(dir, filename);
        if (!locks.has(lock)) {
          let skills = {};
          if (exists(lock)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(lock, "utf8"));
              if (
                !parsed.skills ||
                typeof parsed.skills !== "object" ||
                Array.isArray(parsed.skills)
              )
                throw new Error("缺少 skills 对象");
              skills = parsed.skills;
            } catch (e: any) {
              warnings.push(`忽略损坏的技能锁文件 ${lock}：${e.message}`);
            }
          }
          locks.set(lock, skills);
        }
        const skills = locks.get(lock)!;
        const key = Object.hasOwn(skills, name)
          ? name
          : path.basename(entryPath);
        const record = Object.hasOwn(skills, key) ? skills[key] : undefined;
        if (record && typeof record === "object") {
          const sourceUrl =
            typeof record.sourceUrl === "string"
              ? record.sourceUrl
              : typeof record.source === "string"
                ? record.source
                : undefined;
          return {
            origin: "tool-managed",
            originReason: `skills CLI 锁文件 ${lock}${sourceUrl ? `；来源：${sourceUrl}` : ""}`,
            sourceUrl,
          };
        }
      }
      if (dir === path.dirname(root) || path.dirname(dir) === dir) break;
    }
    return {
      origin: "user",
      originReason: "用户技能目录；未发现平台、系统或工具托管标记",
    };
  };
}
