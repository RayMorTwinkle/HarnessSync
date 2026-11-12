# HarnessSync

本地优先的 AI Harness 配置管理器。独立实现，参考 [Skills Manager](https://github.com/xingkongliang/skills-manager) 的中央技能库、原生部署与版本管理思路。

当前适配 **DeepSeek Harness** 与 **OpenCode V2**，提供本机 Web GUI 和 CLI，两者共用同一套核心。

## 启动

需要 Node.js 22.12+ 和 Git。当前开发与验收环境为 macOS、Node.js 24、DeepSeek Harness 0.2.1-rc.2、OpenCode 2.2.7。

```sh
npm install
npm run build
npm link --ignore-scripts
hsync serve
```

GUI 默认地址：<http://127.0.0.1:47821>。也可以运行 `npm start`。开发模式使用 `npm run dev`。

`hsync --root /absolute/config-directory serve --port 47821` 可指定其他配置库；环境变量 `HARNESS_SYNC_HOME` 也可设置默认位置。

## 已实现

- 全局、设备、项目作用域，默认部署给两个 Harness，可单独选择。
- Skills 扫描、目录导入、新建、编辑、启停、删除，保留完整资源、执行权限及额外 frontmatter。
- 全局指令片段与变量替换；保留原生指令文件中管理区块以外的内容。
- 按名称管理的稳定项目 ID，以及本机目录绑定。
- 部署预览、文本 diff、同名冲突与外部修改检测、过期计划校验。
- 部署前完整快照、失败恢复、最近一次部署回滚、未完成部署检测。
- 源配置本地 Git 历史和版本恢复。
- `manage-harness-sync` 管理 Skill，使 AI 通过 CLI 管理配置。
- 本机 HTTP 服务仅监听 127.0.0.1，校验 Host、Origin 与会话 token。

## CLI 常用操作

```sh
hsync status --json
hsync scan --json
hsync doctor --json

# 建立项目身份，再绑定本机目录
hsync projects add 'My Project' --path /absolute/project
hsync projects list

# 导入完整 Skill；默认全局、两个 Harness
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

普通导入只复制到中央库，不接管原目录。如果原生目录与库中同名，预览会显示冲突；确认要由 HarnessSync 管理时显式使用 `--adopt`。已入库的 Skill 可以接管内容完全一致的原生目录。共享兼容目录只允许普通导入。

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
```

原生部署位置：

| Harness          | 全局指令                                                                   | 全局 Skills                        | 项目 Skills        |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------ |
| DeepSeek Harness | `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md`                             | `$DSH_HOME/skills`                 | `.dsh/skills`      |
| OpenCode V2      | `$XDG_CONFIG_HOME/opencode/AGENTS.md`，默认 `~/.config/opencode/AGENTS.md` | `$XDG_CONFIG_HOME/opencode/skills` | `.opencode/skills` |

两个 Harness 的项目指令都写入项目根 `AGENTS.md`，因此 v0.1 项目指令必须同时适用于两者。部署采用实际文件复制，不使用软链接。

## 变量与生效

指令支持 `{{device.name}}`、`{{device.home}}`、`{{device.id}}`；项目指令还支持 `{{project.name}}`、`{{project.path}}`。自定义变量使用 `{{vars.KEY}}`。未定义变量阻止部署。Skill 包内不做模板替换。

设备变量只存本机；变量渲染后会出现在原生指令文件，故不应用于凭证。设备适用的指令和 Skill 元数据属于源配置；设备实际路径与变量值不进入源 Git。

`doctor` 和 GUI 状态只验证文件系统。运行中的会话是否已加载更新，不能由文件状态推断。DeepSeek 指令更新依赖相关文件操作或恢复会话；新会话最容易确认。OpenCode V2 在后续请求前刷新全局指令。详见 [适配记录](docs/adapters.md)。

管理 Skill 服从 Harness 的沙箱权限。只读 CLI 可以在已初始化的配置库上不创建锁；修改中央库或原生文件仍需该 Harness 对相应目录的写入授权。GUI 与直接运行的本机 CLI 可完成授权范围内的部署。

## 当前边界

- 当前是本机版本：**未实现远端同步、跨设备冲突合并、Claude/Codex 适配或桌面安装包**。本地 Git 历史不等于多端同步。
- 每个项目在一台机器上绑定一个目录；多 checkout/worktree 绑定待扩展。
- 中央库 Skill 名称唯一，暂不支持同名 Skill 按作用域覆盖。
- 自动扫描目前识别一级 `<name>/SKILL.md`；平铺 Markdown、嵌套分类、插件托管技能暂不自动导入。
- 由其他工具提供的同名 Skill 和它们的实际优先级需结合 Harness 的原生目录与会话检查；不会声称扫描结果就是全部有效上下文。
- 拒绝写入符号链接目标，拒绝导入包含链接或特殊文件的技能包。macOS 系统 `/var`、`/tmp`、`/etc` 别名除外。
- 一次部署中任一冲突会阻止整次部署。语义冲突需要人工或 AI 审查，不自动判定自然语言规则优先级。

## 验证

```sh
npm test
npm run build
```

测试覆盖指令保留与外部修改、完整技能包、接管、项目隔离、变量、过期计划、并发更新、源恢复、部署回滚、只读打开以及本机 API 访问控制。真实 Harness 会话验收见 [本机验收记录](docs/local-acceptance.md)。
