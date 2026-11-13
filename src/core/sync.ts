import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "./store.ts";
import {
  AppError,
  atomicWrite,
  hash,
  exists,
  json,
  writeJson,
  readBundle,
  writeBundle,
  noSymlink,
  parseSkill,
  skillMarkdown,
  stagingLeftovers,
  cleanStaging,
  type Bundle,
} from "./files.ts";
import { kinds, stable, readManifest, writeManifest } from "./layout.ts";
import type {
  AutoSyncSettings,
  SyncRuntime,
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
  private autoPath() {
    return path.join(this.store.root, "sync-auto.json");
  }
  private autoState(): {
    settings: AutoSyncSettings;
    runtime: SyncRuntime;
    userConfigured?: boolean;
  } {
    noSymlink(this.autoPath());
    if (exists(this.autoPath())) return json(this.autoPath());
    return {
      settings: {
        enabled: !!this.config(false)?.lastSyncTime,
        debounceSeconds: 120,
        pullIntervalMinutes: 10,
      },
      runtime: { failures: 0, pendingDeployment: 0, pendingPush: false },
    };
  }
  private saveAuto(value: ReturnType<Sync["autoState"]>) {
    noSymlink(this.autoPath());
    writeJson(this.autoPath(), value);
  }
  acknowledgeDeployment() {
    if (!exists(this.autoPath())) return;
    const state = this.autoState();
    state.runtime.pendingDeployment = 0;
    this.saveAuto(state);
  }
  autoSettings() {
    return this.autoState().settings;
  }
  async setAuto(input: Partial<AutoSyncSettings>) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) =>
          !["enabled", "debounceSeconds", "pullIntervalMinutes"].includes(k),
      ) ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      [input.debounceSeconds, input.pullIntervalMinutes].some(
        (n) => n !== undefined && (!Number.isInteger(n) || n < 1 || n > 86400),
      )
    )
      throw new AppError(
        "SYNC_OPTIONS",
        "自动同步参数需要布尔值及 1 至 86400 的整数间隔",
      );
    return this.store.lock(() => {
      const value = this.autoState();
      Object.assign(value.settings, input);
      if (input.enabled !== undefined) value.userConfigured = true;
      value.runtime.nextRunAt =
        value.settings.enabled && this.config(false)
          ? new Date(
              Date.now() + value.settings.pullIntervalMinutes * 60_000,
            ).toISOString()
          : undefined;
      value.runtime.pullDueAt = value.runtime.nextRunAt;
      this.saveAuto(value);
      return value.settings;
    });
  }
  private sourceStamp() {
    const rows = [this.store.git(["rev-parse", "HEAD"])];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name === ".git" || name.startsWith(".hsync-staging-")) continue;
        const file = path.join(dir, name),
          stat = fs.lstatSync(file, { bigint: true });
        rows.push(
          `${path.relative(this.store.repo, file)}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`,
        );
        if (stat.isDirectory()) walk(file);
      }
    };
    walk(this.store.repo);
    return hash(rows.join("\n"));
  }
  private fingerprint(library = this.current()) {
    return hash(
      stable({
        manifest: {
          schemaVersion: 1,
          ...Object.fromEntries(
            kinds.map((kind) => [
              kind,
              [...library.manifest[kind]].sort((a, b) =>
                a.id.localeCompare(b.id),
              ),
            ]),
          ),
        },
        bundles: Object.fromEntries(
          library.manifest.skills.map((skill) => [
            skill.id,
            library.bundles[skill.id],
          ]),
        ),
      }),
    );
  }
  private undoPath() {
    return path.join(this.store.root, "sync-undo.json");
  }
  private recoveryPath() {
    return path.join(this.store.root, "sync-recovery.json");
  }
  private sourceFiles(): Bundle {
    noSymlink(this.store.repo);
    const files: Bundle = {};
    for (const name of fs.readdirSync(this.store.repo)) {
      if ([".git", "entries", "skills"].includes(name)) continue;
      if (!["manifest.json", "harness-sync.json"].includes(name))
        throw new AppError(
          "UNSAFE_SOURCE",
          "源库包含不支持的文件，拒绝同步或恢复",
        );
      const file = path.join(this.store.repo, name);
      noSymlink(file);
      files[name] = {
        content: fs.readFileSync(file).toString("base64"),
        mode: fs.statSync(file).mode & 0o777,
      };
    }
    const entries = path.join(this.store.repo, "entries");
    noSymlink(entries);
    if (exists(entries))
      for (const kind of fs.readdirSync(entries)) {
        if (!kinds.includes(kind as (typeof kinds)[number]))
          throw new AppError("UNSAFE_SOURCE", "源库包含不支持的条目目录");
        const dir = path.join(entries, kind);
        noSymlink(dir);
        for (const name of fs.readdirSync(dir)) {
          if (!/^[a-zA-Z0-9-]+\.json$/.test(name))
            throw new AppError("UNSAFE_SOURCE", "源库条目文件路径无效");
          const file = path.join(dir, name);
          noSymlink(file);
          files[`entries/${kind}/${name}`] = {
            content: fs.readFileSync(file).toString("base64"),
            mode: fs.statSync(file).mode & 0o777,
          };
        }
      }
    const skills = path.join(this.store.repo, "skills");
    noSymlink(skills);
    if (exists(skills))
      for (const id of fs.readdirSync(skills)) {
        if (id.startsWith(".hsync-staging-")) continue;
        if (!/^[a-zA-Z0-9-]+$/.test(id))
          throw new AppError("UNSAFE_SOURCE", "源库技能目录路径无效");
        const dir = path.join(skills, id);
        noSymlink(dir);
        for (const [name, file] of Object.entries(readBundle(dir)))
          files[`skills/${id}/${name}`] = file;
      }
    return files;
  }
  private libraryFiles(library: Library): Bundle {
    const files: Bundle = {};
    const add = (name: string, value: unknown) => {
      files[name] = {
        content: Buffer.from(stable(value)).toString("base64"),
        mode: 0o644,
      };
    };
    add("harness-sync.json", { schemaVersion: 2 });
    for (const kind of kinds)
      for (const entry of library.manifest[kind])
        add(`entries/${kind}/${entry.id}.json`, entry);
    for (const { id } of library.manifest.skills)
      for (const [name, file] of Object.entries(library.bundles[id]))
        files[`skills/${id}/${name}`] = file;
    return files;
  }
  private requireRecovered() {
    noSymlink(this.recoveryPath());
    noSymlink(this.undoPath());
    if (exists(this.recoveryPath()))
      throw new AppError(
        "SYNC_RECOVERY",
        "上次源操作未完成，请先运行 hsync sync undo 恢复安全快照",
      );
    if (
      exists(this.undoPath()) &&
      (!json<any>(this.undoPath()).head ||
        json<any>(this.undoPath()).undoCommit)
    )
      throw new AppError(
        "SYNC_RECOVERY",
        "上次源操作未完成，请先运行 hsync sync undo 恢复安全快照",
      );
  }
  private checkpoint(
    after: Library,
    conflicts: SyncConflict[],
    operation: string,
  ) {
    this.requireRecovered();
    const c = this.config(false);
    const record = {
      beforeFiles: this.sourceFiles(),
      afterFiles: this.libraryFiles(after),
      before: this.safety(),
      beforeFingerprint: this.fingerprint(),
      afterFingerprint: this.fingerprint(after),
      conflicts: c?.conflicts || [],
      afterConflicts: conflicts,
      operation,
      remote: c?.url,
      branch: c?.branch,
      pendingDeployment: this.autoState().runtime.pendingDeployment,
    };
    const file = operation === "merge" ? this.recoveryPath() : this.undoPath();
    noSymlink(file);
    writeJson(file, record);
    return record;
  }
  private finishCheckpoint() {
    noSymlink(this.undoPath());
    const record = json<any>(this.undoPath());
    record.head = this.head();
    writeJson(this.undoPath(), record);
  }
  async restore(commit: string, revision?: string) {
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new AppError("INVALID_COMMIT", "需要完整的提交 SHA");
    return this.store.lock(() => {
      this.store.checkRevision(revision);
      const library = this.read(commit);
      this.checkpoint(library, [], "restore");
      this.write(library);
      this.store.commit(`恢复配置至 ${commit.slice(0, 8)}`);
      const c = this.config(false);
      if (c) {
        c.conflicts = [];
        this.save(c);
      }
      this.finishCheckpoint();
      return { commit };
    });
  }
  private restoreFiles(beforeFiles: Bundle, files = this.sourceFiles()) {
    for (const name of Object.keys(beforeFiles)) {
      if (
        !/^(manifest\.json|harness-sync\.json|entries\/(rules|skills|projects)\/[a-zA-Z0-9-]+\.json|skills\/[a-zA-Z0-9-]+\/.+)$/.test(
          name,
        ) ||
        name.split("/").some((part) => ["..", ".", ".git"].includes(part))
      )
        throw new AppError(
          "SYNC_RECOVERY",
          "安全快照包含不支持的源路径，拒绝恢复",
        );
      // A bundle file may become a directory; validate its existing ancestors first.
      for (
        let target = path.join(this.store.repo, name);
        ;
        target = path.dirname(target)
      ) {
        try {
          noSymlink(target);
          break;
        } catch (error: any) {
          if (error.code !== "ENOTDIR") throw error;
        }
      }
    }
    for (const name of Object.keys(files))
      if (!beforeFiles[name]) fs.rmSync(path.join(this.store.repo, name));
    const removeEmptyDirectory = (dir: string) => {
      noSymlink(dir);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!item.isDirectory())
          throw new AppError(
            "SYNC_UNDO_CHANGED",
            "恢复路径中仍有外部文件，拒绝覆盖",
          );
        removeEmptyDirectory(path.join(dir, item.name));
      }
      fs.rmdirSync(dir);
    };
    for (const [name, data] of Object.entries(beforeFiles)) {
      const target = path.join(this.store.repo, name);
      if (exists(target) && fs.statSync(target).isDirectory())
        removeEmptyDirectory(target);
      atomicWrite(
        path.join(this.store.repo, name),
        Buffer.from(data.content, "base64"),
        data.mode,
      );
    }
  }
  private swapBackups(record: any) {
    const result: {
      stage: string;
      target: string;
      bundle: Bundle;
      id: string;
    }[] = [];
    for (const stage of stagingLeftovers(
      path.join(this.store.repo, "skills"),
    )) {
      const { target: id } = json<{ target: string }>(`${stage}.json`);
      if (!/^[a-zA-Z0-9-]+$/.test(id)) continue;
      const target = this.store.skillPath(id);
      if (exists(target) || !exists(`${stage}-old`)) continue;
      const expected = (files: Bundle) =>
        Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name.startsWith(`skills/${id}/`))
            .map(([name, file]) => [name.slice(`skills/${id}/`.length), file]),
        );
      const before = expected(record.beforeFiles),
        after = expected(record.afterFiles);
      if (
        !Object.keys(before).length ||
        stable(readBundle(`${stage}-old`)) !== stable(before) ||
        !exists(stage) ||
        stable(readBundle(stage)) !== stable(after) ||
        result.some((item) => item.id === id)
      )
        throw new AppError(
          "SYNC_UNDO_CHANGED",
          "目录交换备份或暂存内容已改变，拒绝恢复",
        );
      result.push({ stage, target, bundle: before, id });
    }
    return result;
  }
  async undo() {
    return this.store.lock(() => {
      const file = exists(this.recoveryPath())
        ? this.recoveryPath()
        : this.undoPath();
      if (!exists(file))
        throw new AppError("SYNC_UNDO", "没有可撤销的解决冲突或恢复操作");
      noSymlink(file);
      const record = json<any>(file);
      const c = this.config(false),
        head = this.head();
      const partial = !record.head || !!record.undoCommit;
      const files = this.sourceFiles();
      const swaps = partial ? this.swapBackups(record) : [];
      for (const swap of swaps)
        for (const [name, data] of Object.entries(swap.bundle))
          files[`skills/${swap.id}/${name}`] = data;
      const sameFile = (a: any, b: any) =>
        a?.content === b?.content &&
        (!a || (a.mode & 0o111) === (b.mode & 0o111));
      const safeFiles = [
        ...new Set([
          ...Object.keys(files),
          ...Object.keys(record.beforeFiles),
          ...Object.keys(record.afterFiles),
        ]),
      ].every(
        (name) =>
          sameFile(files[name], record.beforeFiles[name]) ||
          sameFile(files[name], record.afterFiles[name]) ||
          (!files[name] &&
            !sameFile(record.beforeFiles[name], record.afterFiles[name])),
      );
      let safeHead =
        head === (record.head || record.before) ||
        head === record.undoCommit ||
        head === record.targetHead;
      if (!record.head && !safeHead) {
        safeHead =
          this.git(["rev-parse", `${head}^1`]) === record.before &&
          /^(解决同步冲突：|恢复配置至 )/.test(
            this.git(["show", "-s", "--format=%s", head]),
          );
      }
      if (
        !safeHead ||
        !safeFiles ||
        (!partial && this.fingerprint() !== record.afterFingerprint) ||
        record.remote !== c?.url ||
        record.branch !== c?.branch ||
        (stable(c?.conflicts || []) !== stable(record.conflicts) &&
          stable(c?.conflicts || []) !== stable(record.afterConflicts))
      )
        throw new AppError(
          "SYNC_UNDO_CHANGED",
          "操作后源配置、同步连接或冲突已改变，拒绝覆盖；请从同步历史选择恢复点",
        );
      this.read(record.before);
      const beforeFiles = record.beforeFiles as Bundle;
      // Persist the new commit before changing source, so an interrupted undo can resume.
      if (!record.undoCommit) {
        record.undoCommit = this.git([
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          this.git(["rev-parse", `${record.before}^{tree}`]),
          "-p",
          head,
          "-m",
          `撤销同步操作：${record.operation}\n\n设备：${this.store.device().name}`,
        ]);
        writeJson(file, record);
      }
      for (const swap of swaps) {
        noSymlink(swap.target);
        if (
          exists(swap.target) ||
          stable(readBundle(`${swap.stage}-old`)) !== stable(swap.bundle)
        )
          throw new AppError(
            "SYNC_UNDO_CHANGED",
            "目录交换备份已改变，拒绝恢复",
          );
        fs.renameSync(`${swap.stage}-old`, swap.target);
      }
      this.restoreFiles(beforeFiles, files);
      this.git(["reset", "--mixed", record.undoCommit]);
      if (c) {
        c.conflicts = record.conflicts;
        this.save(c);
      }
      if (record.operation === "merge") {
        const state = this.autoState();
        state.runtime.pendingDeployment = record.pendingDeployment;
        this.saveAuto(state);
      }
      for (const swap of swaps) cleanStaging(swap.stage);
      fs.rmSync(file);
      return this.result(c);
    });
  }
  async history() {
    return this.store.lock(() =>
      this.store.history().map((item) => {
        const library = this.read(item.hash);
        let before = empty();
        try {
          before = this.read(this.git(["rev-parse", `${item.hash}^1`]));
        } catch {}
        const changes = kinds.flatMap((kind) =>
          [
            ...new Set(
              [...library.manifest[kind], ...before.manifest[kind]].map(
                (e) => e.id,
              ),
            ),
          ].flatMap((id) => {
            const a = before.manifest[kind].find((e) => e.id === id),
              b = library.manifest[kind].find((e) => e.id === id);
            if (
              stable(a) === stable(b) &&
              (kind !== "skills" ||
                stable(before.bundles[id]) === stable(library.bundles[id]))
            )
              return [];
            const entry = (b || a) as any;
            return [
              {
                kind,
                id,
                name: entry.title || entry.name,
                action: !a ? "新增" : !b ? "删除" : "修改",
              },
            ];
          }),
        );
        const device =
          this.git(["show", "-s", "--format=%B", item.hash]).match(
            /^设备：(.*)$/m,
          )?.[1] || "未知设备（旧提交）";
        return { ...item, device, changes };
      }),
    );
  }
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
    const bundles: Record<string, Bundle> = Object.create(null);
    for (const skill of manifest.skills) {
      const bundle: Bundle = Object.create(null);
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
      auto: this.autoSettings(),
      scheduler: this.autoState().runtime,
      remoteRepositoryRetained: true,
      connected: !!c,
      remote: c?.url,
      branch: c?.branch,
      ahead,
      behind,
      lastFetchedCommit: c?.lastFetchedCommit,
      lastSyncedCommit: c?.lastSyncedCommit,
      lastSyncTime: c?.lastSyncTime,
      conflicts: c?.conflicts || [],
      message: !c
        ? "本机已断开同步；远端仓库仍然保留，不会被删除"
        : c.conflicts.length
          ? `有 ${c.conflicts.length} 个冲突待处理；解决前暂停推送，用 hsync sync resolve <id> --keep local|remote|both 处理后再 sync now`
          : message,
    };
  }
  // Local view for snapshots; never touches the network.
  local() {
    const c = this.config(false);
    return {
      connected: !!c,
      remote: c?.url,
      lastSyncTime: c?.lastSyncTime,
      conflicts: c?.conflicts.length || 0,
    };
  }
  async status() {
    return this.store.lock(() => {
      const c = this.config(false);
      return this.result(c, c?.lastFetchedCommit);
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
      return this.attempt(c, true);
    });
  }
  async now() {
    return this.store.lock(() => this.attempt(this.config()!));
  }
  private failed(
    state: ReturnType<Sync["autoState"]>,
    error: Error,
    now = Date.now(),
  ) {
    state.runtime.lastError = error.message;
    state.runtime.failures++;
    state.runtime.nextRunAt = state.settings.enabled
      ? new Date(
          now +
            Math.min(
              30 * 60_000,
              30_000 * 2 ** Math.min(state.runtime.failures - 1, 10),
            ),
        ).toISOString()
      : undefined;
    this.saveAuto(state);
  }
  private attempt(c: SyncConfig, enable = false, deferPush = false) {
    const firstSync = !c.lastSyncTime;
    const state = this.autoState();
    state.runtime.pendingPush ||= !deferPush;
    state.runtime.lastAttemptAt = new Date().toISOString();
    this.saveAuto(state);
    try {
      const result = this.nowLocked(c, !deferPush);
      const latest = this.autoState();
      if (enable || (firstSync && !latest.userConfigured))
        latest.settings.enabled = true;
      latest.runtime.lastSuccessAt = new Date().toISOString();
      latest.runtime.lastError = undefined;
      latest.runtime.failures = 0;
      latest.runtime.pendingPush = !!result.pushBlocked || result.ahead > 0;
      if (!deferPush) latest.runtime.changedAt = undefined;
      latest.runtime.observedSource = this.sourceStamp();
      latest.runtime.nextRunAt = latest.settings.enabled
        ? new Date(
            Date.now() + latest.settings.pullIntervalMinutes * 60_000,
          ).toISOString()
        : undefined;
      latest.runtime.pullDueAt = latest.runtime.nextRunAt;
      if (latest.settings.enabled && latest.runtime.changedAt)
        latest.runtime.nextRunAt = new Date(
          Math.min(
            Date.parse(latest.runtime.nextRunAt!),
            Date.parse(latest.runtime.changedAt) +
              latest.settings.debounceSeconds * 1000,
          ),
        ).toISOString();
      if (
        latest.runtime.pendingPush &&
        !c.conflicts.length &&
        !latest.runtime.changedAt
      )
        latest.runtime.nextRunAt = new Date().toISOString();
      this.saveAuto(latest);
      return { ...result, auto: latest.settings, scheduler: latest.runtime };
    } catch (e: any) {
      const latest = this.autoState();
      this.failed(latest, e);
      throw e;
    }
  }
  async tick(now = Date.now()) {
    const initial = this.autoState();
    if (!this.config(false) || !initial.settings.enabled) return;
    const next = initial.runtime.nextRunAt;
    if (next && now < Date.parse(next)) {
      try {
        if (this.sourceStamp() === initial.runtime.observedSource) return;
      } catch {}
    }
    return this.store.lock(() => {
      const c = this.config(false),
        state = this.autoState();
      if (!c || !state.settings.enabled) return;
      const previous = stable(state);
      let source: string;
      try {
        source = this.sourceStamp();
      } catch (error: any) {
        state.runtime.lastAttemptAt = new Date(now).toISOString();
        this.failed(state, error, now);
        throw error;
      }
      if (source !== state.runtime.observedSource) {
        state.runtime.observedSource = source;
        state.runtime.changedAt = new Date(now).toISOString();
        state.runtime.pendingPush = true;
      }
      const pull = state.runtime.failures
        ? Date.parse(state.runtime.nextRunAt!)
        : Date.parse(
            (state.runtime.pullDueAt ||= new Date(
              now + state.settings.pullIntervalMinutes * 60_000,
            ).toISOString()),
          );
      const debounce = state.runtime.changedAt
        ? Date.parse(state.runtime.changedAt) +
          state.settings.debounceSeconds * 1000
        : state.runtime.pendingPush && !c.conflicts.length
          ? now
          : Infinity;
      const due = state.runtime.failures ? pull : Math.min(pull, debounce);
      state.runtime.nextRunAt = new Date(due).toISOString();
      if (stable(state) !== previous) this.saveAuto(state);
      if (now >= due) return this.attempt(c, false, now < debounce);
    });
  }
  private nowLocked(c: SyncConfig, push = true) {
    this.requireRecovered();
    this.current();
    this.store.migrate();
    this.store.commit("同步前保存本地配置");
    const local = this.head();
    const remote = this.fetch(c);
    c.lastFetchedCommit = remote;
    this.save(c);
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
        const changed = kinds.reduce(
          (n, kind) =>
            n +
            [
              ...new Set(
                [...l.manifest[kind], ...merged.manifest[kind]].map(
                  (e) => e.id,
                ),
              ),
            ].filter((id) => {
              const a = l.manifest[kind].find((e) => e.id === id),
                b = merged.manifest[kind].find((e) => e.id === id);
              return (
                stable(a) !== stable(b) ||
                (kind === "skills" &&
                  stable(l.bundles[id]) !== stable(merged.bundles[id]))
              );
            }).length,
          0,
        );
        const checkpoint = this.checkpoint(merged, conflicts, "merge");
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
            base === checkpoint.before &&
            tree === this.git(["rev-parse", `${remote}^{tree}`])
              ? remote
              : this.git([
                  "-c",
                  "commit.gpgsign=false",
                  "commit-tree",
                  tree,
                  "-p",
                  checkpoint.before,
                  "-p",
                  remote,
                  "-m",
                  `合并跨设备配置\n\n设备：${this.store.device().name}`,
                ]);
          const recovery = json<any>(this.recoveryPath());
          recovery.targetHead = sha;
          noSymlink(this.recoveryPath());
          writeJson(this.recoveryPath(), recovery);
          this.git(["reset", "--soft", sha]);
          c.conflicts = conflicts;
          this.save(c);
          if (changed) {
            const state = this.autoState();
            state.runtime.pendingDeployment += changed;
            this.saveAuto(state);
          }
          fs.rmSync(this.recoveryPath());
        } catch (e) {
          this.restoreFiles(checkpoint.beforeFiles);
          this.git(["reset", "--mixed", checkpoint.before]);
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
    if (!push) {
      c.lastSyncTime = new Date().toISOString();
      this.save(c);
      return this.result(c, remote);
    }
    this.git(["push", "--", c.url, `HEAD:refs/heads/${c.branch}`]);
    c.lastSyncedCommit = this.head();
    c.lastFetchedCommit = c.lastSyncedCommit;
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
        library = this.current();
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
      this.checkpoint(
        library,
        c.conflicts.filter((x) => x !== conflict),
        "resolve",
      );
      try {
        if (keep !== "local") this.write(library);
        this.store.commit(`解决同步冲突：${keep}`);
      } catch (e) {
        const checkpoint = json<any>(this.undoPath());
        this.restoreFiles(checkpoint.beforeFiles);
        this.git(["reset", "--mixed", checkpoint.before]);
        throw e;
      }
      c.conflicts = c.conflicts.filter((x) => x !== conflict);
      this.save(c);
      const state = this.autoState();
      state.runtime.pendingPush = true;
      if (state.settings.enabled && !c.conflicts.length)
        state.runtime.nextRunAt = new Date().toISOString();
      this.saveAuto(state);
      this.finishCheckpoint();
      return this.result(c);
    });
  }
  async disconnect() {
    return this.store.lock(() => {
      noSymlink(this.configPath());
      if (exists(this.autoPath())) {
        const state = this.autoState();
        state.runtime.nextRunAt = undefined;
        state.runtime.pullDueAt = undefined;
        state.runtime.changedAt = undefined;
        this.saveAuto(state);
      }
      fs.rmSync(this.configPath(), { force: true });
      return this.result();
    });
  }
}
