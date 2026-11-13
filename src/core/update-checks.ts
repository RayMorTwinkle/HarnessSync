import path from "node:path";
import { Store } from "./store.ts";
import { Settings } from "./settings.ts";
import { checkGitSkillUpdates } from "./git-skills.ts";
import { exists, json, noSymlink, writeJson } from "./files.ts";

type Checks = Awaited<ReturnType<typeof checkGitSkillUpdates>>;
type Runtime = {
  lastCheckAt?: string;
  failures: number;
  retryAt?: string;
  error?: string;
};
export function cachedSkillUpdates(store: Store): Checks {
  const file = path.join(store.root, "skill-updates.json");
  noSymlink(file);
  if (!exists(file)) return [];
  const cache = json<Record<string, Checks[number]>>(file);
  return store
    .manifest()
    .skills.flatMap((s) =>
      s.source &&
      typeof s.source !== "string" &&
      cache[s.id]?.commit === s.source.commit
        ? [cache[s.id]]
        : [],
    );
}
export class UpdateChecker {
  private running?: Promise<Checks>;
  constructor(
    readonly store: Store,
    readonly check = checkGitSkillUpdates,
  ) {}
  private state(): Runtime {
    const file = path.join(this.store.root, "update-check-state.json");
    noSymlink(file);
    return exists(file) ? json(file) : { failures: 0 };
  }
  async now(ids: string[] = [], at = Date.now()): Promise<Checks> {
    if (this.running) {
      await this.running;
      return this.now(ids, at);
    }
    this.running = (async () => {
      const state = this.state();
      try {
        const checks = await this.check(this.store, ids);
        const error = checks.find((c) => c.error)?.error;
        if (error) throw Object.assign(new Error(error), { checks });
        if (!ids.length) {
          state.lastCheckAt = new Date(at).toISOString();
          state.failures = 0;
          delete state.retryAt;
          delete state.error;
        }
        return checks;
      } catch (e: any) {
        state.failures++;
        state.error = e.message;
        state.retryAt = new Date(
          at +
            Math.min(
              6 * 3600_000,
              30_000 * 2 ** Math.min(state.failures - 1, 10),
            ),
        ).toISOString();
        if (e.checks) return e.checks as Checks;
        throw e;
      } finally {
        await this.store.lock(() => {
          const file = path.join(this.store.root, "update-check-state.json");
          noSymlink(file);
          writeJson(file, state);
        });
      }
    })();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }
  async tick(at = Date.now()) {
    if (this.running) return;
    const settings = new Settings(this.store).preferences().updates;
    if (!settings.check) return;
    const state = this.state();
    if (state.retryAt && at < Date.parse(state.retryAt)) return;
    const cached = cachedSkillUpdates(this.store);
    const skills = this.store
      .manifest()
      .skills.filter((s) => s.source && typeof s.source !== "string");
    const oldest =
      cached.length === skills.length && cached.length
        ? Math.min(...cached.map((c) => Date.parse(c.checkedAt)))
        : 0;
    const last = Math.max(
      oldest,
      state.lastCheckAt ? Date.parse(state.lastCheckAt) : 0,
    );
    if (
      !state.failures &&
      last &&
      at - last < settings.intervalHours * 3600_000
    )
      return;
    await this.now([], at);
  }
  async close() {
    await this.running?.catch(() => {});
  }
}
