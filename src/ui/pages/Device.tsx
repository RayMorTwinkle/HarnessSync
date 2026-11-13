import React, { useState } from "react";
import { Check, Monitor, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Snapshot } from "../../shared/types.ts";
export function DeviceSettings({
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
