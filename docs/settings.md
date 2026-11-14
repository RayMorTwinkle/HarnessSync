# 本机设置、自动部署与登录启动（v0.5）

设置只属于当前设备，不进入 `repo/`，不随 Git 同步。CLI 和 HTTP 共用 core。

```sh
hsync config list --json
hsync config get deploy.auto
hsync config set deploy.auto false
hsync config set sync.pushDelaySeconds 120
hsync config set updates.intervalHours 24
hsync service status --json
hsync service install
hsync service uninstall
hsync serve --background
```

| 设置键                     | 默认值                                  | 允许值             |
| -------------------------- | --------------------------------------- | ------------------ |
| `deploy.auto`              | `true`                                  | 布尔值             |
| `sync.auto`                | 现有自动同步设置；首次 setup 成功后开启 | 布尔值             |
| `sync.pushDelaySeconds`    | `120`                                   | 1–86400 整数，秒   |
| `sync.pullIntervalMinutes` | `10`                                    | 1–86400 整数，分钟 |
| `updates.check`            | `true`                                  | 布尔值             |
| `updates.intervalHours`    | `24`                                    | 6、24、168，小时   |
| `startup.login`            | 实际服务状态                            | 布尔值             |

`settings.json` 保存 deploy 和 updates；sync 继续使用原有 `sync-auto.json`，保留运行记录和用户偏好。startup 不保存虚拟开关，每次读取检查操作系统服务。写入共用 Store 锁，设置可选地使用独立 revision 防止覆盖其他窗口修改。

## 自动部署边界

开启时，API 保存、删除、导入、启停技能或规则、Git 技能安装/更新/脱离、冲突选择、项目/设备绑定和源恢复会排队自动部署。服务将突发请求合并约 1.5 秒；CLI 在相关命令末尾执行一次。同步调度器发现远端合并待部署时执行；调度器启动时也补做一次。`onboard prepare/bootstrap` 保留仅部署管理技能的初始化范围；登记完整指令替换不会自动确认替换。回滚命令不会立即重新部署源库。

自动部署仍经过完整 `Engine.plan()` → `Engine.apply(planId)`，使用相同收据、事务快照和回滚。仅允许：

- `unchanged`；或仍匹配原生指纹的显式 `skip` 选择。
- `create` 且目标不存在。目标位置由正常 Engine 作用域和路径校验产生，成功后登记所有权。
- 有匹配类型收据的 `update/remove`，并通过 Engine 的外部修改校验。
- 曾手动授权插入的已有指令路径，可在授权仍有效时自动重新插入管理区块。

首次手动应用向已有未托管指令文件插入管理区块的计划后，本机 `state.json.instructionConsents` 保存该绝对路径及区块外全文指纹；这不是源配置，不随 Git 或设备迁移。撤下区块后仍保留授权，同一路径再次启用规则可自动写入，原有区块外内容保留。引擎插入的分隔换行会随部署更新指纹。每次部署持锁检查：文件缺失、不可读、符号链接、管理标记损坏或区块外内容变化均清除授权，之后即使恢复旧文本也需重新手动应用。新路径不继承授权；初始化完整替换不会授予授权。授权随部署快照回滚。

HarnessSync 新建的指令文件会在收据中记录来源；撤下管理区块后若只剩空白，则通过正常部署快照删除文件，之后重新启用为干净创建。已有文件、旧收据来源不明的文件，以及仍有区块外内容的文件保留；删除可正常回滚。

任意计划 error 或 `notices[].blocking=true`、`conflict/adopt/replace`、未授权且未托管的已有指令更新、链接接管、初始化指令完整替换登记、未完成部署、未恢复的源操作或未解决同步冲突，都会停止整次自动部署。插件清单错误、未知 Harness、停用/缺失工具的路径保留、共享目录可见性和显式外部保留均是信息提示，不阻断其余干净路径。暂存残留、本机源目录有更新或无法读取仍要求人工审查。Harness notes 只在元数据展示，不构成部署障碍。不会自动解决冲突或自动确认接管/覆盖。外部同名目录即使内容相同，也需要手动预览并应用接管计划。

计划新增 `notices: {code,message,blocking,path?}[]`，每个通知生成点必须显式选择 code 和 blocking；原有 `warnings: string[]` 从通知消息派生，保留显示兼容。自动部署只检查 blocking，不匹配 code 或中文文案；阻断项携带可选 code 与对应路径。通知分类和内容参与计划 ID，策略变化也使旧计划失效。逐类依据见 [通知分类报告](v0.5-notices-report.md)。

应用持锁后再次核对开关、同步冲突和上述条件。过期计划不强制执行，记录 `needs-review`，调度器稍后重试过期类错误；其他审查项等待用户处理。自动部署与手动 apply 使用同一 Store 锁。无需改文件的正常完整 apply 也会清除同步的 pendingDeployment；需要审查/失败/关闭时保留待部署提示。

`hsync status --json`、`hsync doctor --json`、`GET /api/snapshot` 和 `GET /api/sync/status` 的 `autoDeploy` 为上次结果，尚未运行时为 null：

```ts
type AutoDeploy = {
  at: string;
  reason: string;
  outcome: "applied" | "nothing" | "needs-review" | "failed" | "disabled";
  changes: { create: number; update: number; remove: number };
  deploymentId?: string;
  blockers?: { path: string; status: string; reason: string; code?: string }[];
  error?: string;
};
```

changes 是计划中的新增/更新/删除数量；needs-review 不表示这些数量已经写入。`needs-review` 时用 `hsync plan --json` 阅读差异与 blockers，按授权处理后手动 `hsync apply --plan <id>`。所有结果只证明文件系统状态，不证明运行中的 Harness 会话已加载。

## HTTP 接入

沿用 token、Host、Origin 和 JSON 校验。

- `GET /api/settings`：`data = { settings, meta }`。
- `PUT /api/settings`：深层部分补丁，例如 `{deploy:{auto:false},updates:{intervalHours:6}}`，返回新的完整 `{settings,meta}`。未知键、类型或范围无效返回 `SETTINGS_OPTIONS`。可在 `If-Match` 请求头传入上次 `meta.revision`，不匹配返回 HTTP 409 / `STALE_REVISION`。
- `meta = {path,revision,allowed,service}`。allowed 使用点号键；service 包含 `{supported,installed,loaded,login,file}`。不支持的系统 install/uninstall 返回 `SERVICE_UNSUPPORTED`。
- `settings.sync = {auto,pushDelaySeconds,pullIntervalMinutes}`。原有 `GET/PUT /api/sync/auto` 的 `{enabled,debounceSeconds,pullIntervalMinutes}` 完全保留，并与新门面双向映射。
- 成功的相关写请求在响应**外壳**追加 `autoDeployQueued`：`{ok:true,data:<原有结构>,autoDeployQueued:true}`。保留原有 data 的对象/数组形状。true 表示已排队，可显示“已保存，正在写入各工具”；最终成功与否需读取 autoDeploy。false 表示自动部署关闭。手动 preview/apply 接口不变。
- `GET /api/skills/updates` 只读取 `skill-updates.json` 缓存，返回与 POST 相同的结果数组；过滤已经删除/脱离或源 commit 已变化的过期项，不访问网络。`POST /api/skills/updates` 保留手动立即检查（可带 `{ids:[]}`）。

## 更新检查与进程生命周期

调度器每 5 秒读取本机设置，按 updates.intervalHours 检查 Git 技能上游；检查只提示更新，不自动安装更新。完整手动检查也会推迟下次后台检查。失败从 30 秒开始指数退避，最多 6 小时，保存于 `update-check-state.json`；后台不重复打印网络错误。改变设置在下次轮询生效。检查和同步异步工作都由 close 等待，关闭时取消所有周期及 debounce 计时器。

`serve`、`open` 新服务、`sync watch` 共享同一调度器。`scheduler-owner.json` 用 PID、进程启动时间与随机 token 做配置库级独占；通过 execFile 调用 ps 读取启动时间，Linux 在 ps 不可用时回退到 /proc 的启动时钟和启动 ID。系统限制无法查询时，使用仅监听 127.0.0.1 的随机端口与 token 探活，防止把复用 PID 的无关进程认作调度器。身份匹配时其他调度器返回 `SCHEDULER_RUNNING`；已退出、PID 被复用或缺少进程身份的旧记录可接管，关闭时只清理自己 token 的记录并关闭探活端口。`open` 优先复用默认端口上已验证身份的同库服务，后台实例也适用；指定另一个端口不会绕过同库独占。

## 登录启动

macOS 使用 `$HOME/Library/LaunchAgents/io.github.raymortwinkle.harness-sync.plist`，RunAtLoad，只有异常退出才 KeepAlive。Linux 使用 `$HOME/.config/systemd/user/harness-sync.service`、`Restart=on-failure`。其他系统明确报告不支持。

启动参数为绝对 Node 路径、绝对 `dist/cli.js` 路径、`serve --background`，默认端口 47821，不打开浏览器且隐藏启动日志。开发态 `tsx src/cli.ts` 拒绝安装；先构建安装，再运行安装后的 CLI。服务环境显式携带当前配置根 HARNESS_SYNC_HOME、PATH，以及当前已设置的 CLAUDE_CONFIG_DIR、CODEX_HOME、DSH_HOME、DSH_AGENTS_HOME、XDG_CONFIG_HOME；同时从 Harness 注册表收集所有已加载清单的 root.env 及原生路径中 {env:NAME|fallback} 引用的变量。未设置的变量不写入，空字符串保留，不复制整个 shell 环境。plist 使用 XML 转义，systemd 使用其 Environment= 引号、转义与百分号规则。`hsync service status --json` 的 environment 返回固化值，overrideDifferences 返回与当前 shell 不同的变量名，warnings 提醒重新安装（包含新增或取消设置）。移动安装目录或 Node 后需重新安装服务。

日志位于配置根目录的 `logs/service.log`。启动及后台轮询检查大小，达到 5 MiB 时复制到单个 `.1` 备份并截断原文件，保留服务持有的日志文件描述符。安装、卸载在每次文件修改前重新核验 Label/内容标记、原内容、文件身份及符号链接祖先；异步状态查询或停止期间被替换的文件不会覆盖或删除。失败恢复仅在文件仍是本次写入版本时还原或删除；卸载恢复还检查路径仍空缺且父目录未替换。拒绝外部文件和符号链接。日志和源配置保留。

在正在运行的登录服务中关闭 startup.login 会卸载并停止该服务，当前 HTTP 连接可能断开；服务文件会在停止进程前移除。可使用 `hsync open` 再启动前台界面。操作系统命令全部通过可注入 runner，测试只操作临时 HOME 和配置根目录。

## CLI 提醒

`notices.cli` 默认 `true`，保存在设备本机 `settings.json`，不跨设备同步。
旧设置文件缺少该字段时默认开启。通过 `hsync config get notices.cli`、
`hsync config set notices.cli false` 或 `PUT /api/settings` 的
`{"notices":{"cli":false}}` 修改；`GET /api/settings` 返回 `settings.notices.cli`。
`HSYNC_NO_NOTICES=1` 临时关闭当前 CLI 进程的 JSON 附加和 stderr 提醒。
该设置不关闭 `/api/snapshot` 顶层的 `notices` 数组。
提醒仅消费本地缓存；完整 stderr 块按指纹与 6 小时间隔去重，JSON 不去重。

## 设备变量与组成预览

`device set <键> <值>` / `device unset <键>` 管理本机变量，变量不随源 Git 同步。指令和技能顶层 `SKILL.md` 在计划与部署时渲染；技能只识别 `{{vars.KEY}}`、`{{device.name}}`、`{{device.id}}`、`{{device.home}}`，项目技能另识别 `{{project.name}}`、`{{project.path}}`。未知技能模板、脚本和资源保留原样，源库保存模板原文。

变量更新会按渲染结果重新计算技能更新和收据，不把仍匹配旧收据的部署误报为外部修改。技能缺变量产生逐路径 `skill-missing-variable` 阻断通知和 `skipped` 变更，保留该技能已有副本与收据；手动 apply 可处理其余干净路径。自动部署沿用整次暂停策略，直到补齐变量并重新预览。未受影响的技能不会因另一技能缺变量而变成冲突。

`compose instructions [--json]` 和 `compose skill <id> [--json]` 只读展示组成，不修改原生文件。变量字节从原类别扣除并单列。指令的 `pending` 比较计划全文与磁盘，`error` 不代表部署成功；技能缺变量时查询报错。HTTP 接口和字段见 [CLI 文档](cli.md#内容组成只读)。
