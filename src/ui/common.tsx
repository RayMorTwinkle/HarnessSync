import React from "react";
import { Box, Globe2 } from "lucide-react";
import type { Snapshot, Scope } from "../shared/types.ts";
import { allHarnessIds } from "./lib.ts";
export const ScopeLabel = ({
  scope,
  data,
}: {
  scope: Scope;
  data: Snapshot;
}) => (
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
export const HarnessIcon = ({
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
export function Empty({
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
export function ScopeFields({
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
                    ? allHarnessIds(data)
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
        {data.harnesses.map(({ id: h, name }) => (
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
            {name}
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
// Unified diffs from the core start with Index/=== lines; the file headers are
// relabelled because the raw paths are temp snapshot names.
export function DiffLines({
  diff,
  from,
  to,
}: {
  diff: string;
  from?: string;
  to?: string;
}) {
  return (
    <>
      {diff
        .split("\n")
        .filter((line) => !line.startsWith("Index: ") && !/^=+$/.test(line))
        .map((line, i) => (
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
            {from && line.startsWith("--- ")
              ? `--- ${from}`
              : to && line.startsWith("+++ ")
                ? `+++ ${to}`
                : line || " "}
          </span>
        ))}
    </>
  );
}
