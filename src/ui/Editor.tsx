import React, { useState } from "react";
import { ArrowDownToLine, Check, Loader2, Trash2 } from "lucide-react";
import type { Snapshot, Skill, Scope } from "../shared/types.ts";
import { ScopeFields } from "./common.tsx";
import { allHarnessIds } from "./lib.ts";
import { SkillCompositionView } from "./Composition.tsx";
export function Editor({
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
            scope: { kind: "global", harnesses: allHarnessIds(data) },
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
          {type === "skill" && item?.id && <SkillCompositionView id={item.id} />}
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
export function ImportForm({
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
    harnesses: allHarnessIds(data),
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
