import React, { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CloudOff,
  GitBranch,
  Github,
  Link2,
  Loader2,
  History,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  Zap,
} from "lucide-react";
import type {
  AutoSyncSettings,
  Snapshot,
  SyncStatus,
} from "../shared/types.ts";
import { useApp } from "./app-context.tsx";
import { SyncConflicts } from "./SyncConflicts.tsx";

type HistoryItem = {
  hash: string;
  date: string;
  message: string;
  device: string;
  changes: {
    kind: "rules" | "skills" | "projects";
    id: string;
    name?: string;
    action: string;
  }[];
};

type Act = (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
type Api = <T>(route: string, body?: unknown, method?: string) => Promise<T>;

const kindLabel = { rules: "指令", skills: "技能", projects: "项目" };
const time = (date?: string) =>
  date
    ? new Date(date).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "从未同步";
const relative = (date?: string) => {
  if (!date) return "";
  const diff = Date.parse(date) - Date.now(),
    minutes = Math.round(Math.abs(diff) / 60_000);
  const text =
    minutes < 1
      ? "不到 1 分钟"
      : minutes < 60
        ? `${minutes} 分钟`
        : `${Math.round(minutes / 60)} 小时`;
  return diff > 0 ? `${text}后` : `${text}前`;
};

export function SyncPanel({
  data,
  busy,
  act,
  api,
  openPlan,
}: {
  data: Snapshot;
  busy: boolean;
  act: Act;
  api: Api;
  openPlan: () => void;
}) {
  const { autoDeploy } = useApp();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<"create" | "url">("create");
  const [name, setName] = useState("harness-sync-config");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const load = async () => {
    setLoadError("");
    try {
      setStatus(await api<SyncStatus>("sync/status"));
    } catch (e: any) {
      setLoadError(e.message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const run = (fn: () => Promise<SyncStatus>, message: string) =>
    void act(async () => setStatus(await fn()), message).catch(() => {});

  if (!status)
    return (
      <section className="panel sync-loading">
        {loadError ? (
          <>
            <TriangleAlert size={18} />
            <p>{loadError}</p>
            <button className="button small" onClick={() => void load()}>
              <RefreshCw size={13} />
              重试
            </button>
          </>
        ) : (
          <>
            <Loader2 size={18} className="spin" />
            <p>正在读取同步状态…</p>
          </>
        )}
      </section>
    );

  if (!status.connected)
    return (
      <div className="sync-layout">
        <section className="panel settings-card">
          <div className="settings-card-title">
            <GitBranch size={19} />
            <div>
              <h2>连接私有仓库</h2>
              <p>
                技能、指令和项目会备份到你自己的 Git
                仓库，其他设备连接同一仓库即可同步。设备变量、目录绑定和部署记录只留在本机。
              </p>
            </div>
          </div>
          <div className="segmented" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "create"}
              className={mode === "create" ? "selected" : ""}
              onClick={() => setMode("create")}
            >
              <Github size={14} />
              新建 GitHub 私有仓库
            </button>
            <button
              role="tab"
              aria-selected={mode === "url"}
              className={mode === "url" ? "selected" : ""}
              onClick={() => setMode("url")}
            >
              <Link2 size={14} />
              连接已有仓库
            </button>
          </div>
          <form
            className="sync-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  api<SyncStatus>(
                    "sync/setup",
                    mode === "create"
                      ? { create: name.trim() || true }
                      : { url: url.trim(), branch: branch.trim() || undefined },
                  ),
                "已连接，配置已同步",
              );
            }}
          >
            {mode === "create" ? (
              <>
                <label>
                  仓库名称
                  <input
                    required
                    pattern="[a-zA-Z0-9_.\-]+"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p className="hint">
                  使用本机 GitHub CLI
                  的登录状态创建，仓库默认私有。未登录时先在终端运行{" "}
                  <code>gh auth login</code>。
                </p>
              </>
            ) : (
              <>
                <label>
                  仓库地址
                  <input
                    required
                    placeholder="git@github.com:you/harness-sync-config.git"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
                <label>
                  分支 <small>可选，默认使用远端默认分支</small>
                  <input
                    placeholder="main"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </label>
                <p className="hint">
                  新设备连接已有备份时会直接恢复；两边都有内容时按条目合并。使用
                  SSH 或 Git 凭证助手认证，地址中不要包含令牌。
                </p>
              </>
            )}
            <div className="sync-actions">
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                {mode === "create" ? "创建并同步" : "连接并同步"}
              </button>
            </div>
          </form>
        </section>
        <SyncFacts />
      </div>
    );

  const conflicts = status.conflicts;
  const pendingDeploy = status.scheduler.pendingDeployment;
  return (
    <div className="sync-layout">
      {pendingDeploy > 0 && (
        <div className="sync-pending">
          <ArrowDownToLine size={16} />
          <span>
            其他设备带来了 <strong>{pendingDeploy}</strong>{" "}
            项变更，已合并到技能库，还没有写入各 AI 工具。
          </span>
          <button className="button small primary" onClick={openPlan}>
            <Zap size={13} />
            查看并部署
          </button>
        </div>
      )}
      <section className="panel settings-card">
        <div className="settings-card-title">
          <GitBranch size={19} />
          <div>
            <h2>同步状态</h2>
            <p>
              {conflicts.length
                ? "有冲突待处理，处理完之前暂停推送，其他设备不受影响。"
                : autoDeploy
                  ? "拉取到的改动会自动写入各 AI 工具；遇到需要确认的情况会提示你。"
                  : "同步只更新源配置；拉取后请预览部署，再写入各 AI 工具。"}
            </p>
          </div>
          <span className={`sync-badge ${conflicts.length ? "warn" : ""}`}>
            {conflicts.length ? `${conflicts.length} 个冲突` : "已连接"}
          </span>
        </div>
        <div className="key-value">
          <span>仓库</span>
          <code title={status.remote}>{status.remote}</code>
        </div>
        <div className="key-value">
          <span>分支</span>
          <code>{status.branch}</code>
        </div>
        <div className="key-value">
          <span>上次同步</span>
          <span>{time(status.lastSyncTime)}</span>
        </div>
        <div className="key-value">
          <span>与远端相比</span>
          <span className="sync-counts">
            <span title="本机领先">
              <ArrowUpFromLine size={13} />
              {status.ahead}
            </span>
            <span title="远端领先">
              <ArrowDownToLine size={13} />
              {status.behind}
            </span>
          </span>
        </div>
        <div className="sync-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              run(
                () => api<SyncStatus>("sync/disconnect", {}),
                "已断开，本机配置保持不变",
              )
            }
          >
            <CloudOff size={14} />
            断开
          </button>
          <button className="button" disabled={busy} onClick={openPlan}>
            <Zap size={14} />
            预览部署
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(
                () => api<SyncStatus>("sync/now", {}),
                autoDeploy ? "同步完成" : "同步完成，请预览部署",
              )
            }
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}
            立即同步
          </button>
        </div>
      </section>
      <AutoSyncCard
        status={status}
        busy={busy}
        save={(patch) =>
          run(
            () =>
              api<AutoSyncSettings>("sync/auto", patch, "PUT").then(() =>
                api<SyncStatus>("sync/status"),
              ),
            patch.enabled === false
              ? "已关闭自动同步"
              : patch.enabled
                ? "已开启自动同步"
                : "已保存自动同步设置",
          )
        }
      />
      {conflicts.length > 0 ? (
        <SyncConflicts
          conflicts={conflicts}
          data={data}
          api={api}
          busy={busy}
          run={run}
        />
      ) : null}
      <SyncHistory
        api={api}
        busy={busy}
        revision={status.lastSyncedCommit}
        undoable={!!status.undo?.available}
        undo={() =>
          run(
            () => api<SyncStatus>("sync/undo", {}),
            "已撤销，以新提交恢复到操作前",
          )
        }
      />
    </div>
  );
}

function AutoSyncCard({
  status,
  busy,
  save,
}: {
  status: SyncStatus;
  busy: boolean;
  save: (patch: Partial<AutoSyncSettings>) => void;
}) {
  const { auto, scheduler } = status;
  const failing = scheduler.failures > 0 && scheduler.lastError;
  return (
    <section className="panel settings-card auto-sync">
      <div className="settings-card-title">
        <RefreshCw size={19} />
        <div>
          <h2>自动同步</h2>
          <p>
            停止编辑一会儿后自动推送，并定期拉取其他设备的改动。只在 GUI 服务或{" "}
            <code>hsync sync watch</code> 运行时进行。
          </p>
        </div>
        <button
          role="switch"
          aria-checked={auto.enabled}
          aria-label="自动同步"
          className={`toggle ${auto.enabled ? "on" : ""}`}
          disabled={busy}
          onClick={() => save({ enabled: !auto.enabled })}
        >
          <span />
        </button>
      </div>
      {auto.enabled && (
        <>
          <div className={`auto-sync-state ${failing ? "warn" : ""}`}>
            {failing ? (
              <>
                <TriangleAlert size={14} />
                <span>
                  连续 {scheduler.failures} 次失败：{scheduler.lastError}
                  {scheduler.nextRunAt &&
                    `。将在 ${relative(scheduler.nextRunAt)}重试`}
                </span>
              </>
            ) : (
              <>
                <Check size={14} />
                <span>
                  {scheduler.lastSuccessAt
                    ? `上次成功 ${relative(scheduler.lastSuccessAt)}`
                    : "尚未自动同步过"}
                  {status.pushBlocked
                    ? "。有冲突待处理，暂停推送"
                    : scheduler.pendingPush
                      ? "。有本机改动等待推送"
                      : ""}
                  {scheduler.nextRunAt &&
                    `，下次 ${relative(scheduler.nextRunAt)}`}
                </span>
              </>
            )}
          </div>
          <div className="auto-sync-fields">
            <label>
              编辑后等待
              <select
                value={auto.debounceSeconds}
                disabled={busy}
                onChange={(e) =>
                  save({ debounceSeconds: Number(e.target.value) })
                }
              >
                {[30, 60, 120, 300, 600]
                  .concat(
                    [30, 60, 120, 300, 600].includes(auto.debounceSeconds)
                      ? []
                      : [auto.debounceSeconds],
                  )
                  .map((v) => (
                    <option key={v} value={v}>
                      {v < 60 ? `${v} 秒` : `${v / 60} 分钟`}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              拉取间隔
              <select
                value={auto.pullIntervalMinutes}
                disabled={busy}
                onChange={(e) =>
                  save({ pullIntervalMinutes: Number(e.target.value) })
                }
              >
                {[5, 10, 30, 60]
                  .concat(
                    [5, 10, 30, 60].includes(auto.pullIntervalMinutes)
                      ? []
                      : [auto.pullIntervalMinutes],
                  )
                  .map((v) => (
                    <option key={v} value={v}>
                      {v < 60 ? `${v} 分钟` : `${v / 60} 小时`}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </>
      )}
    </section>
  );
}

function SyncHistory({
  api,
  busy,
  revision,
  undoable,
  undo,
}: {
  api: Api;
  busy: boolean;
  revision?: string;
  undoable: boolean;
  undo: () => void;
}) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let live = true;
    setError("");
    api<HistoryItem[]>("sync/history")
      .then((x) => live && setItems(x))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision]);
  const verb = { 新增: "added", 修改: "modified", 删除: "removed" } as Record<
    string,
    string
  >;
  // Unifying two same-named entries changes only the ID; show it as one merge.
  const collapse = (changes: HistoryItem["changes"]) =>
    changes.flatMap((c, i) => {
      const twin = (d: HistoryItem["changes"][number]) =>
        d.kind === c.kind &&
        d.name &&
        d.name === c.name &&
        d.action !== c.action &&
        ["新增", "删除"].includes(d.action);
      const j = changes.findIndex(twin);
      if (j < 0 || !["新增", "删除"].includes(c.action)) return [c];
      return j > i ? [{ ...c, action: "合并" }] : [];
    });
  return (
    <section className="panel sync-history">
      <div className="sync-history-head">
        <h3>
          <History size={15} />
          同步历史
        </h3>
        {confirm ? (
          <span className="sync-undo-confirm">
            撤销最近一次冲突处理或恢复？
            <button
              className="button small"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              取消
            </button>
            <button
              className="button small primary"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                undo();
              }}
            >
              撤销
            </button>
          </span>
        ) : (
          undoable && (
            <button
              className="sync-undo"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              <Undo2 size={13} />
              撤销上一次处理
            </button>
          )
        )}
      </div>
      {error ? (
        <p className="sync-history-empty">{error}</p>
      ) : !items ? (
        <p className="sync-history-empty">
          <Loader2 size={14} className="spin" /> 正在读取…
        </p>
      ) : !items.length ? (
        <p className="sync-history-empty">还没有记录。</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.hash}>
              <div className="sync-history-meta">
                <strong>{item.message}</strong>
                <span>
                  {item.device} · {time(item.date)} ·{" "}
                  <code>{item.hash.slice(0, 7)}</code>
                </span>
              </div>
              {item.changes.length > 0 && (
                <div className="sync-history-changes">
                  {collapse(item.changes)
                    .slice(0, 6)
                    .map((c) => (
                      <span
                        key={`${c.kind}-${c.id}`}
                        className={`history-chip ${verb[c.action] || ""}`}
                      >
                        {c.action}
                        {kindLabel[c.kind]} {c.name || c.id.slice(0, 8)}
                      </span>
                    ))}
                  {item.changes.length > 6 && (
                    <span className="history-chip">
                      等 {item.changes.length} 项
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SyncFacts() {
  return (
    <section className="panel sync-facts">
      <h3>
        <ShieldCheck size={15} />
        同步如何工作
      </h3>
      <ul>
        <li>按条目合并：不同条目的修改自动合并，不会互相覆盖。</li>
        <li>两台设备有同名且内容相同的条目时，自动合成一份。</li>
        <li>
          同一条目两边内容不同时记为冲突，本机版本保留，暂停推送直到你选择。
        </li>
        <li>每次合并或处理冲突前保存安全点，可在「版本与部署」中恢复。</li>
        <li>
          同步只改技能库。写入各 AI 工具时只动 HarnessSync
          管理的文件，每次都保留快照。
        </li>
      </ul>
    </section>
  );
}
