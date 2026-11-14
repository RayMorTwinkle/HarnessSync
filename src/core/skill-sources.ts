import fs from "node:fs";
import path from "node:path";
import type { Device, DeployState } from "../shared/types.ts";
import type { Store } from "./store.ts";
import {
  AppError,
  bundleDiskHash,
  exists,
  json,
  noSymlink,
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
  const device = store.device();
  const source =
    device.origins?.[id] ||
    (typeof legacy === "string" && path.isAbsolute(legacy)
      ? legacy
      : undefined);
  return source &&
    !insideSkillRoots(store, device.originRealPaths?.[id] || source)
    ? source
    : undefined;
}

export function resolvedSkillSource(store: Store, id: string) {
  const source = skillSource(store, id);
  return source ? store.device().originRealPaths?.[id] || source : undefined;
}

// Compare lexical deployment paths: resolving a managed link would hide its independent source.
const deploymentPaths = new Map<string, { stamp: string; paths: string[] }>();
function insideSkillRoots(store: Store, p: string) {
  const target = path.resolve(p);
  if (
    store
      .state()
      .receipts.some(
        (r) => r.kind === "skill" && path.resolve(r.path) === target,
      )
  )
    return true;
  // v0.6 migration: a removed duplicate only survives in the successful snapshot.
  const root = path.join(store.root, "deployments");
  noSymlink(root);
  if (!exists(root)) return false;
  for (const name of fs.readdirSync(root)) {
    if (!/^[0-9]+-[a-f0-9-]+\.json$/.test(name)) continue;
    const file = path.join(root, name);
    noSymlink(file);
    const stat = fs.statSync(file);
    const stamp = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    let cached = deploymentPaths.get(file);
    if (cached?.stamp !== stamp) {
      const record = json<{
        status: string;
        beforeState: DeployState;
        files: { kind: string; path: string }[];
      }>(file);
      cached = {
        stamp,
        paths:
          record.status === "applied"
            ? [...record.beforeState.receipts, ...record.files]
                .filter((r) => r.kind === "skill")
                .map((r) => path.resolve(r.path))
            : [],
      };
      if (deploymentPaths.size >= 1000) deploymentPaths.clear();
      deploymentPaths.set(file, cached);
    }
    if (cached.paths.includes(target)) return true;
  }
  return false;
}

export type RemovedOrigin = {
  id: string;
  source: string;
  realPath?: string;
  hash?: string;
};
export function removeDeploymentOrigins(
  device: Device,
  paths: string[],
): RemovedOrigin[] {
  const removed: RemovedOrigin[] = [];
  for (const [id, source] of Object.entries(device.origins || {})) {
    const realPath = device.originRealPaths?.[id];
    if (!paths.includes(path.resolve(realPath || source))) continue;
    removed.push({ id, source, realPath, hash: device.originHashes?.[id] });
    delete device.origins![id];
    if (device.originRealPaths) delete device.originRealPaths[id];
    if (device.originHashes) delete device.originHashes[id];
  }
  return removed;
}
export function restoreDeploymentOrigins(
  device: Device,
  removed: RemovedOrigin[],
  allowUnchanged = false,
) {
  for (const item of removed) {
    if (
      allowUnchanged &&
      device.origins?.[item.id] === item.source &&
      device.originRealPaths?.[item.id] === item.realPath &&
      device.originHashes?.[item.id] === item.hash
    )
      continue;
    if (
      device.origins?.[item.id] ||
      device.originRealPaths?.[item.id] ||
      device.originHashes?.[item.id]
    )
      throw new AppError("ROLLBACK_DRIFT", "技能源记录已有新修改，不能回滚");
    device.origins = { ...device.origins, [item.id]: item.source };
    if (item.realPath)
      device.originRealPaths = {
        ...device.originRealPaths,
        [item.id]: item.realPath,
      };
    if (item.hash)
      device.originHashes = { ...device.originHashes, [item.id]: item.hash };
  }
}

export type SkillSourceStatus = {
  id: string;
  name: string;
  source: string;
  changed: boolean;
  status: "changed" | "unchanged" | "unreadable";
  note: string;
};
export function sourceStatus(store: Store) {
  return store.manifest().skills.flatMap<SkillSourceStatus>((skill) => {
    const source = skillSource(store, skill.id);
    if (!source) return [];
    try {
      // "Changed" means the source directory moved on since it was last read.
      // Library edits from sync, merges or the editor are not source updates.
      // Imports from before baselines existed fall back to comparing contents.
      const current = bundleDiskHash(
        fs.realpathSync(resolvedSkillSource(store, skill.id)!),
      );
      const baseline = store.device().originHashes?.[skill.id];
      const changed = baseline
        ? current !== baseline
        : current !== bundleDiskHash(store.skillPath(skill.id));
      return [
        {
          id: skill.id,
          name: skill.name,
          source,
          changed,
          status: changed ? "changed" : "unchanged",
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
          status: "unreadable",
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
      const real = fs.realpathSync(resolvedSkillSource(store, id)!);
      const bundle = readBundle(real);
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
      const device = store.device();
      device.originHashes = {
        ...device.originHashes,
        [id]: bundleDiskHash(real),
      };
      writeJson(path.join(store.root, "device.json"), device);
      return {
        id,
        changed,
        note: changed ? "已刷新完整技能包，请预览部署" : "源目录与库一致",
      };
    }),
  );
}
