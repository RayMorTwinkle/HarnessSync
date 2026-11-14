import fs from "node:fs";
import path from "node:path";
import { AppError, exists, json, noSymlink, writeJson } from "./files.ts";
import type { Store } from "./store.ts";
import type { Library } from "./sync-workspace.ts";
import type { SyncIgnoreStatus } from "../shared/types.ts";

// Deliberately small glob grammar: *, ** and ?. Paths are always POSIX relative paths.
function glob(pattern: string, name: string) {
  const source = pattern
    .split("/")
    .map((part) => {
      if (part === "**") return ".*";
      return part
        .split("")
        .map((c) =>
          c === "*"
            ? "[^/]*"
            : c === "?"
              ? "[^/]"
              : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
    })
    .join("/")
    .replace(/\.\*\//g, "(?:.*/)?");
  return new RegExp(`^${source}(?:/.*)?$`).test(name);
}
function validate(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (r) =>
        typeof r !== "string" ||
        !r.trim() ||
        r !== r.trim() ||
        /[\0\r\n\\]/.test(r),
    )
  )
    throw new AppError("SYNC_IGNORE", "忽略规则必须是非空字符串数组");
  for (const rule of value as string[]) {
    if (rule.startsWith("rule:")) {
      if (!rule.slice(5).trim())
        throw new AppError("SYNC_IGNORE", "请指定指令 ID 或标题");
      continue;
    }
    const [skill, ...parts] = rule.split("/");
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(skill) ||
      parts.some((p) => !p || [".", "..", ".git"].includes(p)) ||
      (parts.length && glob(parts.join("/"), "SKILL.md"))
    )
      throw new AppError(
        "SYNC_IGNORE",
        "请使用技能名或技能名/相对路径（支持 *、**、?）；SKILL.md 必须随技能上传，请改为忽略整个技能",
      );
  }
  return [...new Set(value as string[])].sort();
}
export class SyncIgnore {
  constructor(readonly store: Store) {}
  private file() {
    return path.join(this.store.root, "sync-ignore.json");
  }
  active() {
    noSymlink(this.file());
    return exists(this.file());
  }
  rules(): string[] {
    return this.active() ? validate(json(this.file())) : [];
  }
  skill(name: string, rules = this.rules()) {
    return rules.includes(name);
  }
  fileIgnored(skill: string, file: string, rules = this.rules()) {
    return (
      this.skill(skill, rules) ||
      rules.some(
        (r) =>
          r.startsWith(`${skill}/`) && glob(r.slice(skill.length + 1), file),
      )
    );
  }
  rule(entry: { id: string; title: string }, rules = this.rules()) {
    return (
      rules.includes(`rule:${entry.id}`) ||
      rules.includes(`rule:${entry.title}`)
    );
  }
  paths(id: string) {
    const root = this.store.skillPath(id),
      files: string[] = [];
    const walk = (dir: string) => {
      noSymlink(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", ".DS_Store"].includes(entry.name))
          continue;
        const file = path.join(dir, entry.name);
        noSymlink(file);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile())
          files.push(path.relative(root, file).split(path.sep).join("/"));
      }
    };
    walk(root);
    return files.sort();
  }
  status(): SyncIgnoreStatus {
    const rules = this.rules();
    // Status runs on every snapshot: skip the manifest (and its file walks) unless a rule names a skill.
    const named = new Set(
      rules.filter((r) => !r.startsWith("rule:")).map((r) => r.split("/")[0]),
    );
    if (!named.size) return { rules, matched: [] };
    return {
      rules,
      matched: this.store
        .manifest()
        .skills.filter((s) => named.has(s.name))
        .flatMap<SyncIgnoreStatus["matched"][number]>((s) => {
          if (this.skill(s.name, rules))
            return [{ skill: s.name, files: "all" as const }];
          const files = this.paths(s.id).filter((f) =>
            this.fileIgnored(s.name, f, rules),
          );
          return files.length ? [{ skill: s.name, files }] : [];
        }),
    };
  }
  async update(input: { add?: string[]; remove?: string[] }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["add", "remove"].includes(k))
    )
      throw new AppError("SYNC_IGNORE", "请提供 add 或 remove 规则数组");
    const add = validate(input.add === undefined ? [] : input.add),
      remove = validate(input.remove === undefined ? [] : input.remove);
    return this.store.lock(() => {
      const rules = validate([
        ...this.rules().filter((r) => !remove.includes(r)),
        ...add,
      ]);
      noSymlink(this.file());
      writeJson(this.file(), rules);
      return this.status();
    });
  }
  filter(library: Library): Library {
    const result = structuredClone(library),
      rules = this.rules();
    result.manifest.rules = result.manifest.rules.filter(
      (r) => !this.rule(r, rules),
    );
    result.manifest.skills = result.manifest.skills.filter((s) => {
      if (this.skill(s.name, rules)) {
        delete result.bundles[s.id];
        return false;
      }
      for (const name of Object.keys(result.bundles[s.id]))
        if (this.fileIgnored(s.name, name, rules))
          delete result.bundles[s.id][name];
      return true;
    });
    return result;
  }
  // Restore ignored bytes from the chosen side: local on pull, remote on upload.
  preserve(result: Library, source: Library) {
    const rules = this.rules();
    for (const entry of source.manifest.rules)
      if (this.rule(entry, rules)) {
        result.manifest.rules = result.manifest.rules.filter(
          (r) => r.id !== entry.id,
        );
        result.manifest.rules.push(structuredClone(entry));
      }
    for (const skill of source.manifest.skills) {
      const files = Object.fromEntries(
        Object.entries(source.bundles[skill.id]).filter(([name]) =>
          this.fileIgnored(skill.name, name, rules),
        ),
      );
      if (!Object.keys(files).length && !this.skill(skill.name, rules))
        continue;
      let target = result.manifest.skills.find(
        (s) => s.id === skill.id || s.name === skill.name,
      );
      if (!target) {
        target = structuredClone(skill);
        result.manifest.skills.push(target);
        result.bundles[target.id] = structuredClone(source.bundles[skill.id]);
      } else if (this.skill(skill.name, rules)) {
        const targetId = target.id;
        result.manifest.skills = result.manifest.skills.filter(
          (s) => s.id !== targetId,
        );
        delete result.bundles[targetId];
        result.manifest.skills.push(structuredClone(skill));
        result.bundles[skill.id] = structuredClone(source.bundles[skill.id]);
      } else
        result.bundles[target.id] = { ...result.bundles[target.id], ...files };
    }
    return result;
  }
}
