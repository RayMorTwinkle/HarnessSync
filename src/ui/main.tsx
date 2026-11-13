import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  CheckCircle2,
  Cloud,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  History,
  Layers3,
  LayoutDashboard,
  Monitor,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type { Inspection, Scope, Skill, Snapshot } from "../shared/types.ts";
import "./style.css";
declare const __APP_VERSION__: string;
import { AppearanceMenu } from "./Appearance";
import {
  AppContext,
  type AppContextValue,
  type Modal,
} from "./app-context.tsx";
import {
  api,
  type Page,
  type SettingsData,
  type SettingsPatch,
} from "./lib.ts";
import { Modals } from "./Modals.tsx";
import { OnboardingPanel } from "./OnboardingPanel.tsx";
import { PlanDrawer } from "./PlanDrawer.tsx";
import { gitSource, type UpdateCheck } from "./SkillSources.tsx";
import { SyncPanel } from "./SyncPanel.tsx";
import { DeployStatus } from "./DeployStatus.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { HistoryPage } from "./pages/History.tsx";
import { Instructions } from "./pages/Instructions.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Projects } from "./pages/Projects.tsx";
import { Skills } from "./pages/Skills.tsx";

const navigation: { id: Page; title: string; icon: typeof Box }[] = [
  { id: "overview", title: "工作台", icon: LayoutDashboard },
  { id: "skills", title: "技能库", icon: Box },
  { id: "instructions", title: "全局指令", icon: FileText },
  { id: "projects", title: "项目", icon: Folder },
  { id: "onboarding", title: "首次初始化", icon: Sparkles },
  { id: "sync", title: "跨设备同步", icon: Cloud },
  { id: "history", title: "版本与部署", icon: History },
  { id: "settings", title: "设置", icon: Settings2 },
];
function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [scan, setScan] = useState<Inspection | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateCheck>>({});
  const [updatesChecked, setUpdatesChecked] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const autoDeploy = !!settings?.settings.deploy.auto;
  const refresh = async () => {
    const x = await api<Snapshot>("snapshot");
    setData(x);
    return x;
  };
  const saveSettings = async (patch: SettingsPatch) => {
    setError("");
    try {
      setSettings(await api<SettingsData>("settings", patch, "PUT"));
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    void api<SettingsData>("settings")
      .then(setSettings)
      .catch(() => {});
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
  const gitSkillCount =
    data?.manifest.skills.filter((s) => gitSource(s)).length || 0;
  useEffect(() => {
    // The server checks upstreams on a schedule; this only reads its cache.
    if (page !== "skills" || !gitSkillCount || updatesChecked) return;
    setUpdatesChecked(true);
    api<UpdateCheck[]>("skills/updates")
      .then((list) =>
        setUpdates(Object.fromEntries(list.map((u) => [u.id, u]))),
      )
      .catch(() => {});
  }, [page, gitSkillCount, updatesChecked]);
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
      if (message) setToast(autoDeploy ? deployedHint(message) : message);
      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  // While automatic deployment is on, keep the header status current until the
  // server has written the pending changes (or stopped for review).
  const pendingCount = data
    ? data.plan.changes.filter(
        (c) => !["unchanged", "conflict", "skipped"].includes(c.status),
      ).length
    : 0;
  useEffect(() => {
    if (!autoDeploy || !pendingCount) return;
    const t = setTimeout(() => void refresh().catch(() => {}), 2500);
    return () => clearTimeout(t);
  }, [autoDeploy, pendingCount, data]);
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
      skill.enabled ? "已停用，部署后从各 AI 工具撤下" : "已启用，等待部署",
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
        text: "这会修改源配置，已写入各 AI 工具的副本也会随之撤下。可在版本历史中恢复。",
        action: async () =>
          api(`${type}/${item.id}`, { revision: data.revision }, "DELETE"),
      },
    });
  const context: AppContextValue = {
    data,
    busy,
    autoDeploy,
    api,
    act,
    fire,
    refresh,
    setPage,
    setModal,
    openPlan,
    openScan,
    editSkill,
    changeEnabled,
    remove,
    scopeText,
    updates,
  };
  const breadcrumbs = navigation.find((n) => n.id === page)!;
  return (
    <AppContext.Provider value={context}>
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
              <span className="version">v{__APP_VERSION__}</span>
            </div>
            <button className="device-mini" onClick={() => setPage("settings")}>
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
              工作空间 <ChevronRight size={13} />{" "}
              <span>{breadcrumbs.title}</span>
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
              <AppearanceMenu />
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
                        "把技能、指令和项目习惯，带到你使用的每一个 AI 工具。",
                      skills: "一份技能源，按你的选择写入不同的 AI 工具。",
                      instructions:
                        "组合共享规则与设备差异，让每次会话有一致的起点。",
                      projects:
                        "用项目身份关联配置，目录只是它在这台设备上的位置。",
                      history: "源配置由 Git 留存，原生文件部署可以独立回滚。",
                      settings: "这些偏好只属于这台设备，不会同步到其他设备。",
                      onboarding:
                        "先建立清单与管理入口，再让你常用的 AI 协助整理。",
                      sync: "用你自己的私有 Git 仓库，在多台设备间保持同一套配置。",
                    }[page]
                  }
                </p>
              </div>
              <DeployStatus auto={autoDeploy} />
            </div>
            {page === "onboarding" && (
              <OnboardingPanel
                request={api}
                refresh={refresh}
                sync={data.sync}
                openSync={() => setPage("sync")}
              />
            )}
            {page === "overview" && <Overview />}
            {page === "skills" && <Skills />}
            {page === "instructions" && <Instructions />}
            {page === "projects" && <Projects />}
            {page === "sync" && (
              <SyncPanel
                data={data}
                busy={busy}
                act={act}
                api={api}
                openPlan={openPlan}
              />
            )}
            {page === "history" && <HistoryPage />}
            {page === "settings" && (
              <SettingsPage settings={settings} save={saveSettings} />
            )}
            <footer className="page-footer">
              <span>
                <Layers3 size={13} /> HarnessSync{" "}
                <span className="dot-separator">/</span> 为你的 Agent
                建立共同语言
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
        <Modals
          modal={modal}
          scan={scan}
          setScan={setScan}
          resetUpdates={() => setUpdatesChecked(false)}
        />
        {planOpen && (
          <PlanDrawer
            plan={data.plan}
            home={data.device.home}
            paused={
              autoDeploy && data.autoDeploy?.outcome === "needs-review"
                ? data.autoDeploy.blockers
                : undefined
            }
            busy={busy}
            close={() => setPlanOpen(false)}
            apply={async () => {
              await act(
                () => api("apply", { planId: data.plan.id }),
                "部署完成，原生文件已更新",
              );
              setPlanOpen(false);
            }}
            choose={async (change, use) => {
              await act(
                () =>
                  use
                    ? api("conflicts/choose", {
                        path: change.path,
                        use,
                        fingerprint: change.conflictFingerprint,
                      })
                    : api("conflicts/clear", { path: change.path }),
                use === "native"
                  ? "已把本机版本收进技能库"
                  : use
                    ? "已更新处理方式，计划已重新生成"
                    : "已撤销选择",
              );
            }}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}

// Save messages written for manual deployment ("…，预览后部署") describe the
// wrong next step when the server writes clean changes by itself.
function deployedHint(message: string) {
  return message
    .replace(/已停用，部署后从各 AI 工具撤下$/, "已停用，正在从各工具撤下")
    .replace(/[，,]\s*(请?预览后?部署|等待部署)$/, "，正在写入各工具");
}

createRoot(document.getElementById("root")!).render(<App />);
