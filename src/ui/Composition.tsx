import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { useApp } from "./app-context.tsx";
import { HarnessIcon } from "./common.tsx";
import { api, harnessName } from "./lib.ts";

type SegmentKind =
  | "native"
  | "shared"
  | "harness"
  | "device"
  | "project"
  | "frame";
type Part = { type: "text" | "variable"; text: string; key?: string };
type Segment = {
  kind: SegmentKind;
  ruleId?: string;
  title?: string;
  harnesses?: string[];
  bytes: number;
  parts: Part[];
};
type Output = {
  path: string;
  harnesses: string[];
  projectId?: string;
  exists: boolean;
  pending: boolean;
  bytes: number;
  totals: Record<string, number>;
  segments: Segment[];
  error?: string;
};
type SkillFileKind =
  | "instructions"
  | "script"
  | "reference"
  | "asset"
  | "credential"
  | "other";
type SkillComposition = {
  id: string;
  name: string;
  bytes: number;
  totals: Record<string, number>;
  files: {
    path: string;
    bytes: number;
    kind: SkillFileKind;
    executable: boolean;
    variables: string[];
    syncIgnored: boolean;
  }[];
};
type Legend = { key: string; label: string; hint: string }[];

// Bar order runs from what the user owns to what HarnessSync adds around it.
const instructionLegend: Legend = [
  { key: "native", label: "本机原文", hint: "文件里不归 HarnessSync 管理的文字" },
  { key: "shared", label: "共享", hint: "所有工具都收到的片段" },
  { key: "harness", label: "工具专用", hint: "只发给部分工具的片段" },
  { key: "project", label: "项目专用", hint: "只在这个项目生效" },
  { key: "device", label: "本机专用", hint: "只在这台设备生效" },
  { key: "variable", label: "变量", hint: "每台设备各自填写的值" },
  { key: "frame", label: "结构", hint: "标记行与片段标题" },
];
const skillLegend: Legend = [
  { key: "instructions", label: "SKILL.md", hint: "技能说明正文" },
  { key: "variable", label: "变量", hint: "部署时按本机变量替换" },
  { key: "script", label: "脚本", hint: "可执行文件与代码" },
  { key: "reference", label: "参考资料", hint: "文档与文本" },
  { key: "asset", label: "资源", hint: "图片、字体等二进制文件" },
  { key: "credential", label: "凭证", hint: "密钥、令牌等文件" },
  { key: "other", label: "其他", hint: "" },
];

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const share = (n: number, total: number) =>
  total ? `${Math.max(1, Math.round((n / total) * 100))}%` : "0%";

export function CompositionBar({
  totals,
  legend,
  onPick,
  large = false,
}: {
  totals: Record<string, number>;
  legend: Legend;
  onPick?: (key: string) => void;
  large?: boolean;
}) {
  const total = legend.reduce((sum, l) => sum + (totals[l.key] || 0), 0);
  return (
    <span className={`compo-bar ${large ? "large" : ""}`} aria-hidden={!onPick}>
      {total === 0 && <span className="compo-empty" />}
      {legend
        .filter((l) => totals[l.key] > 0)
        .map((l) => {
          const title = `${l.label} · ${bytes(totals[l.key])} · ${share(totals[l.key], total)}`;
          const style = { flexGrow: totals[l.key] };
          return onPick ? (
            <button
              type="button"
              key={l.key}
              className={`compo-seg k-${l.key}`}
              style={style}
              title={title}
              aria-label={title}
              onClick={() => onPick(l.key)}
            />
          ) : (
            <span
              key={l.key}
              className={`compo-seg k-${l.key}`}
              style={style}
              title={title}
            />
          );
        })}
    </span>
  );
}

function CompositionLegend({
  totals,
  legend,
}: {
  totals: Record<string, number>;
  legend: Legend;
}) {
  const total = legend.reduce((sum, l) => sum + (totals[l.key] || 0), 0);
  return (
    <ul className="compo-legend">
      {legend
        .filter((l) => totals[l.key] > 0)
        .map((l) => (
          <li key={l.key} title={l.hint}>
            <i className={`compo-dot k-${l.key}`} />
            <b>{l.label}</b>
            <span>{share(totals[l.key], total)}</span>
          </li>
        ))}
    </ul>
  );
}

function outputTitle(output: Output, projectName?: string) {
  const file = output.path.split("/").pop();
  return output.projectId ? `${projectName || "项目"} · ${file}` : `全局 · ${file}`;
}

// What each tool actually reads: the user's own text plus HarnessSync's block,
// split by where every piece comes from.
export function InstructionComposition() {
  const { data } = useApp();
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api<{ outputs: Output[] }>("composition/instructions")
      .then((r) => current && setOutputs(r.outputs))
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [data.revision]);
  const home = data.device.home;
  const projects = new Map(data.manifest.projects.map((p) => [p.id, p.name]));
  return (
    <section className="panel compo-panel">
      <header className="compo-head">
        <h2>各工具收到的指令</h2>
        <span>每份原生文件由哪些部分组成</span>
      </header>
      {error && <p className="compo-note">{error}</p>}
      {!outputs && !error && (
        <p className="compo-note">
          <Loader2 size={13} className="spin" />
          读取中…
        </p>
      )}
      {outputs && !outputs.length && (
        <p className="compo-note">还没有需要写入的指令文件。</p>
      )}
      <div className="compo-rows">
        {outputs?.map((o) => {
          const expanded = open === o.path;
          return (
            <div className={`compo-row ${expanded ? "open" : ""}`} key={o.path}>
              <button
                type="button"
                className="compo-row-main"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : o.path)}
              >
                <span className="compo-icons">
                  {o.harnesses.map((h) => (
                    <HarnessIcon id={h} small key={h} />
                  ))}
                </span>
                <span className="compo-name">
                  <b>{outputTitle(o, projects.get(o.projectId || ""))}</b>
                  <span>
                    {o.harnesses.map((h) => harnessName(data, h)).join("、")}
                  </span>
                </span>
                <CompositionBar totals={o.totals} legend={instructionLegend} />
                <span className="compo-size">
                  {o.error ? (
                    <span className="compo-flag warn">
                      <TriangleAlert size={12} />
                      无法生成
                    </span>
                  ) : o.pending ? (
                    <span className="compo-flag">待部署</span>
                  ) : !o.exists ? (
                    <span className="compo-flag muted">未创建</span>
                  ) : null}
                  {bytes(o.bytes)}
                </span>
                <ChevronDown size={14} className="compo-chevron" />
              </button>
              {expanded && (
                <OutputDetail output={o} home={home} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OutputDetail({ output, home }: { output: Output; home: string }) {
  const { data } = useApp();
  const body = useRef<HTMLDivElement>(null);
  const pick = (kind: string) => {
    const target = body.current?.querySelector<HTMLElement>(
      kind === "variable" ? ".compo-var" : `.compo-block.k-${kind}`,
    );
    if (!target) return;
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  };
  const label = (s: Segment) => {
    const name = instructionLegend.find((l) => l.key === s.kind)?.label;
    if (s.kind === "harness" && s.harnesses)
      return `${s.harnesses.map((h) => harnessName(data, h)).join(" + ")} 专用`;
    return name;
  };
  return (
    <div className="compo-detail">
      <div className="compo-detail-top">
        <CompositionBar
          totals={output.totals}
          legend={instructionLegend}
          onPick={pick}
          large
        />
        <CompositionLegend totals={output.totals} legend={instructionLegend} />
        <code className="compo-path">{output.path.replace(home, "~")}</code>
        {output.error && <p className="compo-error">{output.error}</p>}
      </div>
      <div className="compo-file" ref={body}>
        {output.segments.map((s, i) =>
          s.kind === "frame" ? (
            <pre className="compo-block k-frame" key={i}>
              {s.parts.map((p) => p.text).join("")}
            </pre>
          ) : (
            <div className={`compo-block k-${s.kind}`} key={i}>
              <span className="compo-tag">
                {label(s)}
                {s.title && <em>{s.title}</em>}
              </span>
              <pre>
                {s.parts.map((p, j) =>
                  p.type === "variable" ? (
                    <mark className="compo-var" key={j} title={`{{${p.key}}}`}>
                      {p.text}
                    </mark>
                  ) : (
                    <React.Fragment key={j}>{p.text}</React.Fragment>
                  ),
                )}
              </pre>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

const kindLabel = Object.fromEntries(skillLegend.map((l) => [l.key, l.label]));

export function SkillCompositionView({ id }: { id: string }) {
  const [value, setValue] = useState<SkillComposition | null>(null);
  const [error, setError] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [saving, setSaving] = useState("");
  useEffect(() => {
    let current = true;
    api<SkillComposition>(`composition/skills/${id}`)
      .then((r) => current && setValue(r))
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [id]);
  // Upload-only ignore: the file stays deployed here, it just never reaches the repository.
  const toggleUpload = (file: string, ignored: boolean) => {
    const rule = `${value!.name}/${file}`;
    setSaving(file);
    api("sync/ignore", ignored ? { remove: [rule] } : { add: [rule] })
      .then(() => api<SkillComposition>(`composition/skills/${id}`))
      .then(setValue)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(""));
  };
  if (error) return <p className="hint">{error}</p>;
  if (!value) return null;
  const credentials = value.files.filter((f) => f.kind === "credential");
  return (
    <div className="skill-compo">
      <div className="skill-compo-top">
        <span>技能包组成</span>
        <span>
          {value.files.length} 个文件 · {bytes(value.bytes)}
        </span>
      </div>
      <CompositionBar totals={value.totals} legend={skillLegend} large />
      <CompositionLegend totals={value.totals} legend={skillLegend} />
      {credentials.length > 0 && (
        <p className="skill-compo-note">
          <KeyRound size={13} />
          含 {credentials.length} 个凭证文件，
          {credentials.every((f) => f.syncIgnored)
            ? "只留在本机，不上传"
            : "会随技能同步到你的私有仓库"}
        </p>
      )}
      <button
        type="button"
        className="text-button"
        aria-expanded={showFiles}
        onClick={() => setShowFiles(!showFiles)}
      >
        {showFiles ? "收起文件" : "查看文件"}
        <ChevronDown size={13} className={showFiles ? "flip" : ""} />
      </button>
      {showFiles && (
        <ul className="skill-compo-files">
          {value.files.map((f) => (
            <li key={f.path}>
              <i className={`compo-dot k-${f.kind}`} title={kindLabel[f.kind]} />
              <code>{f.path}</code>
              {f.executable && <span className="compo-flag muted">可执行</span>}
              {f.kind === "credential" ? (
                <button
                  type="button"
                  className={`compo-upload ${f.syncIgnored ? "" : "on"}`}
                  disabled={saving === f.path}
                  title={
                    f.syncIgnored
                      ? "只留在本机；点击后随技能同步"
                      : "会同步到私有仓库；点击后只留在本机"
                  }
                  onClick={() => toggleUpload(f.path, f.syncIgnored)}
                >
                  {f.syncIgnored ? "只留本机" : "同步"}
                </button>
              ) : (
                f.syncIgnored && <span className="compo-flag muted">不上传</span>
              )}
              {f.variables.map((v) => (
                <span className="compo-flag var" key={v}>
                  {`{{${v}}}`}
                </span>
              ))}
              <span className="skill-compo-size">{bytes(f.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
