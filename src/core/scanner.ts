import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import { adapters, projectTargets } from "./adapters.ts";
import { bundleHash, exists, hash, parseSkill, readBundle } from "./files.ts";
import type { HarnessId, Inspection } from "../shared/types.ts";

export function scanMachine(store: Store): Inspection {
  const found = new Map<string, Inspection["skills"][number]>();
  const instructions = new Map<string, Inspection["instructions"][number]>();
  const roots = new Map<
    string,
    Inspection["roots"][number] & { projectIds: string[] }
  >();
  const warnings: string[] = [];
  const device = store.device();
  const state = store.state();
  const addRoot = (p: string, h: HarnessId, projectId?: string) => {
    const old = roots.get(p);
    if (old) {
      if (!old.harnesses.includes(h)) old.harnesses.push(h);
      if (projectId && !old.projectIds.includes(projectId))
        old.projectIds.push(projectId);
    } else
      roots.set(p, {
        path: p,
        harnesses: [h],
        projectIds: projectId ? [projectId] : [],
        exists: exists(p),
      });
  };
  for (const h of adapters(store.home)) {
    for (const p of [h.skills, ...h.sharedSkills]) addRoot(p, h.id);
    for (const project of store.manifest().projects)
      if (device.bindings[project.id])
        addRoot(
          projectTargets(h.id, device.bindings[project.id]).skills,
          h.id,
          project.id,
        );
    for (const source of h.instructionSources) {
      const entry: Inspection["instructions"][number] = {
        key: hash(source.path).slice(0, 16),
        harness: h.id,
        harnesses: [h.id],
        path: source.path,
        exists: exists(source.path),
        kind: source.kind,
        active: source.active,
        body: "",
        managed: state.receipts.some(
          (r) => r.kind === "instructions" && r.path === source.path,
        ),
      };
      try {
        if (entry.exists) {
          if (fs.statSync(source.path).size > 1024 * 1024)
            throw new Error("指令文件超过扫描上限 1 MiB");
          entry.body = fs.readFileSync(source.path, "utf8");
          entry.hash = hash(entry.body);
        }
      } catch (e: any) {
        entry.error = e.message;
        warnings.push(`无法读取指令 ${source.path}：${e.message}`);
      }
      const old = instructions.get(source.path);
      if (old) {
        if (!old.harnesses.includes(h.id)) old.harnesses.push(h.id);
        old.active ||= source.active;
      } else instructions.set(source.path, entry);
    }
  }
  let walked = 0;
  for (const root of roots.values()) {
    if (!root.exists) continue;
    const visited = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || walked > 5000) {
        warnings.push(`扫描达到目录深度或数量上限：${dir}`);
        return;
      }
      let canonical: string;
      try {
        canonical = fs.realpathSync(dir);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        walked++;
      } catch (e: any) {
        root.error = e.message;
        return;
      }
      const file = path.join(dir, "SKILL.md");
      if (exists(file)) {
        addSkill(dir, file, root);
        return;
      }
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (
            e.name.startsWith(".") ||
            ["node_modules", "assets", "references", "scripts"].includes(e.name)
          )
            continue;
          const p = path.join(dir, e.name);
          try {
            if (
              e.isDirectory() ||
              (e.isSymbolicLink() && fs.statSync(p).isDirectory())
            )
              walk(p, depth + 1);
            else if (depth === 0 && e.isFile() && e.name.endsWith(".md"))
              addSkill(p, p, root);
          } catch (e: any) {
            root.error = `部分条目无法读取：${p}（${e.message}）`;
          }
        }
      } catch (e: any) {
        root.error = e.message;
      }
    };
    const addSkill = (
      p: string,
      file: string,
      root: typeof roots extends Map<any, infer V> ? V : never,
    ) => {
      let canonical: string;
      try {
        canonical = fs.realpathSync(p);
      } catch (e: any) {
        root.error = e.message;
        return;
      }
      const old = found.get(canonical);
      if (old) {
        old.harnesses = [...new Set([...old.harnesses, ...root.harnesses])];
        old.paths = [...new Set([...old.paths, p])];
        old.projectIds = [...new Set([...old.projectIds, ...root.projectIds])];
        old.linked ||= canonical !== path.resolve(p);
        old.managed ||= state.receipts.some(
          (r) => r.kind === "skill" && r.path === p,
        );
        return;
      }
      const entry: Inspection["skills"][number] = {
        key: hash(canonical).slice(0, 16),
        path: canonical,
        paths: [p],
        name: path.basename(p),
        description: "",
        harnesses: [...root.harnesses],
        projectIds: [...root.projectIds],
        valid: false,
        managed: state.receipts.some((r) => r.kind === "skill" && r.path === p),
        linked: canonical !== path.resolve(p),
        entryFile: fs.realpathSync(file),
      };
      try {
        const text = fs.readFileSync(file, "utf8");
        let fingerprintError: Error | undefined;
        try {
          if (fs.statSync(canonical).isDirectory())
            entry.hash = bundleHash(readBundle(canonical));
        } catch (e: any) {
          fingerprintError = e;
        }
        const parsed = parseSkill(text);
        entry.name = parsed.name;
        entry.description = parsed.description;
        if (!fs.statSync(canonical).isDirectory())
          throw new Error(
            "平铺技能文件：先由 AI 整理为包含 SKILL.md 的目录包，再导入",
          );
        if (fingerprintError) throw fingerprintError;
        entry.valid = true;
      } catch (e: any) {
        entry.error = e.message;
      }
      found.set(canonical, entry);
    };
    walk(root.path, 0);
    if (root.error) warnings.push(`目录扫描不完整 ${root.path}：${root.error}`);
  }
  const skills = [...found.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const groups = new Map<string, typeof skills>();
  for (const s of skills)
    groups.set(s.name, [...(groups.get(s.name) || []), s]);
  const duplicates = [...groups]
    .filter(([, v]) => v.length > 1)
    .map(([name, v]) => ({
      name,
      keys: v.map((s) => s.key),
      variants: new Set(v.filter((s) => s.hash).map((s) => s.hash)).size,
      unverified: v.filter((s) => !s.hash).length,
    }));
  const instructionList = [...instructions.values()];
  return {
    skills,
    instructions: instructionList,
    roots: [...roots.values()].map(({ projectIds, ...root }) => root),
    warnings,
    duplicates,
    summary: {
      physicalSkills: skills.length,
      names: groups.size,
      validSkills: skills.filter((s) => s.valid).length,
      instructionFiles: instructionList.filter((i) => i.exists).length,
      instructionVariants: new Set(
        instructionList.filter((i) => i.hash).map((i) => i.hash),
      ).size,
      nameConflicts: duplicates.filter((g) => g.variants > 1).length,
    },
  };
}
