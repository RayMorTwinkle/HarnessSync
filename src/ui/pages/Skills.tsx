import React, { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  GitBranch,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useApp } from "../app-context.tsx";
import { Empty, HarnessIcon, ScopeLabel } from "../common.tsx";
import { SourceChip, gitSource } from "../SkillSources.tsx";
export function Skills() {
  const {
    data,
    busy,
    setModal,
    openScan,
    editSkill,
    changeEnabled,
    remove,
    updates,
  } = useApp();
  const { manifest } = data;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  return (
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
          <button className="button" onClick={() => setModal({ type: "git" })}>
            <GitBranch size={14} />从 Git 安装
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
              <button className="skill-card-main" onClick={() => editSkill(s)}>
                <h3>{s.displayName || s.name}</h3>
                <p>{s.description}</p>
              </button>
              <div className="skill-card-tags">
                <ScopeLabel scope={s.scope} data={data} />
                {gitSource(s) && (
                  <SourceChip
                    source={gitSource(s)!}
                    update={updates[s.id]}
                    onClick={() => setModal({ type: "source", item: s })}
                  />
                )}
              </div>
              <div className="skill-card-bottom">
                <span className="mini-harnesses">
                  {s.scope.harnesses.map((h) => (
                    <HarnessIcon id={h} small key={h} />
                  ))}
                  <span>
                    {s.scope.harnesses.length >= data.harnesses.length
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
  );
}
