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
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { Snapshot, SyncConflict, SyncStatus } from "../shared/types.ts";

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
  return (
    <div className="sync-layout">
      <section className="panel settings-card">
        <div className="settings-card-title">
          <GitBranch size={19} />
          <div>
            <h2>同步状态</h2>
            <p>
              {conflicts.length
                ? "有冲突待处理，处理完之前暂停推送，其他设备不受影响。"
                : "同步只更新源配置；拉取后请预览部署，再写入各 Harness。"}
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
              run(() => api<SyncStatus>("sync/now", {}), "同步完成，请预览部署")
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
      {conflicts.length > 0 ? (
        <section className="panel sync-conflicts">
          <div className="settings-card-title">
            <TriangleAlert size={19} />
            <div>
              <h2>待处理冲突</h2>
              <p>
                两台设备改了同一条目。本机版本暂时保留，选择后会先保存安全点。
              </p>
            </div>
          </div>
          {conflicts.map((c) => (
            <ConflictRow
              key={`${c.kind}-${c.entryId}`}
              conflict={c}
              data={data}
              busy={busy}
              resolve={(keep) =>
                run(
                  () =>
                    api<SyncStatus>("sync/resolve", {
                      entryId: c.entryId,
                      keep,
                    }),
                  "冲突已处理，再同步一次即可推送",
                )
              }
            />
          ))}
        </section>
      ) : (
        <SyncFacts />
      )}
    </div>
  );
}

function ConflictRow({
  conflict,
  data,
  busy,
  resolve,
}: {
  conflict: SyncConflict;
  data: Snapshot;
  busy: boolean;
  resolve: (keep: "local" | "remote" | "both") => void;
}) {
  const list = data.manifest[conflict.kind] as {
    id: string;
    name?: string;
    title?: string;
  }[];
  const local = list.find(
    (e) => e.id === (conflict.localId || conflict.entryId),
  );
  const label = local?.name || local?.title || conflict.entryId.slice(0, 8);
  const reason =
    conflict.reason === "name"
      ? "两台设备各自新建了同名技能"
      : local
        ? "两台设备都修改了这一条目"
        : "一台设备删除了它，另一台做了修改";
  return (
    <div className="conflict-row">
      <div>
        <span className="tiny-tag">{kindLabel[conflict.kind]}</span>
        <strong>{label}</strong>
        <small>{reason}</small>
      </div>
      <div className="conflict-choices">
        <button
          className="button small"
          disabled={busy}
          onClick={() => resolve("local")}
        >
          保留本机
        </button>
        <button
          className="button small"
          disabled={busy}
          onClick={() => resolve("remote")}
        >
          使用远端
        </button>
        <button
          className="button small"
          disabled={busy || !local}
          title={local ? "远端版本另存为副本" : "删除冲突无法两者都保留"}
          onClick={() => resolve("both")}
        >
          两者都保留
        </button>
      </div>
    </div>
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
        <li>同一条目两边都改时记为冲突，本机版本保留，暂停推送直到你选择。</li>
        <li>每次合并或处理冲突前保存安全点，可在「版本与部署」中恢复。</li>
        <li>同步从不直接写入 Harness 目录，部署始终需要预览确认。</li>
      </ul>
    </section>
  );
}
