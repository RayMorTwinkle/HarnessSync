import React, { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Cloud,
  Layers3,
  Monitor,
  Palette,
  RefreshCw,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { Harness } from "../../shared/types.ts";
import { AppearanceOptions } from "../Appearance.tsx";
import { useApp } from "../app-context.tsx";
import { HarnessIcon } from "../common.tsx";
import type { SettingsData, SettingsPatch } from "../lib.ts";
import { DeviceSettings } from "./Device.tsx";

type HarnessList = {
  harnesses: Harness[];
  errors: { file: string; issues: { path: string; message: string }[] }[];
  pluginDir: string;
};

const docs = "https://github.com/RayMorTwinkle/HarnessSync/blob/main/docs";

function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}

function Row({
  title,
  text,
  children,
  muted,
}: {
  title: React.ReactNode;
  text?: React.ReactNode;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`setting-row ${muted ? "muted" : ""}`}>
      <div className="setting-copy">
        <strong>{title}</strong>
        {text && <p>{text}</p>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

function Group({
  icon: Icon,
  title,
  children,
  footer,
}: {
  icon: typeof Zap;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <h2>
        <Icon size={15} />
        {title}
      </h2>
      <div className="panel settings-rows">{children}</div>
      {footer && <div className="settings-group-footer">{footer}</div>}
    </section>
  );
}

const minutes = (m: number) => (m < 60 ? `${m} 分钟` : `${m / 60} 小时`);
const seconds = (s: number) => (s < 60 ? `${s} 秒` : `${s / 60} 分钟`);
// Keep an unusual stored value selectable instead of silently showing another.
const withCurrent = (list: number[], value: number) =>
  list.includes(value) ? list : [...list, value].sort((a, b) => a - b);

export function SettingsPage({
  settings,
  save,
}: {
  settings: SettingsData | null;
  save: (patch: SettingsPatch) => Promise<void>;
}) {
  const { data, busy, act, api } = useApp();
  const [tools, setTools] = useState<HarnessList | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const loadTools = () =>
    api<HarnessList>("harnesses")
      .then(setTools)
      .catch(() => {});
  useEffect(() => {
    void loadTools();
  }, [data.revision]);
  const change = (key: string, patch: SettingsPatch) => {
    setSaving(key);
    void save(patch).finally(() => setSaving(null));
  };
  const s = settings?.settings;
  const service = settings?.meta.service;
  const syncConnected = !!data.sync?.connected;
  const home = data.device.home;
  const short = (p: string) =>
    p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  // The registry listing has no CLI versions; the snapshot probed them.
  const harnesses = (tools?.harnesses || data.harnesses).map((h) => ({
    ...h,
    version:
      h.version || data.harnesses.find((x) => x.id === h.id)?.version || null,
  }));
  return (
    <div className="settings-page">
      <Group icon={Zap} title="常规">
        <Row
          title="自动写入各工具"
          text={
            <>
              保存技能或指令后，自动把变更写进各 AI
              工具的目录。遇到同名冲突、需要接管已有目录或文件被外部改过时，会停下来等你确认。每次写入都留有快照，可在「版本与部署」回滚。
            </>
          }
        >
          {s && (
            <Toggle
              on={s.deploy.auto}
              label="自动写入各工具"
              disabled={saving === "deploy"}
              onChange={(on) => change("deploy", { deploy: { auto: on } })}
            />
          )}
        </Row>
        <Row
          title="登录后在后台运行"
          muted={service && !service.supported}
          text={
            service && !service.supported
              ? "当前系统暂不支持。需要 macOS（LaunchAgent）或带 systemd 的 Linux。"
              : "登录电脑后自动启动 HarnessSync，不开窗口也能自动同步、写入和检查更新。打开界面时会直接连到这个后台服务。"
          }
        >
          {s && service?.supported && (
            <Toggle
              on={s.startup.login}
              label="登录后在后台运行"
              disabled={saving === "startup"}
              onChange={(on) => change("startup", { startup: { login: on } })}
            />
          )}
        </Row>
      </Group>

      <Group
        icon={Layers3}
        title="AI 工具"
        footer={
          <>
            <span>
              想支持别的工具？写一个 JSON 描述文件放进{" "}
              <code title={tools?.pluginDir}>
                {tools ? short(tools.pluginDir) : "插件目录"}
              </code>
              ，无需改代码。
            </span>
            <a href={`${docs}/plugins.md`} target="_blank" rel="noreferrer">
              插件说明
              <ArrowUpRight size={12} />
            </a>
          </>
        }
      >
        {harnesses.map((h) => (
          <div
            className={`setting-row tool-row ${h.enabled ? "" : "off"}`}
            key={h.id}
          >
            <HarnessIcon id={h.id} />
            <div className="setting-copy">
              <strong>
                {h.name}
                {h.source === "user" && (
                  <span className="tool-badge">插件</span>
                )}
              </strong>
              <p>
                {h.enabled
                  ? h.version || (h.installed ? "已检测到" : "未检测到")
                  : "已停用：已有文件保持原样，不再更新或撤下"}
                <span className="dot-separator">·</span>
                <code title={h.skills}>{short(h.skills)}</code>
              </p>
            </div>
            <div className="setting-control">
              <Toggle
                on={h.enabled}
                label={`管理 ${h.name}`}
                disabled={busy || saving === h.id}
                onChange={(on) => {
                  setSaving(h.id);
                  void act(
                    () =>
                      api<HarnessList>(
                        `harnesses/${h.id}`,
                        { enabled: on, revision: data.revision },
                        "PUT",
                      ).then(setTools),
                    on
                      ? `已启用 ${h.name}`
                      : `已停用 ${h.name}，已有文件保持原样`,
                  )
                    .catch(() => {})
                    .finally(() => setSaving(null));
                }}
              />
            </div>
          </div>
        ))}
        {tools?.errors.map((e) => (
          <div className="setting-row tool-error" key={e.file}>
            <TriangleAlert size={16} />
            <div className="setting-copy">
              <strong>
                插件无法加载 <code>{e.file.split("/").pop()}</code>
              </strong>
              {e.issues.map((i) => (
                <p key={i.path + i.message}>
                  <code>{i.path}</code> {i.message}
                </p>
              ))}
            </div>
          </div>
        ))}
      </Group>

      <Group icon={Cloud} title="同步与更新">
        <Row
          title="自动同步"
          muted={!syncConnected}
          text={
            syncConnected
              ? "停止编辑一会儿后自动推送，并定期拉取其他设备的改动。"
              : "还没有连接同步仓库。先在「跨设备同步」页连接你的私有 Git 仓库。"
          }
        >
          {s && syncConnected && (
            <Toggle
              on={s.sync.auto}
              label="自动同步"
              disabled={saving === "sync"}
              onChange={(on) => change("sync", { sync: { auto: on } })}
            />
          )}
        </Row>
        {s && syncConnected && s.sync.auto && (
          <>
            <Row title="编辑后等待" text="最后一次修改后多久推送。">
              <select
                value={s.sync.pushDelaySeconds}
                disabled={saving === "sync"}
                onChange={(e) =>
                  change("sync", {
                    sync: { pushDelaySeconds: Number(e.target.value) },
                  })
                }
              >
                {withCurrent(
                  [30, 60, 120, 300, 600],
                  s.sync.pushDelaySeconds,
                ).map((v) => (
                  <option key={v} value={v}>
                    {seconds(v)}
                  </option>
                ))}
              </select>
            </Row>
            <Row title="拉取间隔" text="多久检查一次其他设备的改动。">
              <select
                value={s.sync.pullIntervalMinutes}
                disabled={saving === "sync"}
                onChange={(e) =>
                  change("sync", {
                    sync: { pullIntervalMinutes: Number(e.target.value) },
                  })
                }
              >
                {withCurrent([5, 10, 30, 60], s.sync.pullIntervalMinutes).map(
                  (v) => (
                    <option key={v} value={v}>
                      {minutes(v)}
                    </option>
                  ),
                )}
              </select>
            </Row>
          </>
        )}
        <Row
          title="检查技能更新"
          text="定期查看从 Git 安装的技能是否有新版本。只提示，不会自动更新。"
        >
          {s && (
            <>
              {s.updates.check && (
                <select
                  value={s.updates.intervalHours}
                  disabled={saving === "updates"}
                  aria-label="检查频率"
                  onChange={(e) =>
                    change("updates", {
                      updates: { intervalHours: Number(e.target.value) },
                    })
                  }
                >
                  {(
                    (settings!.meta.allowed["updates.intervalHours"] as
                      number[] | undefined) || [6, 24, 168]
                  ).map((v) => (
                    <option key={v} value={v}>
                      {v === 168 ? "每周" : v === 24 ? "每天" : `每 ${v} 小时`}
                    </option>
                  ))}
                </select>
              )}
              <Toggle
                on={s.updates.check}
                label="检查技能更新"
                disabled={saving === "updates"}
                onChange={(on) => change("updates", { updates: { check: on } })}
              />
            </>
          )}
        </Row>
      </Group>

      <Group icon={Palette} title="外观">
        <div className="setting-row appearance-row">
          <AppearanceOptions />
        </div>
      </Group>

      <section className="settings-group">
        <h2>
          <Monitor size={15} />
          这台设备
        </h2>
        <DeviceSettings
          data={data}
          busy={busy}
          save={async (value) => {
            await act(
              () => api("device", { value, revision: data.revision }),
              "设备设置已保存",
            );
          }}
        />
      </section>
      {!settings && (
        <p className="footnote">
          <RefreshCw size={12} className="spin" /> 正在读取设置…
        </p>
      )}
    </div>
  );
}
