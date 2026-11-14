import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.ts";
import { Backups, backupFingerprint, copyBackupTree } from "./backup.ts";
import { AppError, exists, hash, json, noSymlink, writeJson } from "./files.ts";
import { LoginService } from "./service.ts";
import { Settings } from "./settings.ts";
import { processStartTime } from "./sync-scheduler.ts";
export type UninstallOptions = {
  mode: "restore" | "keep-files";
  deleteLibrary?: boolean;
};
export class Uninstaller {
  constructor(
    readonly store: Store,
    readonly service = new LoginService(store),
    readonly runtime: {
      cliPath?: string;
      stopScheduler?: () => Promise<void>;
      kill?: (pid: number) => void;
    } = {},
  ) {}
  private installation() {
    const dir = path.resolve(
      process.env.HSYNC_INSTALL_DIR ||
        path.join(this.store.home, ".local/share/harness-sync"),
    );
    const launcher = path.resolve(
      process.env.HSYNC_BIN_DIR || path.join(this.store.home, ".local/bin"),
      "hsync",
    );
    const cli = this.runtime.cliPath || process.argv[1] || "";
    const safe =
      dir !== this.store.home &&
      dir.startsWith(this.store.home + path.sep) &&
      !this.store.root.startsWith(dir + path.sep) &&
      dir !== this.store.root;
    const marker = path.join(dir, ".harness-sync-install");
    noSymlink(dir);
    noSymlink(marker);
    noSymlink(launcher);
    const owned =
      safe &&
      exists(marker) &&
      fs.readFileSync(marker, "utf8").trim() === "HarnessSync installer v1";
    const installedRun =
      owned &&
      path.resolve(cli).startsWith(dir + path.sep) &&
      cli.endsWith("/dist/cli.js");
    const ownedLauncher =
      installedRun &&
      exists(launcher) &&
      fs
        .readFileSync(launcher, "utf8")
        .split("\n")
        .includes(`# HarnessSync launcher: ${dir}`);
    return {
      dir,
      launcher,
      removeProgram: Boolean(installedRun),
      removeLauncher: Boolean(ownedLauncher),
      marker: backupFingerprint(marker),
      launcherHash: backupFingerprint(launcher),
      message: installedRun
        ? "仅删除安装器拥有的程序和启动器。"
        : "从源码或非安装器版本运行，跳过程序删除。",
    };
  }
  private snapshot(options: UninstallOptions) {
    if (!["restore", "keep-files"].includes(options.mode))
      throw new AppError("UNINSTALL_MODE", "请选择恢复备份或保留文件");
    const backups = new Backups(this.store),
      baseline = backups.list()[0];
    if (!baseline)
      throw new AppError("NO_BACKUP", "请先运行 backup create 保存备份");
    const baselinePlan = backups.plan(baseline.dir);
    const restore = options.mode === "restore" ? baselinePlan : undefined;
    const selfIds = this.store
      .manifest()
      .skills.filter((s) => s.name === "manage-harness-sync")
      .map((s) => s.id);
    const selfSkills = this.store
      .state()
      .receipts.filter(
        (r) => r.kind === "skill" && selfIds.includes(r.sourceId || ""),
      )
      .map((r) => ({
        path: r.path,
        current: backupFingerprint(r.path),
        owned:
          !!r.fullNativeHash && r.fullNativeHash === backupFingerprint(r.path),
      }));
    const serviceFile = this.service.file;
    noSymlink(serviceFile);
    return {
      ...options,
      nativeFingerprint: baselinePlan.id,
      backupDir: baseline.dir,
      restore,
      selfSkills,
      installation: this.installation(),
      serviceFile,
      serviceHash: backupFingerprint(serviceFile),
      revision: this.store.revision(),
      settings: new Settings(this.store).preferences(),
    };
  }
  plan(options: UninstallOptions) {
    const value = this.snapshot(options),
      plan = { ...value, id: hash(JSON.stringify(value)) };
    noSymlink(path.join(this.store.root, "uninstall-plans"));
    writeJson(
      path.join(this.store.root, "uninstall-plans", plan.id + ".json"),
      options,
    );
    return plan;
  }
  async apply(planId: string) {
    if (!/^[a-f0-9]{64}$/.test(planId))
      throw new AppError("STALE_PLAN", "计划 ID 无效");
    const file = path.join(
      this.store.root,
      "uninstall-plans",
      planId + ".json",
    );
    noSymlink(file);
    if (!exists(file)) throw new AppError("STALE_PLAN", "请先预览卸载");
    const options = json<UninstallOptions>(file);
    // Closing an in-process scheduler must happen outside the store lock.
    // Validate once before stopping it, then validate again under the lock.
    if (hash(JSON.stringify(this.snapshot(options))) !== planId)
      throw new AppError("STALE_PLAN", "文件或配置已变化，请重新预览", 409);
    await this.runtime.stopScheduler?.();
    const ownerFile = path.join(this.store.root, "scheduler-owner.json");
    noSymlink(ownerFile);
    if (exists(ownerFile)) {
      const owner = json<{ pid: number; startTime: string }>(ownerFile);
      const actual = await processStartTime(owner.pid);
      if (actual && actual === owner.startTime) {
        if (owner.pid === process.pid)
          throw new AppError("SCHEDULER_RUNNING", "请先停止本进程的调度器");
        (this.runtime.kill || ((pid: number) => process.kill(pid, "SIGTERM")))(
          owner.pid,
        );
        // Do not delete a library while a scheduler may still be writing it.
        for (
          let i = 0;
          i < 50 && (await processStartTime(owner.pid)) === actual;
          i++
        )
          await new Promise((r) => setTimeout(r, 100));
        if ((await processStartTime(owner.pid)) === actual)
          throw new AppError(
            "SCHEDULER_RUNNING",
            "后台服务尚未退出，请稍后重试",
          );
      } else if (!actual) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (e: any) {
          if (e.code === "ESRCH") alive = false;
        }
        if (alive)
          throw new AppError(
            "SCHEDULER_IDENTITY",
            "无法核实后台进程，请先停止后台服务",
          );
      }
      await this.store.lock(() => {
        noSymlink(ownerFile);
        if (
          exists(ownerFile) &&
          JSON.stringify(json(ownerFile)) === JSON.stringify(owner)
        )
          fs.rmSync(ownerFile, { force: true });
      });
    }

    return this.store.lock(async () => {
      const plan = this.snapshot(options);
      if (hash(JSON.stringify(plan)) !== planId)
        throw new AppError("STALE_PLAN", "文件或配置已变化，请重新预览", 409);
      if (plan.selfSkills.some((s) => !s.owned && s.current !== "absent"))
        throw new AppError(
          "UNINSTALL_CONFLICT",
          "管理技能已被修改，请先保存并处理冲突",
        );
      if (plan.restore?.changes.some((c) => c.status === "conflict"))
        throw new AppError(
          "UNINSTALL_CONFLICT",
          "先用 backup restore 处理冲突，再重新预览卸载",
        );
      const beforeDir = path.join(plan.backupDir, "卸载前", String(Date.now()));
      new Backups(this.store).capture(
        beforeDir,
        new Backups(this.store).paths(),
      );
      writeJson(path.join(beforeDir, "state.json"), this.store.state());
      if (exists(this.service.file)) await this.service.uninstall();
      const library = path.join(plan.backupDir, "library");
      noSymlink(library);
      if (exists(library))
        throw new AppError(
          "LIBRARY_EXPORT_EXISTS",
          "备份中已有 library，请先移动该副本再重试",
        );
      // Export the readable source tree, excluding Git internals and remote credentials.
      fs.mkdirSync(library, { mode: 0o700 });
      for (const name of fs.readdirSync(this.store.repo))
        if (name !== ".git")
          copyBackupTree(
            path.join(this.store.repo, name),
            path.join(library, name),
          );
      const restored = plan.restore
        ? new Backups(this.store).restoreLocked(plan.restore.id, plan.backupDir)
        : undefined;
      for (const s of plan.selfSkills)
        if (options.mode === "keep-files" && exists(s.path)) {
          // Restoration may have reinstated a pre-existing personal skill: retain it.
          if (backupFingerprint(s.path) !== s.current) continue;
          noSymlink(path.dirname(s.path));
          fs.rmSync(s.path, { recursive: true, force: true });
        }
      writeJson(path.join(this.store.root, "state.json"), { receipts: [] });
      writeJson(path.join(this.store.root, "settings.json"), {
        ...new Settings(this.store).preferences(),
        deploy: { auto: false },
      });
      const install = this.installation();
      if (JSON.stringify(install) !== JSON.stringify(plan.installation))
        throw new AppError("STALE_PLAN", "程序文件已变化，停止删除");
      if (install.removeLauncher) fs.unlinkSync(install.launcher);
      if (install.removeProgram) fs.rmSync(install.dir, { recursive: true });
      if (options.deleteLibrary) {
        noSymlink(this.store.root);
        fs.rmSync(this.store.root, { recursive: true });
      }
      return {
        mode: options.mode,
        beforeDir,
        backupDir: plan.backupDir,
        libraryDir: library,
        restored,
        libraryDeleted: !!options.deleteLibrary,
        programRemoved: install.removeProgram,
        launcherRemoved: install.removeLauncher,
        autoDeploy: false,
        message: `${install.message} 远端同步仓库未删除。重新安装请按 README 的安装说明运行 install.sh。`,
      };
    });
  }
}
