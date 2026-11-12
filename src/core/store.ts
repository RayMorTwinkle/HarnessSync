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
  type Bundle,
} from "./files.ts";
import { adapters, projectTargets } from "./adapters.ts";
import {
  ruleInput,
  skillInput,
  projectInput,
  type Manifest,
  type Device,
  type DeployState,
  type Scope,
} from "../shared/types.ts";

import {
  manifestSchema,
  diskManifest,
  writeManifest,
  readManifest,
} from "./layout.ts";

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
    this.git(["add", "--all"]);
    if (this.git(["status", "--porcelain"]))
      this.git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
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
        manifestSchema.parse(m);
        writeManifest(this.repo, m);
        this.commit(message);
      } catch (e) {
        for (const dir of fs.readdirSync(path.join(this.repo, "skills")))
          if (!beforeBundles.some((b) => b.id === dir))
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
        const bundle = id ? readBundle(this.skillPath(id)) : {};
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
  ) {
    const absolute = fs.realpathSync(path.resolve(source));
    const bundle = readBundle(absolute);
    if (!bundle["SKILL.md"])
      throw new AppError("INVALID_SKILL", "目录中没有 SKILL.md");
    const parsed = parseSkill(
      Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
    );
    return this.mutate(
      `导入技能：${parsed.name}`,
      (m) => {
        this.validateScope(scope, m);
        const existing = m.skills.find((s) => s.name === parsed.name);
        if (
          existing &&
          (!adopt ||
            bundleHash(readBundle(this.skillPath(existing.id))) !==
              bundleHash(bundle))
        )
          throw new AppError(
            "DUPLICATE_NAME",
            `技能库已有 ${parsed.name}；接管已有目录要求完整内容与库中一致`,
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
        const native = adapters(this.home)
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
                  projectTargets(h.id, d.bindings[p.id]).skills,
                  parsed.name,
                ),
                projectId: p.id,
              })),
          ])
          .filter((t) => exists(t.p) && fs.realpathSync(t.p) === absolute);
        if (adopt && !native.length)
          throw new AppError(
            "NOT_NATIVE_TARGET",
            "只能接管适配器的原生部署目录，目录名需与 Skill name 一致；共享兼容目录可普通导入",
          );
        if (adopt) {
          noSymlink(absolute);
          const state = this.state();
          for (const target of native) {
            if (state.receipts.some((r) => r.path === target.p))
              throw new AppError(
                "ALREADY_MANAGED",
                "该目录已由 HarnessSync 管理",
              );
            if (
              !entry.scope.harnesses.includes(target.h) ||
              (target.projectId
                ? entry.scope.kind !== "project" ||
                  entry.scope.target !== target.projectId
                : entry.scope.kind === "project")
            )
              throw new AppError(
                "SCOPE_MISMATCH",
                "Skill 的适用范围与待接管目录不符",
              );
            state.receipts.push({
              kind: "skill",
              harness: target.h,
              path: target.p,
              sourceId: entry.id,
              projectId: target.projectId,
              hash: bundleHash(bundle),
            });
          }
          writeJson(path.join(this.root, "state.json"), state);
        }
        if (!existing) {
          writeBundle(this.skillPath(entry.id), bundle);
          m.skills.push(entry);
          d.origins = { ...d.origins, [entry.id]: absolute };
          writeJson(path.join(this.root, "device.json"), d);
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
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new AppError("INVALID_COMMIT", "需要完整的提交 SHA");
    return this.lock(() => {
      this.checkRevision(revision);
      // Restore only versioned source; native harness files change on the next explicit deployment.
      this.git(["cat-file", "-e", `${commit}^{commit}`]);
      // Validate both legacy and v2 source before restoring.
      readManifest(
        this.git(["ls-tree", "-r", "--name-only", commit]).split("\n"),
        (f) => this.git(["show", `${commit}:${f}`]),
      );
      this.git([
        "restore",
        "--source",
        commit,
        "--staged",
        "--worktree",
        "--",
        ".",
      ]);
      this.commit(`恢复配置至 ${commit.slice(0, 8)}`);
      return { commit };
    });
  }
}
