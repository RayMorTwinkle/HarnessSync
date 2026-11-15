import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { Store } from "./store.ts";
import { AppError, json, noSymlink, writeJson } from "./files.ts";
import { LoginService, type CommandRunner } from "./service.ts";
import {
  stopOwnedScheduler,
  type SchedulerProcessOptions,
} from "./scheduler-process.ts";
import { version } from "./version.ts";

export type InstallInfo = {
  installDir: string;
  release: string;
  releaseDir: string;
  repo: string;
  binDir?: string;
  version: string;
};
const releaseName = /^[0-9a-f]{40}-\d{14}-\d+$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const gitRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ code: 0, stdout, stderr });
      },
    );
  });
export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}
export function latestStableTag(output: string, current: string) {
  let latest = current;
  for (const line of output.split(/\r?\n/)) {
    const tag = line.match(/^[0-9a-f]{40,64}\s+refs\/tags\/v([^\s]+)$/)?.[1];
    if (tag && stableVersion.test(tag) && compareVersions(tag, latest) > 0)
      latest = tag;
  }
  return latest === current ? undefined : `v${latest}`;
}
function currentRelease(installDir: string) {
  noSymlink(installDir);
  const releases = path.join(installDir, "releases");
  noSymlink(releases);
  const current = path.join(installDir, "current");
  if (!fs.lstatSync(current).isSymbolicLink())
    throw new Error("current 不是版本链接");
  const target = path.resolve(installDir, fs.readlinkSync(current));
  if (path.dirname(target) !== releases)
    throw new Error("current 不是安装器版本");
  noSymlink(target);
  if (!fs.statSync(target).isDirectory()) throw new Error("版本目录不存在");
  return target;
}
export async function installInfo(
  cliPath = process.argv[1],
  options: { home?: string; envPath?: string; runner?: CommandRunner } = {},
): Promise<InstallInfo | undefined> {
  try {
    if (
      !cliPath ||
      !path.isAbsolute(cliPath) ||
      !cliPath.endsWith("/dist/cli.js")
    )
      return;
    const entryRoot = path.dirname(path.dirname(cliPath));
    const installDir =
      path.basename(entryRoot) === "current"
        ? path.dirname(entryRoot)
        : path.basename(path.dirname(entryRoot)) === "releases"
          ? path.dirname(path.dirname(entryRoot))
          : undefined;
    if (!installDir) return;
    const marker = path.join(installDir, ".harness-sync-install");
    noSymlink(marker);
    if (fs.readFileSync(marker, "utf8").trim() !== "HarnessSync installer v1")
      return;
    const current = currentRelease(installDir);
    const releaseDir =
      path.basename(entryRoot) === "current" ? current : entryRoot;
    noSymlink(path.join(releaseDir, "dist/cli.js"));
    if (!fs.statSync(path.join(releaseDir, "dist/cli.js")).isFile()) return;
    const pkg = path.join(releaseDir, "package.json");
    noSymlink(pkg);
    const installedVersion = json<{ version: string }>(pkg).version;
    if (
      typeof installedVersion !== "string" ||
      !stableVersion.test(installedVersion)
    )
      return;
    const remote = await (options.runner ?? gitRunner)("git", [
      "-C",
      releaseDir,
      "remote",
      "get-url",
      "origin",
    ]);
    const repo = remote.stdout.trim();
    if (remote.code || !repo || repo.startsWith("-") || /[\r\n\0]/.test(repo))
      return;
    const home = options.home ?? os.homedir();
    const dirs = [
      ...(options.envPath ?? process.env.PATH ?? "").split(path.delimiter),
      path.join(home, ".local/bin"),
    ];
    const binDir = dirs.find((dir) => {
      if (!path.isAbsolute(dir)) return false;
      const launcher = path.join(dir, "hsync");
      try {
        noSymlink(launcher);
        return (
          fs.statSync(launcher).isFile() &&
          fs
            .readFileSync(launcher, "utf8")
            .split(/\r?\n/)
            .includes(`# HarnessSync launcher: ${installDir}`)
        );
      } catch {
        return false;
      }
    });
    return {
      installDir,
      release: path.basename(releaseDir),
      releaseDir,
      repo,
      binDir,
      version: installedVersion,
    };
  } catch {
    return undefined;
  }
}
type SelfUpdateCache = {
  checkedAt: string;
  current: string;
  latest?: string;
  error?: string;
};
export function cachedSelfUpdate(
  store: Store,
  current: string,
): {
  current: string;
  available: boolean;
  latest?: string;
  checkedAt?: string;
  error?: string;
} {
  const empty = { current, available: false };
  try {
    const file = path.join(store.root, "self-update.json");
    noSymlink(file);
    const cache = json<SelfUpdateCache>(file);
    if (
      cache.current !== current ||
      !Number.isFinite(Date.parse(cache.checkedAt)) ||
      (cache.latest !== undefined &&
        (typeof cache.latest !== "string" ||
          !cache.latest.startsWith("v") ||
          !stableVersion.test(cache.latest.slice(1)))) ||
      (cache.error !== undefined && typeof cache.error !== "string")
    )
      return empty;
    return {
      ...cache,
      available:
        !!cache.latest && compareVersions(cache.latest.slice(1), current) > 0,
    };
  } catch {
    return empty;
  }
}
export async function checkSelfUpdate(
  store: Store,
  info: InstallInfo,
  runner = gitRunner,
) {
  const cache: SelfUpdateCache = {
    checkedAt: new Date().toISOString(),
    current: info.version,
  };
  try {
    const result = await runner("git", [
      "ls-remote",
      "--tags",
      "--refs",
      info.repo,
    ]);
    if (result.code)
      throw new Error(result.stderr || `Git 退出码 ${result.code}`);
    cache.latest = latestStableTag(result.stdout, info.version);
  } catch (e: any) {
    cache.error = e.message || "检查更新失败";
  }
  await writeCache(store, cache);
  return { ...cache, available: !!cache.latest };
}
async function writeCache(store: Store, cache: SelfUpdateCache) {
  try {
    await store.lock(() => {
      const file = path.join(store.root, "self-update.json");
      noSymlink(file);
      writeJson(file, cache);
    });
  } catch {
    /* Optional cache may be read-only. */
  }
}
export async function selfUpdateStatus(
  store: Store,
  check = false,
  options: {
    info?: () => Promise<InstallInfo | undefined>;
    runner?: CommandRunner;
  } = {},
) {
  const info = await (options.info ?? (() => installInfo()))();
  const current = info?.version ?? version;
  return {
    installed: !!info,
    ...(check && info
      ? await checkSelfUpdate(store, info, options.runner)
      : cachedSelfUpdate(store, current)),
  };
}
export function pruneReleases(installDir: string) {
  const current = currentRelease(installDir);
  const releases = path.join(installDir, "releases");
  const candidates = fs
    .readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && releaseName.test(entry.name))
    .map((entry) => entry.name)
    .sort(
      (a, b) =>
        b.slice(41, 55).localeCompare(a.slice(41, 55)) || b.localeCompare(a),
    );
  const previous = candidates.find((name) => name !== path.basename(current));
  let removed = 0;
  for (const name of candidates) {
    if (name === path.basename(current) || name === previous) continue;
    if (currentRelease(installDir) !== current)
      throw new AppError("INSTALL_CHANGED", "当前版本已变化，请稍后重试清理");
    const target = path.join(releases, name);
    noSymlink(target);
    fs.rmSync(target, { recursive: true });
    removed++;
  }
  return removed;
}
export type InstallerRunner = (
  command: string,
  args: string[],
) => Promise<number>;
const installerRunner: InstallerRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve(code ?? 128 + (os.constants.signals[signal!] || 1)),
    );
  });
async function startDetached(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
export async function upgrade(
  store: Store,
  options: {
    check?: boolean;
    ref?: string;
    info?: () => Promise<InstallInfo | undefined>;
    runner?: CommandRunner;
    installer?: InstallerRunner;
    service?: Pick<LoginService, "status" | "restart">;
    scheduler?: SchedulerProcessOptions;
    start?: typeof startDetached;
  } = {},
) {
  const info = await (options.info ?? (() => installInfo()))();
  if (!info)
    throw new AppError("SOURCE_CHECKOUT", "当前从源码运行，请用 git pull 更新");
  if (
    options.ref &&
    (!options.ref.startsWith("v") || !stableVersion.test(options.ref.slice(1)))
  )
    throw new AppError("UPGRADE_REF", "请选择 vX.Y.Z 格式的稳定版本标签");
  const checked =
    options.check || !options.ref
      ? await checkSelfUpdate(store, info, options.runner)
      : undefined;
  if (options.check)
    return { installed: true, ...checked!, code: checked!.error ? 1 : 0 };
  if (checked?.error)
    throw new AppError("SELF_UPDATE_CHECK", `检查更新失败：${checked.error}`);
  const target = options.ref ?? checked?.latest;
  if (!target || target === `v${info.version}`)
    return {
      code: 0,
      current: info.version,
      message: options.ref
        ? `当前已是指定版本 ${info.version}`
        : `当前已是最新版本 ${info.version}`,
      removed: 0,
    };
  if (!info.binDir)
    throw new AppError(
      "LAUNCHER_NOT_FOUND",
      "未找到属于此安装的 hsync 启动器，请重新运行安装命令",
    );
  const script = path.join(info.releaseDir, "install.sh");
  noSymlink(script);
  const code = await (options.installer ?? installerRunner)("bash", [
    script,
    "--ref",
    target,
    "--install-dir",
    info.installDir,
    "--bin-dir",
    info.binDir,
    "--repo",
    info.repo,
  ]);
  if (code) return { code, message: `安装失败，退出码 ${code}；未重启服务` };
  // The installed release is now current; the old cache would still remind.
  await writeCache(store, {
    checkedAt: new Date().toISOString(),
    current: target.slice(1),
  });
  let restarted = "none";
  try {
    const service = options.service ?? new LoginService(store);
    const status = await service.status();
    if (status.installed && status.loaded) {
      await service.restart();
      restarted = "login";
    } else if (await stopOwnedScheduler(store, options.scheduler)) {
      const args = ["serve", "--background"];
      const defaultRoot = path.join(store.home, ".harness-sync");
      if (store.root !== defaultRoot) args.push("--root", store.root);
      await (options.start ?? startDetached)(
        path.join(info.binDir, "hsync"),
        args,
      );
      restarted = "background";
    }
  } catch (e: any) {
    throw new AppError(
      "UPGRADE_RESTART",
      `已安装 ${target}，但服务重启未完成：${e.message}；未清理旧版本`,
    );
  }
  const removed = pruneReleases(info.installDir);
  return {
    code: 0,
    current: info.version,
    target,
    restarted,
    removed,
    message: `已安装 ${target}；${restarted === "login" ? "已重启登录服务" : restarted === "background" ? "已重启后台服务" : "没有运行中的服务，无需启动"}；已清理 ${removed} 个旧版本`,
  };
}
