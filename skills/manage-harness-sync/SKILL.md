---
name: manage-harness-sync
description: 管理 HarnessSync 的共享技能、全局指令、设备变量与命名项目；用于本机首次初始化、扫描整理、配置新增修改、部署检查及回滚。
---

# HarnessSync 配置管理

通过统一 CLI 管理 DeepSeek Harness、OpenCode、Codex 和 Claude Code。技能说明仅提供中文版；`manage-harness-sync` 是跨工具兼容的固定标识。

本机 CLI：`__HSYNC_CLI__`

安装程序会填入这次安装的准确路径。手动安装时也可使用 PATH 中的 `hsync`。

## 首次初始化

收到初始化提示词时，先读取 [初始化流程](references/onboarding.md)，再按提示词中的清单 ID 查询本机扫描快照。无需让用户逐个选择所有技能，只对真正存在歧义的事项集中询问。

## 配置操作

- 先运行 `status --json` 查看源配置、设备、项目绑定与待部署变更。`doctor --json` 在已初始化的库上执行只读检查。
- 不熟悉的命令先查看 `--help`。源配置命令分组是 `rules`、`skills`、`projects` 和 `device`。
- `open`（别名 `gui`、`webui`）自动打开管理界面，复用同库服务或启动前台服务；`serve` 仅启动服务。新服务需保持终端运行，按 Ctrl+C 停止。
- 通过 CLI 修改源配置，避免直接编辑生成的原生文件。
- `deploy.auto` 默认开启，通过 CLI/API 编辑后会自动把干净计划写入各工具。用 `config get deploy.auto` 查看；`config set deploy.auto false` 切回手动流程。
- 修改后用 `status --json` 检查 `autoDeploy`。`applied` 是已写入，`nothing` 是无需改动；`needs-review` 要读取 blockers，再 `plan --json` 核对路径，并在用户已授权范围内 `apply --plan <id>`。`failed` 说明尝试失败；计划过期就重新生成。不要把排队等同于已部署。
- `history` 查看源版本和部署记录；`restore <commit>` 恢复源配置并产生新提交；`rollback <deployment-id>` 从最近一次有效部署开始恢复原生文件。
- 区分文件部署与会话加载。`doctor` 成功不能单独证明运行中的会话已经加载新配置。

## 本机设置与后台服务

`config list --json` 查看设置与 meta；`config get <点号键>` 读取；`config set <点号键> <值>` 修改。同步设置为 `sync.auto`、`sync.pushDelaySeconds`（秒）、`sync.pullIntervalMinutes`（分钟），间隔均为 1–86400 整数。Git 技能后台检查由 `updates.check` 与 `updates.intervalHours`（6、24、168）控制，只检查不自动更新技能。

`service status --json` 查看真实服务状态；`service install` / `service uninstall` 安装或卸载登录启动，等同于修改 `startup.login`。只支持 macOS 和 Linux；使用安装后的 dist/cli.js，tsx 源码入口不能安装。`serve --background` 安静运行、不开浏览器；`open` 复用同库后台服务。同库只能有一个调度器，关闭服务会清除同步、部署与更新检查计时器。

自动部署仍调用正常 plan → apply，保留收据、快照与回滚。冲突、接管、覆盖、外部修改、初始化完整指令替换、计划警告或同步冲突都需要人工审查；不会自动确认这些事项。有效的显式 skip 可让其余干净路径继续部署。API 编辑返回外壳 autoDeployQueued，只表示排队；最终状态看 status.autoDeploy。回滚后不会立即重新部署源配置。

## 技能与指令

技能使用包含 `SKILL.md` 的完整目录，通过 `skills import /完整/技能目录` 导入。脚本、执行权限、参考资料、资源文件和额外元数据都会保留。用 `skills edit <id> --file /完整/SKILL.md` 修改正文并保留资源。

默认共享给四个 Harness。项目专属使用 `--scope project --target <项目ID>`，设备专属使用 `--scope device --target <设备ID>`；`--harness codex` 等参数选择工具。DeepSeek、OpenCode、Codex 共用项目 `AGENTS.md`，面向其中任一工具的项目指令需要同时选择三者；Claude Code 使用独立 `CLAUDE.md`。项目技能可以分别选择。

使用 `rules add --title 标题 --file /完整/指令.md` 添加指令。指令变量包括 `{{device.name}}`、`{{device.home}}`、`{{device.id}}`、`{{project.name}}`、`{{project.path}}`、`{{vars.KEY}}`。技能资源不做模板替换。

`skills import <原生目录> --adopt` 表示显式接管该目录，后续允许更新和撤下。普通导入保留原目录的外部管理状态；对已入库技能接管其他原生副本时，完整内容必须一致。

目录导入的 `source` 原始入口及链接真实源路径按技能 ID 存在设备本地，不进入共享源 Git。`status` / `doctor` 报告“源目录有更新”时，使用 `skills refresh <id>` 或 `skills refresh --all` 重新读取完整包；保留作用域、启停和显示名，再检查自动部署结果。刷新会删除库内源目录已经移除的资源，并按 deploy.auto 设置尝试部署。源目录中的名称变化要求单独导入。

扫描来源 `origin` 分为 `user`、`platform`、`tool-managed`、`system`，原因在 `originReason`，锁文件来源在 `sourceUrl`。默认仅导入有效、未管理且未外部保留的用户技能；其他来源默认排除，报告其托管原因。损坏锁文件只警告，不阻断扫描。

链接技能集中成一个分组问题，默认导入副本，允许逐项改为外部保留。选副本时用原始链接入口导入；原生入口可用 `skills import <链接入口> --adopt`，计划显示“以副本替换链接”，apply 才替换，快照回滚恢复原链接。只允许显式接管末级链接，拒绝通过链接父目录写入；不部署符号链接。兼容目录不能接管，不要静默删除其中链接，应报告保留项。

选择保留时，用 `onboard ignore <绝对入口路径...>` 记录所有相应入口；以后扫描和计划显示“外部保留”，不再建议导入，也不报告同名目标冲突。`onboard ignore <路径...> --remove` 可取消。保留是本机决定，不能对已管理目录使用。

## 边界

不要覆盖外部同名文件，也不要忽略部署偏离。设备路径和变量留在本机；凭证不应进入指令或技能。

CLI 遵守 Harness 的沙箱权限。写入被拒绝时，说明需要哪些目录权限，并使用该 Harness 可用的授权机制，不得声称操作已经成功。

源配置保存后产生本地 Git 提交。跨设备使用 `sync setup --url <git-url>` 或 `sync setup --create` 连接用户私有仓库，`sync now` 同步；冲突使用 `sync resolve <entry-id> --keep local|remote|both`，`sync undo` 撤销最近一次处理；`sync auto on|off` 控制自动同步。同步后按 deploy.auto 尝试自动部署干净计划；needs-review 时再审查 `plan`。

从 Git 仓库安装技能用 `skills install <owner/repo|Git URL> [--skill 名称,...]`；`skills updates` 检查上游，`skills diff <名称>` 查看差异，`skills update <名称>` 更新（本地改过时会拒绝，只有用户明确同意才加 `--force`），`skills detach <名称>` 脱离上游。

`plan` 中同名目录内容不同的冲突用 `conflicts choose <路径或名称> --use library|native|skip` 处理：library 覆盖原生目录（原件进快照，可回滚），native 把原生版本收进技能库，skip 本次跳过。覆盖或收库前先向用户说明影响。

## 声明式 Harness 插件

用 `__HSYNC_CLI__ harness list --json` 查看工具、启停状态、插件错误与目录。
`harness dir` 打印本机插件目录；`harness validate <file>` 校验任意 JSON 清单，
错误包含文件与 JSON 路径，无效时退出码为 1。插件只声明路径，不包含可执行代码。

`harness disable <id>` / `harness enable <id>` 只修改本机管理状态，随后重新 plan。
启用工具仍需要的路径照常管理，共享副本正常更新；只有不再被启用工具需要、且收据属于
禁用或缺失工具的路径才保留原样，不更新、不撤下。
重新启用后恢复管理。禁用不阻止工具读取共享目录中新添加的技能，不是隔离边界。
`--harness all` 与原始四个工具 ID 的完整集合表示所有已启用工具（包括新增插件）。
未知源配置 ID 在 status/doctor 提示，不应擅自删掉其收据或原生文件。
