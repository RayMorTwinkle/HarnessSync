import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  FileText,
  FolderSearch,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Terminal,
} from "lucide-react";
import { harnessNames } from "../shared/harnesses.ts";
import type { Onboarding } from "../shared/types.ts";

type Request = <T>(
  route: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export function OnboardingPanel({
  request,
  refresh,
  sync,
  openSync,
}: {
  request: Request;
  refresh: () => Promise<unknown>;
  sync?: { connected: boolean; remote?: string };
  openSync: () => void;
}) {
  const [record, setRecord] = useState<Onboarding | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void request<Onboarding | null>("onboarding")
      .then(setRecord)
      .catch((e) => setError(e.message));
  }, []);
  const run = async (action: "scan" | "bootstrap") => {
    setBusy(action);
    setError("");
    setCopied(false);
    try {
      setRecord(
        await request<Onboarding>(
          `onboarding-${action}`,
          action === "scan" ? {} : { id: record!.id },
        ),
      );
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  const inventory = record?.inventory;
  return (
    <div className="onboarding-panel">
      <div className="onboarding-steps">
        {[
          {
            n: "01",
            title: "扫描本机配置",
            text: "找出技能位置与全局指令",
            done: Boolean(record),
          },
          {
            n: "02",
            title: "安装中文管理技能",
            text: "只引导管理入口，不迁移原件",
            done: Boolean(record?.bootstrap),
          },
          {
            n: "03",
            title: "交给任意 AI 整理",
            text: "复制提示词，集中处理关键分歧",
            done: false,
          },
          {
            n: "04",
            title: "跨设备同步",
            text: "可选：连接你的私有 Git 仓库",
            done: Boolean(sync?.connected),
          },
        ].map((step) => (
          <div key={step.n} className={step.done ? "done" : ""}>
            <span>{step.done ? <CheckCircle2 size={18} /> : step.n}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          </div>
        ))}
      </div>
      <section className="panel onboarding-intro">
        <span className="onboarding-hero-icon">
          <FolderSearch size={26} />
        </span>
        <div>
          <h2>
            {record ? "本机扫描清单已保存" : "让 AI 帮你整理，而不是逐项勾选"}
          </h2>
          <p>
            扫描已知的用户目录与已绑定项目目录，保留真实位置、内容指纹和重复关系。原始技能与指令会保留，只有你确认具体方案后才发布整理结果。
          </p>
        </div>
        <button
          className="button primary"
          disabled={Boolean(busy)}
          onClick={() => void run("scan")}
        >
          {busy === "scan" ? (
            <Loader2 size={15} className="spin" />
          ) : record ? (
            <RefreshCw size={15} />
          ) : (
            <FolderSearch size={15} />
          )}
          {record ? "重新扫描" : "扫描本机配置"}
        </button>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={16} />
          {error}
        </div>
      )}
      {record && inventory && (
        <>
          <div className="inventory-stats">
            {[
              ["真实技能目录", inventory.summary.physicalSkills],
              ["默认可导入", inventory.summary.importableSkills ?? 0],
              ["托管技能（默认排除）", inventory.summary.excludedSkills ?? 0],
              ["外部保留", inventory.summary.ignoredSkills ?? 0],
              ["全局指令文件", inventory.summary.instructionFiles],
              ["同名不同内容", inventory.summary.nameConflicts],
            ].map(([label, count]) => (
              <div className="panel" key={label}>
                <strong>{count}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="onboarding-columns">
            <section className="panel onboarding-block">
              <div className="onboarding-block-heading">
                <span className="step-label">02</span>
                <div>
                  <h2>把管理入口装进 Harness</h2>
                  <p>只部署中文管理技能，不会顺带发布其他待部署配置。</p>
                </div>
              </div>
              {record.bootstrap ? (
                <div className="bootstrap-success">
                  <CheckCircle2 size={19} />
                  <div>
                    <strong>管理技能已部署</strong>
                    <p>
                      {record.bootstrap.targets
                        .map((id) => harnessNames[id])
                        .join(" · ")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="bootstrap-pending">
                  <Terminal size={23} />
                  <p>
                    安装后，在任意一个已支持的 Harness
                    中粘贴初始化提示词，即可让它通过同一 CLI 整理配置。
                  </p>
                </div>
              )}
              <button
                className="button"
                disabled={Boolean(busy)}
                onClick={() => void run("bootstrap")}
              >
                {busy === "bootstrap" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {record.bootstrap
                  ? "更新中文管理技能"
                  : "安装到已检测的 Harness"}
                <ArrowRight size={14} />
              </button>
            </section>
            <section className="panel onboarding-block">
              <div className="onboarding-block-heading">
                <span className="step-label">03</span>
                <div>
                  <h2>复制提示词，交给你常用的 AI</h2>
                  <p>AI 负责批量归类；同名版本和语义冲突集中讨论。</p>
                </div>
              </div>
              <div className="handoff-copy">
                <ShieldCheck size={18} />
                <p>
                  提示词包含本机清单位置和操作方式，不会自动把扫描资料上传到其他服务。当前阶段：
                  {record.bootstrap ? "等待交给 AI 整理" : "先安装管理技能"}。
                </p>
              </div>
              <button
                className="button primary"
                disabled={!record.bootstrap || Boolean(busy)}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(record.prompt)
                    .then(() => setCopied(true))
                    .catch((e) =>
                      setError(`复制失败，请从下面文本框复制：${e.message}`),
                    );
                }}
              >
                <Copy size={14} />
                {copied ? "已复制初始化提示词" : "复制中文初始化提示词"}
              </button>
              <small className="scan-timestamp">
                扫描于 {new Date(record.createdAt).toLocaleString("zh-CN")}
              </small>
            </section>
          </div>
          <section className="panel onboarding-block onboarding-sync">
            <div className="onboarding-block-heading">
              <span className="step-label">04</span>
              <div>
                <h2>跨设备同步（可选）</h2>
                <p>
                  {sync?.connected
                    ? `已连接 ${sync.remote}。其他设备连接同一仓库即可恢复这套配置。`
                    : "整理完成后，把配置备份到你自己的 GitHub 私有仓库；新设备连接后直接恢复，不用再整理一遍。"}
                </p>
              </div>
            </div>
            <button className="button" onClick={openSync}>
              <GitBranch size={14} />
              {sync?.connected ? "查看同步状态" : "设置跨设备同步"}
              <ArrowRight size={14} />
            </button>
          </section>
          <details className="panel inventory-details">
            <summary>
              <FileText size={16} />
              查看初始化提示词<span>可自行编辑后粘贴</span>
            </summary>
            <textarea
              className="handoff-prompt"
              aria-label="中文初始化提示词"
              readOnly
              value={record.prompt}
            />
            <p className="hint">
              本机文件：<code>{record.promptPath}</code>
            </p>
          </details>
          <section className="panel inventory-details">
            <div className="inventory-title">
              <h2>扫描到的全局指令</h2>
              <span className="tiny muted">
                主文件 · 覆盖文件 · 共享文件 · 规则片段
              </span>
            </div>
            {inventory.instructions
              .filter((i) => i.exists)
              .map((i) => (
                <details className="instruction-inventory-row" key={i.key}>
                  <summary>
                    <FileText size={15} />
                    <div>
                      <strong>{i.path}</strong>
                      <span>
                        {i.harnesses.map((h) => harnessNames[h]).join(" / ")} ·{" "}
                        {
                          {
                            main: "主全局文件",
                            override: "覆盖文件",
                            shared: "共享指令",
                            rules: "规则片段",
                          }[i.kind]
                        }{" "}
                        ·{" "}
                        {i.active ? "按目录规则参与加载" : "被覆盖，当前不生效"}
                      </span>
                    </div>
                    <span className="tiny-tag">{i.body.length} 字符</span>
                  </summary>
                  <pre>{i.error || i.body}</pre>
                </details>
              ))}
            {!inventory.summary.instructionFiles && (
              <p className="inventory-empty">
                没有在已知位置找到全局指令文件。
              </p>
            )}
          </section>
          <details className="panel inventory-details">
            <summary>
              <FolderSearch size={16} />
              技能与存放位置
              <span>{inventory.skills.length} 个真实目录，链接合并统计</span>
            </summary>
            <div className="inventory-table">
              {inventory.skills.map((s) => (
                <div className="inventory-skill-row" key={s.key}>
                  <div>
                    <strong>{s.name}</strong>
                    <span>
                      {s.harnesses.map((h) => harnessNames[h]).join(" / ")}
                      {s.managed ? " · 已由 HarnessSync 管理" : ""}
                      {s.ignored ? " · 外部保留" : ""}
                      {s.origin && s.origin !== "user"
                        ? ` · ${s.origin}（默认不导入）`
                        : ""}
                      {!s.valid ? " · 需要整理格式" : ""}
                    </span>
                    <code>{s.path}</code>
                    {s.paths
                      .filter((p) => p !== s.path)
                      .map((p) => (
                        <code key={p}>链接入口：{p}</code>
                      ))}
                    {s.originReason && <small>{s.originReason}</small>}
                    {s.error && <small className="invalid">{s.error}</small>}
                  </div>
                  <span className="tiny-tag">
                    {s.hash?.slice(0, 8) || "未获得完整指纹"}
                  </span>
                </div>
              ))}
            </div>
          </details>
          {inventory.duplicates.length > 0 && (
            <details className="panel inventory-details">
              <summary>
                <TriangleAlert size={16} />
                重名技能清单<span>相同内容可合并，不同版本保留审查</span>
              </summary>
              {inventory.duplicates.map((g) => (
                <div className="inventory-duplicate" key={g.name}>
                  <strong>{g.name}</strong>
                  <span>
                    {g.keys.length} 份副本 · 已验证 {g.variants} 种内容
                    {g.unverified > 0 ? ` · ${g.unverified} 份待验证` : ""}
                  </span>
                  <span
                    className={`change-tag ${g.variants > 1 ? "conflict" : "unchanged"}`}
                  >
                    {g.variants > 1
                      ? "需要比较差异"
                      : g.unverified > 0
                        ? "部分未验证"
                        : "内容一致"}
                  </span>
                </div>
              ))}
            </details>
          )}
          <details className="panel inventory-details">
            <summary>
              <Terminal size={16} />
              扫描范围与限制<span>不等同于全盘或会话上下文</span>
            </summary>
            <p className="hint">
              扫描已知用户、兼容目录及已绑定项目；插件托管和系统内置技能不自动纳管。目录内的完整资源参与指纹计算。
            </p>
            {inventory.roots.map((r) => (
              <div className="inventory-root" key={r.path}>
                <code>{r.path}</code>
                <span>
                  {r.error ? "读取不完整" : r.exists ? "已扫描" : "目录不存在"}
                </span>
              </div>
            ))}
            {inventory.warnings.map((w) => (
              <p className="form-error" key={w}>
                {w}
              </p>
            ))}
          </details>
        </>
      )}
    </div>
  );
}
