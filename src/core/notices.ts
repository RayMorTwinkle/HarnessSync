import path from "node:path";
import type { Store } from "./store.ts";
import type { SyncConfig, SyncRuntime } from "../shared/types.ts";
import { lastAutoDeploy } from "./auto-deploy.ts";
import { cachedSkillUpdates } from "./update-checks.ts";
import { Settings } from "./settings.ts";
import { exists, hash, json, noSymlink, writeJson } from "./files.ts";

export type Notice = {
  code: string;
  severity: "info" | "action";
  message: string;
  items?: string[];
  paths?: string[];
  command?: string;
};
export const agentNotice =
  "请把这条提醒告诉用户；只有用户要求时才处理；合并内容前必须先说明差异并得到用户明确同意。";
const sixHours = 6 * 3600_000;
// Also remove invisible formatting controls (including bidi overrides).
export function noticeName(value: string) {
  const clean = Array.from(
    value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/[“”"\\]/g, ""),
  );
  return `“${clean.slice(0, 60).join("")}${clean.length > 60 ? "…" : ""}”`;
}
function names(values: string[]) {
  const items = values.slice(0, 5).map(noticeName);
  return {
    items,
    text:
      items.join("、") + (values.length > 5 ? ` 等 ${values.length} 个` : ""),
  };
}
function local<T>(store: Store, name: string): T | undefined {
  const file = path.join(store.root, name);
  noSymlink(file);
  return exists(file) ? json<T>(file) : undefined;
}
// Store paths are ours, not user data: show them whole, with HOME as ~.
function tilde(store: Store, file: string) {
  const rel = path.relative(store.home, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? `~/${rel}`
    : file;
}
// Cache-only: no Engine.plan(), native skill traversal, Git or network calls.
export function collectNotices(store: Store): Notice[] {
  const result: Notice[] = [];
  // A damaged optional cache must not hide other reminders or fail a CLI command.
  const read = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const manifest = read(() => store.manifest());
  const sync = read(() => local<SyncConfig>(store, "sync.json"));
  if (sync?.conflicts?.length) {
    const list = names(
      sync.conflicts.map((c) => {
        const id = c.localId || c.entryId;
        const entry = manifest?.[c.kind]?.find((e) => e.id === id);
        return entry
          ? ((("displayName" in entry && entry.displayName) ||
              ("name" in entry && entry.name) ||
              ("title" in entry && entry.title) ||
              id) as string)
          : c.entryId;
      }),
    );
    result.push({
      code: "SYNC_CONFLICTS",
      severity: "action",
      message: `${sync.conflicts.length} 个同步冲突待处理：${list.text}。${agentNotice}`,
      items: list.items,
      paths: sync.conflicts
        .filter((c) => /^[a-zA-Z0-9_-]+$/.test(c.entryId))
        .map((c) => path.join(store.root, "conflicts", c.entryId)),
      command: "hsync sync conflicts",
    });
  }
  const deployment = read(() => lastAutoDeploy(store));
  const state = read(() => store.state());
  const runtime = read(() =>
    local<{ runtime: SyncRuntime }>(store, "sync-auto.json"),
  )?.runtime;
  if (deployment && ["needs-review", "failed"].includes(deployment.outcome)) {
    const pending =
      deployment.pendingChanges ??
      (Object.values(deployment.changes || {}).some((n) => n > 0) ||
        !!deployment.blockers?.length ||
        !!runtime?.pendingDeployment);
    if (
      pending &&
      (!state?.lastFullApplyAt || state.lastFullApplyAt < deployment.at)
    ) {
      const reasons =
        (deployment.blockers?.length || 0) + (deployment.error ? 1 : 0);
      result.push({
        code: "AUTO_DEPLOY_REVIEW",
        severity: "action",
        message: `自动部署${deployment.outcome === "failed" ? "失败" : "已暂停"}，仍有待部署变化，${reasons} 条原因；请查看部署预览。${agentNotice}`,
        command: "hsync plan",
      });
    }
  }
  const updates = read(() =>
    cachedSkillUpdates(store).filter((s) => s.available && !s.error),
  );
  if (updates?.length) {
    const list = names(
      updates.map(
        (s) =>
          manifest?.skills.find((entry) => entry.id === s.id)?.displayName ||
          s.name,
      ),
    );
    const ids = updates
      .map((s) => s.id)
      .filter((id) => /^[a-zA-Z0-9_-]+$/.test(id));
    result.push({
      code: "SKILL_UPDATES",
      severity: "action",
      message: `${updates.length} 个技能有更新：${list.text}。${agentNotice}`,
      items: list.items,
      command: `hsync skills update ${ids.join(" ")}`,
    });
  }
  const failures =
    runtime && Number.isSafeInteger(runtime.failures) && runtime.failures > 0
      ? runtime.failures
      : 0;
  if (runtime && (runtime.lastError || (runtime.pendingPush && failures >= 3)))
    result.push({
      code: "SYNC_FAILED",
      severity: "action",
      message: `同步未完成，最近失败 ${failures} 次；请查看同步状态。${agentNotice}`,
      command: "hsync sync status",
    });
  return result;
}
export function cliNoticesEnabled(store: Store, env = process.env) {
  return (
    env.HSYNC_NO_NOTICES !== "1" &&
    new Settings(store).preferences().notices.cli
  );
}
export function attachNotices(value: unknown, notices: Notice[]) {
  if (
    !notices.length ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  // `notices` already means plan notices in CLI output; reminders get their own key.
  return { ...value, reminders: notices };
}
export async function cliNoticeOutput(
  store: Store,
  value: unknown,
  options: {
    quiet?: boolean;
    at?: number;
    env?: NodeJS.ProcessEnv;
    stderr?: (block: string) => void;
  } = {},
) {
  // Reminders are best effort, including on read-only stores and failed commands.
  try {
    if (!cliNoticesEnabled(store, options.env)) return value;
    const notices = collectNotices(store);
    const attached = attachNotices(value, notices);
    const at = options.at ?? Date.now();
    if (!notices.length) {
      const file = path.join(store.root, "cli-notices.json");
      try {
        noSymlink(file);
        if (exists(file))
          await store.lock(() => {
            noSymlink(file);
            writeJson(file, { fingerprint: hash("[]"), printedAt: at });
          });
      } catch {
        /* The cache is optional on read-only stores. */
      }
      return attached;
    }
    if (options.quiet) return attached;
    const fingerprint = hash(JSON.stringify(notices));
    let full = true;
    try {
      await store.lock(() => {
        const file = path.join(store.root, "cli-notices.json");
        noSymlink(file);
        const previous = exists(file)
          ? json<{ fingerprint: string; printedAt: number }>(file)
          : undefined;
        full =
          !previous ||
          previous.fingerprint !== fingerprint ||
          at - previous.printedAt >= sixHours;
        if (full) writeJson(file, { fingerprint, printedAt: at });
      });
    } catch {
      /* Keep machine-readable notices when cache writes are unavailable. */
    }
    const block = full
      ? notices
          .map(
            (n) =>
              `[HarnessSync] ${n.message}\n  查看：${n.command || "hsync status"}${n.paths?.length ? `\n  文件：${tilde(store, path.join(store.root, "conflicts"))}/<冲突 ID>/{local,remote,merged}` : ""}`,
          )
          .join("\n")
      : `[HarnessSync] 有 ${notices.length} 类提醒待查看；运行 hsync status --json 查看详情。`;
    (options.stderr ?? console.error)(block);
    return attached;
  } catch {
    return value;
  }
}
