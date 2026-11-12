# HarnessSync

本地优先的 AI Harness 配置管理器：在一处管理共享技能、全局指令、设备变量和按名称识别的项目，再部署到不同 AI 工具。

当前适配 **DeepSeek Harness、OpenCode V2、Codex 和 Claude Code**，提供本机 Web GUI 和 CLI，共用同一套核心。

当前版本 **v0.2.2**。已提供本机配置管理与 Git 历史；跨设备远端同步、合并仍在后续范围内。

## 安装

需要 **Node.js 22.12+、npm、Git**。安装器面向 macOS 与 Linux；Windows 请在 WSL 内使用。目前真实 Harness 会话验收环境为 macOS；跨平台测试不能替代各 Harness 的实际会话验收。

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.2.2/install.sh | bash
```

默认安装到 `~/.local/share/harness-sync`，命令启动器为 `~/.local/bin/hsync`。不需要 sudo，不修改 shell 配置，不自动改写已有 Harness 配置。若启动器目录不在 PATH 中，按安装器提示添加，或直接使用完整路径：

```sh
~/.local/bin/hsync --version
~/.local/bin/hsync onboard prepare
~/.local/bin/hsync open
```

`hsync open` 自动打开默认浏览器，也可以使用 `hsync gui` 或 `hsync webui`。GUI 默认地址：<http://127.0.0.1:47821>；可用 `open --port 47822` 指定端口。已有同一配置库的服务时直接复用；否则启动本机服务，需保持终端运行，按 Ctrl+C 停止。`hsync serve` 仅启动服务，不打开浏览器。

无法自动打开浏览器时会显示访问地址，服务仍可使用。端口属于其他程序或另一个配置库时会报错，不自动打开错误的界面。

希望先查看脚本或指定目录时：

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.2.2/install.sh -o install-harness-sync.sh
bash install-harness-sync.sh --help
bash install-harness-sync.sh --ref v0.2.2 \
  --install-dir "$HOME/.local/share/harness-sync" \
  --bin-dir "$HOME/.local/bin"
```

重复运行安装器即可重装或升级到指定标签/分支。新版本构建成功后才切换 `current`，构建失败保留当前程序；旧程序版本保留，`~/.harness-sync` 配置库独立保存。更新程序不会重启已有服务；停止后重新启动 `serve`。更新管理技能可再运行 `onboard prepare`。

## 让 AI 帮你安装

仓库附带两个中文 Skill：

- [安装 HarnessSync](skills/harness-sync-install/SKILL.md)：检查依赖、安装或升级 CLI/GUI，完成首次扫描和管理技能引导。
- [HarnessSync 配置管理](skills/manage-harness-sync/SKILL.md)：安装后通过 CLI 管理技能、指令、设备与项目，由初始化流程部署到检测到的 Harness。

可以把下面这段话交给有终端和网络权限的 AI；此方式让 AI 读取安装 Skill，不要求预先安装 HarnessSync：

```text
请读取 https://github.com/RayMorTwinkle/HarnessSync/blob/v0.2.2/skills/harness-sync-install/SKILL.md，按其中说明在本机安装 HarnessSync，并完成扫描和管理技能部署。保留原有配置，把生成的初始化提示词交给我。
```

也可把 `skills/harness-sync-install/` 完整目录放入所用 Harness 支持的用户技能目录。它不依赖仓库外的个人技能或本机固定路径。

## 从源码开发

当前开发与验收环境为 macOS、Node.js 24、DeepSeek Harness 0.2.1-rc.2、OpenCode 2.2.7、Codex 0.167.0-alpha.3.2、Claude Code 2.1.148。

```sh
git clone https://github.com/RayMorTwinkle/HarnessSync.git
cd HarnessSync
npm ci
npm run build
npm link --ignore-scripts
hsync serve
```

也可以运行 `npm start`。开发模式使用 `npm run dev`。`npm link` 是源码开发入口；普通安装无需全局 npm 写入权限。

`hsync --root /absolute/config-directory serve --port 47821` 可指定其他配置库；环境变量 `HARNESS_SYNC_HOME` 也可设置默认位置。

## 已实现

- 全局、设备、项目作用域，新条目默认部署给四个 Harness，可单独选择。
- Skills 扫描、目录导入、新建、编辑、启停、删除，保留完整资源、执行权限及额外 frontmatter。
- 全局指令片段与变量替换；保留原生指令文件中管理区块以外的内容。
- 按名称管理的稳定项目 ID，以及本机目录绑定。
- 部署预览、文本 diff、同名冲突与外部修改检测、过期计划校验。
- 部署前完整快照、失败恢复、最近一次部署回滚、未完成部署检测。
- 源配置本地 Git 历史和版本恢复。
- `manage-harness-sync` 管理 Skill，使 AI 通过 CLI 管理配置。
- 本机 HTTP 服务仅监听 127.0.0.1，校验 Host、Origin 与会话 token。

## 首次部署到一台机器

在 GUI 的「首次初始化」中：

1. **扫描本机配置**：显示真实技能目录、技能名称、完整资源指纹、同名版本、全局主指令、覆盖文件、共享指令和规则片段。异常目录单独报告，断链不阻断其他技能扫描。
2. **安装中文管理技能**：只部署 `manage-harness-sync`，不顺带发布其他待部署变更，不改写原全局指令。
3. **复制中文初始化提示词**：粘贴到任意已支持 Harness，让 AI 批量整理共用技能和指令。只对真正的版本差异或语义矛盾集中询问，不要求用户逐个勾选所有文件。

CLI 可一次准备：

```sh
hsync onboard prepare --json
hsync onboard show --json
```

也可以分开运行 `onboard scan` 与 `onboard bootstrap <id>`。扫描快照与提示词保存在本机 `onboarding/<id>/`，不进入源 Git。已知目录扫描不等同于全盘扫描或运行中会话的完整上下文。

AI 整理源指令后，可用 `onboard stage-instructions <id> --keys <key1,key2>` 登记主全局文件的完整替换。此时原件不变；`plan` 展示完整 diff，扫描后文件变化会拒绝覆盖，`apply` 前保存快照。`onboard unstage-instructions` 可取消登记。非主文件、外部规则片段与链接不能借初始化静默删除。

管理技能仅提供中文版；固定标识 `manage-harness-sync` 保留 ASCII，以兼容四种 Harness。GUI 和 Codex 元数据提供中文显示名。

## CLI 常用操作

完整命令、参数和编辑作用域注意事项见 [CLI 命令文档](docs/cli.md)。当前可用命令组：

| 命令组                          | 能力                                             |
| ------------------------------- | ------------------------------------------------ |
| `init / status / scan / doctor` | 初始化、扫描、查询与健康检查                     |
| `onboard`                       | 保存清单、部署管理技能、生成 AI 初始化提示词     |
| `skills`                        | 完整技能包导入、查看、修改、启停、删除及显式接管 |
| `rules`                         | 添加、编辑和删除全局、设备或项目指令片段         |
| `projects / device`             | 项目身份、目录绑定、本机名称和变量               |
| `plan / apply`                  | 部署预览、差异检查和按计划发布                   |
| `history / restore / rollback`  | 本地 Git 源版本和部署快照恢复                    |
| `self-skill / open / serve`     | 更新中文管理技能、打开 GUI 或仅启动本机服务      |

```sh
hsync status --json
hsync scan --json
hsync doctor --json

# 建立项目身份，再绑定本机目录
hsync projects add 'My Project' --path /absolute/project
hsync projects list

# 导入完整 Skill；默认全局、四个 Harness
hsync skills import /absolute/my-skill
hsync skills import /absolute/project-skill --scope project --target PROJECT_ID
hsync skills import /absolute/device-skill --scope device --target DEVICE_ID

# 显式接管已有原生目录，允许后续更新和撤下
hsync skills import /absolute/native/skills/my-skill --adopt

# 修改已有正文，保留脚本和资源。作用域通过相同参数设置
hsync skills edit my-skill --file /absolute/SKILL.md
hsync skills disable my-skill

# 添加指令和本机变量
hsync rules add --title '工作约定' --file /absolute/instructions.md
hsync device set WORKSPACE /absolute/workspace
hsync device show

# 保存源配置后，预览并使用返回的 id 部署
hsync plan --json
hsync apply --plan PLAN_ID

hsync history
hsync rollback DEPLOYMENT_ID
hsync restore FULL_COMMIT_SHA

# 安装或更新管理 Skill，然后再次预览部署
hsync self-skill
```

所有命令支持 `--help`。`--json` 可放在子命令后。失败返回非零退出码及 JSON 错误。若目录或配置被其他进程修改，重新获取源版本或部署计划；系统不会自动覆盖。

普通导入先复制到中央库；部署计划选择的原生目录如果完整内容与源相同，会显示“接管”，应用时仅登记收据，不重写文件。内容不同仍显示冲突。`--adopt` 可在导入时显式接管支持的原生目录；共享兼容目录使用普通导入，再检查部署计划。

## 文件布局

```text
~/.harness-sync/
  repo/                   # 可迁移的源配置 Git 仓库
    manifest.json         # 项目、指令片段、技能元数据
    skills/<stable-id>/   # 完整技能包
    .git/
  device.json             # 本机身份、变量、项目目录绑定
  state.json              # 本机文件所有权与部署收据
  deployments/            # 本机部署快照
  onboarding/<id>/        # 初始化快照与中文提示词（不进入 Git）
```

原生部署位置：

| Harness          | 全局指令                                                                   | 全局 Skills                        | 项目 Skills        |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------ |
| DeepSeek Harness | `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md`                             | `$DSH_HOME/skills`                 | `.dsh/skills`      |
| OpenCode V2      | `$XDG_CONFIG_HOME/opencode/AGENTS.md`，默认 `~/.config/opencode/AGENTS.md` | `$XDG_CONFIG_HOME/opencode/skills` | `.opencode/skills` |
| Codex            | `$CODEX_HOME/AGENTS.md`，有非空 `AGENTS.override.md` 时优先                | `~/.agents/skills`                 | `.agents/skills`   |
| Claude Code      | `$CLAUDE_CONFIG_DIR/CLAUDE.md`，默认 `~/.claude/CLAUDE.md`                 | `~/.claude/skills`                 | `.claude/skills`   |

DeepSeek、OpenCode 和 Codex 共用项目根 `AGENTS.md`，面向其中任一工具的项目指令须同时选择三者。Claude Code 使用独立的项目 `CLAUDE.md`。技能采用实际文件复制；Harness 选择表示确保所选工具可读取。放置器依据读取目录表依次最小化同名重复、未选工具可见性、副本数量，平局优先非旧版目录；旧收据中的多余副本会在计划中撤下。共享目录仍可能被其他工具读取，不能将 Harness 选择理解为严格隔离。旧条目保留既有选择，不自动扩大范围。

## 变量与生效

指令支持 `{{device.name}}`、`{{device.home}}`、`{{device.id}}`；项目指令还支持 `{{project.name}}`、`{{project.path}}`。自定义变量使用 `{{vars.KEY}}`。未定义变量阻止部署。Skill 包内不做模板替换。

设备变量只存本机；变量渲染后会出现在原生指令文件，故不应用于凭证。设备适用的指令和 Skill 元数据属于源配置；设备实际路径与变量值不进入源 Git。

`doctor` 和 GUI 状态只验证文件系统。运行中的会话是否已加载更新，不能由文件状态推断。DeepSeek 指令更新依赖相关文件操作或恢复会话；新会话最容易确认。OpenCode V2 在后续请求前刷新全局指令。详见 [适配记录](docs/adapters.md)。

管理 Skill 服从 Harness 的沙箱权限。只读 CLI 可以在已初始化的配置库上不创建锁；修改中央库或原生文件仍需该 Harness 对相应目录的写入授权。GUI 与直接运行的本机 CLI 可完成授权范围内的部署。

## 当前边界

- 当前是本机版本：**未实现远端同步、跨设备冲突合并或桌面安装包**。本地 Git 历史不等于多端同步。
- 每个项目在一台机器上绑定一个目录；多 checkout/worktree 绑定待扩展。
- 中央库 Skill 名称唯一，暂不支持同名 Skill 按作用域覆盖。
- 扫描支持最多六层分类目录、真实路径与链接入口去重，并识别平铺 Markdown。平铺技能需要先整理成目录包；插件托管和系统内置技能不自动纳管。
- 由其他工具提供的同名 Skill 和它们的实际优先级需结合 Harness 的原生目录与会话检查；不会声称扫描结果就是全部有效上下文。
- 拒绝写入符号链接目标，拒绝导入包含链接或特殊文件的技能包。macOS 系统 `/var`、`/tmp`、`/etc` 别名除外。
- 一次部署中任一冲突会阻止整次部署。语义冲突需要人工或 AI 审查，不自动判定自然语言规则优先级。

## 验证

```sh
npm test
npm run build
```

测试覆盖指令保留与外部修改、完整技能包、接管、项目隔离、变量、过期计划、并发更新、源恢复、部署回滚、只读打开以及本机 API 访问控制。真实 Harness 会话验收见 [本机验收记录](docs/local-acceptance.md)。

## 参考

独立实现，参考 [Skills Manager](https://github.com/xingkongliang/skills-manager) 的中央技能库、原生部署与版本管理思路。
