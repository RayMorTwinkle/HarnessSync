import React, { useEffect, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Loader2,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useApp } from "./app-context.tsx";
import { time } from "./lib.ts";

type Backup = { dir: string; createdAt: string };
type RestoreChange = {
  path: string;
  status: "unchanged" | "restore" | "remove" | "keep" | "conflict";
  absent?: boolean;
  message: string;
};
type RestorePlan = { id: string; changes: RestoreChange[] };
type UninstallPlan = {
  id: string;
  restore?: RestorePlan;
  installation: { removeProgram: boolean; removeLauncher: boolean };
};
type UninstallResult = {
  backupDir: string;
  libraryDir?: string;
  libraryDeleted: boolean;
  programRemoved: boolean;
  message: string;
};
type Dialog = { type: "restore" } | { type: "uninstall" } | null;

// The baseline backup, putting things back as they were, and leaving cleanly.
// Everything here previews first; nothing runs from a single click.
export function BackupSettings({
  Group,
  Row,
}: {
  Group: React.ComponentType<{
    icon: typeof Archive;
    title: string;
    children: React.ReactNode;
  }>;
  Row: React.ComponentType<{
    title: React.ReactNode;
    text?: React.ReactNode;
    children?: React.ReactNode;
  }>;
}) {
  const { data, api, act, busy } = useApp();
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);
  const load = () =>
    api<Backup[]>("backups")
      .then(setBackups)
      .catch(() => setBackups([]));
  useEffect(() => {
    void load();
  }, []);
  const baseline = backups?.[0];
  const missing = data.notices?.some((n) => n.code === "BACKUP_MISSING");
  const home = data.device.home;
  const shown = baseline
    ? baseline.dir.startsWith(home + "/")
      ? `~${baseline.dir.slice(home.length)}`
      : baseline.dir
    : "";
  return (
    <>
      <Group icon={Archive} title="备份与卸载">
        <Row
          title="使用前的备份"
          text={
            !backups ? (
              "正在读取…"
            ) : !baseline ? (
              "还没有备份。第一次初始化或第一次写入各工具时会自动创建，也可以现在手动创建。"
            ) : (
              <>
                {missing
                  ? "备份文件夹已被移动或删除，恢复暂时不可用。"
                  : `${time(baseline.createdAt)} 保存。只包含 HarnessSync 可能改动的技能目录和指令文件，技能目录内的凭证文件也会保存，仅保存在本机；不含会话记录。`}
                <code className="backup-path">{shown}</code>
              </>
            )
          }
        >
          {baseline && !missing && (
            <button
              className="button small"
              onClick={() =>
                void navigator.clipboard.writeText(baseline.dir).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
              }
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制路径"}
            </button>
          )}
          {(!baseline || missing) && backups && (
            <button
              className="button small"
              disabled={busy}
              onClick={() =>
                void act(() => api("backups", {}), "备份已保存到下载目录").then(
                  load,
                )
              }
            >
              <Archive size={13} />
              新建备份
            </button>
          )}
        </Row>
        <Row
          title="恢复到使用前"
          text="撤下 HarnessSync 写入的内容，原有文件变回备份时的样子。你之后自己新增的内容会保留。恢复前会再存一份当前状态。"
        >
          <button
            className="button small"
            disabled={!baseline || missing}
            onClick={() => setDialog({ type: "restore" })}
          >
            <RotateCcw size={13} />
            预览恢复
          </button>
        </Row>
        <Row
          title="卸载 HarnessSync"
          text="停止后台运行，移除装进各工具的管理技能和程序。你的配置库会导出一份可读副本到备份文件夹。"
        >
          <button
            className="button small danger"
            disabled={!baseline || missing}
            onClick={() => setDialog({ type: "uninstall" })}
          >
            <Trash2 size={13} />
            卸载…
          </button>
        </Row>
      </Group>
      {dialog && (
        <BackupDialog
          type={dialog.type}
          close={() => setDialog(null)}
          shownBackup={shown}
        />
      )}
    </>
  );
}

const groups: {
  title: string;
  match: (c: RestoreChange) => boolean;
}[] = [
  {
    title: "撤下 HarnessSync 写入的",
    match: (c) =>
      c.status === "remove" || (c.status === "restore" && !!c.absent),
  },
  {
    title: "恢复成备份时的样子",
    match: (c) => c.status === "restore" && !c.absent,
  },
  { title: "你后来新增的，保留", match: (c) => c.status === "keep" },
  {
    title: "备份之后改过，默认保留现状",
    match: (c) => c.status === "conflict",
  },
];

function BackupDialog({
  type,
  close,
  shownBackup,
}: {
  type: "restore" | "uninstall";
  close: () => void;
  shownBackup: string;
}) {
  const { api, act, busy, data } = useApp();
  const home = data.device.home;
  const short = (p: string) =>
    p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
  const [mode, setMode] = useState<"restore" | "keep-files">("restore");
  const [deleteLibrary, setDeleteLibrary] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | UninstallPlan | null>(null);
  const [error, setError] = useState("");
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [done, setDone] = useState<UninstallResult | null>(null);
  useEffect(() => {
    setPlan(null);
    setError("");
    (type === "restore"
      ? api<RestorePlan>("backups/restore-plan", {})
      : api<UninstallPlan>("uninstall-plan", { mode, deleteLibrary })
    )
      .then(setPlan)
      .catch((e) => setError(e.message));
  }, [type, mode, deleteLibrary]);
  const restore =
    type === "restore"
      ? (plan as RestorePlan | null)
      : (plan as UninstallPlan | null)?.restore;
  const changes = restore?.changes.filter((c) => c.status !== "unchanged");
  const confirm = () =>
    void act(
      async () => {
        if (type === "restore") {
          await api("backups/restore", { planId: plan!.id, overwrite });
          close();
        } else
          setDone(
            await api<UninstallResult>("uninstall", { planId: plan!.id }),
          );
      },
      type === "restore" ? "已恢复到使用前，自动写入已关闭" : undefined,
    ).catch(() => {});
  if (done)
    return (
      <Overlay close={close} title="已卸载">
        <div className="backup-done">
          <Check size={22} />
          <p>HarnessSync 已经停止并移除。这个页面可以关闭了。</p>
          <dl>
            <dt>备份</dt>
            <dd>
              <code>{short(done.backupDir)}</code>
            </dd>
            {done.libraryDir && (
              <>
                <dt>配置库副本</dt>
                <dd>
                  <code>{short(done.libraryDir)}</code>
                </dd>
              </>
            )}
          </dl>
          <p className="backup-note">{done.message}</p>
        </div>
      </Overlay>
    );
  return (
    <Overlay
      close={close}
      title={type === "restore" ? "恢复到使用前" : "卸载 HarnessSync"}
    >
      {type === "uninstall" && (
        <div className="uninstall-options">
          <label className={mode === "restore" ? "selected" : ""}>
            <input
              type="radio"
              checked={mode === "restore"}
              onChange={() => setMode("restore")}
            />
            <span>
              <strong>恢复原状（推荐）</strong>
              <small>各工具回到使用 HarnessSync 之前的样子。</small>
            </span>
          </label>
          <label className={mode === "keep-files" ? "selected" : ""}>
            <input
              type="radio"
              checked={mode === "keep-files"}
              onChange={() => setMode("keep-files")}
            />
            <span>
              <strong>保留现有文件</strong>
              <small>已写入的技能和指令原样留下，只是不再管理。</small>
            </span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteLibrary}
              onChange={(e) => setDeleteLibrary(e.target.checked)}
            />
            同时删除这台电脑上的配置库（副本仍会导出到备份文件夹）
          </label>
        </div>
      )}
      {error ? (
        <p className="backup-error">
          <TriangleAlert size={14} />
          {error}
        </p>
      ) : !plan ? (
        <p className="backup-note">
          <Loader2 size={14} className="spin" /> 正在计算…
        </p>
      ) : changes && changes.length === 0 ? (
        <p className="backup-note">
          各工具的文件与备份一致，没有需要恢复的内容。
        </p>
      ) : (
        changes &&
        groups.map((g) => {
          const items = changes.filter(g.match);
          if (!items.length) return null;
          return (
            <section key={g.title} className="backup-group">
              <h3>
                {g.title} <span>{items.length}</span>
              </h3>
              <ul>
                {items.map((c) => (
                  <li key={c.path}>
                    <code>{short(c.path)}</code>
                    {c.status === "conflict" && type === "restore" && (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={overwrite.includes(c.path)}
                          onChange={(e) =>
                            setOverwrite(
                              e.target.checked
                                ? [...overwrite, c.path]
                                : overwrite.filter((p) => p !== c.path),
                            )
                          }
                        />
                        用备份覆盖
                      </label>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {type === "uninstall" && plan && (
        <p className="backup-note">
          {(plan as UninstallPlan).installation.removeProgram
            ? "会停止后台运行，移除管理技能、hsync 命令和程序文件。"
            : "会停止后台运行并移除管理技能。当前从源码运行，程序文件不删除。"}{" "}
          GitHub 上的同步仓库不会删除。卸载前的状态另存在 {shownBackup}。
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={close}>
          取消
        </button>
        <button
          className={`button ${type === "uninstall" ? "danger-solid" : "primary"}`}
          disabled={!plan || busy}
          onClick={confirm}
        >
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {type === "restore" ? "恢复" : "卸载"}
        </button>
      </div>
    </Overlay>
  );
}

function Overlay({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal backup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-title"
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">HARNESS SYNC</span>
            <h2 id="backup-title">{title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={19} />
          </button>
        </div>
        <div className="modal-body backup-body">{children}</div>
      </section>
    </div>
  );
}
