import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleMinus,
  Loader2,
  RefreshCw,
  TriangleAlert,
  XCircle,
} from "lucide-react";

type Check = {
  id: string;
  status: "ok" | "warn" | "fail" | "skip";
  title: string;
  detail: string;
  fix?: string;
};
type Result = { ready: boolean; checks: Check[] };
type Api = <T>(route: string, body?: unknown, method?: string) => Promise<T>;

const icon = {
  ok: <CheckCircle2 size={14} />,
  warn: <TriangleAlert size={14} />,
  fail: <XCircle size={14} />,
  skip: <CircleMinus size={14} />,
};

// Shows what this Mac already has for sync (git, gh login, repository access)
// before the user presses connect, so a missing login is not a failed setup.
export function SyncCheck({
  api,
  mode,
  name,
  url,
}: {
  api: Api;
  mode: "create" | "url";
  name: string;
  url: string;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  const query =
    mode === "create"
      ? `create=${encodeURIComponent(name.trim() || "true")}`
      : url.trim()
        ? `url=${encodeURIComponent(url.trim())}`
        : "";
  useEffect(() => {
    if (!query) return setResult(null);
    let current = true;
    const timer = setTimeout(() => {
      setChecking(true);
      setError("");
      api<Result>(`sync/check?${query}`)
        .then((r) => current && setResult(r))
        .catch((e) => current && setError(e.message))
        .finally(() => current && setChecking(false));
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, round]);
  if (!query) return null;
  const shown = result?.checks.filter((c) => c.status !== "skip") || [];
  return (
    <div className="sync-check">
      <div className="sync-check-head">
        <strong>
          {checking ? (
            <Loader2 size={13} className="spin" />
          ) : result?.ready ? (
            <CheckCircle2 size={13} />
          ) : (
            <TriangleAlert size={13} />
          )}
          {checking
            ? "正在检查这台电脑…"
            : error
              ? "检查没有完成"
              : result?.ready
                ? "可以连接"
                : "连接前还差一步"}
        </strong>
        <button
          type="button"
          className="text-button"
          disabled={checking}
          onClick={() => setRound(round + 1)}
        >
          <RefreshCw size={12} />
          重新检查
        </button>
      </div>
      {error && <p className="sync-check-error">{error}</p>}
      <ul>
        {shown.map((c) => (
          <li key={c.id} className={c.status}>
            {icon[c.status]}
            <div>
              <span>
                {c.title}
                <small>{c.detail}</small>
              </span>
              {c.fix && c.status !== "ok" && <p>{c.fix}</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className="sync-check-note">
        HarnessSync 只用这台电脑上已有的 gh 登录或 SSH 密钥，不需要也不保存
        token。
      </p>
    </div>
  );
}
