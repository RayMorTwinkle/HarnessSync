import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { Settings } from "./settings.ts";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { createAutoDeployer, lastAutoDeploy } from "./auto-deploy.ts";
import { rotateServiceLog } from "./service.ts";
import { UpdateChecker } from "./update-checks.ts";
import { AppError, exists, json, noSymlink, writeJson } from "./files.ts";
import { Sync } from "./sync.ts";

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

async function schedulerProbe(token: string) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.end(token);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
async function matchesSchedulerProbe(port: number | undefined, token: string) {
  if (
    !Number.isInteger(port) ||
    port! < 1 ||
    port! > 65535 ||
    typeof token !== "string"
  )
    return false;
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port!, "127.0.0.1");
    let received = "";
    const done = (matched: boolean) => {
      socket.destroy();
      resolve(matched);
    };
    socket.setTimeout(1000, () => done(false));
    socket.on("error", () => done(false));
    socket.on("data", (data) => {
      received += data.toString();
      if (received.length > 128) done(false);
    });
    socket.on("end", () => done(received === token));
  });
}

// Polling also catches editor replacements and changes made outside HarnessSync.
export function startSyncScheduler(
  sync: Sync,
  intervalMs = 5000,
  afterTick?: () => Promise<void>,
) {
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = sync
      .tick()
      .finally(() => afterTick?.())
      .catch(() => {
        // Sync persists actionable errors and backoff; never flood the console.
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

// One scheduler owner per store, shared by serve/open/watch across processes.
export async function startBackgroundScheduler(
  store: Store,
  engine = new Engine(store),
  options: {
    intervalMs?: number;
    debounceMs?: number;
    checker?: UpdateChecker;
    serviceLog?: boolean;
  } = {},
) {
  new Settings(store).preferences();
  const file = path.join(store.root, "scheduler-owner.json");
  const startTime = await processStartTime(process.pid);
  const token = crypto.randomUUID();
  const probe = await schedulerProbe(token);
  const owner = { pid: process.pid, startTime, token, probePort: probe.port };
  try {
    await store.lock(async () => {
      noSymlink(file);
      if (exists(file)) {
        const previous = json<{
          pid: number;
          startTime?: string;
          token: string;
          probePort?: number;
        }>(file);
        let alive = false;
        if (
          Number.isSafeInteger(previous.pid) &&
          previous.pid > 0 &&
          typeof previous.startTime === "string"
        ) {
          const actual = await processStartTime(previous.pid);
          if (
            actual &&
            actual.split(":")[0] === previous.startTime.split(":")[0]
          )
            alive = actual === previous.startTime;
          else
            alive = await matchesSchedulerProbe(
              previous.probePort,
              previous.token,
            );
        }
        if (alive)
          throw new AppError(
            "SCHEDULER_RUNNING",
            "此配置库已有后台调度器，请复用现有服务",
            409,
          );
      }
      noSymlink(file);
      writeJson(file, owner);
    });
  } catch (e) {
    await probe.close();
    throw e;
  }
  const deployer = createAutoDeployer(engine, options.debounceMs);
  const checker = options.checker ?? new UpdateChecker(store);
  let updates: Promise<unknown> | undefined;
  const sync = new Sync(store);
  const stopSync = startSyncScheduler(
    sync,
    options.intervalMs ?? 5000,
    async () => {
      if (options.serviceLog) rotateServiceLog(store);
      if (sync.pendingDeployment()) deployer.queue("sync-pull", false);
      else if (
        lastAutoDeploy(store)?.blockers?.some((b) =>
          ["STALE_PLAN", "STALE_TARGET", "STALE_SOURCE"].includes(b.status),
        )
      )
        deployer.queue("stale-retry", false);
      if (!updates)
        updates = checker
          .tick()
          .catch(() => {})
          .finally(() => {
            updates = undefined;
          });
    },
  );
  deployer.queue("scheduler-start");
  return {
    queue: deployer.queue,
    checker,
    async close() {
      await probe.close();
      await stopSync();
      await deployer.close();
      await updates;
      await checker.close();
      if (!exists(store.root)) return;
      await store.lock(() => {
        noSymlink(file);
        if (exists(file) && json<typeof owner>(file).token === owner.token)
          fs.unlinkSync(file);
      });
    },
  };
}
