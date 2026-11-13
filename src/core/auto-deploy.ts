import path from "node:path";
import type { Engine } from "./engine.ts";
import type { Plan } from "../shared/types.ts";
import { Store } from "./store.ts";
import { Sync } from "./sync.ts";
import { Settings } from "./settings.ts";
import { AppError, hash, exists, json, noSymlink, writeJson } from "./files.ts";

export type AutoDeployResult = {
  at: string;
  reason: string;
  outcome: "applied" | "nothing" | "needs-review" | "failed" | "disabled";
  changes: { create: number; update: number; remove: number };
  deploymentId?: string;
  blockers?: { path: string; status: string; reason: string; code?: string }[];
  error?: string;
};
export function lastAutoDeploy(store: Store): AutoDeployResult | null {
  const file = path.join(store.root, "auto-deploy.json");
  noSymlink(file);
  return exists(file) ? json(file) : null;
}
// Status names alone do not capture initialization replacements or adopted links.
export function autoDeployBlockers(engine: Engine, plan: Plan) {
  const state = engine.store.state();
  const consents = engine.instructionConsents();
  const blockers: NonNullable<AutoDeployResult["blockers"]> = [];
  const sync = new Sync(engine.store);
  if (sync.recoveryPending())
    blockers.push({
      path: "",
      status: "sync-recovery",
      reason: "源操作尚未恢复，请先运行 hsync sync undo",
    });
  if (sync.local().conflicts)
    blockers.push({
      path: "",
      status: "sync-conflict",
      reason: "跨设备同步冲突尚未解决",
    });
  for (const reason of plan.errors)
    blockers.push({ path: "", status: "blocked", reason });
  for (const notice of plan.notices)
    if (notice.blocking)
      blockers.push({
        path: notice.path || "",
        status: "blocked",
        reason: notice.message,
        code: notice.code,
      });
  for (const r of state.instructionReplacements || [])
    blockers.push({
      path: r.path,
      status: "staged-replacement",
      reason: "初始化指令替换需要人工预览确认",
    });
  for (const c of plan.changes) {
    const receipt = state.receipts.find((r) => r.path === c.path);
    if (c.status === "unchanged") continue;
    if (
      c.status === "skipped" &&
      c.conflictFingerprint &&
      state.conflictChoices?.[c.path]?.use === "skip" &&
      state.conflictChoices[c.path].fingerprint === c.conflictFingerprint
    )
      continue;
    const owned =
      c.status === "create"
        ? c.beforeHash === hash("ABSENT")
        : (!!receipt && receipt.kind === c.kind) ||
          (c.kind === "instructions" &&
            c.status === "update" &&
            consents.some((consent) => consent.path === c.path));
    if (
      !["create", "update", "remove"].includes(c.status) ||
      !owned ||
      receipt?.adoptedLink !== undefined ||
      c.conflictOptions
    )
      blockers.push({
        path: c.path,
        status: c.status,
        reason:
          c.status === "update" && !receipt && c.kind === "instructions"
            ? `第一次写入已有的 ${path.basename(c.path)}：会加入 HarnessSync 管理区块，原有内容保留`
            : c.status === "update" && !receipt
              ? "目标已存在，但不是 HarnessSync 写入的"
              : c.reason || "此路径需要人工确认",
      });
  }
  return blockers;
}
export async function autoDeploy(
  engine: Engine,
  reason: string,
): Promise<AutoDeployResult> {
  const store = engine.store;
  const result: AutoDeployResult = {
    at: new Date().toISOString(),
    reason,
    outcome: "nothing",
    changes: { create: 0, update: 0, remove: 0 },
  };
  try {
    if (!new Settings(store).preferences().deploy.auto)
      result.outcome = "disabled";
    else {
      const plan = await store.lock(() => {
        engine.pruneInstructionConsents();
        const p = engine.plan();
        result.blockers = autoDeployBlockers(engine, p);
        return p;
      });
      for (const c of plan.changes)
        if (
          c.status === "create" ||
          c.status === "update" ||
          c.status === "remove"
        )
          result.changes[c.status]++;
      if (result.blockers!.length) result.outcome = "needs-review";
      else {
        const applied = await engine.apply(plan.id, {
          validate: (current) => {
            if (!new Settings(store).preferences().deploy.auto)
              throw new AppError("AUTO_DISABLED", "自动部署已关闭");
            const blockers = autoDeployBlockers(engine, current);
            if (blockers.length) {
              result.blockers = blockers;
              throw new AppError("AUTO_REVIEW", "部署条件已变化，需要人工审查");
            }
          },
        });
        result.outcome = applied.id ? "applied" : "nothing";
        if (applied.id) result.deploymentId = applied.id;
      }
    }
  } catch (e: any) {
    result.outcome =
      e.code === "AUTO_DISABLED"
        ? "disabled"
        : [
              "AUTO_REVIEW",
              "STALE_PLAN",
              "STALE_TARGET",
              "STALE_SOURCE",
              "DEPLOY_CONFLICT",
              "INCOMPLETE_DEPLOYMENT",
            ].includes(e.code)
          ? "needs-review"
          : "failed";
    result.error = e.message;
    if (!result.blockers?.length && result.outcome === "needs-review")
      result.blockers = [{ path: "", status: e.code, reason: e.message }];
  }
  if (!result.blockers?.length) delete result.blockers;
  await store.lock(() => {
    const file = path.join(store.root, "auto-deploy.json");
    noSymlink(file);
    writeJson(file, result);
  });
  return result;
}
export function createAutoDeployer(engine: Engine, delayMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let pending: string | undefined;
  let stopped = false;
  const execute = () => {
    timer = undefined;
    if (stopped || running || !pending) return;
    const reason = pending;
    pending = undefined;
    running = autoDeploy(engine, reason)
      .catch(() => {})
      .finally(() => {
        running = undefined;
        if (pending && !stopped) timer = setTimeout(execute, delayMs);
      });
  };
  return {
    queue(reason: string, reset = true) {
      if (stopped || !new Settings(engine.store).preferences().deploy.auto)
        return false;
      if (!reset && pending === reason && timer) return true;
      pending = reason;
      if (timer) clearTimeout(timer);
      timer = setTimeout(execute, delayMs);
      return true;
    },
    async close() {
      stopped = true;
      pending = undefined;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
