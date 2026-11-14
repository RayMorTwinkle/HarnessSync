import fs from "node:fs";
import path from "node:path";
import {
  AppError,
  atomicWrite,
  exists,
  noSymlink,
  type Bundle,
} from "./files.ts";
import { stable } from "./layout.ts";
import type { Store } from "./store.ts";
import type { SyncConflict } from "../shared/types.ts";
import type { Library } from "./sync-workspace.ts";

export type IdMap = Record<string, string>;
export function semanticObject(
  library: Library,
  kind: SyncConflict["kind"],
  id: string,
) {
  const entry = library.manifest[kind].find((e) => e.id === id);
  if (!entry) return undefined;
  const { id: ignored, ...value } = entry;
  if ("source" in value) delete value.source;
  if ("scope" in value)
    value.scope = {
      ...value.scope,
      harnesses: [...new Set(value.scope.harnesses)].sort(),
    };
  return {
    entry: value,
    ...(kind === "skills"
      ? {
          bundle: Object.fromEntries(
            Object.entries(library.bundles[id]).map(([name, file]) => [
              name,
              { content: file.content, executable: !!(file.mode & 0o111) },
            ]),
          ),
        }
      : {}),
  };
}
export function remapScopes(library: Library, ids: IdMap) {
  for (const entry of [...library.manifest.rules, ...library.manifest.skills])
    if (
      entry.scope.kind === "project" &&
      entry.scope.target &&
      ids[entry.scope.target]
    )
      entry.scope.target = ids[entry.scope.target];
}
export type LocalReferences = { before: Bundle; after: Bundle };
// Only live identity fields are rewritten. Native paths, text, hashes and historical
// source commits remain immutable; deployment beforeState must follow current IDs.
export function referenceChanges(store: Store, ids: IdMap): LocalReferences {
  const before: Bundle = {},
    after: Bundle = {};
  if (!Object.keys(ids).length) return { before, after };
  const mapped = (id: string) => ids[id] || id;
  const state = (value: any) => {
    for (const r of value.receipts || []) {
      if (r.sourceId) r.sourceId = mapped(r.sourceId);
      if (r.projectId) r.projectId = mapped(r.projectId);
    }
    for (const c of Object.values(value.conflictChoices || {}) as any[])
      c.sourceId = mapped(c.sourceId);
  };
  const names = ["state.json", "device.json", "skill-updates.json"];
  const deployments = path.join(store.root, "deployments");
  noSymlink(deployments);
  if (exists(deployments))
    for (const name of fs.readdirSync(deployments)) {
      if (!/^[a-zA-Z0-9-]+\.json$/.test(name))
        throw new AppError("SYNC_REFERENCES", "部署快照文件名无效");
      names.push(`deployments/${name}`);
    }
  for (const name of names) {
    const file = path.join(store.root, name);
    noSymlink(file);
    if (!exists(file)) continue;
    const raw = fs.readFileSync(file),
      value = JSON.parse(raw.toString());
    const original = stable(value);
    if (name === "state.json") state(value);
    else if (name === "device.json") {
      const manifest = store.manifest();
      // Legacy imports stored absolute development paths in source metadata.
      // Preserve that local origin before adopting the canonical remote entry.
      for (const skill of manifest.skills) {
        if (
          ids[skill.id] &&
          typeof skill.source === "string" &&
          path.isAbsolute(skill.source)
        ) {
          value.origins ||= {};
          value.origins[skill.id] ||= skill.source;
        }
      }
      const rules = manifest.rules;
      if (rules.some((r) => ids[r.id])) {
        const order: string[] = value.ruleOrder || rules.map((r) => r.id);
        value.ruleOrder = [
          ...new Set([...order, ...rules.map((r) => r.id)].map(mapped)),
        ];
      }
      for (const key of ["bindings", "origins", "originRealPaths"]) {
        if (!value[key]) continue;
        for (const [from, to] of Object.entries(ids))
          if (Object.hasOwn(value[key], from)) {
            if (
              Object.hasOwn(value[key], to) &&
              value[key][to] !== value[key][from]
            )
              throw new AppError(
                "SYNC_REFERENCES",
                "两条记录的本机路径不同，请先整理路径绑定",
              );
            value[key][to] = value[key][from];
            delete value[key][from];
          }
      }
    } else if (name === "skill-updates.json") {
      for (const [from, to] of Object.entries(ids))
        if (Object.hasOwn(value, from)) {
          value[to] = { ...value[from], id: to };
          delete value[from];
        }
    } else if (value.beforeState) state(value.beforeState);
    if (stable(value) === original) continue;
    const mode = fs.statSync(file).mode & 0o777;
    before[name] = { content: raw.toString("base64"), mode };
    after[name] = {
      content: Buffer.from(JSON.stringify(value, null, 2) + "\n").toString(
        "base64",
      ),
      mode,
    };
  }
  return { before, after };
}
export function validateReferences(store: Store, refs?: LocalReferences) {
  if (!refs) return;
  if (
    stable(Object.keys(refs.before).sort()) !==
    stable(Object.keys(refs.after).sort())
  )
    throw new AppError("SYNC_RECOVERY", "本机引用快照不完整");
  for (const name of Object.keys(refs.before)) {
    if (
      !/^(state\.json|device\.json|skill-updates\.json|deployments\/[a-zA-Z0-9-]+\.json)$/.test(
        name,
      )
    )
      throw new AppError("SYNC_RECOVERY", "本机引用快照路径无效");
    const file = path.join(store.root, name);
    noSymlink(file);
    const data = exists(file)
      ? fs.readFileSync(file).toString("base64")
      : undefined;
    if (
      ![refs.before[name], refs.after[name]].some(
        (expected) =>
          expected.content === data &&
          (fs.statSync(file).mode & 0o777) === expected.mode,
      )
    )
      throw new AppError(
        "SYNC_UNDO_CHANGED",
        "本机引用已改变，拒绝覆盖；请先检查部署状态",
      );
  }
}
export function writeReferences(
  store: Store,
  refs: LocalReferences | undefined,
  side: "before" | "after",
) {
  validateReferences(store, refs);
  for (const [name, file] of Object.entries(refs?.[side] || {}))
    atomicWrite(
      path.join(store.root, name),
      Buffer.from(file.content, "base64"),
      file.mode,
    );
}
