import React from "react";
import { ArrowRight, ArrowUpRight, FileText, Plus, Trash2 } from "lucide-react";
import { useApp } from "../app-context.tsx";
import { Empty, HarnessIcon, ScopeLabel } from "../common.tsx";
import { harnessName } from "../lib.ts";
export function Instructions() {
  const { data, busy, fire, api, setModal, remove, scopeText } = useApp();
  const { manifest } = data;
  return (
    <>
      <div className="info-strip">
        <FileText size={17} />
        <span>
          指令以片段组合，写入各 AI 工具
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
          指令片段 <span className="count-badge">{manifest.rules.length}</span>
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
                {r.scope.harnesses.map((h) => harnessName(data, h)).join(" + ")}
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
  );
}
