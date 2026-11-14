import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Store } from "./store.ts";
import { AppError, exists, hash, json, noSymlink, writeJson } from "./files.ts";
import {
  registry,
  manifestRoot,
  resolveTemplate,
  resolveProjectPath,
} from "./harness-registry.ts";
import { Settings } from "./settings.ts";

export type BackupEntry = {
  path: string;
  relative: string;
  type: string;
  fingerprint: string;
  absent: boolean;
};
export type BackupManifest = {
  version: 1;
  device: string;
  createdAt: string;
  home: string;
  entries: BackupEntry[];
};
// Never follow links, including the root link. Modes participate in the fingerprint.
export function backupFingerprint(p: string): string {
  noSymlink(path.dirname(p));
  if (!exists(p)) return "absent";
  const s = fs.lstatSync(p),
    d = crypto.createHash("sha256");
  d.update(String(s.mode & 0o7777));
  if (s.isSymbolicLink()) d.update("link:" + fs.readlinkSync(p));
  else if (s.isFile()) {
    d.update("file:");
    const fd = fs.openSync(p, "r"),
      b = Buffer.alloc(65536);
    try {
      let n;
      while ((n = fs.readSync(fd, b, 0, b.length, null)))
        d.update(b.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } else if (s.isDirectory()) {
    d.update("directory:");
    for (const name of fs.readdirSync(p).sort())
      d.update(JSON.stringify([name, backupFingerprint(path.join(p, name))]));
  } else throw new AppError("BACKUP_SPECIAL_FILE", `不支持特殊文件：${p}`);
  return d.digest("hex");
}
export function copyBackupTree(source: string, target: string) {
  noSymlink(path.dirname(source));
  noSymlink(path.dirname(target));
  const s = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (s.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
  else if (s.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o700 });
    for (const name of fs.readdirSync(source))
      copyBackupTree(path.join(source, name), path.join(target, name));
    fs.chmodSync(target, s.mode & 0o7777);
  } else if (s.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, s.mode & 0o7777);
  } else throw new AppError("BACKUP_SPECIAL_FILE", `不支持特殊文件：${source}`);
}
function bytes(p: string): number {
  if (!exists(p)) return 0;
  const s = fs.lstatSync(p);
  return s.isSymbolicLink()
    ? 0
    : s.isDirectory()
      ? fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0)
      : s.size;
}
const within = (p: string, parent: string) =>
  p === parent || p.startsWith(parent + path.sep);
export class Backups {
  constructor(readonly store: Store) {}
  list(): { dir: string; createdAt: string }[] {
    const p = path.join(this.store.root, "backups.json");
    noSymlink(p);
    return exists(p) ? json(p) : [];
  }
  paths() {
    const data = registry(this.store.home, this.store.root);
    if (data.errors.length)
      throw new AppError("BACKUP_REGISTRY", "工具清单有错误，请先修复再备份");
    const paths = new Set<string>();
    for (const { manifest: m } of data.entries) {
      const resolve = (p: string) =>
        resolveTemplate(p, this.store.home, manifestRoot(m, this.store.home));
      for (const p of [
        m.skills.global,
        ...m.skills.reads.global.map((r) =>
          typeof r === "string" ? r : r.path,
        ),
        ...m.instructions.global.map((r) => r.path),
        ...m.instructions.fragments.map((p) =>
          p.replace(/\/\*\*\/\*\.md$/, ""),
        ),
      ])
        paths.add(resolve(p));
      for (const project of Object.values(this.store.device().bindings))
        for (const p of [
          m.skills.project,
          m.instructions.project,
          ...m.skills.reads.project.map((r) =>
            typeof r === "string" ? r : r.path,
          ),
        ])
          paths.add(
            resolveProjectPath(
              p,
              project,
              this.store.home,
              this.store.root,
              "backup",
            ),
          );
    }
    const roots = data.entries.map(({ manifest: m }) =>
      manifestRoot(m, this.store.home),
    );
    for (const p of paths)
      if (
        p === this.store.home ||
        roots.some((r) => within(r, p)) ||
        within(this.store.root, p)
      )
        throw new AppError(
          "BACKUP_SCOPE",
          `备份范围过宽，拒绝复制工具根目录：${p}`,
        );
    return [...paths]
      .sort()
      .filter(
        (p) => ![...paths].some((other) => other !== p && within(p, other)),
      );
  }
  ensureLocked() {
    const first = this.list()[0];
    // Deployment only needs the local registration, not the backup contents.
    if (first) return first;
    return this.createLocked();
  }
  create(confirmLarge = false) {
    return this.store.lock(() => this.createLocked(confirmLarge));
  }
  createLocked(confirmLarge = false) {
    const paths = this.paths();
    for (const p of paths) noSymlink(path.dirname(p));
    const size = paths.reduce((n, p) => n + bytes(p), 0);
    if (size > 500 * 1024 * 1024 && !confirmLarge)
      throw new AppError(
        "BACKUP_CONFIRM_SIZE",
        `备份共 ${size} 字节，超过 500 MB。确认后运行 backup create --confirm-large`,
      );
    const downloads = path.join(this.store.home, "Downloads");
    noSymlink(downloads);
    const base = path.join(
      exists(downloads) ? downloads : this.store.home,
      "HarnessSync 备份",
    );
    noSymlink(base);
    const now = new Date(),
      stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    let dir = path.join(base, stamp);
    if (exists(dir)) dir += `-${crypto.randomUUID().slice(0, 8)}`;
    this.capture(dir, paths);
    const record = { dir, createdAt: now.toISOString() };
    writeJson(path.join(this.store.root, "backups.json"), [
      ...this.list(),
      record,
    ]);
    return record;
  }
  capture(dir: string, paths: string[]) {
    noSymlink(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const entries = paths.map((p, i) => {
      noSymlink(path.dirname(p));
      const relative = within(p, this.store.home)
        ? path.relative(this.store.home, p)
        : `_projects/${i}/${path.basename(p)}`;
      const fingerprint = backupFingerprint(p),
        absent = fingerprint === "absent";
      const s = absent ? undefined : fs.lstatSync(p);
      if (!absent) copyBackupTree(p, path.join(dir, "files", relative));
      if (
        backupFingerprint(p) !== fingerprint ||
        (!absent &&
          backupFingerprint(path.join(dir, "files", relative)) !== fingerprint)
      )
        throw new AppError("BACKUP_CHANGED", `备份期间文件变化：${p}`);
      return {
        path: p,
        relative,
        fingerprint,
        absent,
        type: absent
          ? "absent"
          : s!.isSymbolicLink()
            ? "link"
            : s!.isDirectory()
              ? "directory"
              : "file",
      };
    });
    const manifest: BackupManifest = {
      version: 1,
      device: os.hostname(),
      createdAt: new Date().toISOString(),
      home: this.store.home,
      entries,
    };
    writeJson(path.join(dir, "manifest.json"), manifest);
    fs.writeFileSync(
      path.join(dir, "如何恢复.md"),
      '# 如何恢复\n\n运行 `hsync backup restore "' +
        dir +
        '"` 查看预览，再加 `--plan <id>` 执行。冲突默认保留，覆盖需明确指定路径。\n\n已经卸载时：先退出相关工具，按 manifest.json 的 path 将 files 中对应 relative 的内容复制回去（保留权限和符号链接，不跟随链接）。absent 表示原先不存在；删除前请确认没有后来新增的个人内容。\n\n包含注册工具的技能、指令及已绑定项目路径；不包含工具根目录、会话、凭证、扩展属性或 ACL。HOME 外的项目存于 files/_projects，按清单还原。恢复前副本位于“恢复前”，可用同一恢复命令预览撤回。\n',
    );
    return manifest;
  }
  verify(dir: string) {
    if (!exists(dir))
      throw new AppError(
        "BACKUP_MISSING",
        "初始备份已被移动或删除；恢复不可用，可运行 hsync backup create 新建",
      );
    noSymlink(dir);
    noSymlink(path.join(dir, "manifest.json"));
    const m = json<BackupManifest>(path.join(dir, "manifest.json"));
    if (
      m.version !== 1 ||
      m.home !== this.store.home ||
      !Array.isArray(m.entries)
    )
      throw new AppError("BACKUP_MANIFEST", "备份格式或设备路径不匹配");
    const seen = new Set<string>();
    for (const e of m.entries) {
      const p = path.resolve(dir, "files", e.relative);
      if (
        !path.isAbsolute(e.path) ||
        e.path === this.store.home ||
        within(e.path, this.store.root) ||
        !within(p, path.join(dir, "files")) ||
        p === path.join(dir, "files") ||
        seen.has(e.path)
      )
        throw new AppError("BACKUP_MANIFEST", "备份路径无效");
      seen.add(e.path);
      noSymlink(path.dirname(p));
      if (
        backupFingerprint(p) !== e.fingerprint ||
        e.absent !== (e.fingerprint === "absent")
      )
        throw new AppError("BACKUP_CORRUPT", `备份校验失败：${e.path}`);
    }
    for (const a of seen)
      for (const b of seen)
        if (a !== b && within(a, b))
          throw new AppError("BACKUP_MANIFEST", "备份路径重叠");
    return m;
  }
  plan(dir = this.list()[0]?.dir) {
    if (!dir) throw new AppError("NO_BACKUP", "还没有基线备份");
    const m = this.verify(dir);
    const receipts = this.store.state().receipts;
    const classify = (e: BackupEntry, child = false) => {
      const current = backupFingerprint(e.path);
      const owned =
        current !== "absent" &&
        receipts.some((r) => r.path === e.path && r.fullNativeHash === current);
      // Something the user added after the backup is theirs: keep it, no choice needed.
      const status =
        current === e.fingerprint
          ? "unchanged"
          : owned
            ? child && e.absent
              ? "remove"
              : "restore"
            : e.absent
              ? "keep"
              : "conflict";
      return {
        ...e,
        current,
        status,
        message:
          status === "unchanged"
            ? "与备份相同"
            : status === "remove"
              ? "移除 HarnessSync 新增的条目"
              : status === "restore"
                ? e.absent
                  ? "备份时不存在，删除 HarnessSync 创建的内容"
                  : "恢复为备份内容"
                : status === "keep"
                  ? "备份之后新增，不是 HarnessSync 写入的，保留"
                  : "备份之后被删除或修改过；默认保留现状，选择覆盖将恢复备份内容",
      };
    };
    const changes = m.entries.flatMap((e) => {
      noSymlink(path.dirname(e.path));
      const current = exists(e.path) ? fs.lstatSync(e.path) : undefined;
      // An absent baseline directory may now contain both owned and personal skills.
      if (e.type !== "directory" && !(e.absent && current?.isDirectory()))
        return [classify(e)];
      if (current && !current.isDirectory())
        throw new AppError(
          "BACKUP_DIRECTORY_CHANGED",
          `原目录已被替换为文件或链接，请先处理：${e.path}`,
        );
      const saved = path.join(dir!, "files", e.relative);
      const names = new Set([
        ...(e.absent ? [] : fs.readdirSync(saved)),
        ...(current ? fs.readdirSync(e.path) : []),
      ]);
      // Ignore the container's permissions; each direct child is an independent unit.
      return [...names].sort().map((name) => {
        const original = path.join(saved, name);
        const fingerprint = backupFingerprint(original);
        const stat =
          fingerprint === "absent" ? undefined : fs.lstatSync(original);
        return classify(
          {
            path: path.join(e.path, name),
            relative: path.join(e.relative, name),
            fingerprint,
            absent: fingerprint === "absent",
            type: !stat
              ? "absent"
              : stat.isSymbolicLink()
                ? "link"
                : stat.isDirectory()
                  ? "directory"
                  : "file",
          },
          true,
        );
      });
    });
    const payload = {
      dir,
      changes,
      revision: this.store.revision(),
      settings: new Settings(this.store).preferences(),
    };
    const plan = { ...payload, id: hash(JSON.stringify(payload)) };
    noSymlink(path.join(this.store.root, "backup-plans"));
    writeJson(path.join(this.store.root, "backup-plans", plan.id + ".json"), {
      dir,
    });
    return plan;
  }
  restore(planId: string, dir?: string, overwrite: string[] = []) {
    return this.store.lock(() => this.restoreLocked(planId, dir, overwrite));
  }
  restoreLocked(planId: string, dir?: string, overwrite: string[] = []) {
    if (!/^[a-f0-9]{64}$/.test(planId))
      throw new AppError("STALE_PLAN", "计划 ID 无效");
    const saved = path.join(this.store.root, "backup-plans", planId + ".json");
    noSymlink(saved);
    if (!dir && exists(saved)) dir = json<{ dir: string }>(saved).dir;
    const plan = this.plan(dir);
    if (plan.id !== planId)
      throw new AppError("STALE_PLAN", "文件或配置已变化，请重新预览", 409);
    if (
      overwrite.some(
        (p) =>
          !plan.changes.some((c) => c.path === p && c.status === "conflict"),
      )
    )
      throw new AppError("BACKUP_OVERWRITE", "只能选择预览中的冲突路径");
    const selected = plan.changes.filter(
      (c) =>
        ["restore", "remove"].includes(c.status) || overwrite.includes(c.path),
    );
    const before = path.join(
      plan.dir,
      "恢复前",
      `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    );
    this.capture(
      before,
      plan.changes.map((c) => c.path),
    );
    writeJson(path.join(before, "state.json"), this.store.state());
    writeJson(
      path.join(before, "settings.json"),
      new Settings(this.store).preferences(),
    );
    const done: typeof selected = [];
    try {
      for (const e of selected) {
        noSymlink(path.dirname(e.path));
        if (backupFingerprint(e.path) !== e.current)
          throw new AppError("STALE_PLAN", `文件已变化：${e.path}`);
        done.push(e);
        fs.rmSync(e.path, { recursive: true, force: true });
        if (!e.absent)
          copyBackupTree(path.join(plan.dir, "files", e.relative), e.path);
      }
    } catch (error) {
      const snapshot = this.verify(before);
      for (const e of done.reverse()) {
        const original = snapshot.entries.find((x) => x.path === e.path)!;
        noSymlink(path.dirname(e.path));
        fs.rmSync(e.path, { recursive: true, force: true });
        if (!original.absent)
          copyBackupTree(path.join(before, "files", original.relative), e.path);
      }
      throw error;
    }
    const state = this.store.state(),
      cleared = plan.changes.filter(
        (c) => c.status === "unchanged" || selected.includes(c),
      );
    state.receipts = state.receipts.filter(
      (r) => !cleared.some((c) => within(r.path, c.path)),
    );
    state.instructionConsents = [];
    state.instructionReplacements = [];
    state.conflictChoices = {};
    noSymlink(path.join(this.store.root, "state.json"));
    writeJson(path.join(this.store.root, "state.json"), state);
    writeJson(path.join(this.store.root, "settings.json"), {
      ...new Settings(this.store).preferences(),
      deploy: { auto: false },
    });
    return {
      backupDir: plan.dir,
      beforeDir: before,
      restored: selected.map((c) => c.path),
      conflicts: plan.changes
        .filter((c) => c.status === "conflict" && !overwrite.includes(c.path))
        .map((c) => c.path),
      autoDeploy: false,
      message: "恢复完成，自动部署已关闭。",
    };
  }
}
