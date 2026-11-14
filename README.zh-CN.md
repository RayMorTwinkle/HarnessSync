# HarnessSync

在一个库中管理 AI 编程工具的技能和指令。

HarnessSync 把共享技能和指令写入各工具的原生目录。源配置保存在你自己的私有 Git 仓库中，可以跨设备同步；设备路径和部署状态留在本机。本机 Web GUI 和 CLI 使用同一套核心。

[English](README.md)

![HarnessSync 工作台：技能、指令及其写入的 AI 工具](docs/images/overview.png)

GUI、CLI 提示和内置技能目前使用简体中文，欢迎参与国际化。

## 功能

- 统一技能库：导入完整包，保留脚本、资源和执行权限。
- 指令与技能顶层 `SKILL.md` 支持设备、项目和自定义变量。
- CLI 与本机 API 可只读查看指令片段和技能文件组成。
- 全局、设备和项目作用域；项目使用稳定 ID，目录由各设备单独绑定。
- 自动部署干净变更，保留快照，支持失败恢复和回滚。
- 同名冲突逐项选择：使用库版本、原生版本收库或跳过目标。
- Git 技能来源：安装、检查上游变化、查看差异、更新或脱离上游。
- 通过自己的私有 Git 仓库跨设备同步：相同条目自动合并，不同的并排对比，由你或你的 Agent 处理。
- 声明式工具插件：用 JSON 描述发现路径即可添加工具。
- 设置页及登录启动服务，支持 macOS 和具有 systemd 用户服务的 Linux。
- CLI ≡ GUI：配置和部署均调用同一套核心。
- 内置 [`manage-harness-sync` 管理技能](skills/manage-harness-sync/SKILL.md)，可交给 AI 管理配置。

## 支持的工具

下表来自 [`harnesses/*.json`](harnesses/)，列出默认原生路径。规划器可能选择共享技能目录以减少重复副本。

| 工具             | 全局技能目录                | 全局指令文件                                         |
| ---------------- | --------------------------- | ---------------------------------------------------- |
| DeepSeek Harness | `~/.dsh/skills`             | `~/.dsh/AGENTS.md`                                   |
| OpenCode         | `~/.config/opencode/skills` | `~/.config/opencode/AGENTS.md`                       |
| Codex            | `~/.agents/skills`          | `~/.codex/AGENTS.md`；非空 `AGENTS.override.md` 优先 |
| Claude Code      | `~/.claude/skills`          | `~/.claude/CLAUDE.md`                                |

根目录遵循 `DSH_HOME`、`XDG_CONFIG_HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`。DeepSeek 还读取 `DSH_AGENTS_HOME` 下的共享路径，默认 `~/.agents`。修改 `CODEX_HOME` 不会改变 Codex 的原生技能目录 `~/.agents/skills`。完整 reader map 见[插件路径语义](docs/plugins.md#path-templates)。

项目技能依次使用 `.dsh/skills`、`.opencode/skills`、`.agents/skills`、`.claude/skills`。DeepSeek、OpenCode、Codex 共用项目 `AGENTS.md`；面向其中之一的项目指令必须同时选择共用该文件的所有已启用工具。Claude 使用 `CLAUDE.md`。工具选择不是访问控制边界，其他工具仍可能读取共享目录。

## 安装

需要 Node.js **22.12+**、npm、Git。安装器支持 macOS 和 Linux；**Windows 请使用 WSL**，不支持原生 Windows。目前有记录的真实会话验收仅覆盖 macOS，见[本机验收](docs/local-acceptance.md)和[适配证据](docs/adapters.md)。

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.5.0/install.sh | bash
```

默认安装到 `~/.local/share/harness-sync`，启动器为 `~/.local/bin/hsync`。无需 sudo，不修改 shell 配置，只安装程序。按提示把启动器目录加入 PATH，或直接运行 `~/.local/bin/hsync`。升级时重新运行安装器；已有服务需重启才能使用新构建。配置库 `~/.harness-sync` 与程序安装目录分开保存。

也可以先查看脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.5.0/install.sh -o install-harness-sync.sh
bash install-harness-sync.sh --help
```

内置[安装技能](skills/harness-sync-install/SKILL.md)也可指导 AI 安装和初始化。

### 备份与卸载

首次扫描或实际部署前自动保存本机基线到 `~/Downloads/HarnessSync 备份/`；没有 Downloads 时放在 HOME 下。包含已注册工具（含停用工具）及已绑定项目的技能、指令路径，会包含技能目录内的凭证文件，仅保存在本机；不复制工具根目录和会话；符号链接只保存链接本身。

运行 `hsync backup list` 查看位置，`hsync backup verify <目录>` 校验。`hsync backup restore` 先预览，再用 `--plan <id>` 执行。外部修改默认保留，覆盖需指定 `--overwrite <路径>`。恢复前另存副本，并关闭自动部署。

卸载先运行 `hsync uninstall --restore`（推荐）或 `hsync uninstall --keep-files` 预览，再运行 `hsync uninstall --plan <id>`。配置库导出到备份的 `library/`，预览加 `--delete-library` 才删除本机库；远端仓库不删除。从源码运行不会删除程序。详见 [CLI 文档](docs/cli.md)。

## 快速开始

```sh
hsync open
```

默认打开 `http://127.0.0.1:47821`。同库已有经过身份核验的服务时直接复用，否则在当前终端启动；新服务需保持终端运行，Ctrl+C 停止。`hsync serve` 只启动服务，不打开浏览器。

在 GUI 使用初始化面板，或运行以下命令准备管理技能和中文交接提示词：

```sh
hsync onboard prepare --json
hsync onboard show --json
hsync doctor --json
```

初始化扫描已知工具位置，只向检测到的工具部署管理技能，保留原有全局指令。把生成的提示词交给所选工具，继续整理其余技能与指令。

管理技能使用安装器经核实的 `current/dist/cli.js` 稳定入口，HOME 下的路径保存为 `{{device.home}}/...`，部署时渲染为本机绝对路径。新启动 `serve/open` 服务及 `onboard prepare` 会原位刷新已有且未手改的生成版本，保留作用域、启停和显示名，生成源提交；服务随后按 `deploy.auto` 部署，初始化仍只部署管理技能。启动服务不会安装缺少的技能。手改版本或缺少生成指纹的旧副本会保留，`status` 提醒 `SELF_SKILL_UPDATE`；确认替换正文和资源后运行 `hsync self-skill`。指纹随技能同步，提醒缓存留在本机；HOME 外路径或不同相对安装位置仍可能需要跨设备人工协调。

已有技能包与项目的操作示例（替换路径，使用 `projects add` 返回的项目 ID）：

```sh
hsync skills import /absolute/my-skill
hsync rules add --title 'Working agreements' --file /absolute/instructions.md
hsync projects add 'My Project' --path /absolute/project
hsync skills import /absolute/project-skill --scope project --target PROJECT_ID
hsync plan --json
```

初始化会话会暂停自动部署；会话结束后自动部署默认开启，上述源编辑可能同时把干净变更写入原生目录。如需每次部署前手动审查，请在**编辑之前**关闭：

```sh
hsync config set deploy.auto false
hsync plan --json
hsync apply --plan PLAN_ID
hsync history
hsync rollback DEPLOYMENT_ID
```

使用 `plan` 和 `history` 返回的 ID。完整命令见 [CLI 文档](docs/cli.md)，各命令也提供 `--help`。

## 工作原理

流程为 **配置库 → plan → apply**。源条目和完整技能包保存在 `~/.harness-sync/repo/`，这是普通 Git 仓库。设备身份、变量、项目目录绑定、设置、收据和快照保存在仓库之外。可用 `HARNESS_SYNC_HOME` 或 `hsync --root /absolute/store plan` 指定其他配置库根目录。

规划器读取已有原生文件、渲染指令，计算路径、差异、冲突和计划 ID。应用时持有配置库锁并重新计算，拒绝过期 ID。技能按完整包复制；所有权收据记录托管路径与指纹，不会静默覆盖未托管的同名技能或外部修改。

指令更新保留管理区块外的内容。例外是基于已验证扫描显式登记的初始化完整替换：计划展示完整差异，部署快照保留原件。快照也用于失败恢复和最近一次有效部署的回滚。回滚拒绝覆盖部署后的新修改，不改变源库，也不会立即重新部署。

自动部署使用相同的规划器、收据和快照。相关 CLI/API 编辑、同步拉取和调度器启动都可能触发。它允许在不存在的目标上新建，以及更新或撤下未被外部修改的已托管内容；显式跳过选择必须仍匹配原生指纹。计划错误、冲突、接管、覆盖、初始化指令替换登记、未完成恢复，以及需要确认的提示（暂存残留、本机导入源已变化或无法读取）会停止整次自动部署，等待审查。仅供参考的提示不会阻止，例如某个工具已停用、文件保持原样，或共享目录也会被其他工具读取。它不代选冲突方案，也不自动安装上游技能更新。读取 `hsync doctor --json` 的 `autoDeploy`；出现 `needs-review` 时检查新计划，解决阻碍后手动应用。详见[本机设置](docs/settings.md)。

指令支持 `{{device.name}}`、`{{device.id}}`、`{{device.home}}`、`{{project.name}}`、`{{project.path}}`、`{{vars.KEY}}`。技能仅渲染顶层 `SKILL.md` 中已识别的变量，项目变量仅适用于项目技能；其他模板语法、脚本和资源原样保留。源库和同步保存模板，部署哈希与接管比较使用渲染结果，修改设备变量会产生更新，不会因此误报外部修改。技能缺变量时跳过该技能部署路径并保留已有副本，手动应用仍可处理其他干净路径；阻断通知会暂停整次自动部署。用 `hsync device set KEY 值` 补齐后重新预览。变量会渲染到原生文件中，不要用来保存凭证。

`hsync compose instructions [--json]` 查看全部已启用工具的全局指令和已绑定项目输出，共用文件只列一次；`hsync compose skill ID [--json]` 查看技能文件类别。文本输出含 40 字符组成条、图例和字节数。JSON 单独统计变量的 UTF-8 字节，按顺序拼接指令片段可还原计划全文，包含管理区块外的用户文字。`pending` 表示源计算结果与磁盘不同，`error` 标明指令预览仍有阻碍；技能组成缺变量时报错。这些只读查询不读取凭证内容，也不证明会话已加载。详见 [CLI/API 契约](docs/cli.md#内容组成只读)。

## 同步

连接自己拥有的私有专用 Git 仓库。凭证来自本机已有的 gh 登录、SSH 或系统 Git 凭证助手。GitHub HTTPS 命令临时借用 `gh auth git-credential`，不改全局 Git 配置。HarnessSync 不接收同步登录 token，认证留给本机工具。用户选择的技能配置包含密钥文件时也会进入私有仓库，仓库必须保持私有；不要把凭证写进指令正文或 URL。先运行 `hsync sync check`，再按选用的 URL 或创建选项检查后连接。需要登录时，由你本人在终端运行 `gh auth login` 并按浏览器提示授权（Claude Code 中可用 `! gh auth login`）。

```sh
hsync sync check --url git@github.com:USER/config.git
hsync sync setup --url git@github.com:USER/config.git
hsync sync status --json
hsync sync now --json
```

也可以用 `hsync sync setup --create`，通过已安装并登录的 `gh` 创建私有 GitHub 仓库。新设备在初始化之前或之后连接同一 URL 都可以；初始化会先问这是不是你的第一台设备，再把本机技能和共享库逐个比较。源配置按对象合并，两台设备上同名且内容相同的条目自动合成一份。内容不同时，`hsync sync conflicts` 列出每个冲突的差异，文件放在 `~/.harness-sync/conflicts/<id>/`（`local/`、`remote/`、`merged/`）。可以用 `hsync sync resolve ENTRY_ID --keep local|remote|both` 选择，也可以交给 Agent 合并：列表里附带的提示词要求它先说明差异、得到你同意，才写入 `merged/` 并执行 `--keep merged`。未解决冲突阻止推送和自动部署。

每个 CLI 命令都会附带 `reminders`（同步冲突、暂停的部署、技能更新、同步失败），调用 `hsync` 的 Agent 因此能及时知道；用 `hsync config set notices.cli false` 关闭。

连接成功后，自动同步默认在停止编辑 120 秒后推送，每 10 分钟拉取一次；需要 `hsync open`、`hsync serve` 或 `hsync sync watch` 持续运行。开启 `deploy.auto` 且完整计划干净时，拉取的变更可自动部署。设备路径、变量、快照、本机插件和设置不参与同步。

技能包中的 `.gitignore`、`.gitattributes` 和其他 `.git*` 普通文件按包数据保存，不作为配置库的忽略或转换规则；文件原始字节（含 CRLF、二进制）和执行位参与提交、同步、历史比较与源恢复。只有本机 `sync ignore` 规则控制上传范围，包内 `.git` 仍按原有导入规则排除。下次提交会自动补收工作区仍存在、旧版本漏提交的文件；已丢失且从未进入提交的内容无法从旧历史恢复。技能文件批量保存，避免逐文件启动 Git 进程。

Git 技能是另一种来源机制：

```sh
hsync skills install owner/repo --skill research
hsync skills updates
hsync skills diff research
hsync skills update research
hsync skills detach research
```

替换仓库和技能名。后台检查只提示更新，安装需显式执行 update。本地库版本有修改时拒绝上游更新，除非显式覆盖。安装和更新源库后遵循自动部署设置。

## 添加工具

在 `hsync harness dir` 打印的目录中放入 JSON 清单，用 `hsync harness validate /absolute/tool.json` 校验，再检查部署计划。内置工具贡献放入 `harnesses/`。字段、发现证据、测试和共享目录行为见[插件指南](docs/plugins.md)。

每台设备都可以在「设置」里单独开关工具。停用的工具已有文件保持原样。

![HarnessSync 设置：自动写入、登录后运行与按设备开关工具](docs/images/settings.png)

## 安全模型

- 规划前读取原生配置；写入或撤下托管内容前核对所有权与指纹。
- 拒绝损坏的指令标记、过期计划和通过符号链接写入。显式接管或覆盖可把末级链接替换为副本，快照保留原链接；始终不写入链接目标。
- 快照只存本机；回滚拒绝覆盖后续新修改。
- HTTP 仅监听 `127.0.0.1`，检查 Host、Origin 和会话 token。
- 如实报告文件系统状态；`doctor` 和 GUI 不能证明运行中的工具会话已加载部署结果。

当前限制：每个项目每台设备只绑定一个目录；整个库中的技能名必须唯一；没有桌面安装包。扫描覆盖已知位置，不代表工具可能加载的全部配置。自然语言指令冲突需人工或 AI 审查。

## 开发

```sh
git clone https://github.com/RayMorTwinkle/HarnessSync.git
cd HarnessSync
npm ci
npm run build
```

本地 CLI/GUI 开发使用临时 HOME 和配置库：

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/store"
env -u DSH_HOME -u DSH_AGENTS_HOME -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u XDG_CONFIG_HOME \
  HOME="$sandbox/home" HARNESS_SYNC_HOME="$sandbox/store" npm run dev
```

Ctrl+C 停止开发服务。CLI（`npm run cli -- plan --json`）、构建后的 CLI/GUI（`npm start`）和测试也应使用相同隔离。`npm run typecheck` 检查类型；`npm test` 运行完整测试；`npm run build` 检查类型并构建 CLI/UI。定向测试和可复用的沙箱函数见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心改动必须通过完整测试与构建。

## 参与贡献

从[贡献指南](CONTRIBUTING.md)和[架构地图](docs/architecture.md)开始。欢迎工具插件、文档、国际化、测试和 UI 改进。目前详细操作文档多数为中文。

独立实现，参考 [Skills Manager](https://github.com/xingkongliang/skills-manager) 的思路。

许可证：[MIT](LICENSE)。

### 初始化扫描与本机来源

`onboard scan`（含 prepare 和界面扫描）启动设备本地初始化会话，7 天内暂停自动部署，不修改 `deploy.auto`。`status` / `doctor` 的 `onboarding` 返回会话 ID、开始和失效时间，`autoDeploy` 显示 `needs-review` 及“初始化进行中：确认部署预览后再写入”。成功的完整手动 `apply --plan <id>`（包括无变更计划）结束会话；失败或仅部署管理技能不会结束。放弃用 `onboard cancel <会话ID>`，源配置与替换登记保留；取消或到期后恢复原设置，后续正常触发自动部署。重复扫描以最新会话为准，不接受旧 ID 取消。无需 Agent 手动关闭再打开自动部署。

HarnessSync 收据管理的部署位置不是独立源目录；成功 apply 清理被接管或移除位置的本机来源及指纹。旧安装通过当前收据及已成功部署快照识别并忽略遗留记录，无需手工修 JSON。链接指向外部开发目录时保留真实来源，仍检测更新；不按目录名称猜测所有权。

`origin=bundled` 表示产品附带，附 `originReason` 与 `bundledBy: {name,path}`；`inventory.summary.bundledSkills` 单独计数，也计入 `excludedSkills`。识别应用包、常见安装目录、node_modules 和链接指向的软件项目；向上查找项目不越过 HOME，最多 8 层，纯技能集合保留用户分类。默认建议不导入、不上传，说明会随产品更新；用户坚持时照常 `skills import`，并不禁止导入。

扫描的 `inventory.skills[].credentials` 和 `skills show <id>` 的 `credentials` 列出技能内疑似凭证文件的相对路径，仅按文件名识别，不展示值；`inventory.summary.credentialSkills` 按真实技能目录计数。用户选择全部配置（含密钥文件）同步到私有仓库，仓库必须保持私有。不想上传的文件可用 `hsync sync ignore <技能名>/<文件>`（由同步忽略功能提供）。不得向用户索要 token、密码或私钥，不要把凭证写进指令正文或 URL。

`onboard repository` 的 `absent` 表示默认名称仓库不存在，仍须确认是否用了其他名字；网络或权限错误保留 `unknown`。

本机上传忽略：`hsync sync ignore add anysearch/.env genbox`，取消用 `sync ignore remove anysearch/.env`，查看用 `sync ignore list --json`。支持整技能、文件路径、加引号的 `*`/`**`/`?` 通配符及 `rule:<ID或标题>`。规则只属于当前设备，不影响本机保存和部署；已上传版本保留远端，忽略后的本机变化不上传，拉取不覆盖本机忽略文件。取消后恢复正常合并。启用忽略后上传使用独立历史，既有远端历史不清除。[完整语义、API 与显式远端移除](docs/cli.md#本机上传忽略规则)。`sync check` 对含未忽略凭证的公开仓库报失败，可见性未知报警告，私有仓库显示文件数量。
