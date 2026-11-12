import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { adapters, projectTargets, harnessVersions } from "./adapters.ts";
import { Store } from "./store.ts";
import {
  AppError,
  atomicWrite,
  bundleHash,
  diskHash,
  exists,
  hash,
  json,
  noSymlink,
  parseSkill,
  readBundle,
  writeBundle,
  writeJson,
  type Bundle,
} from "./files.ts";
import type {
  Change,
  HarnessId,
  Inspection,
  Plan,
  Receipt,
  Rule,
  Scope,
  Snapshot,
} from "../shared/types.ts";

const START = "<!-- harness-sync:begin -->";
const END = "<!-- harness-sync:end -->";
const absent = hash("ABSENT");
type SavedFile = {
  path: string;
  kind: "instructions" | "skill";
  existed: boolean;
  content?: string;
  files?: Bundle;
  afterHash: string;
  mode?: number;
};
type Deployment = {
  id: string;
  date: string;
  changes: number;
  status: "pending" | "applied" | "failed" | "rolled-back";
  beforeState: { receipts: Receipt[] };
  files: SavedFile[];
};

function managedBlock(text: string) {
  const starts = text.split(START).length - 1,
    ends = text.split(END).length - 1;
  if (!starts && !ends) return null;
  if (starts !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(START))
    throw new AppError(
      "MALFORMED_BLOCK",
      "HarnessSync 管理区块标记损坏或重复，请先修复",
    );
  return text.slice(text.indexOf(START), text.indexOf(END) + END.length);
}
function replaceBlock(text: string, block: string | null) {
  const previous = managedBlock(text);
  if (previous) return text.replace(previous, block || "");
  return block
    ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`
    : text;
}
export class Engine {
  constructor(readonly store: Store) {}
  private matches(scope: Scope, harness: HarnessId, projectId?: string) {
    if (!scope.harnesses.includes(harness)) return false;
    if (projectId)
      return scope.kind === "project" && scope.target === projectId;
    return (
      scope.kind === "global" ||
      (scope.kind === "device" && scope.target === this.store.device().id)
    );
  }
  private render(text: string, projectId?: string) {
    const d = this.store.device();
    const p = this.store.manifest().projects.find((p) => p.id === projectId);
    const vars: Record<string, string | undefined> = {
      "device.name": d.name,
      "device.id": d.id,
      "device.home": d.home,
      "project.name": p?.name,
      "project.path": projectId ? d.bindings[projectId] : undefined,
      ...Object.fromEntries(
        Object.entries(d.variables).map(([k, v]) => [`vars.${k}`, v]),
      ),
    };
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      if (vars[key] === undefined)
        throw new AppError(
          "MISSING_VARIABLE",
          `缺少变量 {{${key}}}，请在设备设置中配置`,
        );
      return vars[key]!;
    });
  }
  private instructions(rules: Rule[], projectId?: string) {
    if (!rules.length) return null;
    const content = rules
      .map((r) => `## ${r.title}\n\n${this.render(r.body, projectId).trim()}`)
      .join("\n\n");
    if (Buffer.byteLength(content) > 48 * 1024)
      throw new AppError(
        "INSTRUCTIONS_TOO_LARGE",
        "合成指令超过 48 KiB，请拆分为按需加载的 Skills",
      );
    if (content.includes(START) || content.includes(END))
      throw new AppError(
        "RESERVED_MARKER",
        "指令正文不能包含 HarnessSync 保留标记",
      );
    return `${START}\n# HarnessSync\n\n${content}\n${END}`;
  }
  plan(): Plan {
    const manifest = this.store.manifest();
    const state = this.store.state();
    const device = this.store.device();
    const changes: Change[] = [];
    const errors: string[] = [];
    const wanted = new Set<string>();
    if (this.pending().length)
      errors.push("有部署未完成，请先在版本与部署中回滚最新的未完成部署");
    const add = (spec: {
      path: string;
      harness: HarnessId;
      kind: "instructions" | "skill";
      projectId?: string;
      sourceId?: string;
      block?: string | null;
      files?: Bundle;
      removing?: boolean;
    }) => {
      if (wanted.has(spec.path)) return;
      wanted.add(spec.path);
      const receipt = state.receipts.find((r) => r.path === spec.path);
      const change: Change = {
        ...spec,
        status: "unchanged",
        reason: "已是最新部署",
        before: "",
        after: "",
        beforeHash: absent,
        afterHash: absent,
        diff: "",
      };
      try {
        noSymlink(spec.path);
        change.beforeHash = diskHash(spec.path, spec.kind);
        const present = exists(spec.path);
        if (spec.kind === "instructions") {
          const before = present ? fs.readFileSync(spec.path, "utf8") : "";
          change.before = before;
          const oldBlock = managedBlock(before);
          if (oldBlock && !receipt)
            throw new AppError(
              "UNOWNED_BLOCK",
              "发现未登记的管理区块，请先检查部署历史",
            );
          if (receipt && hash(oldBlock || "") !== receipt.hash)
            throw new AppError(
              "LOCAL_DRIFT",
              "指令管理区块被外部修改；请复制修改到源指令或使用部署回滚恢复",
            );
          const after = replaceBlock(
            before,
            spec.removing ? null : spec.block || null,
          );
          change.after = after;
          change.afterHash = hash(after);
          if (!after && spec.removing) change.afterHash = absent;
          change.status =
            before === after
              ? "unchanged"
              : !present
                ? "create"
                : spec.removing
                  ? "remove"
                  : "update";
          change.diff = createTwoFilesPatch(
            spec.path,
            spec.path,
            before,
            after,
            "",
            "",
          );
        } else {
          const before = present ? readBundle(spec.path) : null;
          change.before = before?.["SKILL.md"]
            ? Buffer.from(before["SKILL.md"].content, "base64").toString("utf8")
            : "";
          if (present && !receipt)
            throw new AppError(
              "TARGET_CONFLICT",
              "目标已存在且不属于 HarnessSync；先导入，或使用独立名称",
            );
          if (receipt && change.beforeHash !== receipt.hash)
            throw new AppError(
              "LOCAL_DRIFT",
              "已部署 Skill 被外部修改；请先导入修改或回滚部署",
            );
          change.after = spec.files?.["SKILL.md"]
            ? Buffer.from(spec.files["SKILL.md"].content, "base64").toString(
                "utf8",
              )
            : "";
          change.afterHash = spec.removing ? absent : bundleHash(spec.files!);
          change.status =
            change.beforeHash === change.afterHash
              ? "unchanged"
              : spec.removing
                ? "remove"
                : present
                  ? "update"
                  : "create";
          change.diff = createTwoFilesPatch(
            spec.path + "/SKILL.md",
            spec.path + "/SKILL.md",
            change.before,
            change.after,
            "",
            "",
          );
        }
        if (change.status !== "unchanged")
          change.reason = {
            create: "部署新的配置",
            update: "源配置有更新",
            remove: "撤下已停用或移除的配置",
            conflict: "",
          }[change.status];
      } catch (e: any) {
        change.status = "conflict";
        change.reason = e.message;
      }
      changes.push(change);
    };
    for (const harness of adapters(this.store.home)) {
      const rules = manifest.rules
        .filter((r) => r.enabled && this.matches(r.scope, harness.id))
        .sort(
          (a, b) =>
            Number(a.scope.kind === "device") -
            Number(b.scope.kind === "device"),
        );
      try {
        const block = this.instructions(rules);
        if (block)
          add({
            path: harness.instructions,
            harness: harness.id,
            kind: "instructions",
            block,
          });
      } catch (e: any) {
        errors.push(`${harness.name}: ${e.message}`);
      }
      for (const skill of manifest.skills.filter(
        (s) => s.enabled && this.matches(s.scope, harness.id),
      )) {
        try {
          const files = readBundle(this.store.skillPath(skill.id));
          parseSkill(
            Buffer.from(files["SKILL.md"].content, "base64").toString("utf8"),
          );
          add({
            path: path.join(harness.skills, skill.name),
            harness: harness.id,
            kind: "skill",
            sourceId: skill.id,
            files,
          });
        } catch (e: any) {
          errors.push(`${skill.name}: ${e.message}`);
        }
      }
      for (const project of manifest.projects) {
        const dir = device.bindings[project.id];
        const rules = manifest.rules.filter(
          (r) => r.enabled && this.matches(r.scope, harness.id, project.id),
        );
        const skills = manifest.skills.filter(
          (s) => s.enabled && this.matches(s.scope, harness.id, project.id),
        );
        if (!dir) {
          if (rules.length || skills.length)
            errors.push(`项目 ${project.name} 尚未绑定本机目录`);
          continue;
        }
        if (!exists(dir) || !fs.statSync(dir).isDirectory()) {
          errors.push(`项目 ${project.name} 的目录不存在：${dir}`);
          continue;
        }
        const targets = projectTargets(harness.id, dir);
        try {
          if (
            manifest.rules.some(
              (r) =>
                r.enabled &&
                r.scope.kind === "project" &&
                r.scope.target === project.id &&
                r.scope.harnesses.length !== 2,
            )
          )
            throw new AppError(
              "SHARED_PROJECT_INSTRUCTIONS",
              "两个 Harness 共用项目 AGENTS.md；第一版项目指令需选择全部 Harness，项目 Skills 可以独立选择",
            );
          const block = this.instructions(rules, project.id);
          if (block)
            add({
              path: targets.instructions,
              harness: harness.id,
              kind: "instructions",
              projectId: project.id,
              block,
            });
          for (const skill of skills) {
            const files = readBundle(this.store.skillPath(skill.id));
            add({
              path: path.join(targets.skills, skill.name),
              harness: harness.id,
              kind: "skill",
              projectId: project.id,
              sourceId: skill.id,
              files,
            });
          }
        } catch (e: any) {
          errors.push(`${project.name}: ${e.message}`);
        }
      }
    }
    for (const receipt of state.receipts)
      if (!wanted.has(receipt.path)) add({ ...receipt, removing: true });
    const revision = this.store.revision();
    const id = hash(
      JSON.stringify({
        revision,
        changes: changes.map((c) => [
          c.path,
          c.beforeHash,
          c.afterHash,
          c.status,
        ]),
        errors,
      }),
    );
    return {
      id,
      revision,
      changes,
      errors: [...new Set(errors)],
      createdAt: new Date().toISOString(),
    };
  }
  deployments() {
    return fs
      .readdirSync(path.join(this.store.root, "deployments"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 40)
      .map((f) => {
        const x = json<Deployment>(
          path.join(this.store.root, "deployments", f),
        );
        return {
          id: x.id,
          date: x.date,
          changes: x.changes,
          rolledBack: x.status === "rolled-back",
          status: x.status,
        };
      });
  }
  private pending() {
    return this.deployments().filter((d) => d.status === "pending");
  }
  async apply(expectedPlanId: string) {
    return this.store.lock(() => {
      if (this.pending().length)
        throw new AppError(
          "INCOMPLETE_DEPLOYMENT",
          "上次部署未完成，请先在历史中回滚该部署",
          409,
        );
      const plan = this.plan();
      if (plan.id !== expectedPlanId)
        throw new AppError(
          "STALE_PLAN",
          "源配置或目标文件已变化，请重新预览",
          409,
        );
      if (
        plan.errors.length ||
        plan.changes.some((c) => c.status === "conflict")
      )
        throw new AppError(
          "DEPLOY_CONFLICT",
          "请先解决预览中的错误和冲突",
          409,
        );
      const changed = plan.changes.filter((c) => c.status !== "unchanged");
      if (!changed.length) return { id: null, changes: 0 };
      const state = this.store.state();
      const record: Deployment = {
        id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        date: new Date().toISOString(),
        changes: changed.length,
        status: "pending",
        beforeState: state,
        files: changed.map((c) => ({
          path: c.path,
          kind: c.kind,
          existed: exists(c.path),
          afterHash: c.afterHash,
          ...(c.kind === "skill"
            ? { files: exists(c.path) ? readBundle(c.path) : {} }
            : {
                content: exists(c.path) ? fs.readFileSync(c.path, "utf8") : "",
                mode: exists(c.path) ? fs.statSync(c.path).mode & 0o777 : 0o644,
              }),
        })),
      };
      const recordPath = path.join(
        this.store.root,
        "deployments",
        `${record.id}.json`,
      );
      writeJson(recordPath, record);
      const done: SavedFile[] = [];
      try {
        for (const change of changed) {
          if (diskHash(change.path, change.kind) !== change.beforeHash)
            throw new AppError(
              "STALE_TARGET",
              `部署过程中目标变化：${change.path}`,
              409,
            );
          if (change.kind === "skill") {
            if (change.status === "remove")
              fs.rmSync(change.path, { recursive: true, force: true });
            else writeBundle(change.path, change.files!);
          } else {
            if (change.afterHash === absent)
              fs.rmSync(change.path, { force: true });
            else
              atomicWrite(
                change.path,
                change.after,
                exists(change.path)
                  ? fs.statSync(change.path).mode & 0o777
                  : 0o644,
              );
          }
          done.push(record.files.find((f) => f.path === change.path)!);
        }
        const receipts = state.receipts.filter(
          (r) => !changed.some((c) => c.path === r.path),
        );
        for (const c of changed.filter((c) => c.status !== "remove"))
          receipts.push({
            path: c.path,
            kind: c.kind,
            harness: c.harness,
            sourceId: c.sourceId,
            projectId: c.projectId,
            hash:
              c.kind === "skill"
                ? c.afterHash
                : hash(managedBlock(c.after) || ""),
          });
        writeJson(path.join(this.store.root, "state.json"), { receipts });
        record.status = "applied";
        writeJson(recordPath, record);
      } catch (e) {
        for (const f of done.reverse()) this.restoreFile(f);
        writeJson(path.join(this.store.root, "state.json"), state);
        record.status = "failed";
        writeJson(recordPath, record);
        throw e;
      }
      return { id: record.id, changes: changed.length };
    });
  }
  private restoreFile(f: SavedFile) {
    noSymlink(f.path);
    if (!f.existed)
      fs.rmSync(f.path, { recursive: f.kind === "skill", force: true });
    else if (f.kind === "skill") writeBundle(f.path, f.files!);
    else atomicWrite(f.path, f.content!, f.mode);
  }
  async rollback(id: string) {
    if (!/^[0-9]+-[a-f0-9-]+$/.test(id))
      throw new AppError("INVALID_ID", "非法部署 ID");
    return this.store.lock(() => {
      const p = path.join(this.store.root, "deployments", `${id}.json`);
      if (!exists(p)) throw new AppError("NOT_FOUND", "部署记录不存在", 404);
      const record = json<Deployment>(p);
      if (!["applied", "pending"].includes(record.status))
        throw new AppError("NOT_APPLIED", "该部署已回滚或未成功执行");
      const latest = this.deployments().find(
        (d) => d.status === "applied" || d.status === "pending",
      );
      if (latest?.id !== id)
        throw new AppError(
          "NOT_LATEST",
          "只能回滚最近一次有效部署，请从最新记录依次回滚",
          409,
        );
      for (const f of record.files) {
        const actual = diskHash(f.path, f.kind);
        if (
          actual !== f.afterHash &&
          !(
            record.status === "pending" &&
            actual ===
              (f.existed
                ? f.kind === "skill"
                  ? bundleHash(f.files!)
                  : hash(f.content!)
                : absent)
          )
        )
          throw new AppError(
            "ROLLBACK_DRIFT",
            `目标有部署后的新修改，回滚会覆盖它：${f.path}`,
            409,
          );
      }
      for (const f of [...record.files].reverse()) this.restoreFile(f);
      writeJson(path.join(this.store.root, "state.json"), record.beforeState);
      record.status = "rolled-back";
      writeJson(p, record);
      return { id, changes: record.changes };
    });
  }
  inspect(): Inspection {
    const found = new Map<string, Inspection["skills"][number]>();
    const harnesses = adapters(this.store.home);
    const manifest = this.store.manifest();
    const device = this.store.device();
    for (const h of harnesses) {
      const roots = [
        h.skills,
        ...h.sharedSkills,
        ...Object.values(device.bindings).map(
          (dir) => projectTargets(h.id, dir).skills,
        ),
      ];
      for (const root of new Set(roots)) {
        if (!exists(root)) continue;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const file = path.join(root, entry.name, "SKILL.md");
          if (!exists(file)) continue;
          const source = path.dirname(file);
          const key = hash(source).slice(0, 16);
          const prior = found.get(key);
          if (prior) {
            if (!prior.harnesses.includes(h.id)) prior.harnesses.push(h.id);
            continue;
          }
          const item: Inspection["skills"][number] = {
            key,
            path: source,
            name: entry.name,
            description: "",
            harnesses: [h.id],
            valid: false,
            managed: this.store.state().receipts.some((r) => r.path === source),
          };
          try {
            const parsed = parseSkill(fs.readFileSync(file, "utf8"));
            item.name = parsed.name;
            item.description = parsed.description;
            item.valid = true;
          } catch (e: any) {
            item.error = e.message;
          }
          found.set(key, item);
        }
      }
    }
    return {
      skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
      instructions: harnesses.map((h) => ({
        harness: h.id,
        path: h.instructions,
        exists: exists(h.instructions),
        body: exists(h.instructions)
          ? fs.readFileSync(h.instructions, "utf8")
          : "",
      })),
    };
  }
  snapshot(): Snapshot {
    const versions =
      this.store.home === process.env.HOME ? harnessVersions() : {};
    return {
      root: this.store.root,
      revision: this.store.revision(),
      manifest: this.store.manifest(),
      device: this.store.device(),
      harnesses: adapters(this.store.home).map((h) => ({
        ...h,
        version: versions[h.id] || null,
        installed: h.installed || Boolean(versions[h.id]),
      })),
      plan: this.plan(),
      history: this.store.history(),
      deployments: this.deployments(),
    };
  }
}
export const publicPlan = (plan: Plan): Plan => ({
  ...plan,
  changes: plan.changes.map(({ files, ...c }) => c),
});
