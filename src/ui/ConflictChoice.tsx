import React, { useState } from "react";
import {
  ArrowDownToLine,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  SkipForward,
  Undo2,
  Upload,
} from "lucide-react";
import type { Change } from "../shared/types.ts";

export type ConflictUse = "library" | "native" | "skip";
type FileChange = NonNullable<Change["fileChanges"]>[number];

const options: {
  use: ConflictUse;
  title: string;
  text: string;
  icon: typeof Upload;
}[] = [
  {
    use: "library",
    title: "用技能库版本覆盖",
    text: "原目录完整存进部署快照，回滚即可恢复。",
    icon: ArrowDownToLine,
  },
  {
    use: "native",
    title: "把本机版本收进技能库",
    text: "立即用这个目录更新库中的技能，之后按原样接管，不改写文件。",
    icon: Upload,
  },
  {
    use: "skip",
    title: "这次先跳过",
    text: "不碰这个目录，其余变更照常部署。",
    icon: SkipForward,
  },
];

const chosen: Partial<Record<Change["status"], ConflictUse>> = {
  replace: "library",
  skipped: "skip",
};

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function ConflictChoice({
  change,
  busy,
  choose,
}: {
  change: Change;
  busy: boolean;
  choose: (use: ConflictUse | null) => void;
}) {
  const current = chosen[change.status];
  const [pending, setPending] = useState<ConflictUse | null>(null);
  const allowed = new Set(change.conflictOptions || []);
  const pick = (use: ConflictUse | null) => {
    setPending(use);
    choose(use);
  };
  return (
    <div className="conflict-choice">
      <div className="conflict-choice-head">
        <h3>
          {current
            ? current === "library"
              ? "将用技能库版本覆盖"
              : "这次跳过这个目录"
            : "本机已有同名目录，内容不同"}
        </h3>
        <p>
          {current
            ? "这个选择只在本机生效。目录之后若再被修改，选择会自动作废，需要重新确认。"
            : "HarnessSync 不会擅自覆盖它。选一种处理方式，计划会立即重新生成。"}
        </p>
      </div>
      <div className="conflict-options" role="radiogroup">
        {options
          .filter((o) => allowed.has(o.use))
          .map((o) => (
            <button
              key={o.use}
              role="radio"
              aria-checked={current === o.use}
              className={current === o.use ? "selected" : ""}
              disabled={busy}
              onClick={() => pick(current === o.use ? null : o.use)}
            >
              <span className="conflict-option-icon">
                {busy && pending === o.use ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <o.icon size={15} />
                )}
              </span>
              <span>
                <strong>{o.title}</strong>
                <small>{o.text}</small>
              </span>
            </button>
          ))}
      </div>
      {current && (
        <button
          className="conflict-reset"
          disabled={busy}
          onClick={() => pick(null)}
        >
          <Undo2 size={13} />
          撤销选择，恢复为冲突
        </button>
      )}
      {change.fileChanges && change.fileChanges.length > 0 && (
        <FileChanges files={change.fileChanges} />
      )}
    </div>
  );
}

function FileChanges({ files }: { files: FileChange[] }) {
  const [open, setOpen] = useState<string | null>(
    files.find((f) => f.diff)?.path || null,
  );
  const label = { added: "库中新增", removed: "将删除", modified: "不同" };
  return (
    <div className="file-changes">
      <h4>
        覆盖时的逐文件差异 <span>{files.length}</span>
      </h4>
      {files.map((f) => (
        <div key={f.path} className="file-change">
          <button
            className="file-change-row"
            disabled={!f.diff}
            aria-expanded={open === f.path}
            onClick={() => setOpen(open === f.path ? null : f.path)}
          >
            {f.beforeLink !== undefined ? (
              <Link2 size={13} />
            ) : (
              <FileText size={13} />
            )}
            <code>{f.path}</code>
            <span className={`file-status ${f.status}`}>{label[f.status]}</span>
            <small>
              {f.binary
                ? `二进制 · ${size(f.beforeSize)} → ${size(f.afterSize)}`
                : f.beforeLink !== undefined
                  ? `链接 → ${f.beforeLink}`
                  : `${size(f.beforeSize)} → ${size(f.afterSize)}`}
            </small>
            {f.diff && (
              <ChevronRight
                size={13}
                className={open === f.path ? "rotated" : ""}
              />
            )}
          </button>
          {open === f.path && f.diff && (
            <pre className="diff-code compact">
              {f.diff
                .split("\n")
                .filter(
                  (line) => !line.startsWith("Index: ") && !/^=+$/.test(line),
                )
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
                    {line.startsWith("--- ")
                      ? "--- 本机目录"
                      : line.startsWith("+++ ")
                        ? "+++ 技能库"
                        : line || " "}
                  </span>
                ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
