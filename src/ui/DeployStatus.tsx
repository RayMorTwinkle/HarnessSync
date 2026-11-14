import React from "react";
import { CheckCircle2, Loader2, TriangleAlert, Zap } from "lucide-react";
import { useApp } from "./app-context.tsx";

// With automatic deployment the header shows where things stand instead of a
// "deploy" button: written, being written, or waiting for the user.
export function DeployStatus({ auto }: { auto: boolean }) {
  const { data, busy, openPlan } = useApp();
  const pending = data.plan.changes.filter(
    (c) => !["unchanged", "conflict", "skipped"].includes(c.status),
  ).length;
  const review =
    data.plan.changes.filter((c) => c.status === "conflict").length +
    data.plan.errors.length;
  const last = data.autoDeploy;
  if (!auto)
    return (
      <button className="button primary" disabled={busy} onClick={openPlan}>
        <Zap size={15} />
        预览并部署
        {pending > 0 && <span className="button-count">{pending}</span>}
      </button>
    );
  const stopped =
    pending > 0 &&
    (last?.outcome === "needs-review" || last?.outcome === "failed");
  // Onboarding pauses automatic writes until the user applies the preview once.
  const onboarding = !!data.onboarding && pending > 0;
  const state = onboarding
    ? {
        tone: "warn",
        icon: <TriangleAlert size={15} />,
        text: "初始化中，确认预览后写入",
      }
    : review
      ? {
          tone: "warn",
          icon: <TriangleAlert size={15} />,
          text: `${review} 处需要你确认`,
        }
      : stopped
        ? {
            tone: "warn",
            icon: <TriangleAlert size={15} />,
            text:
              last?.outcome === "failed"
                ? "写入失败，查看详情"
                : `${last?.blockers?.length || pending} 处需要你确认`,
          }
        : pending
          ? {
              tone: "busy",
              icon: <Loader2 size={15} className="spin" />,
              text: "正在写入各工具…",
            }
          : {
              tone: "ok",
              icon: <CheckCircle2 size={15} />,
              text: "各工具已是最新",
            };
  return (
    <button
      className={`deploy-status ${state.tone}`}
      title={
        last?.outcome === "needs-review" && last.blockers?.length
          ? last.blockers.map((b) => b.reason).join("\n")
          : "查看部署详情"
      }
      onClick={openPlan}
    >
      {state.icon}
      {state.text}
    </button>
  );
}
