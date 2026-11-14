import React, { useEffect, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  TriangleAlert,
} from "lucide-react";
import type { Snapshot, SyncConflict, SyncStatus } from "../shared/types.ts";
import { DiffLines } from "./common.tsx";

type Keep = "local" | "remote" | "both" | "merged";
type FileDifference = {
  path: string;
  status: "added" | "removed" | "modified";
  binary: boolean;
  diff?: string;
};
type ConflictDetail = SyncConflict & {
  name?: string;
  paths: { root: string; merged: string };
  localEntry?: unknown;
  remoteEntry?: unknown;
  summary: FileDifference[];
  metadataDiff: FileDifference[];
  prompt: string;
};
type Api = <T>(route: string, body?: unknown, method?: string) => Promise<T>;

const kindLabel = { rules: "指令", skills: "技能", projects: "项目" };
const fileStatus = {
  added: "仅另一台有",
  removed: "仅本机有",
  modified: "内容不同",
};

const tilde = (home: string, p: string) =>
  home && p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;

// Conflicts are what sync could not decide alone: the same entry with different
// content on two devices. Simple cases are one click; anything that needs the
// two versions combined goes to the user's Agent with a prompt that makes it ask first.
export function SyncConflicts({
  conflicts,
  data,
  api,
  busy,
  run,
}: {
  conflicts: SyncConflict[];
  data: Snapshot;
  api: Api;
  busy: boolean;
  run: (fn: () => Promise<SyncStatus>, message: string) => void;
}) {
  const [details, setDetails] = useState<ConflictDetail[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const key = conflicts.map((c) => c.entryId).join(",");
  useEffect(() => {
    let current = true;
    api<{ conflicts: ConflictDetail[] }>("sync/conflicts")
      .then((r) => current && setDetails(r.conflicts))
      .catch(() => current && setDetails([]));
    return () => {
      current = false;
    };
  }, [key]);
  const prompt = details[0]?.prompt;
  const folder = details[0]
    ? tilde(data.device.home, details[0].paths.root.replace(/\/[^/]+$/, ""))
    : "";
  const resolve = (entryId: string, keep: Keep) =>
    run(
      () => api<SyncStatus>("sync/resolve", { entryId, keep }),
      keep === "merged"
        ? "已使用合并版本，再同步一次即可推送"
        : "冲突已处理，再同步一次即可推送",
    );
  return (
    <section className="panel sync-conflicts">
      <div className="settings-card-title">
        <TriangleAlert size={19} />
        <div>
          <h2>待处理冲突</h2>
          <p>
            同一条目在两台设备上内容不同。处理完之前暂停推送，本机版本保持不动。
          </p>
        </div>
      </div>
      {conflicts.map((c) => (
        <ConflictCard
          key={`${c.kind}-${c.entryId}`}
          conflict={c}
          detail={details.find((d) => d.entryId === c.entryId)}
          data={data}
          busy={busy}
          resolve={(keep) => resolve(c.entryId, keep)}
        />
      ))}
      <div className="conflict-agent">
        <Bot size={17} />
        <div>
          <strong>需要把两边合成一份？交给你的 AI 助手</strong>
          <p>
            复制提示词给 Claude Code、Codex
            等。它会先说明差异、征得你同意，再把结果写进 merged
            文件夹；之后点对应冲突的「使用合并版本」。
          </p>
          {folder && (
            <code title="每个冲突的 local、remote、merged 文件夹都在这里">
              <FolderOpen size={12} />
              {folder}/
            </code>
          )}
          {copyError && <p className="conflict-error">{copyError}</p>}
        </div>
        <button
          className="button small"
          disabled={!prompt}
          onClick={() =>
            void navigator.clipboard
              .writeText(prompt!)
              .then(() => {
                setCopied(true);
                setCopyError("");
                setTimeout(() => setCopied(false), 2400);
              })
              .catch((e) => setCopyError(`复制失败：${e.message}`))
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制提示词"}
        </button>
      </div>
    </section>
  );
}

function ConflictCard({
  conflict,
  detail,
  data,
  busy,
  resolve,
}: {
  conflict: SyncConflict;
  detail?: ConflictDetail;
  data: Snapshot;
  busy: boolean;
  resolve: (keep: Keep) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = data.manifest[conflict.kind] as {
    id: string;
    name?: string;
    title?: string;
  }[];
  const local = list.find(
    (e) => e.id === (conflict.localId || conflict.entryId),
  );
  const label =
    local?.name || local?.title || detail?.name || conflict.entryId.slice(0, 8);
  const remoteGone = detail ? !detail.remoteEntry : false;
  const reason =
    conflict.reason === "name"
      ? "两台设备都有这个名字，内容不同"
      : !local
        ? "本机删除了它，另一台做了修改"
        : remoteGone
          ? "另一台删除了它，本机做了修改"
          : "两台设备都改了它";
  const files = [
    ...(detail?.summary || []),
    ...(detail?.metadataDiff || []).map((d) => ({ ...d, path: "设置项" })),
  ];
  return (
    <div className={`conflict-card ${open ? "open" : ""}`}>
      <div className="conflict-row">
        <button
          className="conflict-toggle"
          aria-expanded={open}
          disabled={!files.length}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} />
          <span className="tiny-tag">{kindLabel[conflict.kind]}</span>
          <strong>{label}</strong>
          <small>
            {reason}
            {files.length > 0 &&
              ` · ${files.length} 处不同${open ? "" : "，点开查看"}`}
          </small>
        </button>
        <div className="conflict-choices">
          <button
            className="button small"
            disabled={busy}
            onClick={() => resolve("local")}
          >
            保留本机
          </button>
          <button
            className="button small"
            disabled={busy}
            onClick={() => resolve("remote")}
          >
            用另一台的
          </button>
          <button
            className="button small"
            disabled={busy || !local || remoteGone}
            title={
              local && !remoteGone
                ? "另一台的版本另存为副本"
                : "一边已删除，无法两者都保留"
            }
            onClick={() => resolve("both")}
          >
            两者都保留
          </button>
          <button
            className="button small"
            disabled={busy}
            title="使用 merged 文件夹里的合并结果"
            onClick={() => resolve("merged")}
          >
            使用合并版本
          </button>
        </div>
      </div>
      {open && (
        <div className="conflict-diffs">
          {files.map((f, i) => (
            <div key={`${f.path}-${i}`} className="diff-pane">
              <div className="diff-heading">
                <code>{f.path}</code>
                <span>{fileStatus[f.status]}</span>
              </div>
              <pre className="diff-code">
                {f.binary || !f.diff ? (
                  <span>二进制文件不同，无法逐行对比</span>
                ) : (
                  <DiffLines diff={f.diff} from="本机" to="另一台设备" />
                )}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
