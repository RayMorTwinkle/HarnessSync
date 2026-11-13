import React from "react";
import { ArrowRight, Folder, Plus, Trash2 } from "lucide-react";
import { useApp } from "../app-context.tsx";
import { Empty, HarnessIcon, ScopeLabel } from "../common.tsx";
export function Projects() {
  const { data, setModal, remove } = useApp();
  const { manifest, device } = data;
  return (
    <>
      <div className="section-heading list-heading">
        <h2>
          逻辑项目{" "}
          <span className="count-badge">{manifest.projects.length}</span>
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
                    manifest.skills.filter((s) => s.scope.target === p.id)
                      .length
                  }{" "}
                  个技能
                </span>
                <span>
                  {manifest.rules.filter((r) => r.scope.target === p.id).length}{" "}
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
  );
}
