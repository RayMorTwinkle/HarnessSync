import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTwoFilesPatch } from "diff";
import {
  adapters,
  projectTargets,
  harnessVersions,
  sharedInstructionPeers,
  skillReaders,
  placeSkills,
} from "./adapters.ts";
import {
  nativeHash,
  matchesNativeHash,
  readNative,
  restoreNative,
  type NativeTree,
} from "./native-snapshot.ts";
import { Store } from "./store.ts";
import { isIgnoredNativePath, sourceStatus } from "./skill-sources.ts";
import { scanMachine } from "./scanner.ts";
import {
  AppError,
  adoptedSkillHash,
  atomicWrite,
  bundleHash,
  bundleDiskHash,
  matchesDiskHash,
  stagingLeftovers,
  cleanStaging,
  diskHash,
  exists,
  hash,
  json,
  noSymlink,
  parseSkill,
  skillMarkdown,
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
  native?: NativeTree;
  afterNativeHash?: string;
  path: string;
  kind: "instructions" | "skill";
  existed: boolean;
  content?: string;
  files?: Bundle;
  afterHash: string;
  mode?: number;
  adopted?: boolean;
  link?: string;
  beforeHash?: string;
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
  private deploymentCache = new Map<
    string,
    { key: string; value: Deployment }
  >();
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
  plan(options: { onlySkillId?: string } = {}): Plan {
    const source = this.store.manifest();
    const manifest = options.onlySkillId
      ? {
          ...source,
          rules: [],
          projects: [],
          skills: source.skills.filter((s) => s.id === options.onlySkillId),
        }
      : source;
    const state = this.store.state();
    const device = this.store.device();
    const changes: Change[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const wanted = new Set<string>();
    const stagingFingerprints: string[][] = [];
    if (this.pending().length)
      errors.push("有部署未完成，请先在版本与部署中回滚最新的未完成部署");
    const add = (spec: {
      path: string;
      harness: HarnessId;
      kind: "instructions" | "skill";
      projectId?: string;
      sourceId?: string;
      block?: string | null;
      sourceHash?: string;
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
        if (
          spec.kind === "skill" &&
          !receipt &&
          isIgnoredNativePath(this.store, spec.path)
        ) {
          change.reason = "外部保留：此本机入口不由 HarnessSync 管理";
          changes.push(change);
          return;
        }
        if (receipt?.adoptedLink !== undefined) {
          if (spec.removing)
            throw new AppError(
              "PENDING_ADOPTION",
              "链接尚未接管，请先完成副本替换后再撤下",
            );
          change.beforeHash = adoptedSkillHash(spec.path, receipt.adoptedLink);
        } else {
          if (spec.kind === "skill" && !receipt && exists(spec.path))
            noSymlink(path.dirname(spec.path));
          else noSymlink(spec.path);
          try {
            change.beforeHash = diskHash(spec.path, spec.kind);
          } catch (e) {
            if (spec.kind !== "skill" || receipt || !exists(spec.path)) throw e;
            change.beforeHash = nativeHash(spec.path);
          }
        }
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
          const replacement = options.onlySkillId
            ? undefined
            : state.instructionReplacements?.find((r) => r.path === spec.path);
          if (replacement && change.beforeHash !== replacement.hash)
            throw new AppError(
              "STALE_INVENTORY",
              "全局指令已在扫描后变化，请重新扫描再登记替换",
            );
          if (replacement && (!spec.block || spec.removing))
            throw new AppError(
              "NO_REPLACEMENT",
              "替换全局指令前，需要先保存适用于该 Harness 的源指令",
            );
          const after = replacement
            ? spec.block + "\n"
            : replaceBlock(before, spec.removing ? null : spec.block || null);
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
          change.afterHash = spec.removing ? absent : spec.sourceHash!;
          const choice = state.conflictChoices?.[spec.path];
          const fingerprint =
            present && !receipt ? nativeHash(spec.path) : undefined;
          const valid =
            choice &&
            choice.sourceId === spec.sourceId &&
            choice.fingerprint === fingerprint;
          const nativeAdoption =
            valid &&
            choice.use === "native" &&
            choice.sourceHash === spec.sourceHash;
          const collision =
            present &&
            !receipt &&
            (change.beforeHash !== change.afterHash ||
              fs.lstatSync(spec.path).isSymbolicLink());
          if (collision) {
            change.conflictFingerprint = fingerprint;
            change.conflictOptions = ["library", "native", "skip"];
            this.conflictDiff(change, spec.sourceId!);
            if (!valid)
              throw new AppError(
                "TARGET_CONFLICT",
                choice
                  ? "原生目录在选择后变化，请重新选择冲突处理方式"
                  : "目标已存在且内容不同，请选择 library、native 或 skip",
              );
            if (choice.use === "skip") {
              change.status = "skipped";
              change.reason = "已跳过，待处理";
              changes.push(change);
              return;
            }
            if (!nativeAdoption && choice.use !== "library")
              throw new AppError(
                "TARGET_CONFLICT",
                "源配置已变化，请重新选择冲突处理方式",
              );
            change.beforeHash = fingerprint!;
          }
          if (
            (nativeAdoption && !fs.lstatSync(spec.path).isSymbolicLink()) ||
            (receipt?.adoptedSourceHash !== undefined &&
              receipt.adoptedSourceHash === spec.sourceHash)
          )
            change.afterHash = receipt?.hash || diskHash(spec.path, "skill");
          if (
            receipt &&
            !(receipt.adoptedLink !== undefined
              ? change.beforeHash === receipt.hash
              : matchesDiskHash(spec.path, "skill", receipt.hash))
          )
            throw new AppError(
              "LOCAL_DRIFT",
              "已部署 Skill 被外部修改；请先导入修改或回滚部署",
            );
          change.status =
            collision &&
            (!nativeAdoption || fs.lstatSync(spec.path).isSymbolicLink())
              ? "replace"
              : present && !receipt
                ? "adopt"
                : change.beforeHash === change.afterHash
                  ? "unchanged"
                  : spec.removing
                    ? "remove"
                    : present
                      ? "update"
                      : "create";
          if (["create", "update", "remove"].includes(change.status)) {
            change.before = present
              ? fs.readFileSync(path.join(spec.path, "SKILL.md"), "utf8")
              : "";
            change.after = spec.removing
              ? ""
              : fs.readFileSync(
                  path.join(this.store.skillPath(spec.sourceId!), "SKILL.md"),
                  "utf8",
                );
          }
          if (!change.conflictOptions)
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
          change.reason =
            receipt?.adoptedLink !== undefined
              ? "以副本替换链接"
              : {
                  replace: "以库版本覆盖，原件保存到部署快照",
                  skipped: "已跳过，待处理",
                  adopt: "内容一致，接管现有目录",
                  create: "部署新的配置",
                  update: "源配置有更新",
                  remove:
                    spec.kind === "skill" &&
                    manifest.skills.some(
                      (s) => s.id === spec.sourceId && s.enabled,
                    )
                      ? "移除重复副本或已变更的部署位置"
                      : "撤下已停用或移除的配置",
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
                sharedInstructionPeers.includes(harness.id) &&
                sharedInstructionPeers.some((h) =>
                  r.scope.harnesses.includes(h),
                ) &&
                !sharedInstructionPeers.every((h) =>
                  r.scope.harnesses.includes(h),
                ),
            )
          )
            throw new AppError(
              "SHARED_PROJECT_INSTRUCTIONS",
              "DeepSeek、OpenCode、Codex 共用项目 AGENTS.md；面向其中任一工具的项目指令需同时选择三者。Claude Code 使用独立 CLAUDE.md",
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
        } catch (e: any) {
          errors.push(`${project.name}: ${e.message}`);
        }
      }
    }
    for (const skill of manifest.skills.filter((s) => s.enabled)) {
      const projectId =
        skill.scope.kind === "project" ? skill.scope.target : undefined;
      if (skill.scope.kind === "device" && skill.scope.target !== device.id)
        continue;
      const projectDir = projectId ? device.bindings[projectId] : undefined;
      if (projectId && (!projectDir || !exists(projectDir))) continue;
      try {
        const sourcePath = this.store.skillPath(skill.id);
        const sourceHash = bundleDiskHash(sourcePath);
        parseSkill(fs.readFileSync(path.join(sourcePath, "SKILL.md"), "utf8"));
        const placement = placeSkills(
          skill.scope.harnesses,
          skillReaders(this.store.home, projectDir),
        );
        const exposure = [
          ...new Set(placement.flatMap((d) => d.readers)),
        ].filter((h) => !skill.scope.harnesses.includes(h));
        if (exposure.length)
          warnings.push(
            `${skill.name}：共享技能目录也会被 ${exposure.join("、")} 读取，不能保证仅对所选 Harness 可见`,
          );
        for (const entry of placement)
          add({
            path: path.join(entry.dir, skill.name),
            kind: "skill",
            sourceId: skill.id,
            projectId,
            harness: entry.readers.find((h) =>
              skill.scope.harnesses.includes(h),
            )!,
            sourceHash,
          });
      } catch (e: any) {
        errors.push(`${skill.name}: ${e.message}`);
      }
    }
    for (const receipt of state.receipts)
      if (
        (!options.onlySkillId || receipt.sourceId === options.onlySkillId) &&
        !wanted.has(receipt.path)
      )
        add({ ...receipt, removing: true });
    if (!options.onlySkillId)
      for (const replacement of state.instructionReplacements || [])
        if (!wanted.has(replacement.path))
          errors.push(`已登记的指令替换没有适用源片段：${replacement.path}`);
    try {
      for (const stage of this.staging()) {
        stagingFingerprints.push([
          stage,
          diskHash(stage, "skill"),
          hash(fs.readFileSync(`${stage}.json`, "utf8")),
        ]);
        if (exists(`${stage}-old`))
          errors.push(`暂存目录含原件备份，需先恢复未完成部署并检查：${stage}`);
        else
          warnings.push(`发现 HarnessSync 暂存残留，应用计划时清理：${stage}`);
      }
    } catch (e: any) {
      errors.push(e.message);
    }
    if (!options.onlySkillId) {
      for (const p of device.ignoredNativePaths || [])
        warnings.push(`外部保留：${p}`);
      for (const s of sourceStatus(this.store))
        if (s.changed || s.note.startsWith("源目录无法读取"))
          warnings.push(`${s.name}：${s.note}`);
    }
    const revision = this.store.revision();
    const id = hash(
      JSON.stringify({
        revision,
        choices: state.conflictChoices,
        staging: stagingFingerprints,
        changes: changes.map((c) => [
          c.path,
          c.beforeHash,
          c.afterHash,
          c.status,
        ]),
        errors,
        warnings,
      }),
    );
    return {
      id,
      revision,
      changes,
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      createdAt: new Date().toISOString(),
    };
  }
  private conflictDiff(change: Change, sourceId: string) {
    let tree: NativeTree;
    try {
      tree = readNative(change.path);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "SNAPSHOT_TOO_LARGE") throw e;
      change.diff = `${e.message}，无法生成完整差异或覆盖；仍可选择 skip`;
      return;
    }
    const library = readBundle(this.store.skillPath(sourceId));
    let native = tree.files;
    let prefix = "";
    if (native[""].link !== undefined) {
      prefix = `符号链接：${native[""].link} → 库版本目录（不会写入链接目标）\n`;
      try {
        native = readNative(fs.realpathSync(change.path)).files;
      } catch {
        change.diff = prefix;
        return;
      }
    }
    change.fileChanges = [
      ...new Set([
        ...Object.keys(native).filter(
          (p) =>
            native[p].content !== undefined || native[p].link !== undefined,
        ),
        ...Object.keys(library),
      ]),
    ]
      .sort()
      .flatMap((p) => {
        const before = native[p],
          after = library[p];
        const a =
            before?.link !== undefined
              ? Buffer.from(before.link)
              : Buffer.from(before?.content || "", "base64"),
          b = Buffer.from(after?.content || "", "base64");
        if (
          before?.link === undefined &&
          before?.content === after?.content &&
          before?.mode === after?.mode
        )
          return [];
        const binary = [a, b].some(
          (v) => v.includes(0) || !Buffer.from(v.toString("utf8")).equals(v),
        );
        return [
          {
            path: p,
            status: !before
              ? ("added" as const)
              : !after
                ? ("removed" as const)
                : ("modified" as const),
            binary,
            ...(before?.link !== undefined ? { beforeLink: before.link } : {}),
            beforeSize: a.length,
            afterSize: b.length,
            beforeHash: hash(a.toString("base64")),
            afterHash: hash(b.toString("base64")),
            ...(binary
              ? {}
              : {
                  diff: createTwoFilesPatch(
                    p,
                    p,
                    before?.link !== undefined
                      ? `符号链接：${before.link}\n`
                      : a.toString("utf8"),
                    b.toString("utf8"),
                  ),
                }),
          },
        ];
      });
    change.diff =
      prefix +
      (change.fileChanges.find((f) => f.path === "SKILL.md")?.diff || "");
  }
  conflicts() {
    return publicPlan(this.plan()).changes.filter((c) => c.conflictOptions);
  }
  private conflictTarget(target: string) {
    const matches = this.conflicts().filter(
      (c) =>
        c.path === path.resolve(target) || path.basename(c.path) === target,
    );
    if (matches.length !== 1)
      throw new AppError(
        "AMBIGUOUS_CONFLICT",
        "未找到唯一冲突，请使用计划中的完整路径",
        409,
      );
    return matches[0];
  }
  async chooseConflict(
    target: string,
    use: "library" | "native" | "skip",
    fingerprint?: string,
  ) {
    if (!["library", "native", "skip"].includes(use))
      throw new AppError("INVALID_CHOICE", "请选择 library、native 或 skip");
    const revision = this.store.revision();
    const selected = this.conflictTarget(target);
    if (fingerprint && fingerprint !== selected.conflictFingerprint)
      throw new AppError("STALE_TARGET", "冲突已变化，请重新预览", 409);
    const choose = () => {
      if (nativeHash(selected.path) !== selected.conflictFingerprint)
        throw new AppError("STALE_TARGET", "原生目录已变化，请重新预览", 409);
      const state = this.store.state();
      state.conflictChoices = {
        ...state.conflictChoices,
        [selected.path]: {
          use,
          fingerprint: selected.conflictFingerprint!,
          sourceId: selected.sourceId!,
          ...(use === "native"
            ? {
                sourceHash: bundleDiskHash(
                  this.store.skillPath(selected.sourceId!),
                ),
              }
            : {}),
        },
      };
      writeJson(path.join(this.store.root, "state.json"), state);
      return {
        path: selected.path,
        use,
        fingerprint: selected.conflictFingerprint,
      };
    };
    if (use !== "native")
      return this.store.lock(() => {
        this.store.checkRevision(revision);
        if (use === "library") readNative(selected.path);
        return choose();
      });
    return this.store.mutate(
      "采用原生技能解决冲突",
      (manifest) => {
        if (nativeHash(selected.path) !== selected.conflictFingerprint)
          throw new AppError("STALE_TARGET", "原生目录已变化，请重新预览", 409);
        const entry = manifest.skills.find((s) => s.id === selected.sourceId)!;
        const bundle = readBundle(fs.realpathSync(selected.path));
        if (!bundle["SKILL.md"])
          throw new AppError("INVALID_SKILL", "目录中缺少 SKILL.md");
        const parsed = parseSkill(
          Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
        );
        if (parsed.name !== entry.name)
          throw new AppError(
            "SOURCE_NAME_CHANGED",
            "原生 name 必须与对应库技能一致",
          );
        const old = parseSkill(
          fs.readFileSync(
            path.join(this.store.skillPath(entry.id), "SKILL.md"),
            "utf8",
          ),
        );
        bundle["SKILL.md"].content = Buffer.from(
          skillMarkdown(parsed.name, parsed.description, parsed.body, {
            ...old.metadata,
            ...parsed.metadata,
          }),
        ).toString("base64");
        writeBundle(this.store.skillPath(entry.id), bundle);
        entry.description = parsed.description;
        return choose();
      },
      revision,
    );
  }
  async clearConflicts(target?: string) {
    return this.store.lock(() => {
      const state = this.store.state();
      if (target) delete state.conflictChoices?.[path.resolve(target)];
      else state.conflictChoices = {};
      writeJson(path.join(this.store.root, "state.json"), state);
      return { choices: state.conflictChoices || {} };
    });
  }
  deployments() {
    return fs
      .readdirSync(path.join(this.store.root, "deployments"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => {
        const file = path.join(this.store.root, "deployments", f);
        const stat = fs.statSync(file);
        const key = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(":");
        let cached = this.deploymentCache.get(file);
        if (cached?.key !== key) {
          // Keep metadata only: full snapshot bodies can be many MB each.
          const { files, beforeState, ...metadata } = json<Deployment>(file);
          cached = {
            key,
            value: { ...metadata, files: [], beforeState: { receipts: [] } },
          };
          this.deploymentCache.set(file, cached);
        }
        const x = cached.value;
        return {
          id: x.id,
          date: x.date,
          changes: x.changes,
          rolledBack: x.status === "rolled-back",
          status: x.status,
        };
      });
  }
  private staging() {
    const dirs = new Set(skillReaders(this.store.home).map((r) => r.dir));
    for (const dir of Object.values(this.store.device().bindings))
      for (const r of skillReaders(this.store.home, dir)) dirs.add(r.dir);
    for (const r of this.store.state().receipts)
      if (r.kind === "skill") dirs.add(path.dirname(r.path));
    return [...dirs].flatMap((dir) => stagingLeftovers(dir));
  }
  private pruneDeployments() {
    const records = this.deployments();
    const protectedIds = new Set(
      records.filter((d) => d.status === "pending").map((d) => d.id),
    );
    const latest = records.find((d) => d.status === "applied");
    if (latest) protectedIds.add(latest.id);
    let count = protectedIds.size;
    let bytes = records
      .filter((d) => protectedIds.has(d.id))
      .reduce(
        (n, d) =>
          n +
          fs.statSync(path.join(this.store.root, "deployments", `${d.id}.json`))
            .size,
        0,
      );
    for (const d of records) {
      if (protectedIds.has(d.id)) continue;
      const file = path.join(this.store.root, "deployments", `${d.id}.json`);
      const size = fs.statSync(file).size;
      if (count < 20 && bytes + size <= 128 * 1024 * 1024) {
        count++;
        bytes += size;
        continue;
      }
      fs.unlinkSync(file);
      this.deploymentCache.delete(file);
    }
  }

  private pending() {
    return this.deployments().filter((d) => d.status === "pending");
  }
  async apply(expectedPlanId: string, options: { onlySkillId?: string } = {}) {
    return this.store.lock(() => {
      if (this.pending().length)
        throw new AppError(
          "INCOMPLETE_DEPLOYMENT",
          "上次部署未完成，请先在历史中回滚该部署",
          409,
        );
      const plan = this.plan(options);
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
      const changed = plan.changes.filter(
        (c) => !["unchanged", "skipped"].includes(c.status),
      );
      for (const stage of this.staging()) cleanStaging(stage);
      if (!changed.length) return { id: null, changes: 0 };
      const state = this.store.state();
      const record: Deployment = {
        id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        date: new Date().toISOString(),
        changes: changed.length,
        status: "pending",
        beforeState: state,
        files: changed.map((c) => ({
          ...(c.status === "replace" ? { native: readNative(c.path) } : {}),
          adopted: c.status === "adopt",
          path: c.path,
          kind: c.kind,
          existed: exists(c.path),
          afterHash: c.afterHash,
          beforeHash: c.beforeHash,
          ...(state.receipts.find((r) => r.path === c.path)?.adoptedLink !==
          undefined
            ? { link: fs.readlinkSync(c.path) }
            : {}),
          ...(c.kind === "skill"
            ? {
                files:
                  c.status !== "adopt" &&
                  c.status !== "replace" &&
                  exists(c.path)
                    ? readBundle(c.path)
                    : {},
              }
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
      if (
        Buffer.byteLength(JSON.stringify(record, null, 2) + "\n") >
        64 * 1024 * 1024
      )
        throw new AppError(
          "SNAPSHOT_TOO_LARGE",
          "单次部署快照超过 64 MiB，请拆分源配置后重新预览",
        );
      writeJson(recordPath, record);
      const done: SavedFile[] = [];
      try {
        for (const change of changed) {
          const adoption = state.receipts.find(
            (r) => r.path === change.path,
          )?.adoptedLink;
          if (
            (change.conflictFingerprint && exists(change.path)
              ? nativeHash(change.path)
              : adoption !== undefined
                ? adoptedSkillHash(change.path, adoption)
                : diskHash(change.path, change.kind)) !== change.beforeHash
          )
            throw new AppError(
              "STALE_TARGET",
              `部署过程中目标变化：${change.path}`,
              409,
            );
          if (change.status === "adopt") continue;
          done.push(record.files.find((f) => f.path === change.path)!);
          if (
            adoption !== undefined ||
            (change.status === "replace" &&
              fs.lstatSync(change.path).isSymbolicLink())
          )
            fs.unlinkSync(change.path);
          if (change.kind === "skill") {
            if (change.status === "remove")
              fs.rmSync(change.path, { recursive: true, force: true });
            else {
              const files = readBundle(this.store.skillPath(change.sourceId!));
              if (bundleHash(files) !== change.afterHash)
                throw new AppError(
                  "STALE_SOURCE",
                  "部署过程中源 Skill 变化，请重新预览",
                  409,
                );
              writeBundle(change.path, files);
              const saved = record.files.find((f) => f.path === change.path)!;
              if (saved.native) {
                saved.afterNativeHash = nativeHash(change.path);
                writeJson(recordPath, record);
              }
            }
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
        }
        const receipts = state.receipts.filter(
          (r) => !changed.some((c) => c.path === r.path),
        );
        for (const c of changed.filter((c) => c.status !== "remove"))
          receipts.push({
            ...(c.status === "adopt" &&
            state.conflictChoices?.[c.path]?.use === "native"
              ? { adoptedSourceHash: state.conflictChoices[c.path].sourceHash }
              : {}),
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
        writeJson(path.join(this.store.root, "state.json"), {
          ...state,
          receipts,
          instructionReplacements: state.instructionReplacements?.filter(
            (r) => !changed.some((c) => c.path === r.path),
          ),
        });
        record.status = "applied";
        writeJson(recordPath, record);
      } catch (e) {
        for (const f of done.reverse()) this.restoreFile(f);
        writeJson(path.join(this.store.root, "state.json"), state);
        record.status = "failed";
        writeJson(recordPath, record);
        throw e;
      }
      try {
        this.pruneDeployments();
      } catch (e: any) {
        return {
          id: record.id,
          changes: changed.length,
          warnings: [`部署已完成，但旧快照清理失败：${e.message}`],
        };
      }
      return { id: record.id, changes: changed.length };
    });
  }
  private restoreFile(f: SavedFile) {
    if (f.adopted) return;
    if (f.native) {
      restoreNative(f.path, f.native);
      return;
    }
    if (f.link !== undefined) {
      noSymlink(path.dirname(f.path));
      if (exists(f.path) && fs.lstatSync(f.path).isSymbolicLink()) {
        if (fs.readlinkSync(f.path) === f.link) return;
        throw new AppError("ROLLBACK_DRIFT", `链接已变化：${f.path}`);
      }
      noSymlink(f.path);
      fs.rmSync(f.path, { recursive: true, force: true });
      fs.symlinkSync(f.link, f.path);
      return;
    }
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
        if (
          f.afterNativeHash &&
          exists(f.path) &&
          matchesNativeHash(f.path, f.afterNativeHash)
        )
          continue;
        if (f.afterNativeHash && record.status === "applied")
          throw new AppError(
            "ROLLBACK_DRIFT",
            `目标有部署后的新修改：${f.path}`,
            409,
          );
        const pendingLink =
          record.status === "pending" &&
          f.link !== undefined &&
          exists(f.path) &&
          fs.lstatSync(f.path).isSymbolicLink();
        const originalNative =
          record.status === "pending" &&
          f.native &&
          exists(f.path) &&
          f.beforeHash !== undefined &&
          matchesNativeHash(f.path, f.beforeHash);
        if (originalNative) continue;
        if (
          record.status === "pending" &&
          f.native?.files[""].link !== undefined &&
          !exists(f.path)
        )
          continue;
        if (f.afterNativeHash)
          throw new AppError(
            "ROLLBACK_DRIFT",
            `目标有部署后的新修改：${f.path}`,
            409,
          );
        const actual = pendingLink
          ? adoptedSkillHash(f.path, f.link!)
          : diskHash(f.path, f.kind);
        if (
          !(pendingLink
            ? actual === f.afterHash
            : matchesDiskHash(f.path, f.kind, f.afterHash)) &&
          !(
            record.status === "pending" &&
            (actual ===
              (f.beforeHash ??
                (f.existed
                  ? f.kind === "skill"
                    ? bundleHash(f.files!)
                    : hash(f.content!)
                  : absent)) ||
              (f.link !== undefined && actual === absent))
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
    return scanMachine(this.store);
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
