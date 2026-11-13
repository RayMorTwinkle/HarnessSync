import { Sync } from "./sync.ts";

// Polling also catches editor replacements and changes made outside HarnessSync.
export function startSyncScheduler(sync: Sync, intervalMs = 5000) {
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = sync
      .tick()
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
