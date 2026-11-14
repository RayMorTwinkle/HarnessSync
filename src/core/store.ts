import { registry, selectedHarnesses } from "./harness-registry.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  AppError,
  exists,
  hash,
  json,
  writeJson,
  noSymlink,
  readBundle,
  parseSkill,
  skillMarkdown,
  writeBundle,
  bundleHash,
  bundleDiskHash,
  skillPackageHash,
  type Bundle,
} from "./files.ts";
import { nativeHash, readNative } from "./native-snapshot.ts";
import { isIgnoredNativePath } from "./skill-sources.ts";
import {
  adapters,
  projectTargets,
  placeSkills,
  skillReaders,
} from "./adapters.ts";
import {
  harnessIds,
  ruleInput,
  skillInput,
  projectInput,
  type Manifest,
  type Device,
  type DeployState,
  type Scope,
} from "../shared/types.ts";

import { manifestSchema, diskManifest, writeManifest } from "./layout.ts";

export class Store {
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  constructor(
    root = process.env.HARNESS_SYNC_HOME ||
      path.join(os.homedir(), ".harness-sync"),
    home = os.homedir(),
  ) {
    this.root = path.resolve(root);
    this.repo = path.join(this.root, "repo");
    this.home = home;
  }
  async init() {
    noSymlink(this.root);
    // Opening an existing store must be genuinely read-only: harness sandboxes
    // may permit inspection of the user configuration but not home-directory writes.
    if (
      (exists(path.join(this.repo, "manifest.json")) ||
        exists(path.join(this.repo, "harness-sync.json"))) &&
      ["repo/.git", "device.json", "state.json", "deployments"].every((p) =>
        exists(path.join(this.root, p)),
      )
    ) {
      this.manifest();
      this.device();
      this.state();
      return this;
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    await this.lock(async () => {
      fs.mkdirSync(path.join(this.repo, "skills"), { recursive: true });
      fs.mkdirSync(path.join(this.root, "deployments"), {
        recursive: true,
        mode: 0o700,
      });
      if (
        !exists(path.join(this.repo, "manifest.json")) &&
        !exists(path.join(this.repo, "harness-sync.json"))
      )
        writeManifest(this.repo, {
          schemaVersion: 1,
          rules: [],
          skills: [],
          projects: [],
        });
      if (!exists(path.join(this.root, "device.json")))
        writeJson(path.join(this.root, "device.json"), {
          id: crypto.randomUUID(),
          name: os.hostname(),
          home: this.home,
          variables: {},
          bindings: {},
        });
      if (!exists(path.join(this.root, "state.json")))
        writeJson(path.join(this.root, "state.json"), { receipts: [] });
      if (!exists(path.join(this.repo, ".git"))) {
        this.git(["init", "-b", "main"]);
        this.git(["config", "user.name", "HarnessSync"]);
        this.git(["config", "user.email", "local@harness-sync.invalid"]);
        this.git([
          "config",
          "core.hooksPath",
          path.join(this.root, "disabled-hooks"),
        ]);
        this.commit("初始化配置库");
      }
    });
    return this;
  }
  manifest(): Manifest {
    return diskManifest(this.repo);
  }
  // Caller holds store.lock. Read paths never migrate.
  migrate() {
    if (exists(path.join(this.repo, "manifest.json"))) {
      writeManifest(this.repo, this.manifest());
      this.commit("迁移配置库到 v2");
    }
  }
  device(): Device {
    return json(path.join(this.root, "device.json"));
  }
  state(): DeployState {
    return json(path.join(this.root, "state.json"));
  }
  revision() {
    const m = this.manifest();
    return hash(
      JSON.stringify({
        m,
        d: this.device(),
        s: this.state(),
        harnesses: registry(this.home, this.root).stamp,
        skills: m.skills.map((s) => bundleDiskHash(this.skillPath(s.id))),
      }),
    );
  }
  skillPath(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id))
      throw new AppError("INVALID_ID", "非法 Skill ID");
    return path.join(this.repo, "skills", id);
  }
  git(args: string[]) {
    return execFileSync("git", args, {
      cwd: this.repo,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  }
  commit(message: string) {
    this.git(["add", "--all", "--", ".", ":(exclude)skills/.hsync-staging-*"]);
    if (this.git(["diff", "--cached", "--name-only"]))
      this.git([
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `${message}\n\n设备：${this.device().name.replace(/[\r\n]/g, " ")}`,
      ]);
  }
  history() {
    return this.git(["log", "-40", "--format=%H%x09%cI%x09%s"])
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, date, ...message] = l.split("\t");
        return { hash, date, message: message.join("\t") };
      });
  }
  async lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const lock = path.join(this.root, ".lock");
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try {
        fs.mkdirSync(lock);
        writeJson(path.join(lock, "owner.json"), { pid: process.pid });
        acquired = true;
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        try {
          const owner = json<{ pid: number }>(path.join(lock, "owner.json"));
          try {
            process.kill(owner.pid, 0);
          } catch (p: any) {
            if (p.code === "ESRCH")
              fs.rmSync(lock, { recursive: true, force: true });
          }
        } catch {
          try {
            if (Date.now() - fs.statSync(lock).mtimeMs > 30_000)
              fs.rmSync(lock, { recursive: true, force: true });
          } catch {}
        }
        await sleep(50);
      }
    }
    if (!acquired)
      throw new AppError(
        "BUSY",
        "另一个 CLI 或 GUI 正在修改配置，请稍后再试",
        409,
      );
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  checkRevision(expected?: string) {
    if (expected && expected !== this.revision())
      throw new AppError(
        "STALE_REVISION",
        "配置已被其他窗口或 CLI 修改，请刷新后重试",
        409,
      );
  }
  private validateScope(scope: Scope, m: Manifest) {
    const ids = registry(this.home, this.root).entries.map(
      (e) => e.manifest.id,
    );
    if (
      !(
        scope.harnesses.length === harnessIds.length &&
        harnessIds.every((id) => scope.harnesses.includes(id))
      ) &&
      ids.length === scope.harnesses.length &&
      ids.every((id) => scope.harnesses.includes(id))
    )
      scope.harnesses = [...harnessIds];
    if (
      scope.kind === "project" &&
      !m.projects.some((p) => p.id === scope.target)
    )
      throw new AppError("PROJECT_NOT_FOUND", "作用域引用的项目不存在");
  }
  async mutate<T>(
    message: string,
    fn: (m: Manifest) => T,
    revision?: string,
  ): Promise<T> {
    return this.lock(() => {
      this.checkRevision(revision);
      this.migrate();
      const m = this.manifest();
      const before = JSON.stringify(m);
      const beforeDevice = this.device();
      const beforeState = this.state();
      const beforeBundles = m.skills.map((s) => ({
        id: s.id,
        files: readBundle(this.skillPath(s.id)),
      }));
      let result: T;
      try {
        result = fn(m);
        const local = this.device();
        let migrated = false;
        for (const skill of m.skills) {
          if (
            typeof skill.source === "string" &&
            path.isAbsolute(skill.source)
          ) {
            local.origins = {
              ...local.origins,
              [skill.id]: local.origins?.[skill.id] || skill.source,
            };
            skill.source = "local-import";
            migrated = true;
          }
        }
        if (migrated) writeJson(path.join(this.root, "device.json"), local);
        manifestSchema.parse(m);
        writeManifest(this.repo, m);
        this.commit(message);
      } catch (e) {
        for (const dir of fs.readdirSync(path.join(this.repo, "skills")))
          if (
            !dir.startsWith(".hsync-staging-") &&
            !beforeBundles.some((b) => b.id === dir)
          )
            fs.rmSync(path.join(this.repo, "skills", dir), {
              recursive: true,
              force: true,
            });
        for (const b of beforeBundles)
          writeBundle(this.skillPath(b.id), b.files);
        writeManifest(this.repo, JSON.parse(before));
        writeJson(path.join(this.root, "device.json"), beforeDevice);
        writeJson(path.join(this.root, "state.json"), beforeState);
        this.git(["reset", "--mixed", "HEAD"]);
        throw e;
      }
      return result;
    });
  }
  async saveRule(data: unknown, id?: string, revision?: string) {
    const rule = ruleInput.parse(data);
    return this.mutate(
      `指令：${rule.title}`,
      (m) => {
        this.validateScope(rule.scope, m);
        const entry = { ...rule, id: id || crypto.randomUUID() };
        if (id && !m.rules.some((r) => r.id === id))
          throw new AppError("NOT_FOUND", "指令不存在", 404);
        m.rules = [...m.rules.filter((r) => r.id !== entry.id), entry];
        return entry;
      },
      revision,
    );
  }
  async saveSkill(
    data: unknown,
    id?: string,
    revision?: string,
    resources?: Bundle,
    options: { replaceResources?: boolean } = {},
  ) {
    const input = skillInput.parse(data);
    return this.mutate(
      `技能：${input.name}`,
      (m) => {
        this.validateScope(input.scope, m);
        if (m.skills.some((s) => s.name === input.name && s.id !== id))
          throw new AppError("DUPLICATE_NAME", "技能库中已存在同名 Skill", 409);
        if (id && !m.skills.some((s) => s.id === id))
          throw new AppError("NOT_FOUND", "Skill 不存在", 404);
        const entry = {
          id: id || crypto.randomUUID(),
          name: input.name,
          description: input.description,
          displayName:
            input.displayName || m.skills.find((s) => s.id === id)?.displayName,
          enabled: input.enabled,
          scope: input.scope,
          source: m.skills.find((s) => s.id === id)?.source,
        };
        const bundle: Bundle =
          id && !options.replaceResources
            ? readBundle(this.skillPath(id))
            : Object.create(null);
        if (resources) Object.assign(bundle, resources);
        const metadata = bundle["SKILL.md"]
          ? parseSkill(
              Buffer.from(bundle["SKILL.md"].content, "base64").toString(
                "utf8",
              ),
            ).metadata
          : {};
        bundle["SKILL.md"] = {
          content: Buffer.from(
            skillMarkdown(input.name, input.description, input.body, metadata),
          ).toString("base64"),
          mode: 0o644,
        };
        writeBundle(this.skillPath(entry.id), bundle);
        m.skills = [...m.skills.filter((s) => s.id !== entry.id), entry];
        return entry;
      },
      revision,
    );
  }
  async importSkill(
    source: string,
    scope: Scope,
    revision?: string,
    adopt = false,
    options: {
      useLibrary?: boolean;
      replaceLibrary?: boolean;
      name?: string;
    } = {},
  ) {
    if (
      [
        options.useLibrary,
        options.replaceLibrary,
        options.name !== undefined,
      ].filter(Boolean).length > 1
    )
      throw new AppError(
        "IMPORT_OPTIONS",
        "请选择 --use-library、--replace-library 或 --name 其中一个",
      );
    if (options.name && adopt)
      throw new AppError("IMPORT_OPTIONS", "改名导入不能同时接管原目录");
    const original = path.resolve(source);
    const absolute = fs.realpathSync(original);
    const bundle = readBundle(absolute);
    if (!bundle["SKILL.md"])
      throw new AppError("INVALID_SKILL", "目录中没有 SKILL.md");
    let parsed = parseSkill(
      Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
    );
    if (options.name !== undefined) {
      const text = skillMarkdown(
        options.name,
        parsed.description,
        parsed.body,
        parsed.metadata,
      );
      parsed = parseSkill(text);
      bundle["SKILL.md"].content = Buffer.from(text).toString("base64");
    }
    return this.mutate(
      `导入技能：${parsed.name}`,
      (m) => {
        this.validateScope(scope, m);
        const existing = m.skills.find((s) => s.name === parsed.name);
        if (options.name !== undefined && existing)
          throw new AppError(
            "DUPLICATE_NAME",
            "改名后的技能名称已存在，请选择新名称",
            409,
          );
        if ((options.useLibrary || options.replaceLibrary) && !existing)
          throw new AppError(
            "NOT_FOUND",
            "共享库中没有同名技能，请普通导入",
            404,
          );
        const same =
          existing &&
          skillPackageHash(readBundle(this.skillPath(existing.id))) ===
            skillPackageHash(bundle);
        if (existing && !same && !options.useLibrary && !options.replaceLibrary)
          throw new AppError(
            "LIBRARY_DIFFERS",
            "共享库已有同名技能，完整包内容不同。请先说明差异并选择：用共享库版本：skills import <目录> --use-library（plan 显示替换差异）；用这台的版本替换共享库：skills import <目录> --replace-library（会同步到其他设备，须明确同意）；两个都保留：skills import <目录> --name <新名称>；让 Agent 合并：先说明差异并取得明确同意，将合并结果写入单独目录，再 skills import <合并目录> --replace-library。",
            409,
          );
        const entry = existing || {
          id: crypto.randomUUID(),
          name: parsed.name,
          description: parsed.description,
          enabled: true,
          scope,
          source: "local-import",
        };
        const d = this.device();
        const native = adapters(this.home, this.root)
          .flatMap((h) => [
            {
              h: h.id,
              p: path.join(h.skills, parsed.name),
              projectId: undefined as string | undefined,
            },
            ...m.projects
              .filter((p) => d.bindings[p.id])
              .map((p) => ({
                h: h.id,
                p: path.join(
                  projectTargets(h.id, d.bindings[p.id], this.home, this.root)
                    .skills,
                  parsed.name,
                ),
                projectId: p.id,
              })),
          ])
          .filter((t) => exists(t.p) && fs.realpathSync(t.p) === absolute);
        adopt =
          adopt ||
          Boolean(options.useLibrary) ||
          Boolean(existing && native.length && !options.replaceLibrary);
        if (adopt && !native.length)
          throw new AppError(
            "NOT_NATIVE_TARGET",
            "只能接管适配器的原生部署目录，目录名需与 Skill name 一致；共享兼容目录可普通导入",
          );
        if (adopt) {
          noSymlink(path.dirname(original));
          const state = this.state();
          for (const target of native) {
            if (state.receipts.some((r) => r.path === target.p))
              throw new AppError(
                "ALREADY_MANAGED",
                "该目录已由 HarnessSync 管理",
              );
            if (
              !selectedHarnesses(
                entry.scope.harnesses,
                this.home,
                this.root,
                d.disabledHarnesses,
              ).includes(target.h) ||
              (target.projectId
                ? entry.scope.kind !== "project" ||
                  entry.scope.target !== target.projectId
                : entry.scope.kind === "project")
            )
              throw new AppError(
                "SCOPE_MISMATCH",
                "Skill 的适用范围与待接管目录不符",
              );
            noSymlink(path.dirname(target.p));
            if (isIgnoredNativePath(this, target.p))
              throw new AppError(
                "IGNORED_NATIVE_PATH",
                "该目录已标记外部保留，请先取消保留",
              );
            const adoptedLink = fs.lstatSync(target.p).isSymbolicLink()
              ? fs.readlinkSync(target.p)
              : undefined;
            if (
              adoptedLink !== undefined &&
              !placeSkills(
                selectedHarnesses(
                  entry.scope.harnesses,
                  this.home,
                  this.root,
                  d.disabledHarnesses,
                ),
                skillReaders(
                  this.home,
                  target.projectId ? d.bindings[target.projectId] : undefined,
                  this.root,
                  d.disabledHarnesses,
                ),
                registry(this.home, this.root)
                  .entries.filter(
                    (e) => e.manifest.skills.sameNameCopies === "collapse",
                  )
                  .map((e) => e.manifest.id),
              ).some(
                (placement) =>
                  path.join(placement.dir, entry.name) === target.p,
              )
            )
              throw new AppError(
                "NOT_PLACEMENT_TARGET",
                "链接不在当前技能放置目标中；请普通导入并保留原链接，或调整 Harness 选择后再接管",
              );
            if (existing) {
              // Stage a fingerprint-bound choice; plan/apply owns native writes and receipts.
              if (options.useLibrary) readNative(target.p);
              state.conflictChoices = {
                ...state.conflictChoices,
                [target.p]: {
                  use: options.useLibrary ? "library" : "native",
                  fingerprint: nativeHash(target.p),
                  sourceId: entry.id,
                  sourceHash: options.replaceLibrary
                    ? bundleHash(bundle)
                    : bundleDiskHash(this.skillPath(entry.id)),
                  adoptScope: JSON.stringify(entry.scope),
                },
              };
              continue;
            }
            state.receipts.push({
              adoptedLink,
              kind: "skill",
              harness: target.h,
              path: target.p,
              sourceId: entry.id,
              projectId: target.projectId,
              hash:
                adoptedLink === undefined
                  ? bundleHash(bundle)
                  : hash(
                      JSON.stringify({
                        link: adoptedLink,
                        bundle: bundleHash(bundle),
                      }),
                    ),
            });
          }
          writeJson(path.join(this.root, "state.json"), state);
        }
        if (existing && options.replaceLibrary) {
          noSymlink(this.skillPath(entry.id));
          writeBundle(this.skillPath(entry.id), bundle);
          entry.description = parsed.description;
          entry.source = "local-import";
          d.origins = { ...d.origins, [entry.id]: original };
          d.originHashes = {
            ...d.originHashes,
            [entry.id]: bundleDiskHash(absolute),
          };
          if (d.originRealPaths) delete d.originRealPaths[entry.id];
          if (original !== absolute)
            d.originRealPaths = { ...d.originRealPaths, [entry.id]: absolute };
          writeJson(path.join(this.root, "device.json"), d);
        }
        if (!existing) {
          writeBundle(this.skillPath(entry.id), bundle);
          m.skills.push(entry);
          // A renamed copy has a different SKILL.md and cannot be refreshed from the old name.
          if (options.name === undefined) {
            d.origins = { ...d.origins, [entry.id]: original };
            d.originHashes = {
              ...d.originHashes,
              [entry.id]: bundleDiskHash(absolute),
            };
            if (original !== absolute)
              d.originRealPaths = {
                ...d.originRealPaths,
                [entry.id]: absolute,
              };
            writeJson(path.join(this.root, "device.json"), d);
          }
        }
        return entry;
      },
      revision,
    );
  }
  async remove(
    kind: "rules" | "skills" | "projects",
    id: string,
    revision?: string,
  ) {
    return this.mutate(
      `删除${{ rules: "指令", skills: "技能", projects: "项目" }[kind]}`,
      (m) => {
        if (!m[kind].some((x) => x.id === id))
          throw new AppError("NOT_FOUND", "条目不存在", 404);
        if (
          kind === "projects" &&
          [...m.rules, ...m.skills].some(
            (x) => x.scope.kind === "project" && x.scope.target === id,
          )
        )
          throw new AppError(
            "PROJECT_IN_USE",
            "请先移除该项目专属的指令和 Skills",
          );
        (m[kind] as { id: string }[]) = m[kind].filter((x) => x.id !== id);
        if (kind === "skills") {
          fs.rmSync(this.skillPath(id), { recursive: true, force: true });
          const d = this.device();
          if (d.origins) {
            delete d.origins[id];
            if (d.originRealPaths) delete d.originRealPaths[id];
            if (d.originHashes) delete d.originHashes[id];
            writeJson(path.join(this.root, "device.json"), d);
          }
        }
        if (kind === "projects") {
          const d = this.device();
          delete d.bindings[id];
          writeJson(path.join(this.root, "device.json"), d);
        }
        return { id };
      },
      revision,
    );
  }
  async saveProject(data: unknown, id?: string, revision?: string) {
    const input = projectInput.parse(data);
    return this.mutate(
      `项目：${input.name}`,
      (m) => {
        if (
          m.projects.some(
            (p) =>
              p.name.toLowerCase() === input.name.toLowerCase() && p.id !== id,
          )
        )
          throw new AppError("DUPLICATE_NAME", "已有同名项目", 409);
        if (id && !m.projects.some((p) => p.id === id))
          throw new AppError("NOT_FOUND", "项目不存在", 404);
        const entry = { id: id || crypto.randomUUID(), name: input.name };
        if (input.path !== undefined && !input.path.trim()) {
          const d = this.device();
          delete d.bindings[entry.id];
          writeJson(path.join(this.root, "device.json"), d);
        } else if (input.path) {
          const dir = fs.realpathSync(path.resolve(input.path));
          if (
            !fs.statSync(dir).isDirectory() ||
            dir === path.parse(dir).root ||
            dir === this.home ||
            dir.startsWith(this.root + path.sep)
          )
            throw new AppError("INVALID_PROJECT", "请选择实际的项目目录");
          const d = this.device();
          if (
            Object.entries(d.bindings).some(
              ([key, value]) => key !== entry.id && value === dir,
            )
          )
            throw new AppError("PATH_BOUND", "这个目录已绑定到另一个项目");
          d.bindings[entry.id] = dir;
          writeJson(path.join(this.root, "device.json"), d);
        }
        m.projects = [...m.projects.filter((p) => p.id !== entry.id), entry];
        return entry;
      },
      revision,
    );
  }
  harnesses() {
    const { errors, pluginDir } = registry(this.home, this.root);
    return {
      harnesses: adapters(
        this.home,
        this.root,
        this.device().disabledHarnesses,
      ),
      errors,
      pluginDir,
    };
  }
  async setHarnessEnabled(id: string, enabled: boolean, revision?: string) {
    return this.lock(() => {
      this.checkRevision(revision);
      if (
        !registry(this.home, this.root).entries.some(
          (e) => e.manifest.id === id,
        )
      )
        throw new AppError("UNKNOWN_HARNESS", `未知 Harness：${id}`);
      const d = this.device();
      const disabled = new Set(d.disabledHarnesses || []);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      d.disabledHarnesses = [...disabled].sort();
      writeJson(path.join(this.root, "device.json"), d);
      return this.harnesses();
    });
  }
  async saveDevice(input: unknown, revision?: string) {
    const value = z
      .object({
        name: z.string().trim().min(1).max(100),
        variables: z.record(
          z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          z.string().max(10_000),
        ),
      })
      .parse(input);
    return this.lock(() => {
      this.checkRevision(revision);
      const d = this.device();
      d.name = value.name;
      d.variables = value.variables;
      writeJson(path.join(this.root, "device.json"), d);
      return d;
    });
  }
  async restoreSource(commit: string, revision?: string) {
    const { Sync } = await import("./sync.ts");
    return new Sync(this).restore(commit, revision);
  }
}
