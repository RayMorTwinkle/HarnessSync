import React, { useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { api, time } from "./lib.ts";

export type SelfUpdate = {
  installed: boolean;
  current: string;
  // Tag form, e.g. v0.6.1; current is the bare package version.
  latest?: string;
  available: boolean;
  checkedAt?: string;
  error?: string;
};

// The server checks on its schedule; a GET only reads the cache.
export function useSelfUpdate() {
  const [info, setInfo] = useState<SelfUpdate | null>(null);
  useEffect(() => {
    api<SelfUpdate>("self-update")
      .then(setInfo)
      .catch(() => {});
  }, []);
  return [info, setInfo] as const;
}

const command = "hsync upgrade";

export function SelfUpdateRow({
  Row,
}: {
  Row: (props: {
    title: React.ReactNode;
    text?: React.ReactNode;
    children?: React.ReactNode;
  }) => React.ReactElement;
}) {
  const [info, setInfo] = useSelfUpdate();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const check = () => {
    setChecking(true);
    setError("");
    api<SelfUpdate>("self-update/check", {})
      .then(setInfo)
      .catch((e) => setError(e.message))
      .finally(() => setChecking(false));
  };
  if (!info) return null;
  const failed = error || info.error;
  const text = !info.installed ? (
    "当前从源码运行，用 git pull 更新。"
  ) : info.available ? (
    <>
      有新版本 {info.latest}。在终端运行下面的命令升级，完成后本机服务会自动重启。
      <code className="self-update-command">{command}</code>
    </>
  ) : failed ? (
    `检查失败：${failed}`
  ) : info.checkedAt ? (
    `已是最新版本 · ${time(info.checkedAt)} 检查`
  ) : (
    "还没有检查过新版本。"
  );
  return (
    <Row
      title={
        <>
          HarnessSync 版本
          <span className={`tool-badge ${info.available ? "self-update-new" : ""}`}>
            v{info.current}
            {info.available && ` → ${info.latest}`}
          </span>
        </>
      }
      text={text}
    >
      {info.available ? (
        <button
          className="button small"
          onClick={() =>
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制命令"}
        </button>
      ) : (
        info.installed && (
          <button className="button small" disabled={checking} onClick={check}>
            <RefreshCw size={13} className={checking ? "spin" : ""} />
            {checking ? "检查中…" : "立即检查"}
          </button>
        )
      )}
    </Row>
  );
}
