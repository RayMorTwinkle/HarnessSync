import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ruleInput, skillInput, type Manifest } from "../shared/types.ts";
import { AppError, atomicWrite, exists, noSymlink } from "./files.ts";

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(ruleInput.extend({ id: z.string().regex(/^[a-zA-Z0-9-]+$/) })),
  skills: z.array(
    skillInput
      .omit({ body: true })
      .extend({
        id: z.string().regex(/^[a-zA-Z0-9-]+$/),
        source: z.string().optional(),
      }),
  ),
  projects: z.array(
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9-]+$/),
      name: z.string().min(1).max(100),
    }),
  ),
});
export const kinds = ["rules", "skills", "projects"] as const;
export function stable(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}
export function readManifest(
  files: string[],
  read: (file: string) => string,
): Manifest {
  if (!files.includes("harness-sync.json"))
    return manifestSchema.parse(JSON.parse(read("manifest.json")));
  if (JSON.parse(read("harness-sync.json")).schemaVersion !== 2)
    throw new AppError("INVALID_SCHEMA", "不支持的配置库版本");
  const m: Manifest = { schemaVersion: 1, rules: [], skills: [], projects: [] };
  for (const kind of kinds)
    for (const file of files
      .filter((f) => f.startsWith(`entries/${kind}/`))
      .sort()) {
      if (!/^entries\/(rules|skills|projects)\/[a-zA-Z0-9-]+\.json$/.test(file))
        throw new AppError("INVALID_ENTRY", "配置条目路径无效");
      const entry = JSON.parse(read(file));
      if (file !== `entries/${kind}/${entry.id}.json`)
        throw new AppError("INVALID_ENTRY", "配置条目 ID 与路径不符");
      (m[kind] as any[]).push(entry);
    }
  const parsed = manifestSchema.parse(m);
  for (const kind of kinds)
    if (new Set(parsed[kind].map((e) => e.id)).size !== parsed[kind].length)
      throw new AppError("INVALID_ENTRY", "配置条目 ID 重复");
  if (new Set(parsed.skills.map((s) => s.name)).size !== parsed.skills.length)
    throw new AppError("DUPLICATE_NAME", "技能库中存在同名 Skill");
  return parsed;
}
export function diskManifest(repo: string) {
  if (!exists(path.join(repo, "harness-sync.json")))
    return readManifest(["manifest.json"], (f) =>
      fs.readFileSync(path.join(repo, f), "utf8"),
    );
  const files = ["harness-sync.json"];
  for (const kind of kinds) {
    const dir = path.join(repo, "entries", kind);
    if (exists(dir))
      for (const file of fs.readdirSync(dir))
        files.push(`entries/${kind}/${file}`);
  }
  return readManifest(files, (f) =>
    fs.readFileSync(path.join(repo, f), "utf8"),
  );
}
export function writeManifest(repo: string, value: Manifest) {
  const m = manifestSchema.parse(value);
  noSymlink(repo);
  for (const kind of kinds) {
    const dir = path.join(repo, "entries", kind);
    noSymlink(dir);
    fs.mkdirSync(dir, { recursive: true });
    const names = new Set(m[kind].map((e) => `${e.id}.json`));
    for (const file of fs.readdirSync(dir)) {
      noSymlink(path.join(dir, file));
      if (!names.has(file)) fs.rmSync(path.join(dir, file));
    }
    for (const entry of m[kind]) {
      const file = path.join(dir, `${entry.id}.json`);
      noSymlink(file);
      atomicWrite(file, stable(entry));
    }
  }
  noSymlink(path.join(repo, "harness-sync.json"));
  atomicWrite(
    path.join(repo, "harness-sync.json"),
    stable({ schemaVersion: 2 }),
  );
  noSymlink(path.join(repo, "manifest.json"));
  fs.rmSync(path.join(repo, "manifest.json"), { force: true });
}
