import React, { useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type { Skill, Plan, Change } from "../shared/types.ts";
import { DiffLines, Empty } from "./common.tsx";
import { ConflictChoice, type ConflictUse } from "./ConflictChoice.tsx";
export function PlanDrawer({
  plan,
  home,
  busy,
  close,
  apply,
  choose,
}: {
  plan: Plan;
  home: string;
  busy: boolean;
  close: () => void;
  apply: () => Promise<void>;
  choose: (change: Change, use: ConflictUse | null) => Promise<void>;
}) {
  const changed = plan.changes.filter(
    (c) => !["unchanged", "conflict", "skipped"].includes(c.status),
  );
  const [selectedPath, setSelectedPath] = useState(
    () =>
      (
        plan.changes.find((c) => c.status === "conflict") ||
        changed[0] ||
        plan.changes[0]
      )?.path,
  );
  // The plan is replaced after every choice; keep the selection by path.
  const selected =
    plan.changes.find((c) => c.path === selectedPath) ||
    plan.changes[0] ||
    null;
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Change["status"] | "all">("all");
  const conflicts = plan.changes.filter((c) => c.status === "conflict");
  const short = (p: string) =>
    p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  const order: Change["status"][] = [
    "conflict",
    "replace",
    "create",
    "update",
    "adopt",
    "remove",
    "skipped",
    "unchanged",
  ];
  const counts = Object.fromEntries(
    order.map((k) => [k, plan.changes.filter((c) => c.status === k).length]),
  ) as Record<Change["status"], number>;
  const visible = plan.changes
    .filter((c) => status === "all" || c.status === status)
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const linkReplace = (c: Change) => c.reason === "以副本替换链接";
  const labels: Record<Change["status"], string> = {
    replace: "覆盖",
    skipped: "跳过",
    adopt: "接管",
    create: "新增",
    update: "更新",
    remove: "撤下",
    unchanged: "一致",
    conflict: "冲突",
  };
  return (
    <div
      className="overlay drawer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="plan-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-title"
      >
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">REVIEW BEFORE APPLY</span>
            <h2 id="plan-title">预览部署变更</h2>
            <p>
              {changed.length} 项变更<span className="dot-separator">·</span>
              {conflicts.length} 个文件冲突
              <span className="dot-separator">·</span>
              {plan.errors.length} 个配置错误
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭部署预览"
            onClick={close}
          >
            <X size={21} />
          </button>
        </div>
        {(plan.warnings || []).length > 0 && (
          <div className="plan-warnings">
            {plan.warnings!.map((w) => (
              <p key={w}>
                <TriangleAlert size={15} />
                {w}
              </p>
            ))}
          </div>
        )}
        {plan.errors.length > 0 && (
          <div className="plan-errors">
            {plan.errors.map((e) => (
              <p key={e}>
                <TriangleAlert size={15} />
                {e}
              </p>
            ))}
          </div>
        )}
        <div className="plan-layout">
          <div className="change-list">
            {plan.changes.length > 0 && (
              <div className="change-filter" role="tablist">
                {(["all", ...order] as const)
                  .filter((k) => k === "all" || counts[k] > 0)
                  .map((k) => (
                    <button
                      key={k}
                      role="tab"
                      aria-selected={status === k}
                      className={status === k ? "selected" : ""}
                      onClick={() => setStatus(k)}
                    >
                      {k === "all" ? "全部" : labels[k]}
                      <span>
                        {k === "all" ? plan.changes.length : counts[k]}
                      </span>
                    </button>
                  ))}
              </div>
            )}
            {plan.changes.length ? (
              visible.map((c) => (
                <button
                  key={c.path}
                  className={selected?.path === c.path ? "selected" : ""}
                  onClick={() => setSelectedPath(c.path)}
                >
                  <span
                    className={`change-tag ${c.status} ${linkReplace(c) ? "link" : ""}`}
                  >
                    {linkReplace(c) ? "替换链接" : labels[c.status]}
                  </span>
                  <div>
                    <strong>{c.path.split("/").slice(-1)[0]}</strong>
                    <small title={c.path}>
                      {short(c.path.split("/").slice(0, -1).join("/"))}
                    </small>
                  </div>
                  <ChevronRight size={13} />
                </button>
              ))
            ) : (
              <Empty
                icon={CheckCircle2}
                title="没有待部署内容"
                text="先添加一个 Skill 或指令片段。"
              />
            )}
          </div>
          <div className="diff-pane">
            {selected ? (
              <>
                <div className="diff-heading">
                  <code title={selected.path}>{short(selected.path)}</code>
                  <span className={`change-tag ${selected.status}`}>
                    {labels[selected.status]}
                  </span>
                </div>
                <div
                  className={`diff-note ${selected.status === "conflict" ? "conflict" : ""}`}
                >
                  {selected.status === "conflict" ? (
                    <TriangleAlert size={15} />
                  ) : (
                    <ShieldCheck size={15} />
                  )}
                  {selected.conflictOptions && selected.status === "conflict"
                    ? "已有同名目录，内容与技能库不同"
                    : selected.reason}
                </div>
                {selected.status === "adopt" ? (
                  <div className="conflict-detail calm">
                    <h3>内容完全一致，只登记归属</h3>
                    <p>
                      这个目录与技能库中的版本逐字节相同。部署不会改写任何文件，只记录它由
                      HarnessSync 管理，之后的更新和撤下都会经过预览。
                    </p>
                  </div>
                ) : linkReplace(selected) ? (
                  <div className="conflict-detail calm">
                    <h3>以副本替换软链接</h3>
                    <p>
                      部署时只移除这个链接本身，换成技能库中的完整副本；链接指向的源目录不会被修改。回滚会恢复原来的链接。源目录之后有更新时，用「刷新」把改动带回技能库。
                    </p>
                  </div>
                ) : selected.conflictOptions &&
                  ["conflict", "replace", "skipped"].includes(
                    selected.status,
                  ) ? (
                  <ConflictChoice
                    change={selected}
                    busy={busy}
                    choose={(use) => {
                      setError("");
                      void choose(selected, use).catch((e) =>
                        setError(e.message),
                      );
                    }}
                  />
                ) : selected.status === "conflict" ? (
                  <div className="conflict-detail">
                    <h3>保留文件，先解决来源差异</h3>
                    <p>
                      已有内容不会被覆盖。可以在技能库中使用不同名称，或将外部修改整理到源配置；已管理文件可通过部署历史安全恢复。
                    </p>
                  </div>
                ) : (
                  <pre className="diff-code">
                    {selected.diff ? (
                      <DiffLines diff={selected.diff} />
                    ) : (
                      <span className="muted">
                        文本未变化。Skill 的资源或执行权限也会参与完整包比较。
                      </span>
                    )}
                  </pre>
                )}
              </>
            ) : null}
          </div>
        </div>
        {error && <p className="form-error drawer-error">{error}</p>}
        <div className="drawer-footer">
          <span>
            <ShieldCheck size={15} />
            部署前自动保存文件快照
          </span>
          <button className="button" onClick={close}>
            返回编辑
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              !changed.length ||
              conflicts.length > 0 ||
              plan.errors.length > 0
            }
            onClick={() => {
              setError("");
              void apply().catch((e) => setError(e.message));
            }}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}
            部署 {changed.length} 项变更
          </button>
        </div>
      </section>
    </div>
  );
}
