import fs from "node:fs";
import path from "node:path";
import { exists } from "./files.ts";
import type { DiscoveredSkill, Harness } from "../shared/types.ts";

type Origin = Pick<
  DiscoveredSkill,
  "origin" | "originReason" | "sourceUrl" | "bundledBy"
>;
const within = (file: string, root: string) =>
  file === root || file.startsWith(root + path.sep);
function bundled(pathname: string, name: string): Origin {
  return {
    origin: "bundled",
    originReason: `链接或目录位于产品 ${name} 内部，会随产品更新`,
    bundledBy: { name, path: pathname },
  };
}
function pureSkillCollection(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const directories = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  );
  const skillTree =
    exists(path.join(dir, "SKILL.md")) ||
    directories.some(
      (e) => e.name === "skills" || exists(path.join(dir, e.name, "SKILL.md")),
    );
  return (
    skillTree &&
    directories.every(
      (e) =>
        ["skills", "scripts", "references", "assets", "node_modules"].includes(
          e.name,
        ) || exists(path.join(dir, e.name, "SKILL.md")),
    ) &&
    entries
      .filter((e) => e.isFile())
      .every((e) =>
        /^(SKILL\.md|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|Cargo\.(toml|lock)|go\.(mod|sum)|README.*|LICENSE.*|\..*)$/i.test(
          e.name,
        ),
      )
  );
}
function bundledOrigin(
  canonical: string,
  linked: boolean,
  home: string,
): Origin | undefined {
  const app = canonical.match(/^(.*?\/([^/]+)\.app)\/Contents(?:\/|$)/);
  if (app) return bundled(app[1], app[2]);
  for (const root of [
    "/Applications",
    "/opt/homebrew",
    "/usr/local",
    "/usr/share",
    path.join(home, ".local/share"),
  ]) {
    if (!within(canonical, root)) continue;
    const child = path.relative(root, canonical).split(path.sep)[0];
    return bundled(path.join(root, child), child || path.basename(root));
  }
  const modules = canonical.indexOf(`${path.sep}node_modules${path.sep}`);
  if (modules >= 0) {
    const root = canonical.slice(0, modules + "/node_modules".length);
    const parts = path.relative(root, canonical).split(path.sep);
    const name = parts[0].startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0];
    return bundled(path.join(root, name), name);
  }
  if (!linked || !within(canonical, home)) return;
  for (
    let dir = canonical, depth = 0;
    dir !== home && within(dir, home) && depth < 8;
    dir = path.dirname(dir), depth++
  ) {
    if (
      ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"].some((f) =>
        exists(path.join(dir, f)),
      ) &&
      !pureSkillCollection(dir)
    )
      return bundled(dir, path.basename(dir));
  }
}
export function originDetector(
  harnesses: Harness[],
  warnings: string[],
  home: string,
) {
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
    const product = bundledOrigin(
      canonical,
      canonical !== path.resolve(entryPath),
      home,
    );
    if (product) return product;
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
