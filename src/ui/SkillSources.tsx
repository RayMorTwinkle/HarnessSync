import React, { useEffect, useState } from "react";
import {
  ArrowUpCircle,
  Check,
  FileText,
  GitBranch,
  Loader2,
  Search,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import type { GitSkillSource, Skill } from "../shared/types.ts";
import { DiffLines } from "./common.tsx";

type Api = <T>(route: string, body?: unknown, method?: string) => Promise<T>;
type Act = (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;

type Candidate = {
  name: string;
  description: string;
  subpath: string;
  error?: string;
};
type InstallResult = {
  selectionRequired: boolean;
  url: string;
  ref: string;
  commit: string;
  candidates: Candidate[];
  installed: Skill[];
};
export type UpdateCheck = {
  id: string;
  name: string;
  checkedAt: string;
  commit: string;
  latestCommit?: string;
  available?: boolean;
  error?: string;
};
type FileDiff = {
  path: string;
  status: "added" | "removed" | "modified";
  binary: boolean;
  diff: string;
};

export const gitSource = (skill: Skill) =>
  typeof skill.source === "object" && skill.source?.type === "git"
    ? (skill.source as GitSkillSource)
    : undefined;

// "https://github.com/owner/repo.git" → "owner/repo"; other hosts keep the path.
export function repoLabel(url: string) {
  const github = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (github) return github[1];
  return url
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(-2)
    .join("/");
}

export function SourceChip({
  source,
  update,
  onClick,
}: {
  source: GitSkillSource;
  update?: UpdateCheck;
  onClick: () => void;
}) {
  const available = update?.available && update.commit === source.commit;
  return (
    <button
      className={`source-chip ${available ? "update" : ""}`}
      title={`${source.url}${source.subpath ? " · " + source.subpath : ""}`}
      onClick={onClick}
    >
      {available ? <ArrowUpCircle size={12} /> : <GitBranch size={12} />}
      <span>{repoLabel(source.url)}</span>
      {available && <strong>有更新</strong>}
    </button>
  );
}

export function GitInstallDialog({
  api,
  act,
  busy,
  done,
}: {
  api: Api;
  act: Act;
  busy: boolean;
  done: () => void;
}) {
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [found, setFound] = useState<InstallResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [looking, setLooking] = useState(false);
  const request = { source: source.trim(), ref: ref.trim() || undefined };

  const lookup = async () => {
    setError("");
    setFound(null);
    setLooking(true);
    try {
      const result = await api<InstallResult>("skills/install", request);
      if (!result.selectionRequired) {
        await act(
          async () => result,
          `已安装 ${result.installed.map((s) => s.name).join("、")}，预览后部署`,
        );
        done();
        return;
      }
      setFound(result);
      setPicked(
        new Set(
          result.candidates.filter((c) => !c.error).map((c) => c.subpath),
        ),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLooking(false);
    }
  };
  const install = () =>
    void act(
      () =>
        api<InstallResult>("skills/install", {
          ...request,
          // Pin the commit the user reviewed, not whatever HEAD is now.
          commit: found!.commit,
          skills: [...picked],
        }),
      `已安装 ${picked.size} 个技能，预览后部署`,
    )
      .then(done)
      .catch((e) => setError(e.message));

  return (
    <div className="editor-form git-install">
      {!found ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          <p className="modal-intro">
            从 GitHub 或任意 Git
            仓库安装技能。来源会记在技能库里，之后可以检查和拉取上游更新；本地改过的技能不会被悄悄覆盖。
          </p>
          <label>
            仓库
            <input
              required
              autoFocus
              placeholder="owner/repo、owner/repo/子目录 或 Git 地址"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label>
            分支、标签或提交 <small>可选，默认跟随远端默认分支</small>
            <input
              placeholder="main"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-footer">
            <span className="hint">私有仓库沿用本机 gh 或 SSH 的登录。</span>
            <button
              className="button primary"
              disabled={looking || busy || !source.trim()}
            >
              {looking ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Search size={14} />
              )}
              查找技能
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="modal-intro">
            <code>{repoLabel(found.url)}</code> 里有 {found.candidates.length}{" "}
            个技能，选择要安装的。
          </p>
          <div className="candidate-list">
            {found.candidates.map((c) => {
              const on = picked.has(c.subpath);
              return (
                <label
                  key={c.subpath}
                  className={`candidate ${c.error ? "is-invalid" : ""} ${on ? "on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!!c.error}
                    onChange={() => {
                      const next = new Set(picked);
                      if (on) next.delete(c.subpath);
                      else next.add(c.subpath);
                      setPicked(next);
                    }}
                  />
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.error ? (
                        <>
                          <TriangleAlert size={11} /> {c.error}
                        </>
                      ) : (
                        c.description
                      )}
                    </small>
                    <code>{c.subpath || "仓库根目录"}</code>
                  </span>
                </label>
              );
            })}
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="form-footer">
            <button className="button" onClick={() => setFound(null)}>
              返回
            </button>
            <button
              className="button primary"
              disabled={busy || !picked.size}
              onClick={install}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Check size={14} />
              )}
              安装 {picked.size} 个技能
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function SourceDialog({
  skill,
  update,
  api,
  act,
  busy,
  done,
}: {
  skill: Skill;
  update?: UpdateCheck;
  api: Api;
  act: Act;
  busy: boolean;
  done: () => void;
}) {
  const source = gitSource(skill)!;
  const [diff, setDiff] = useState<{
    latestCommit: string;
    files: FileDiff[];
  } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const localChange = /已在本地修改/.test(error);
  useEffect(() => {
    api<{ latestCommit: string; files: FileDiff[] }>(`skills/${skill.id}/diff`)
      .then((d) => {
        setDiff(d);
        setOpen(d.files.find((f) => f.diff)?.path || null);
      })
      .catch((e) => setError(e.message));
  }, [skill.id]);
  const runUpdate = (force: boolean) =>
    void act(
      () => api("skills/update", { ids: [skill.id], force }),
      `已更新 ${skill.name}，预览后部署`,
    )
      .then(done)
      .catch((e) => setError(e.message));
  const upToDate = diff && diff.files.length === 0;
  return (
    <div className="editor-form source-dialog">
      <div className="source-facts">
        <div className="key-value">
          <span>仓库</span>
          <code title={source.url}>{source.url}</code>
        </div>
        {source.subpath && (
          <div className="key-value">
            <span>目录</span>
            <code>{source.subpath}</code>
          </div>
        )}
        <div className="key-value">
          <span>跟随</span>
          <code>{source.ref === "HEAD" ? "默认分支" : source.ref}</code>
        </div>
        <div className="key-value">
          <span>已安装</span>
          <code>
            {source.commit.slice(0, 7)}
            {diff && diff.latestCommit !== source.commit
              ? ` → 上游 ${diff.latestCommit.slice(0, 7)}`
              : ""}
          </code>
        </div>
        {update?.checkedAt && (
          <div className="key-value">
            <span>上次检查</span>
            <span>
              {new Date(update.checkedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
      </div>
      <h4 className="source-diff-title">与上游的差异</h4>
      {!diff && !error ? (
        <p className="source-status">
          <Loader2 size={14} className="spin" /> 正在获取上游内容…
        </p>
      ) : upToDate ? (
        <p className="source-status ok">
          <Check size={14} /> 技能库中的版本与上游一致。
        </p>
      ) : diff ? (
        <div className="file-changes">
          {diff.files.map((f) => (
            <div key={f.path} className="file-change">
              <button
                className="file-change-row"
                disabled={!f.diff || f.binary}
                aria-expanded={open === f.path}
                onClick={() => setOpen(open === f.path ? null : f.path)}
              >
                <FileText size={13} />
                <code>{f.path}</code>
                <span className={`file-status ${f.status}`}>
                  {
                    {
                      added: "上游新增",
                      removed: "上游已删",
                      modified: "有变化",
                    }[f.status]
                  }
                </span>
                {f.binary && <small>二进制</small>}
              </button>
              {open === f.path && f.diff && !f.binary && (
                <pre className="diff-code compact">
                  <DiffLines diff={f.diff} from="技能库" to="上游" />
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {error && (
        <p className="form-error">
          {localChange
            ? "这个技能在技能库里被改过，和安装时的版本不同。直接更新会丢掉这些修改。"
            : error}
        </p>
      )}
      <div className="form-footer">
        {confirmDetach ? (
          <span className="danger detach-confirm">
            脱离后不再检查上游，技能内容保持不变。
            <button
              className="button small"
              onClick={() => setConfirmDetach(false)}
            >
              取消
            </button>
            <button
              className="button small"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api(`skills/${skill.id}/detach`, {}),
                  "已脱离上游，成为普通本地技能",
                )
                  .then(done)
                  .catch((e) => setError(e.message))
              }
            >
              确认脱离
            </button>
          </span>
        ) : (
          <button
            className="button danger-link"
            onClick={() => setConfirmDetach(true)}
          >
            <Unlink size={14} />
            脱离上游
          </button>
        )}
        {localChange ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => runUpdate(true)}
          >
            覆盖本地修改并更新
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy || !diff || !!upToDate}
            onClick={() => runUpdate(false)}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ArrowUpCircle size={14} />
            )}
            更新到上游
          </button>
        )}
      </div>
    </div>
  );
}
