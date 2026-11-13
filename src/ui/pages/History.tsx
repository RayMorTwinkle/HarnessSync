import React from "react";
import { ArrowDownToLine, GitBranch, History } from "lucide-react";
import { useApp } from "../app-context.tsx";
import { Empty, HarnessIcon, ScopeLabel } from "../common.tsx";
import { time } from "../lib.ts";
export function HistoryPage() {
  const { data, busy, setModal, api } = useApp();
  return (
    <div className="history-columns">
      <section>
        <div className="section-heading">
          <h2>
            <GitBranch size={16} />
            源配置版本
          </h2>
          <span className="tiny muted">{data.history.length} 条最近记录</span>
        </div>
        <div className="panel history-list">
          {data.history.map((h, i) => (
            <div className="history-row" key={h.hash}>
              <span className={`timeline-dot ${i === 0 ? "current" : ""}`} />
              <div>
                <strong>{h.message}</strong>
                <span>
                  <code>{h.hash.slice(0, 8)}</code>
                  <span>{time(h.date)}</span>
                  {i === 0 && <span className="tiny-tag">最新</span>}
                </span>
              </div>
              <button
                className="text-button"
                disabled={busy || i === 0}
                onClick={() =>
                  setModal({
                    type: "confirm",
                    item: {
                      title: "恢复这份源配置？",
                      text: "将产生一条新的版本记录。Harness 的文件不会立即改变，请检查后重新部署。",
                      action: () =>
                        api("restore", {
                          hash: h.hash,
                          revision: data.revision,
                        }),
                    },
                  })
                }
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>
            <ArrowDownToLine size={16} />
            原生文件部署
          </h2>
          <span className="tiny muted">可独立回滚</span>
        </div>
        <div className="panel history-list">
          {data.deployments.length ? (
            data.deployments.map((d, i) => (
              <div className="history-row" key={d.id}>
                <span
                  className={`timeline-dot ${d.rolledBack ? "" : "current"}`}
                />
                <div>
                  <strong>
                    {d.status === "pending"
                      ? "部署中断，请回滚"
                      : d.status === "failed"
                        ? "部署失败（已恢复）"
                        : d.rolledBack
                          ? "已回滚部署"
                          : "部署配置"}
                    <span className="tiny-tag">{d.changes} 项</span>
                  </strong>
                  <span>{time(d.date)}</span>
                </div>
                <button
                  className="text-button"
                  disabled={
                    busy ||
                    !["applied", "pending"].includes(d.status) ||
                    i !==
                      data.deployments.findIndex((d) =>
                        ["applied", "pending"].includes(d.status),
                      )
                  }
                  onClick={() =>
                    setModal({
                      type: "confirm",
                      item: {
                        title: "回滚这次部署？",
                        text: "将恢复部署前的原生文件，保留当前源配置。若文件有后续修改，系统会拒绝覆盖。",
                        action: () => api("rollback", { id: d.id }),
                      },
                    })
                  }
                >
                  回滚
                </button>
              </div>
            ))
          ) : (
            <Empty
              icon={History}
              title="还没有部署记录"
              text="每次部署前都会保存原生文件快照。"
            />
          )}
        </div>
      </section>
    </div>
  );
}
