import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import {
  AppError,
  bundleHash,
  parseSkill,
  readBundle,
  writeBundle,
  writeJson,
} from "./files.ts";

export function isIgnoredNativePath(store: Store, nativePath: string) {
  return (store.device().ignoredNativePaths || []).includes(
    path.resolve(nativePath),
  );
}

export async function ignoreNativePaths(
  store: Store,
  paths: string[],
  ignored = true,
) {
  if (!paths.length || paths.some((p) => !path.isAbsolute(p)))
    throw new AppError("INVALID_PATH", "请选择扫描清单中的绝对路径");
  return store.lock(() => {
    const device = store.device();
    const entries = new Set(device.ignoredNativePaths || []);
    for (const p of paths) {
      const absolute = path.resolve(p);
      if (store.state().receipts.some((r) => r.path === absolute))
        throw new AppError("ALREADY_MANAGED", "已管理目录不能标记外部保留");
      if (ignored) entries.add(absolute);
      else entries.delete(absolute);
    }
    device.ignoredNativePaths = [...entries].sort();
    writeJson(path.join(store.root, "device.json"), device);
    return {
      paths: device.ignoredNativePaths,
      note: ignored ? "外部保留" : "已取消外部保留",
    };
  });
}

export function skillSource(store: Store, id: string) {
  const legacy = store.manifest().skills.find((s) => s.id === id)?.source;
  return (
    store.device().origins?.[id] ||
    (legacy && path.isAbsolute(legacy) ? legacy : undefined)
  );
}

export function resolvedSkillSource(store: Store, id: string) {
  return store.device().originRealPaths?.[id] || skillSource(store, id);
}

export function sourceStatus(store: Store) {
  return store.manifest().skills.flatMap((skill) => {
    const source = skillSource(store, skill.id);
    if (!source) return [];
    try {
      const changed =
        bundleHash(
          readBundle(fs.realpathSync(resolvedSkillSource(store, skill.id)!)),
        ) !== bundleHash(readBundle(store.skillPath(skill.id)));
      return [
        {
          id: skill.id,
          name: skill.name,
          source,
          changed,
          note: changed ? "源目录有更新" : "源目录与库一致",
        },
      ];
    } catch (e: any) {
      return [
        {
          id: skill.id,
          name: skill.name,
          source,
          changed: false,
          note: `源目录无法读取：${e.message}`,
        },
      ];
    }
  });
}

export async function refreshSkills(store: Store, ids: string[]) {
  if (!ids.length) return [];
  return store.mutate("刷新技能源目录", (manifest) =>
    ids.map((id) => {
      const entry = manifest.skills.find((s) => s.id === id);
      if (!entry) throw new AppError("NOT_FOUND", "Skill 不存在", 404);
      const source = skillSource(store, id);
      if (!source)
        throw new AppError(
          "NO_SKILL_SOURCE",
          `技能没有本机源目录：${entry.name}`,
        );
      const bundle = readBundle(
        fs.realpathSync(resolvedSkillSource(store, id)!),
      );
      if (!bundle["SKILL.md"])
        throw new AppError("INVALID_SKILL", "目录中缺少 SKILL.md");
      const parsed = parseSkill(
        Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
      );
      if (parsed.name !== entry.name)
        throw new AppError(
          "SOURCE_NAME_CHANGED",
          `源技能名称已变化：${entry.name} → ${parsed.name}；请单独导入`,
        );
      const changed =
        bundleHash(bundle) !== bundleHash(readBundle(store.skillPath(id)));
      if (changed) {
        writeBundle(store.skillPath(id), bundle);
        entry.description = parsed.description;
      }
      return {
        id,
        changed,
        note: changed ? "已刷新完整技能包，请预览部署" : "源目录与库一致",
      };
    }),
  );
}
