import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Settings } from "./settings.ts";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { createAutoDeployer, lastAutoDeploy } from "./auto-deploy.ts";
import { rotateServiceLog } from "./service.ts";
import { UpdateChecker } from "./update-checks.ts";
import { AppError, exists, json, noSymlink, writeJson } from "./files.ts";
import { Sync } from "./sync.ts";

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
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  await store.lock(() => {
    noSymlink(file);
    if (exists(file)) {
      const previous = json<{ pid: number }>(file);
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") alive = false;
      }
      if (alive)
        throw new AppError(
          "SCHEDULER_RUNNING",
          "此配置库已有后台调度器，请复用现有服务",
          409,
        );
    }
    writeJson(file, owner);
  });
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
