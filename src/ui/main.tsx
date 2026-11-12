import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Command,
  Copy,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  History,
  Layers3,
  LayoutDashboard,
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type {
  Snapshot,
  Rule,
  Skill,
  Scope,
  Project,
  Inspection,
  Plan,
  Change,
} from "../shared/types.ts";
import "./style.css";
import { harnessIds, harnessNames } from "../shared/harnesses.ts";
import { OnboardingPanel } from "./OnboardingPanel.tsx";

type Page =
  | "overview"
  | "skills"
  | "instructions"
  | "projects"
  | "onboarding"
  | "history"
  | "device";
const navigation: { id: Page; title: string; icon: typeof Box }[] = [
  { id: "overview", title: "工作台", icon: LayoutDashboard },
  { id: "skills", title: "技能库", icon: Box },
  { id: "instructions", title: "全局指令", icon: FileText },
  { id: "projects", title: "项目", icon: Folder },
  { id: "onboarding", title: "首次初始化", icon: Sparkles },
  { id: "history", title: "版本与部署", icon: History },
  { id: "device", title: "设备与变量", icon: Settings2 },
];
async function api<T>(
  route: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? "GET" : method,
    headers: {
      "x-harness-sync-token":
        document.querySelector<HTMLMetaElement>("meta[name=harness-sync-token]")
          ?.content || "",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!value.ok) throw new Error(value.message || "操作失败");
  return value.data;
}
const time = (date?: string) =>
  date
    ? new Date(date).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未部署";
const ScopeLabel = ({ scope, data }: { scope: Scope; data: Snapshot }) => (
  <span className={`scope ${scope.kind}`}>
    <Globe2 size={11} />
    {scope.kind === "global"
      ? "全局共享"
      : scope.kind === "device"
        ? "当前设备"
        : data.manifest.projects.find((p) => p.id === scope.target)?.name ||
          "项目"}
  </span>
);
const HarnessIcon = ({
  id,
  small = false,
}: {
  id: string;
  small?: boolean;
}) => (
  <span className={`harness-icon ${id} ${small ? "small" : ""}`}>
    {id === "deepseek" ? (
      <span className="whale">D</span>
    ) : (
      <span className="oc-symbol">
        {id === "codex" ? (
          "C"
        ) : id === "claude" ? (
          "✳"
        ) : (
          <>
            o<span>c</span>
          </>
        )}
      </span>
    )}
  </span>
);
function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ type: string; item?: any } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [scan, setScan] = useState<Inspection | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const refresh = async () => {
    const x = await api<Snapshot>("snapshot");
    setData(x);
    return x;
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const t = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    setQuery("");
    setFilter("all");
  }, [page]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(null);
        setPlanOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      if (message) setToast(message);
      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const fire = (fn: () => Promise<unknown>, message?: string) => {
    void act(fn, message).catch(() => {});
  };
  if (!data)
    return (
      <div className="loading">
        <Layers3 size={32} />
        <p>{error || "正在连接本地配置库…"}</p>
        {error && <button onClick={() => location.reload()}>重新连接</button>}
      </div>
    );
  const { manifest, device } = data;
  const pending = data.plan.changes.filter(
    (c) => !["unchanged", "conflict"].includes(c.status),
  );
  const conflicts = data.plan.changes.filter((c) => c.status === "conflict");
  const activeSkills = manifest.skills.filter((s) => s.enabled);
  const latest = data.deployments.find(
    (d) => d.status === "applied" || d.status === "pending",
  );
  const hasError = conflicts.length + data.plan.errors.length;
  const scopeText = (scope: Scope) =>
    scope.kind === "global"
      ? "所有设备与项目"
      : scope.kind === "device"
        ? device.name
        : manifest.projects.find((p) => p.id === scope.target)?.name || "项目";
  const openScan = () =>
    fire(async () => {
      setScan(await api<Inspection>("inspect"));
      setModal({ type: "scan" });
    });
  const editSkill = (skill: Skill) =>
    fire(async () =>
      setModal({ type: "skill", item: await api(`skills/${skill.id}`) }),
    );
  const changeEnabled = (skill: Skill) =>
    fire(
      async () => {
        const full = await api<any>(`skills/${skill.id}`);
        await api(`skills/${skill.id}`, {
          value: { ...full, enabled: !skill.enabled },
          revision: data.revision,
        });
      },
      skill.enabled ? "已停用，部署后从 Harness 撤下" : "已启用，等待部署",
    );
  const openPlan = () =>
    fire(async () => {
      await refresh();
      setPlanOpen(true);
    });
  const remove = (type: string, item: any) =>
    setModal({
      type: "confirm",
      item: {
        title: `移除「${item.name || item.title}」？`,
        text: "这会修改源配置。已部署内容会在下一次部署时撤下，可通过版本历史恢复。",
        action: async () =>
          api(`${type}/${item.id}`, { revision: data.revision }, "DELETE"),
      },
    });
  const breadcrumbs = navigation.find((n) => n.id === page)!;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("overview");
          }}
        >
          <span className="brand-mark">
            <Layers3 size={23} />
          </span>
          <span>
            HarnessSync
            <span className="brand-caption">ONE CONFIG. EVERY AGENT.</span>
          </span>
        </a>
        <button className="workspace-switch" onClick={() => setPage("device")}>
          <span className="workspace-avatar">R</span>
          <span>
            个人工作空间<small>本地配置库</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">工作空间</div>
        <nav>
          {navigation.slice(0, 4).map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              <span>{n.title}</span>
              {n.id === "skills" && manifest.skills.length > 0 && (
                <span className="nav-count">{manifest.skills.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label secondary-label">管理</div>
        <nav>
          {navigation.slice(4).map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              <span>{n.title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <span>本地服务运行中</span>
            <span className="version">v0.2</span>
          </div>
          <button className="device-mini" onClick={() => setPage("device")}>
            <span className="device-avatar">
              <Monitor size={17} />
            </span>
            <span>
              {device.name}
              <small>当前设备 · {navigator.platform}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            工作空间 <ChevronRight size={13} /> <span>{breadcrumbs.title}</span>
          </span>
          <div className="topbar-right">
            <span className="local-pill">
              <ShieldCheck size={13} /> 本地优先
            </span>
            <button
              className="icon-button"
              title="刷新配置"
              aria-label="刷新配置"
              onClick={() => fire(refresh, "已刷新本地配置")}
            >
              <RefreshCw size={16} className={busy ? "spin" : ""} />
            </button>
            <span className="top-avatar">R</span>
          </div>
        </header>
        <main>
          {error && (
            <div role="alert" className="error-banner">
              <TriangleAlert size={17} />
              <span>{error}</span>
              <button aria-label="关闭错误" onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "overview"
                  ? "YOUR AGENT WORKSPACE"
                  : "HARNESS SYNC / " + page.toUpperCase()}
              </div>
              <h1>
                {page === "overview"
                  ? "让每个 Agent，沿用你的习惯。"
                  : breadcrumbs.title}
              </h1>
              <p>
                {
                  {
                    overview:
                      "把技能、指令和项目习惯，带到你使用的每一个 Harness。",
                    skills: "一份技能源，按你的选择部署到不同 Harness。",
                    instructions:
                      "组合共享规则与设备差异，让每次会话有一致的起点。",
                    projects:
                      "用项目身份关联配置，目录只是它在这台设备上的位置。",
                    history: "源配置由 Git 留存，原生文件部署可以独立回滚。",
                    device: "设备变量与本地目录绑定保存在这台计算机。",
                    onboarding:
                      "先建立清单与管理入口，再让你常用的 AI 协助整理。",
                  }[page]
                }
              </p>
            </div>
            <button
              className="button primary"
              disabled={busy}
              onClick={openPlan}
            >
              <Zap size={15} />
              预览并部署
              {pending.length > 0 && (
                <span className="button-count">{pending.length}</span>
              )}
            </button>
          </div>
          {page === "onboarding" && (
            <OnboardingPanel request={api} refresh={refresh} />
          )}
          {page === "overview" && (
            <>
              <div className="onboarding-entry">
                <span>
                  <Sparkles size={16} />
                  第一次在这台机器使用？让 AI 帮你整理已有配置。
                </span>
                <button
                  className="text-button"
                  onClick={() => setPage("onboarding")}
                >
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
                    const changes = data.plan.changes.filter(
                      (c) => c.harness === h.id,
                    );
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
                    <button
                      className="text-button"
                      onClick={() => setPage("skills")}
                    >
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
                  <p>
                    安装管理 Skill，就能用自然语言新增技能、调整指令和检查部署。
                  </p>
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
          )}
          {page === "skills" && (
            <>
              <div className="toolbar">
                <div className="segmented">
                  <button
                    className={filter === "all" ? "selected" : ""}
                    onClick={() => setFilter("all")}
                  >
                    全部技能 <span>{manifest.skills.length}</span>
                  </button>
                  <button
                    className={filter === "global" ? "selected" : ""}
                    onClick={() => setFilter("global")}
                  >
                    全局
                  </button>
                  <button
                    className={filter === "project" ? "selected" : ""}
                    onClick={() => setFilter("project")}
                  >
                    项目
                  </button>
                  <button
                    className={filter === "device" ? "selected" : ""}
                    onClick={() => setFilter("device")}
                  >
                    设备
                  </button>
                </div>
                <div className="toolbar-actions">
                  <label className="search">
                    <Search size={15} />
                    <input
                      aria-label="搜索技能"
                      placeholder="搜索技能…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <button className="button" onClick={openScan}>
                    <ArrowDownToLine size={14} />
                    导入
                  </button>
                  <button
                    className="button dark"
                    onClick={() => setModal({ type: "skill" })}
                  >
                    <Plus size={15} />
                    新建技能
                  </button>
                </div>
              </div>
              <div className="skill-grid">
                {manifest.skills
                  .filter(
                    (s) =>
                      (filter === "all" || s.scope.kind === filter) &&
                      `${s.name} ${s.description}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <article
                      className={`skill-card ${!s.enabled ? "disabled" : ""}`}
                      key={s.id}
                    >
                      <div className="skill-card-top">
                        <span className="skill-tile">
                          <Box size={21} />
                        </span>
                        <button
                          className={`toggle ${s.enabled ? "on" : ""}`}
                          role="switch"
                          aria-checked={s.enabled}
                          aria-label={`启用 ${s.name}`}
                          onClick={() => changeEnabled(s)}
                          disabled={busy}
                        >
                          <span />
                        </button>
                      </div>
                      <button
                        className="skill-card-main"
                        onClick={() => editSkill(s)}
                      >
                        <h3>{s.displayName || s.name}</h3>
                        <p>{s.description}</p>
                      </button>
                      <ScopeLabel scope={s.scope} data={data} />
                      <div className="skill-card-bottom">
                        <span className="mini-harnesses">
                          {s.scope.harnesses.map((h) => (
                            <HarnessIcon id={h} small key={h} />
                          ))}
                          <span>
                            {s.scope.harnesses.length === harnessIds.length
                              ? "全部 Harness"
                              : `${s.scope.harnesses.length} 个 Harness`}
                          </span>
                        </span>
                        <button
                          className="icon-button"
                          title="移除技能"
                          aria-label={`移除 ${s.name}`}
                          onClick={() => remove("skills", s)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
              {!manifest.skills.length && (
                <div className="panel">
                  <Empty
                    icon={Box}
                    title="建立你的统一技能库"
                    text="完整导入 SKILL.md、脚本和参考资料，再选择部署范围。"
                    action={
                      <button className="button primary" onClick={openScan}>
                        扫描本机 Skills
                        <ArrowRight size={14} />
                      </button>
                    }
                  />
                </div>
              )}
            </>
          )}
          {page === "instructions" && (
            <>
              <div className="info-strip">
                <FileText size={17} />
                <span>
                  指令以片段组合，部署到各 Harness
                  的原生全局文件。已有文件的其他内容会被保留。
                </span>
                <button
                  className="text-button"
                  onClick={() => setModal({ type: "variables" })}
                >
                  变量说明
                  <ArrowUpRight size={13} />
                </button>
              </div>
              <div className="section-heading list-heading">
                <h2>
                  指令片段{" "}
                  <span className="count-badge">{manifest.rules.length}</span>
                </h2>
                <button
                  className="button dark"
                  onClick={() => setModal({ type: "rule" })}
                >
                  <Plus size={14} />
                  添加指令
                </button>
              </div>
              <div className="rules-list">
                {manifest.rules.map((r) => (
                  <article
                    className={`panel rule-card ${!r.enabled ? "disabled" : ""}`}
                    key={r.id}
                  >
                    <div className="rule-top">
                      <span className="rule-icon">
                        <FileText size={18} />
                      </span>
                      <h3>{r.title}</h3>
                      <ScopeLabel scope={r.scope} data={data} />
                      <button
                        className={`toggle ${r.enabled ? "on" : ""}`}
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={`启用 ${r.title}`}
                        disabled={busy}
                        onClick={() =>
                          fire(
                            () =>
                              api(`rules/${r.id}`, {
                                value: { ...r, enabled: !r.enabled },
                                revision: data.revision,
                              }),
                            "指令状态已保存，等待部署",
                          )
                        }
                      >
                        <span />
                      </button>
                    </div>
                    <pre className="rule-preview">{r.body}</pre>
                    <div className="rule-bottom">
                      <span>
                        {scopeText(r.scope)}
                        <span className="dot-separator">·</span>
                        {r.scope.harnesses
                          .map((h) => harnessNames[h])
                          .join(" + ")}
                      </span>
                      <button
                        className="text-button"
                        onClick={() => setModal({ type: "rule", item: r })}
                      >
                        编辑片段
                        <ArrowRight size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`移除 ${r.title}`}
                        onClick={() => remove("rules", r)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!manifest.rules.length && (
                <div className="panel">
                  <Empty
                    icon={FileText}
                    title="写下你的工作约定"
                    text="语言偏好、验证要求、设备说明，都可以从一小段指令开始。"
                    action={
                      <button
                        className="button"
                        onClick={() => setModal({ type: "rule" })}
                      >
                        <Plus size={14} />
                        添加第一条指令
                      </button>
                    }
                  />
                </div>
              )}
            </>
          )}
          {page === "projects" && (
            <>
              <div className="section-heading list-heading">
                <h2>
                  逻辑项目{" "}
                  <span className="count-badge">
                    {manifest.projects.length}
                  </span>
                </h2>
                <button
                  className="button dark"
                  onClick={() => setModal({ type: "project" })}
                >
                  <Plus size={14} />
                  添加项目
                </button>
              </div>
              <div className="projects-list">
                {manifest.projects.map((p) => (
                  <article className="panel project-card" key={p.id}>
                    <span className="project-icon">
                      <Folder size={23} />
                    </span>
                    <div className="project-copy">
                      <h3>{p.name}</h3>
                      <code>{device.bindings[p.id] || "尚未绑定本机目录"}</code>
                      <div className="project-details">
                        <span>
                          {
                            manifest.skills.filter(
                              (s) => s.scope.target === p.id,
                            ).length
                          }{" "}
                          个技能
                        </span>
                        <span>
                          {
                            manifest.rules.filter(
                              (r) => r.scope.target === p.id,
                            ).length
                          }{" "}
                          个指令片段
                        </span>
                        <span className="mono" title={p.id}>
                          ID {p.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                    <button
                      className="button"
                      onClick={() => setModal({ type: "project", item: p })}
                    >
                      绑定 / 编辑
                      <ArrowRight size={13} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`移除 ${p.name}`}
                      onClick={() => remove("projects", p)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                ))}
              </div>
              {!manifest.projects.length && (
                <div className="panel">
                  <Empty
                    icon={Folder}
                    title="项目跟着名字走"
                    text="创建一个稳定的项目身份，再绑定它在这台设备上的目录。"
                    action={
                      <button
                        className="button"
                        onClick={() => setModal({ type: "project" })}
                      >
                        <Plus size={14} />
                        添加项目
                      </button>
                    }
                  />
                </div>
              )}
              <p className="footnote">
                项目技能使用各 Harness 原生目录。DeepSeek、OpenCode、Codex 共用
                AGENTS.md，Claude 使用 CLAUDE.md；多个项目不切换全局配置。
              </p>
            </>
          )}
          {page === "history" && (
            <div className="history-columns">
              <section>
                <div className="section-heading">
                  <h2>
                    <GitBranch size={16} />
                    源配置版本
                  </h2>
                  <span className="tiny muted">
                    {data.history.length} 条最近记录
                  </span>
                </div>
                <div className="panel history-list">
                  {data.history.map((h, i) => (
                    <div className="history-row" key={h.hash}>
                      <span
                        className={`timeline-dot ${i === 0 ? "current" : ""}`}
                      />
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
          )}
          {page === "device" && (
            <DeviceSettings
              data={data}
              busy={busy}
              save={async (value) => {
                await act(
                  () => api("device", { value, revision: data.revision }),
                  "设备设置已保存",
                );
              }}
            />
          )}
          <footer className="page-footer">
            <span>
              <Layers3 size={13} /> HarnessSync{" "}
              <span className="dot-separator">/</span> 为你的 Agent 建立共同语言
            </span>
            <span>
              <GitBranch size={12} /> {data.history[0]?.hash.slice(0, 7)}{" "}
              <span className="dot-separator">·</span>本机存储
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={`modal ${modal.type === "scan" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">HARNESS SYNC</span>
                <h2 id="modal-title">
                  {
                    {
                      skill: modal.item ? "编辑技能" : "新建技能",
                      rule: modal.item ? "编辑指令片段" : "添加指令片段",
                      project: modal.item ? "项目设置" : "添加项目",
                      scan: "导入已有 Skills",
                      confirm: modal.item?.title,
                      variables: "可用变量",
                    }[modal.type]
                  }
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭弹窗"
                onClick={() => setModal(null)}
              >
                <X size={19} />
              </button>
            </div>
            {["skill", "rule", "project"].includes(modal.type) && (
              <Editor
                key={`${modal.type}-${modal.item?.id || "new"}`}
                type={modal.type}
                item={modal.item}
                data={data}
                busy={busy}
                onDelete={
                  modal.item && modal.type === "rule"
                    ? () => remove("rules", modal.item)
                    : undefined
                }
                submit={async (value) => {
                  await act(
                    () =>
                      api(
                        `${modal.type === "rule" ? "rules" : modal.type === "skill" ? "skills" : "projects"}${modal.item?.id ? "/" + modal.item.id : ""}`,
                        { value, revision: data.revision },
                      ),
                    "已保存到源配置，预览后部署",
                  );
                  setModal(null);
                }}
              />
            )}
            {modal.type === "scan" && (
              <div className="scan-body">
                <p className="modal-intro">
                  导入会复制完整 Skill
                  包到中央库。已有原生文件不会因此被覆盖；同名部署冲突会在预览中显示。
                </p>
                <ImportForm
                  data={data}
                  busy={busy}
                  submit={async (p, scope, adopt) => {
                    await act(
                      () =>
                        api("import", {
                          path: p,
                          scope,
                          adopt,
                          revision: data.revision,
                        }),
                      "Skill 已导入中央库",
                    );
                    setScan(await api("inspect"));
                  }}
                />
                <div className="scan-heading">
                  <h3>
                    本机发现 <span>{scan?.skills.length || 0}</span>
                  </h3>
                  <button
                    className="text-button"
                    onClick={() =>
                      fire(async () => setScan(await api("inspect")))
                    }
                  >
                    重新扫描
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div className="scan-list">
                  {scan?.skills.map((s) => {
                    const imported = manifest.skills.some(
                      (x) => x.name === s.name,
                    );
                    return (
                      <div className="scan-row" key={s.key}>
                        <span className="skill-tile small">
                          <Box size={17} />
                        </span>
                        <div>
                          <strong>
                            {s.name}
                            {!s.valid && (
                              <span className="invalid">格式待修复</span>
                            )}
                          </strong>
                          <code title={s.path}>
                            {s.path.replace(device.home, "~")}
                          </code>
                          {s.error && (
                            <small className="invalid">{s.error}</small>
                          )}
                        </div>
                        <button
                          className="button small"
                          disabled={busy || imported || !s.valid || s.managed}
                          onClick={() =>
                            fire(async () => {
                              await api("import", {
                                path: s.path,
                                scope: {
                                  kind: "global",
                                  harnesses: [...harnessIds],
                                },
                                revision: data.revision,
                              });
                            }, "已导入；原目录保持不变")
                          }
                        >
                          {imported ? (
                            <>
                              <Check size={13} />
                              已入库
                            </>
                          ) : s.managed ? (
                            "已管理"
                          ) : (
                            <>
                              <Plus size={13} />
                              导入
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {modal.type === "confirm" && (
              <div className="confirm-body">
                <p>{modal.item.text}</p>
                <div className="form-footer">
                  <button className="button" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      fire(async () => {
                        await modal.item.action();
                        setModal(null);
                      }, "操作已完成")
                    }
                  >
                    {busy ? <Loader2 size={14} className="spin" /> : null}
                    确认操作
                  </button>
                </div>
              </div>
            )}
            {modal.type === "variables" && (
              <div className="variables-help">
                <p>在指令正文中使用双花括号。缺失变量会阻止部署。</p>
                {[
                  ["{{device.name}}", "当前设备名称"],
                  ["{{device.home}}", "当前用户主目录"],
                  ["{{device.id}}", "稳定的本机 ID"],
                  ["{{project.name}}", "项目显示名称，仅项目指令"],
                  ["{{project.path}}", "项目本机目录，仅项目指令"],
                  ["{{vars.KEY}}", "设备与变量页面中的自定义变量"],
                ].map(([key, value]) => (
                  <div key={key}>
                    <code>{key}</code>
                    <span>{value}</span>
                  </div>
                ))}
                <p className="footnote">
                  第一版只解析指令变量，Skill 文件与资源保持原样。
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      {planOpen && (
        <PlanDrawer
          plan={data.plan}
          busy={busy}
          close={() => setPlanOpen(false)}
          apply={async () => {
            await act(
              () => api("apply", { planId: data.plan.id }),
              "部署完成，原生文件已更新",
            );
            setPlanOpen(false);
          }}
        />
      )}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof Box;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function ScopeFields({
  value,
  onChange,
  data,
  projectInstruction = false,
}: {
  value: Scope;
  onChange: (s: Scope) => void;
  data: Snapshot;
  projectInstruction?: boolean;
}) {
  return (
    <>
      <div className="form-row">
        <label>
          适用范围
          <select
            value={value.kind}
            onChange={(e) =>
              onChange({
                ...value,
                kind: e.target.value as Scope["kind"],
                target:
                  e.target.value === "device"
                    ? data.device.id
                    : e.target.value === "project"
                      ? data.manifest.projects[0]?.id
                      : undefined,
                harnesses:
                  projectInstruction && e.target.value === "project"
                    ? [...harnessIds]
                    : value.harnesses,
              })
            }
          >
            <option value="global">全局共享</option>
            <option value="device">当前设备专属</option>
            <option value="project" disabled={!data.manifest.projects.length}>
              项目专属{!data.manifest.projects.length ? "（请先添加项目）" : ""}
            </option>
          </select>
        </label>
        {value.kind === "project" && (
          <label>
            项目
            <select
              value={value.target || ""}
              onChange={(e) => onChange({ ...value, target: e.target.value })}
            >
              {data.manifest.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <fieldset className="harness-options">
        <legend>部署到 Harness</legend>
        {harnessIds.map((h) => (
          <label key={h}>
            <input
              type="checkbox"
              checked={value.harnesses.includes(h)}
              disabled={false}
              onChange={(e) =>
                onChange({
                  ...value,
                  harnesses: e.target.checked
                    ? [...value.harnesses, h]
                    : value.harnesses.filter((x) => x !== h),
                })
              }
            />
            <HarnessIcon id={h} small />
            {harnessNames[h]}
          </label>
        ))}
      </fieldset>
      {projectInstruction && value.kind === "project" && (
        <small className="muted">
          DeepSeek、OpenCode、Codex 共用项目 AGENTS.md；Claude Code 使用独立
          CLAUDE.md。
        </small>
      )}
    </>
  );
}
function Editor({
  type,
  item,
  data,
  busy,
  submit,
  onDelete,
}: {
  type: string;
  item?: any;
  data: Snapshot;
  busy: boolean;
  submit: (value: any) => Promise<void>;
  onDelete?: () => void;
}) {
  const [value, setValue] = useState<any>(
    item ||
      (type === "project"
        ? { name: "", path: "" }
        : {
            name: "",
            title: "",
            description: "",
            body: "",
            enabled: true,
            scope: { kind: "global", harnesses: [...harnessIds] },
          }),
  );
  const [formError, setFormError] = useState("");
  const update = (key: string, v: any) => setValue({ ...value, [key]: v });
  return (
    <form
      className="editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        setFormError("");
        void submit(value).catch((e) => setFormError(e.message));
      }}
    >
      <label>
        {type === "rule"
          ? "片段名称"
          : type === "skill"
            ? "技能名称"
            : "项目名称"}
        <input
          autoFocus
          required
          value={type === "rule" ? value.title : value.name}
          placeholder={
            type === "skill"
              ? "例如 review-code"
              : type === "rule"
                ? "例如 编码与验证约定"
                : "例如 Date Match"
          }
          pattern={type === "skill" ? "[a-z0-9]+(-[a-z0-9]+)*" : undefined}
          maxLength={type === "skill" ? 64 : 120}
          onChange={(e) =>
            update(type === "rule" ? "title" : "name", e.target.value)
          }
        />
      </label>
      {type === "skill" && (
        <label>
          描述与触发条件
          <textarea
            required
            rows={2}
            value={value.description}
            placeholder="这个技能做什么？用户提出什么任务时使用？"
            onChange={(e) => update("description", e.target.value)}
          />
        </label>
      )}
      {type === "project" ? (
        <>
          <label>
            本机项目目录
            <input
              value={
                value.path ?? (item ? data.device.bindings[item.id] || "" : "")
              }
              placeholder="/Users/you/projects/my-project"
              onChange={(e) => update("path", e.target.value)}
            />
          </label>
          <p className="hint">
            可暂不绑定。目录绑定保存在本机，项目名称与稳定 ID 属于源配置。
          </p>
          {item && <code className="id-line">{item.id}</code>}
        </>
      ) : (
        <>
          <ScopeFields
            value={value.scope}
            onChange={(s) => update("scope", s)}
            data={data}
            projectInstruction={type === "rule"}
          />
          <label>
            {type === "skill" ? "Skill 正文 · Markdown" : "指令正文 · Markdown"}
            <textarea
              className="code-editor"
              required
              rows={type === "skill" ? 10 : 8}
              value={value.body}
              placeholder={
                type === "skill"
                  ? "# Workflow\n\n1. Inspect the relevant files.\n2. ..."
                  : "请使用中文回复。\n\n当前设备：{{device.name}}\n工作目录：{{vars.WORKSPACE}}"
              }
              onChange={(e) => update("body", e.target.value)}
            />
          </label>
          {type === "skill" && (
            <p className="hint">
              编辑正文会保留已有 Skill 的脚本、资源和额外
              frontmatter。需要新增资源时使用目录导入。
            </p>
          )}
        </>
      )}
      {formError && (
        <p role="alert" className="form-error">
          {formError}
        </p>
      )}
      <div className="form-footer">
        {onDelete && (
          <button
            type="button"
            className="text-button danger"
            onClick={onDelete}
          >
            <Trash2 size={14} />
            移除片段
          </button>
        )}
        <span className="hint">保存源配置后，预览并部署。</span>
        <button
          className="button primary"
          type="submit"
          disabled={
            busy || (type !== "project" && !value.scope.harnesses.length)
          }
        >
          {busy && <Loader2 size={14} className="spin" />}保存
          {type === "project" ? "项目" : "配置"}
          <Check size={14} />
        </button>
      </div>
    </form>
  );
}
function ImportForm({
  data,
  busy,
  submit,
}: {
  data: Snapshot;
  busy: boolean;
  submit: (path: string, scope: Scope, adopt: boolean) => Promise<void>;
}) {
  const [p, setP] = useState("");
  const [adopt, setAdopt] = useState(false);
  const [scope, setScope] = useState<Scope>({
    kind: "global",
    harnesses: [...harnessIds],
  });
  const [error, setError] = useState("");
  return (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        void submit(p, scope, adopt)
          .then(() => setP(""))
          .catch((e) => setError(e.message));
      }}
    >
      <label>
        从本地目录导入
        <div className="input-action">
          <input
            required
            value={p}
            onChange={(e) => setP(e.target.value)}
            placeholder="包含 SKILL.md 的完整目录路径"
          />
          <button
            className="button dark"
            disabled={busy || !scope.harnesses.length}
          >
            <ArrowDownToLine size={14} />
            导入目录
          </button>
        </div>
      </label>
      <ScopeFields value={scope} onChange={setScope} data={data} />
      <label className="adopt-option">
        <input
          type="checkbox"
          checked={adopt}
          onChange={(e) => setAdopt(e.target.checked)}
        />
        同时接管这个已有原生目录，允许后续更新或撤下
      </label>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
function DeviceSettings({
  data,
  busy,
  save,
}: {
  data: Snapshot;
  busy: boolean;
  save: (value: any) => Promise<void>;
}) {
  const [name, setName] = useState(data.device.name);
  const [variables, setVariables] = useState(
    Object.entries(data.device.variables).map(([key, value]) => ({
      key,
      value,
    })),
  );
  const [err, setErr] = useState("");
  return (
    <form
      className="device-layout"
      onSubmit={(e) => {
        e.preventDefault();
        setErr("");
        const keys = variables.map((v) => v.key);
        if (new Set(keys).size !== keys.length)
          return setErr("变量名称不能重复");
        void save({
          name,
          variables: Object.fromEntries(variables.map((v) => [v.key, v.value])),
        }).catch((e) => setErr(e.message));
      }}
    >
      <section className="panel settings-card">
        <div className="settings-card-title">
          <Monitor size={19} />
          <div>
            <h2>当前设备</h2>
            <p>稳定身份用于匹配设备专属的指令和 Skills。</p>
          </div>
        </div>
        <label>
          设备名称
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="key-value">
          <span>设备 ID</span>
          <code>{data.device.id}</code>
        </div>
        <div className="key-value">
          <span>用户目录</span>
          <code>{data.device.home}</code>
        </div>
        <div className="key-value">
          <span>配置库</span>
          <code>{data.root}</code>
        </div>
      </section>
      <section className="panel settings-card">
        <div className="settings-card-title">
          <SlidersHorizontal size={19} />
          <div>
            <h2>本机变量</h2>
            <p>
              指令中使用 <code>{"{{vars.KEY}}"}</code>，部署时替换。
            </p>
          </div>
          <button
            className="button small"
            type="button"
            onClick={() => setVariables([...variables, { key: "", value: "" }])}
          >
            <Plus size={13} />
            添加变量
          </button>
        </div>
        {variables.length ? (
          variables.map((v, i) => (
            <div className="variable-row" key={i}>
              <input
                aria-label={`变量名 ${i + 1}`}
                required
                pattern="[a-zA-Z][a-zA-Z0-9_]*"
                placeholder="WORKSPACE"
                value={v.key}
                onChange={(e) =>
                  setVariables(
                    variables.map((x, j) =>
                      i === j ? { ...x, key: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                aria-label={`变量值 ${i + 1}`}
                placeholder="变量值"
                value={v.value}
                onChange={(e) =>
                  setVariables(
                    variables.map((x, j) =>
                      i === j ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                className="icon-button"
                type="button"
                aria-label={`删除变量 ${i + 1}`}
                onClick={() =>
                  setVariables(variables.filter((_, j) => i !== j))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <div className="variable-empty">
            还没有自定义变量。设备名称与主目录可以直接引用。
          </div>
        )}
        <p className="hint">
          变量保存在本机，不进入源配置 Git 仓库。请勿将凭证写入最终会被 AI
          读取的指令。
        </p>
      </section>
      {err && <p className="form-error">{err}</p>}
      <div className="settings-save">
        <button className="button primary" disabled={busy}>
          <Check size={15} />
          保存设备设置
        </button>
      </div>
    </form>
  );
}
function PlanDrawer({
  plan,
  busy,
  close,
  apply,
}: {
  plan: Plan;
  busy: boolean;
  close: () => void;
  apply: () => Promise<void>;
}) {
  const changed = plan.changes.filter((c) => c.status !== "unchanged");
  const [selected, setSelected] = useState<Change | null>(
    changed[0] || plan.changes[0] || null,
  );
  const [error, setError] = useState("");
  const conflicts = plan.changes.filter((c) => c.status === "conflict");
  const labels = {
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
            {plan.changes.length ? (
              plan.changes.map((c) => (
                <button
                  key={c.path}
                  className={selected?.path === c.path ? "selected" : ""}
                  onClick={() => setSelected(c)}
                >
                  <span className={`change-tag ${c.status}`}>
                    {labels[c.status]}
                  </span>
                  <div>
                    <strong>{c.path.split("/").slice(-1)[0]}</strong>
                    <small title={c.path}>{c.path}</small>
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
                  <code>{selected.path}</code>
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
                  {selected.reason}
                </div>
                {selected.status === "conflict" ? (
                  <div className="conflict-detail">
                    <h3>保留文件，先解决来源差异</h3>
                    <p>
                      已有内容不会被覆盖。可以在技能库中使用不同名称，或将外部修改整理到源配置；已管理文件可通过部署历史安全恢复。
                    </p>
                  </div>
                ) : (
                  <pre className="diff-code">
                    {selected.diff ? (
                      selected.diff.split("\n").map((line, i) => (
                        <span
                          key={i}
                          className={
                            line.startsWith("+")
                              ? "added"
                              : line.startsWith("-")
                                ? "removed"
                                : line.startsWith("@@")
                                  ? "range"
                                  : ""
                          }
                        >
                          {line || " "}
                          <br />
                        </span>
                      ))
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

createRoot(document.getElementById("root")!).render(<App />);
