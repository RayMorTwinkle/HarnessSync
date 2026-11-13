import React from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Box,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Folder,
  GitBranch,
  Layers3,
  Search,
  Sparkles,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import type { Skill } from "../../shared/types.ts";
import { useApp } from "../app-context.tsx";
import { Empty, HarnessIcon, ScopeLabel } from "../common.tsx";
import { time, type Page } from "../lib.ts";
export function Overview() {
  const { data, busy, fire, api, setPage, openPlan, openScan, editSkill } =
    useApp();
  const { manifest, device } = data;
  const pending = data.plan.changes.filter(
    (c) => !["unchanged", "conflict", "skipped"].includes(c.status),
  );
  const conflicts = data.plan.changes.filter((c) => c.status === "conflict");
  const activeSkills = manifest.skills.filter((s) => s.enabled);
  const latest = data.deployments.find(
    (d) => d.status === "applied" || d.status === "pending",
  );
  const hasError = conflicts.length + data.plan.errors.length;
  return (
    <>
      <div className="onboarding-entry">
        <span>
          <Sparkles size={16} />
          第一次在这台机器使用？让 AI 帮你整理已有配置。
        </span>
        <button className="text-button" onClick={() => setPage("onboarding")}>
          开始本机初始化
          <ArrowRight size={14} />
        </button>
      </div>
      <section className="stats-grid">
        {[
          {
            label: "统一技能库",
            value: manifest.skills.length,
            unit: "个技能",
            icon: Box,
            sub: `${activeSkills.length} 个已启用`,
            go: "skills",
          },
          {
            label: "行为指令",
            value: manifest.rules.length,
            unit: "个片段",
            icon: FileText,
            sub: "共享习惯，按需组合",
            go: "instructions",
          },
          {
            label: "已连接 Harness",
            value: data.harnesses.filter((h) => h.installed).length,
            unit: `/ ${data.harnesses.length}`,
            icon: Layers3,
            sub: "DeepSeek · OpenCode · Codex · Claude",
            go: "overview",
          },
          {
            label: "命名项目",
            value: manifest.projects.length,
            unit: "个项目",
            icon: Folder,
            sub: `${Object.keys(device.bindings).filter((id) => manifest.projects.some((p) => p.id === id)).length} 个本机目录已绑定`,
            go: "projects",
          },
        ].map((c) => (
          <button
            key={c.label}
            className="stat-card"
            onClick={() => setPage(c.go as Page)}
          >
            <span className="stat-top">
              {c.label}
              <c.icon size={17} />
            </span>
            <span className="stat-value">
              {c.value}
              <small>{c.unit}</small>
            </span>
            <span className="stat-sub">
              {c.sub}
              <ArrowUpRight size={13} />
            </span>
          </button>
        ))}
      </section>
      <section className="section harness-section">
        <div className="section-heading">
          <h2>
            你的 Harness{" "}
            <span className="count-badge">{data.harnesses.length}</span>
          </h2>
          <span className="muted tiny">
            <span className="status-dot" />
            当前设备
          </span>
        </div>
        <div className="harness-grid">
          {data.harnesses.map((h) => {
            const changes = data.plan.changes.filter((c) => c.harness === h.id);
            const count = data.plan.changes.filter(
              (c) =>
                c.harness === h.id &&
                c.kind === "skill" &&
                c.status !== "remove",
            ).length;
            return (
              <article className="harness-card" key={h.id}>
                <div className="harness-card-top">
                  <HarnessIcon id={h.id} />
                  <div className="harness-title">
                    <h3>{h.name}</h3>
                    <span>{h.version || "尚未检测到 CLI 版本"}</span>
                  </div>
                  <span
                    className={`connection-pill ${h.installed ? "" : "offline"}`}
                  >
                    <span className="status-dot" />
                    {h.installed ? "已检测到" : "未检测到"}
                  </span>
                </div>
                <div className="harness-metrics">
                  <span>
                    <strong>{count}</strong> 个目标技能
                  </span>
                  <span>
                    <strong>
                      {
                        manifest.rules.filter(
                          (r) =>
                            r.enabled &&
                            r.scope.harnesses.includes(h.id) &&
                            r.scope.kind !== "project",
                        ).length
                      }
                    </strong>{" "}
                    个全局片段
                  </span>
                </div>
                <div className="harness-card-footer">
                  <code title={h.skills}>
                    {h.skills.replace(device.home, "~")}
                  </code>
                  <button onClick={openPlan}>
                    {changes.some((c) => c.status === "conflict")
                      ? "查看冲突"
                      : changes.some((c) => c.status !== "unchanged")
                        ? "等待部署"
                        : changes.length
                          ? "文件已部署"
                          : "查看配置"}
                    <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <div className="overview-columns">
        <section className="section skills-section">
          <div className="section-heading">
            <h2>技能库</h2>
            <button className="text-button" onClick={() => setPage("skills")}>
              查看全部
              <ArrowRight size={13} />
            </button>
          </div>
          <div className="panel skill-list-panel">
            {manifest.skills.length ? (
              manifest.skills.slice(0, 5).map((s) => (
                <button
                  className="skill-row"
                  key={s.id}
                  onClick={() => editSkill(s)}
                >
                  <span className="skill-tile">
                    <Box size={19} />
                  </span>
                  <span className="skill-row-copy">
                    <strong>{s.displayName || s.name}</strong>
                    <span>{s.description}</span>
                  </span>
                  <ScopeLabel scope={s.scope} data={data} />
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <Empty
                icon={Box}
                title="从一份 Skill 开始"
                text="导入已有技能，或让 AI 帮你管理这个工作空间。"
                action={
                  <button className="button" onClick={openScan}>
                    <Search size={14} />
                    扫描本机 Skills
                  </button>
                }
              />
            )}
          </div>
        </section>
        <section className="section">
          <div className="section-heading">
            <h2>配置状态</h2>
            <span className="tiny muted">实时文件检查</span>
          </div>
          <div className="panel status-panel">
            <div className={`status-hero ${hasError ? "warning" : ""}`}>
              <span className="status-hero-icon">
                {hasError ? (
                  <TriangleAlert size={24} />
                ) : (
                  <CheckCircle2 size={24} />
                )}
              </span>
              <div>
                <h3>
                  {hasError
                    ? "有配置需要处理"
                    : pending.length
                      ? "变更已准备好"
                      : "配置状态正常"}
                </h3>
                <p>
                  {hasError
                    ? `${hasError} 个冲突或配置错误`
                    : pending.length
                      ? `${pending.length} 项变更等待部署到 Harness`
                      : "源配置与已管理文件保持一致"}
                </p>
              </div>
            </div>
            <div className="status-line">
              <span>
                <GitBranch size={14} />
                版本管理
              </span>
              <strong>本地 Git</strong>
            </div>
            <div className="status-line">
              <span>
                <Clock3 size={14} />
                最近部署
              </span>
              <strong>{time(latest?.date)}</strong>
            </div>
            <div className="status-line">
              <span>
                <Activity size={14} />
                会话加载
              </span>
              <span className="muted">未观测</span>
            </div>
            <button className="status-bottom" onClick={openPlan}>
              查看部署详情
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
      </div>
      <section className="agent-callout">
        <span className="callout-icon">
          <Sparkles size={23} />
        </span>
        <div>
          <h3>让 AI 管理它自己的工作方式</h3>
          <p>安装管理 Skill，就能用自然语言新增技能、调整指令和检查部署。</p>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            fire(
              () => api("self-skill", { revision: data.revision }),
              "管理 Skill 已加入技能库，请预览部署",
            )
          }
        >
          <Terminal size={14} />
          {manifest.skills.some((s) => s.name === "manage-harness-sync")
            ? "更新管理 Skill"
            : "安装管理 Skill"}
          <ArrowRight size={14} />
        </button>
      </section>
    </>
  );
}
