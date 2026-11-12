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
- 修改后运行 `plan --json`，核对影响的路径；在用户已授权的范围内执行 `apply --plan <id>`。计划过期就重新生成。
- `history` 查看源版本和部署记录；`restore <commit>` 恢复源配置并产生新提交；`rollback <deployment-id>` 从最近一次有效部署开始恢复原生文件。
- 区分文件部署与会话加载。`doctor` 成功不能单独证明运行中的会话已经加载新配置。

## 技能与指令

技能使用包含 `SKILL.md` 的完整目录，通过 `skills import /完整/技能目录` 导入。脚本、执行权限、参考资料、资源文件和额外元数据都会保留。用 `skills edit <id> --file /完整/SKILL.md` 修改正文并保留资源。

默认共享给四个 Harness。项目专属使用 `--scope project --target <项目ID>`，设备专属使用 `--scope device --target <设备ID>`；`--harness codex` 等参数选择工具。DeepSeek、OpenCode、Codex 共用项目 `AGENTS.md`，面向其中任一工具的项目指令需要同时选择三者；Claude Code 使用独立 `CLAUDE.md`。项目技能可以分别选择。

使用 `rules add --title 标题 --file /完整/指令.md` 添加指令。指令变量包括 `{{device.name}}`、`{{device.home}}`、`{{device.id}}`、`{{project.name}}`、`{{project.path}}`、`{{vars.KEY}}`。技能资源不做模板替换。

`skills import <原生目录> --adopt` 表示显式接管该目录，后续允许更新和撤下。普通导入保留原目录的外部管理状态；对已入库技能接管其他原生副本时，完整内容必须一致。

## 边界

不要覆盖外部同名文件，也不要忽略部署偏离。设备路径和变量留在本机；凭证不应进入指令或技能。

CLI 遵守 Harness 的沙箱权限。写入被拒绝时，说明需要哪些目录权限，并使用该 Harness 可用的授权机制，不得声称操作已经成功。

源配置保存后产生本地 Git 提交。跨设备使用 `sync setup --url <git-url>` 或 `sync setup --create` 连接用户私有仓库，`sync now` 同步；冲突使用 `sync resolve <entry-id> --keep local|remote|both`。同步后先审查 `plan`，不会自动部署。
