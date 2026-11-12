import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "./store.ts";
import {
  AppError,
  exists,
  json,
  writeJson,
  readBundle,
  writeBundle,
  noSymlink,
  parseSkill,
  skillMarkdown,
  type Bundle,
} from "./files.ts";
import { kinds, stable, readManifest, writeManifest } from "./layout.ts";
import type {
  Manifest,
  SyncConfig,
  SyncStatus,
  SyncSetup,
  SyncConflict,
} from "../shared/types.ts";

type Library = { manifest: Manifest; bundles: Record<string, Bundle> };
const empty = (): Library => ({
  manifest: { schemaVersion: 1, rules: [], skills: [], projects: [] },
  bundles: {},
});
const message = "同步仅更新源配置；请运行 hsync plan 审查后再 apply";

export class Sync {
  constructor(readonly store: Store) {}
  private configPath() {
    return path.join(this.store.root, "sync.json");
  }
  private config(required = true): SyncConfig | undefined {
    if (exists(this.configPath())) return json(this.configPath());
    if (required)
      throw new AppError(
        "SYNC_NOT_SETUP",
        "请先运行 hsync sync setup --url <git-url>",
      );
  }
  private save(c: SyncConfig) {
    noSymlink(this.configPath());
    writeJson(this.configPath(), c);
  }
  private command(command: string, args: string[]) {
    try {
      return execFileSync(command, args, {
        cwd: this.store.repo,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND:
            process.env.GIT_SSH_COMMAND ||
            "ssh -oBatchMode=yes -oConnectTimeout=15",
        },
      }).trim();
    } catch (e: any) {
      const detail = String(e.stderr || e.message);
      const hint =
        command === "gh"
          ? "GitHub 创建失败：请安装 gh 并运行 gh auth login，或改用 sync setup --url <git-url>"
          : e.code === "ETIMEDOUT" || e.signal
            ? "Git 操作超过 60 秒，请检查网络后重试 hsync sync now"
            : /non-fast-forward|fetch first|rejected/i.test(detail)
              ? "远端已更新，请重新运行 hsync sync now"
              : /auth|permission denied|could not read Username/i.test(detail)
                ? "认证失败，请配置 Git 凭证助手或 SSH，或运行 gh auth login 和 gh auth setup-git"
                : "Git 操作失败，请检查网络、远端地址和访问权限后重试 hsync sync now";
      const lines = detail
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const first =
        lines.find((l) =>
          /error|fatal|invalid|denied|not found|could not|failed|unauthori/i.test(
            l,
          ),
        ) || lines[0];
      throw new AppError(
        "SYNC_GIT",
        first ? `${hint}（${first.slice(0, 200)}）` : hint,
        409,
      );
    }
  }
  private git(args: string[]) {
    // Borrow gh's credentials for GitHub HTTPS remotes without touching global git config.
    const url = this.config(false)?.url || this.pendingUrl;
    if (url?.startsWith("https://github.com/") && this.hasGh())
      return this.command("git", [
        "-c",
        "credential.https://github.com.helper=",
        "-c",
        "credential.https://github.com.helper=!gh auth git-credential",
        ...args,
      ]);
    return this.command("git", args);
  }
  private pendingUrl?: string;
  private hasGh() {
    try {
      execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
  private head() {
    return this.git(["rev-parse", "HEAD"]);
  }
  private read(commit: string): Library {
    const tree = this.git(["ls-tree", "-rz", commit])
      .split("\0")
      .filter(Boolean);
    const files: string[] = [];
    for (const row of tree) {
      const match = row.match(/^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/);
      if (
        !match ||
        !/^(manifest\.json|harness-sync\.json|entries\/(rules|skills|projects)\/[a-zA-Z0-9-]+\.json|skills\/[a-zA-Z0-9-]+\/.+)$/.test(
          match[3],
        )
      )
        throw new AppError(
          "UNSAFE_REMOTE",
          "远端包含不支持的文件或符号链接，请使用专用配置仓库",
        );
      files.push(match[3]);
    }
    const read = (file: string) => this.git(["show", `${commit}:${file}`]);
    const manifest = readManifest(files, read);
    const bundles: Record<string, Bundle> = {};
    for (const skill of manifest.skills) {
      const bundle: Bundle = {};
      for (const row of tree) {
        const separator = row.indexOf("\t");
        const info = row.slice(0, separator),
          file = row.slice(separator + 1);
        if (!file.startsWith(`skills/${skill.id}/`)) continue;
        const relative = file.slice(`skills/${skill.id}/`.length);
        if (
          relative
            .split("/")
            .some((p) => p === ".." || p === "." || p === ".git")
        )
          throw new AppError("UNSAFE_REMOTE", "远端技能路径无效");
        const content = execFileSync(
          "git",
          ["cat-file", "blob", info.split(" ")[2]],
          {
            cwd: this.store.repo,
            timeout: 60_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        bundle[relative] = {
          content: content.toString("base64"),
          mode: info.startsWith("100755") ? 0o755 : 0o644,
        };
      }
      if (
        !bundle["SKILL.md"] ||
        parseSkill(Buffer.from(bundle["SKILL.md"].content, "base64").toString())
          .name !== skill.name
      )
        throw new AppError("INVALID_SKILL", "远端 Skill 元数据与完整包不符");
      bundles[skill.id] = bundle;
    }
    return { manifest, bundles };
  }
  private current(): Library {
    const manifest = this.store.manifest();
    return {
      manifest,
      bundles: Object.fromEntries(
        manifest.skills.map((s) => [
          s.id,
          readBundle(this.store.skillPath(s.id)),
        ]),
      ),
    };
  }
  private write(library: Library) {
    // Validate all write targets before changing anything.
    noSymlink(this.store.repo);
    noSymlink(path.join(this.store.repo, "skills"));
    const dirs = fs
      .readdirSync(path.join(this.store.repo, "skills"))
      .filter((name) => !name.startsWith(".hsync-staging-"));
    for (const dir of dirs)
      noSymlink(path.join(this.store.repo, "skills", dir));
    writeManifest(this.store.repo, library.manifest);
    for (const dir of dirs)
      if (!library.manifest.skills.some((s) => s.id === dir))
        fs.rmSync(this.store.skillPath(dir), { recursive: true, force: true });
    for (const s of library.manifest.skills)
      writeBundle(this.store.skillPath(s.id), library.bundles[s.id]);
  }
  private safety() {
    this.store.commit("同步前保存本地配置");
    const commit = this.head();
    this.git([
      "update-ref",
      `refs/hsync/safety/${crypto.randomUUID()}`,
      commit,
    ]);
    return commit;
  }
  private fetch(c: SyncConfig): string | undefined {
    const refs = this.git(["ls-remote", "--heads", "--", c.url]);
    if (!refs) return undefined;
    if (!refs.split("\n").some((r) => r.endsWith(`refs/heads/${c.branch}`)))
      throw new AppError(
        "SYNC_BRANCH",
        "远端分支不存在，请通过 setup --branch 指定已有分支",
      );
    this.git(["fetch", "--no-tags", "--", c.url, `refs/heads/${c.branch}`]);
    return this.git(["rev-parse", "FETCH_HEAD"]);
  }
  private result(c?: SyncConfig, remote?: string): SyncStatus {
    let ahead = 0,
      behind = 0;
    if (remote)
      [ahead, behind] = this.git([
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${remote}`,
      ])
        .split(/\s+/)
        .map(Number);
    return {
      connected: !!c,
      remote: c?.url,
      branch: c?.branch,
      ahead,
      behind,
      lastSyncedCommit: c?.lastSyncedCommit,
      lastSyncTime: c?.lastSyncTime,
      conflicts: c?.conflicts || [],
      message: c?.conflicts.length
        ? `有 ${c.conflicts.length} 个冲突待处理；解决前暂停推送，用 hsync sync resolve <id> --keep local|remote|both 处理后再 sync now`
        : message,
    };
  }
  async status() {
    return this.store.lock(() => {
      const c = this.config(false);
      return this.result(c, c && this.fetch(c));
    });
  }
  async setup(options: SyncSetup) {
    return this.store.lock(() => {
      if (!!options.url === !!options.create)
        throw new AppError("SYNC_OPTIONS", "请指定 --url 或 --create 其中一个");
      if (this.config(false))
        throw new AppError(
          "SYNC_CONNECTED",
          "已连接远端；更换前请先 sync disconnect",
        );
      let url = options.url;
      if (options.create) {
        const name =
          typeof options.create === "string"
            ? options.create
            : "harness-sync-config";
        if (!/^[a-zA-Z0-9_.-]+$/.test(name))
          throw new AppError("SYNC_OPTIONS", "GitHub 仓库名称无效");
        this.command("gh", ["repo", "create", name, "--private"]);
        let protocol = "https";
        try {
          protocol = this.command("gh", ["config", "get", "git_protocol"]);
        } catch {}
        const field = protocol === "ssh" ? "sshUrl" : "url";
        url = this.command("gh", [
          "repo",
          "view",
          name,
          "--json",
          field,
          "--jq",
          `.${field}`,
        ]);
        if (url.startsWith("https://") && !url.endsWith(".git")) url += ".git";
      }
      if (
        !url ||
        url.startsWith("-") ||
        /[\r\n]/.test(url) ||
        /(https?:\/\/[^/]*@|:\/\/[^/]*:[^/]*@|[?#])/.test(url)
      )
        throw new AppError(
          "SYNC_URL",
          "Git URL 无效；请勿在 URL 中嵌入凭证，使用 SSH 或 Git 凭证助手",
        );
      this.pendingUrl = url;
      const defaultRef = options.branch
        ? ""
        : this.git(["ls-remote", "--symref", "--", url, "HEAD"]);
      const defaultBranch = defaultRef.match(
        /^ref: refs\/heads\/(.+)\tHEAD/m,
      )?.[1];
      const c: SyncConfig = {
        url,
        branch: options.branch || defaultBranch || "main",
        conflicts: [],
      };
      this.git(["check-ref-format", `refs/heads/${c.branch}`]);
      this.save(c);
      return this.nowLocked(c);
    });
  }
  async now() {
    return this.store.lock(() => this.nowLocked(this.config()!));
  }
  private nowLocked(c: SyncConfig) {
    this.store.migrate();
    this.store.commit("同步前保存本地配置");
    const local = this.head();
    const remote = this.fetch(c);
    if (remote && remote !== local) {
      const r = this.read(remote),
        l = this.current();
      let base: string | undefined;
      try {
        base = this.store.git(["merge-base", local, remote]);
      } catch {}
      if (base !== remote) {
        const b = base ? this.read(base) : empty();
        const merged = structuredClone(l);
        const conflicts = [...c.conflicts];
        const object = (
          v: Library,
          kind: (typeof kinds)[number],
          id: string,
        ) => {
          const entry = v.manifest[kind].find((e) => e.id === id);
          return entry
            ? { entry, bundle: kind === "skills" ? v.bundles[id] : undefined }
            : undefined;
        };
        const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
        for (const kind of kinds)
          for (const id of new Set(
            [...b.manifest[kind], ...l.manifest[kind], ...r.manifest[kind]].map(
              (e) => e.id,
            ),
          )) {
            if (
              conflicts.some(
                (c) =>
                  c.kind === kind && (c.entryId === id || c.localId === id),
              )
            )
              continue;
            const bv = object(b, kind, id),
              lv = object(l, kind, id),
              rv = object(r, kind, id);
            if (equal(lv, rv) || equal(bv, rv)) continue;
            const conflict = (
              reason: SyncConflict["reason"],
              localId?: string,
            ) =>
              conflicts.push({
                entryId: id,
                kind,
                localCommit: local,
                remoteCommit: remote,
                reason,
                localId,
              });
            if (!equal(bv, lv)) {
              conflict("entry");
              continue;
            }
            if (kind === "skills" && rv) {
              const collision = merged.manifest.skills.find(
                (s) => s.id !== id && s.name === (rv.entry as any).name,
              );
              if (collision) {
                conflict("name", collision.id);
                continue;
              }
            }
            (merged.manifest[kind] as any[]) = merged.manifest[kind].filter(
              (e) => e.id !== id,
            );
            if (rv) (merged.manifest[kind] as any[]).push(rv.entry);
            if (kind === "skills") {
              delete merged.bundles[id];
              if (rv) merged.bundles[id] = rv.bundle!;
            }
          }
        this.safety();
        try {
          this.write(merged);
          this.git([
            "add",
            "--all",
            "--",
            ".",
            ":(exclude)skills/.hsync-staging-*",
          ]);
          const tree = this.git(["write-tree"]);
          const sha =
            base === local &&
            tree === this.git(["rev-parse", `${remote}^{tree}`])
              ? remote
              : this.git([
                  "-c",
                  "commit.gpgsign=false",
                  "commit-tree",
                  tree,
                  "-p",
                  local,
                  "-p",
                  remote,
                  "-m",
                  "合并跨设备配置",
                ]);
          this.git(["reset", "--soft", sha]);
          c.conflicts = conflicts;
          this.save(c);
        } catch (e) {
          this.write(l);
          this.git(["reset", "--mixed", local]);
          throw e;
        }
      }
    }
    // Pushing while conflicts are open would silently replace the other device's version.
    if (c.conflicts.length) {
      c.lastSyncTime = new Date().toISOString();
      this.save(c);
      return { ...this.result(c, remote), pushBlocked: true };
    }
    this.git(["push", "--", c.url, `HEAD:refs/heads/${c.branch}`]);
    c.lastSyncedCommit = this.head();
    c.lastSyncTime = new Date().toISOString();
    this.save(c);
    return this.result(c, this.head());
  }
  async resolve(entryId: string, keep: "local" | "remote" | "both") {
    return this.store.lock(() => {
      if (!["local", "remote", "both"].includes(keep))
        throw new AppError("SYNC_OPTIONS", "keep 必须是 local、remote 或 both");
      const c = this.config()!;
      const matches = c.conflicts.filter((x) => x.entryId === entryId);
      if (matches.length !== 1)
        throw new AppError("SYNC_CONFLICT", "请指定唯一待处理条目 ID");
      const conflict = matches[0],
        library = this.current(),
        before = structuredClone(library);
      const remote = this.read(conflict.remoteCommit);
      const entry = remote.manifest[conflict.kind].find(
        (e) => e.id === entryId,
      );
      if (
        keep === "both" &&
        (!entry ||
          !library.manifest[conflict.kind].some(
            (e) => e.id === (conflict.localId || entryId),
          ))
      )
        throw new AppError(
          "SYNC_CONFLICT",
          "删除冲突无法保留双方，请选择 local 或 remote",
        );
      if (keep !== "local") {
        const kind = conflict.kind;
        if (keep === "remote")
          (library.manifest[kind] as any[]) = library.manifest[kind].filter(
            (e) => e.id !== entryId && e.id !== conflict.localId,
          );
        if (entry) {
          const copy: any = { ...entry };
          let bundle = remote.bundles[entryId];
          if (keep === "both") {
            copy.id = crypto.randomUUID();
            if (kind === "skills") {
              let n = 2;
              const stem = copy.name.slice(0, 56).replace(/-$/, "");
              while (
                library.manifest.skills.some((s) => s.name === `${stem}-${n}`)
              )
                n++;
              copy.name = `${stem}-${n}`;
              bundle = structuredClone(bundle);
              const parsed = parseSkill(
                Buffer.from(bundle["SKILL.md"].content, "base64").toString(),
              );
              bundle["SKILL.md"].content = Buffer.from(
                skillMarkdown(
                  copy.name,
                  parsed.description,
                  parsed.body,
                  parsed.metadata,
                ),
              ).toString("base64");
            } else if (kind === "rules")
              copy.title = `${copy.title.slice(0, 110)}（远端副本）`;
            else copy.name = `${copy.name.slice(0, 90)}（远端副本）`;
          }
          if (
            kind === "skills" &&
            library.manifest.skills.some(
              (s) => s.name === copy.name && s.id !== copy.id,
            )
          )
            throw new AppError(
              "DUPLICATE_NAME",
              "远端技能名称与其他条目冲突，请选择 both 或先修改名称",
            );
          (library.manifest[kind] as any[]).push(copy);
          if (kind === "skills") library.bundles[copy.id] = bundle;
        }
      }
      this.safety();
      try {
        this.write(library);
        this.store.commit(`解决同步冲突：${keep}`);
      } catch (e) {
        this.write(before);
        this.git(["reset", "--mixed", "HEAD"]);
        throw e;
      }
      c.conflicts = c.conflicts.filter((x) => x !== conflict);
      this.save(c);
      return this.result(c);
    });
  }
  async disconnect() {
    return this.store.lock(() => {
      noSymlink(this.configPath());
      fs.rmSync(this.configPath(), { force: true });
      return this.result();
    });
  }
}
