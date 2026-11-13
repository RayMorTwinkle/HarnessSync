import React from "react";
import { Box, Check, Loader2, Plus, RefreshCw, X } from "lucide-react";
import type { Inspection } from "../shared/types.ts";
import { useApp, type Modal } from "./app-context.tsx";
import { Editor, ImportForm } from "./Editor.tsx";
import { allHarnessIds } from "./lib.ts";
import { GitInstallDialog, SourceDialog } from "./SkillSources.tsx";
export function Modals({
  modal,
  scan,
  setScan,
  resetUpdates,
}: {
  modal: Modal;
  scan: Inspection | null;
  setScan: (scan: Inspection) => void;
  resetUpdates: () => void;
}) {
  const { data, busy, act, fire, api, setModal, remove, updates } = useApp();
  const { manifest, device } = data;
  if (!modal) return null;
  return (
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
                  git: "从 Git 安装技能",
                  source: `${modal.item?.name} · 上游来源`,
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
                onClick={() => fire(async () => setScan(await api("inspect")))}
              >
                重新扫描
                <RefreshCw size={12} />
              </button>
            </div>
            <div className="scan-list">
              {scan?.skills.map((s) => {
                const imported = manifest.skills.some((x) => x.name === s.name);
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
                      {s.error && <small className="invalid">{s.error}</small>}
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
                              harnesses: allHarnessIds(data),
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
        {modal.type === "git" && (
          <GitInstallDialog
            api={api}
            act={act}
            busy={busy}
            done={() => {
              setModal(null);
              resetUpdates();
            }}
          />
        )}
        {modal.type === "source" && (
          <SourceDialog
            skill={modal.item}
            update={updates[modal.item.id]}
            api={api}
            act={act}
            busy={busy}
            done={() => {
              setModal(null);
              resetUpdates();
            }}
          />
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
  );
}
