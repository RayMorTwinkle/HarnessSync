import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { Store } from "./store.ts";
import { AppError, exists, json, noSymlink } from "./files.ts";

const runtimeStart = `runtime:${process.pid}:${crypto.randomUUID()}`;

export async function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const start = await new Promise<string | null>((resolve) => {
      execFile(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH, LC_ALL: "C" },
        },
        (error, stdout) =>
          resolve(!error && stdout.trim() ? `ps:${stdout.trim()}` : null),
      );
    }).then((start) => {
      if (start || process.platform !== "linux") return start;
      // Minimal Linux systems may lack ps. Include the boot identity as well.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = fs
        .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
        .trim();
      return ticks && boot ? `proc:${boot}:${ticks}` : null;
    });
    if (start) return start;
  } catch {
    /* Fall through to the identity available inside this process. */
  }
  return pid === process.pid ? runtimeStart : null;
}

export type SchedulerProcessOptions = {
  startTime?: typeof processStartTime;
  kill?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  wait?: () => Promise<void>;
};
export async function stopOwnedScheduler(
  store: Store,
  options: SchedulerProcessOptions = {},
) {
  const file = path.join(store.root, "scheduler-owner.json");
  noSymlink(file);
  if (!exists(file)) return false;
  const owner = json<{ pid: number; startTime: string }>(file);
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startTime !== "string" ||
    !owner.startTime
  )
    throw new AppError(
      "SCHEDULER_IDENTITY",
      "无法核实后台进程，请先停止后台服务",
    );
  const startTime = options.startTime ?? processStartTime;
  const actual = await startTime(owner.pid);
  let stopped = false;
  if (actual && actual === owner.startTime) {
    if (owner.pid === process.pid)
      throw new AppError("SCHEDULER_RUNNING", "请先停止本进程的调度器");
    (options.kill ?? ((pid) => process.kill(pid, "SIGTERM")))(owner.pid);
    for (let i = 0; i < 50 && (await startTime(owner.pid)) === actual; i++)
      await (
        options.wait ?? (() => new Promise<void>((r) => setTimeout(r, 100)))
      )();
    if ((await startTime(owner.pid)) === actual)
      throw new AppError("SCHEDULER_RUNNING", "后台服务尚未退出，请稍后重试");
    stopped = true;
  } else if (!actual) {
    const alive =
      options.alive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e: any) {
          return e.code !== "ESRCH";
        }
      });
    if (alive(owner.pid))
      throw new AppError(
        "SCHEDULER_IDENTITY",
        "无法核实后台进程，请先停止后台服务",
      );
  }
  await store.lock(() => {
    noSymlink(file);
    if (exists(file) && JSON.stringify(json(file)) === JSON.stringify(owner))
      fs.rmSync(file, { force: true });
  });
  return stopped;
}
