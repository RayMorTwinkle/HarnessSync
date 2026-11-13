import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessManifestSchema,
  type HarnessManifest,
} from "../shared/harness-manifest.ts";
import { harnessIds, type Harness } from "../shared/types.ts";

export type ManifestError = {
  file: string;
  issues: { path: string; message: string }[];
};
export const pluginDirectory = (home = os.homedir(), root?: string) =>
  path.join(
    root || process.env.HARNESS_SYNC_HOME || path.join(home, ".harness-sync"),
    "harnesses",
  );
const builtinDir = fileURLToPath(
  new URL(
    import.meta.url.includes("/src/core/")
      ? "../../harnesses/"
      : "../harnesses/",
    import.meta.url,
  ),
);
export function validateHarnessFile(file: string): {
  manifest?: HarnessManifest;
  claimedId?: string;
  error?: ManifestError;
} {
  try {
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error("不允许符号链接清单");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const claimedId = typeof raw?.id === "string" ? raw.id : undefined;
    const result = harnessManifestSchema.safeParse(raw, {
      error: z.locales.zhCN().localeError,
    });
    if (result.success) return { manifest: result.data, claimedId };
    return {
      claimedId,
      error: {
        file,
        issues: result.error.issues.flatMap((i) => {
          const keys = i.code === "unrecognized_keys" ? i.keys : [undefined];
          return keys.map((key) => ({
            path:
              "$" +
              [...i.path, ...(key ? [key] : [])]
                .map((p) =>
                  typeof p === "number" ? `[${p}]` : `.${String(p)}`,
                )
                .join(""),
            message: `清单字段无效：${i.message}`,
          }));
        }),
      },
    };
  } catch (e: any) {
    return {
      error: {
        file,
        issues: [{ path: "$", message: `无法读取 JSON 清单：${e.message}` }],
      },
    };
  }
}
type Entry = {
  manifest: HarnessManifest;
  source: "builtin" | "user";
  file: string;
};
const cache = new Map<
  string,
  { stamp: string; entries: Entry[]; errors: ManifestError[] }
>();
export function registry(home = os.homedir(), root?: string) {
  const pluginDir = pluginDirectory(home, root);
  const listingErrors: ManifestError[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(builtinDir);
  } catch (e: any) {
    listingErrors.push({
      file: builtinDir,
      issues: [{ path: "$", message: `无法读取内置清单目录：${e.message}` }],
    });
  }
  const builtinNames = names
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => {
      const rank = (name: string) => {
        const i = harnessIds.findIndex((id) => `${id}.json` === name);
        return i < 0 ? harnessIds.length : i;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  const files: { file: string; source: Entry["source"] }[] = builtinNames.map(
    (name) => ({ file: path.join(builtinDir, name), source: "builtin" }),
  );
  try {
    for (const name of fs.readdirSync(pluginDir).sort())
      if (name.endsWith(".json"))
        files.push({ file: path.join(pluginDir, name), source: "user" });
  } catch (e: any) {
    if (e.code !== "ENOENT")
      listingErrors.push({
        file: pluginDir,
        issues: [{ path: "$", message: `无法读取插件目录：${e.message}` }],
      });
  }
  const stamp = JSON.stringify([
    listingErrors,
    files.map((f) => {
      try {
        const s = fs.lstatSync(f.file);
        return [f.file, s.mtimeMs, s.ctimeMs, s.size, s.ino];
      } catch {
        return [f.file];
      }
    }),
  ]);
  let data = cache.get(pluginDir);
  if (!data || data.stamp !== stamp) {
    const errors = [...listingErrors];
    const candidates: Entry[] = [];
    const claims: { id: string; source: Entry["source"] }[] = [];
    for (const f of files) {
      const result = validateHarnessFile(f.file);
      if (result.claimedId)
        claims.push({ id: result.claimedId, source: f.source });
      if (result.error) errors.push(result.error);
      else if (result.manifest)
        candidates.push({ ...f, manifest: result.manifest });
    }
    const entries = candidates.filter((e) => {
      let message = "";
      let issuePath = "$.id";
      if (e.source === "builtin" && !e.manifest.notes["zh-CN"]) {
        message = "内置清单需要中文说明";
        issuePath = "$.notes.zh-CN";
      }
      if (
        e.source === "user" &&
        (harnessIds.some((id) => id === e.manifest.id) ||
          claims.some((c) => c.source === "builtin" && c.id === e.manifest.id))
      )
        message = "用户插件不能覆盖内置 ID";
      else if (
        claims.filter((c) => c.source === e.source && c.id === e.manifest.id)
          .length > 1
      )
        message = "插件 ID 重复；所有同 ID 清单均已跳过";
      if (message)
        errors.push({ file: e.file, issues: [{ path: issuePath, message }] });
      return !message;
    });
    data = { stamp, entries, errors };
    cache.set(pluginDir, data);
  }
  return { ...data, pluginDir };
}
export const listManifests = (home = os.homedir(), root?: string) =>
  registry(home, root).entries.map((e) => e.manifest);
export function resolveTemplate(
  template: string,
  home: string,
  root = "",
  project?: string,
): string {
  let value = template
    .replace(
      /\{env:([A-Z_][A-Z0-9_]*)\|([^{}]+)\}/g,
      (_, name, fallback) =>
        (home === os.homedir() && process.env[name]) || fallback,
    )
    .replaceAll("{root}", root);
  if (value === "~" || value.startsWith("~/")) value = home + value.slice(1);
  return path.resolve(project || home, value);
}
export function manifestRoot(m: HarnessManifest, home: string) {
  return resolveTemplate(
    (home === os.homedir() && m.root.env && process.env[m.root.env]) ||
      m.root.default,
    home,
  );
}
export function resolvedHarnesses(
  home = os.homedir(),
  root?: string,
  disabled: string[] = [],
): Harness[] {
  return registry(home, root).entries.map(({ manifest: m, source }) => {
    const base = manifestRoot(m, home);
    const resolve = (s: string) => resolveTemplate(s, home, base);
    const entries = m.instructions.global.map((e) => ({
      ...e,
      path: resolve(e.path),
    }));
    const chosen = entries.find(
      (e) =>
        e.kind !== "shared" &&
        e.kind !== "rules" &&
        (!e.when ||
          (() => {
            try {
              const s = fs.statSync(e.path);
              return s.isFile() && s.size > 0;
            } catch {
              return false;
            }
          })()),
    );
    const instructionSources: Harness["instructionSources"] = entries
      .map((e) => ({
        path: e.path,
        kind: e.kind,
        active: e === chosen || e.kind === "shared" || e.kind === "rules",
      }))
      .sort(
        (a, b) => Number(a.kind === "override") - Number(b.kind === "override"),
      );
    for (const fragment of m.instructions.fragments) {
      const dir = resolve(fragment.replace(/\/\*\*\/\*\.md$/, ""));
      const walk = (d: string, depth = 0) => {
        if (depth > 6) return;
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (e.isFile() && e.name.endsWith(".md"))
              instructionSources.push({ path: p, kind: "rules", active: true });
          }
        } catch {}
      };
      walk(dir);
    }
    const skills = resolve(m.skills.global);
    return {
      id: m.id,
      name: m.name,
      source,
      enabled: !disabled.includes(m.id),
      monogram: m.monogram,
      homepage: m.homepage,
      notes: m.notes,
      note: m.notes["zh-CN"] || m.notes.en || "",
      home: base,
      instructions: chosen?.path || entries[0].path,
      skills,
      sharedSkills: [
        ...new Set(
          m.skills.reads.global
            .map((r) => resolve(typeof r === "string" ? r : r.path))
            .filter((p) => p !== skills),
        ),
      ],
      instructionSources,
      installed: m.detect.some((p) => fs.existsSync(resolve(p))),
      version: null,
    };
  });
}
export function selectedHarnesses(
  ids: string[],
  home: string,
  root?: string,
  disabled: string[] = [],
) {
  const all =
    ids.length === harnessIds.length &&
    harnessIds.every((id) => ids.includes(id));
  return listManifests(home, root)
    .map((m) => m.id)
    .filter((id) => !disabled.includes(id) && (all || ids.includes(id)));
}
