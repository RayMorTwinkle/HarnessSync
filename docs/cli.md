# CLI 完整命令

所有命令以 `hsync` 开头。`--root <目录>` 指定配置库，默认使用 `HARNESS_SYNC_HOME` 或 `~/.harness-sync`；`--json` 输出紧凑 JSON，便于 AI 与脚本使用。`--help` 查看对应层级帮助，`--version` 查看版本。失败返回非零退出码和 JSON 错误。

## 状态、部署和版本

| 命令                    | 功能                                           |
| ----------------------- | ---------------------------------------------- |
| `init`                  | 初始化本地配置库                               |
| `status`                | 查看源配置、设备、适配器和部署状态             |
| `scan`                  | 扫描已知原生技能与全局指令，不保存初始化清单   |
| `plan`                  | 预览完整部署计划、文本差异和冲突，返回计划 ID  |
| `apply --plan <id>`     | 执行对应计划，过期或冲突时拒绝部署             |
| `doctor`                | 检查部署偏离、变量、作用域和未完成部署         |
| `history`               | 查看源 Git 历史和部署历史                      |
| `restore <commit>`      | 恢复源配置并产生新提交，之后仍需部署           |
| `rollback <deployment>` | 回滚最近一次有效部署，保留源配置               |
| `self-skill`            | 在源库中安装或更新中文管理技能，之后需预览部署 |
| `serve [--port <端口>]` | 启动本机 GUI，默认 47821；`--dev` 用于源码开发 |

`doctor` 的 `healthy` 表示没有阻断性错误，不代表没有待部署变更；同时检查 `pendingChanges`。`observed: filesystem-only` 与 `sessionLoaded: unknown` 表示尚未观测会话加载。

## 首次初始化

| 命令                                                 | 功能                                               |
| ---------------------------------------------------- | -------------------------------------------------- |
| `onboard prepare`                                    | 扫描、保存快照并仅部署管理技能，生成中文交接提示词 |
| `onboard scan`                                       | 只保存扫描快照和提示词                             |
| `onboard show [id]`                                  | 读取指定清单；省略 ID 时读取最新清单               |
| `onboard bootstrap <id>`                             | 只向已检测到的 Harness 部署管理技能                |
| `onboard stage-instructions <id> --keys <key1,key2>` | 登记已扫描主全局指令的完整替换，原件暂不变         |
| `onboard unstage-instructions`                       | 取消尚未发布的完整替换登记                         |

`prepare` 与 `bootstrap` 不替用户合并已有技能或全局指令。`stage-instructions` 需先保存适用的源规则，再通过 `plan` 审阅、`apply` 部署；扫描后原文件变化会阻止覆盖。

## 技能

| 命令                                       | 功能                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `skills list`                              | 列出中央库技能                                 |
| `skills show <id或名称>`                   | 查看元数据和正文                               |
| `skills import <目录> [--adopt]`           | 导入完整目录包；`--adopt` 显式接管已有原生目录 |
| `skills edit <id或名称> --file <SKILL.md>` | 修改正文、元数据与作用域，保留资源             |
| `skills enable <id或名称>`                 | 启用技能                                       |
| `skills disable <id或名称>`                | 停用技能，下次部署撤下已托管副本               |
| `skills remove <id或名称>`                 | 从源库删除，下次部署撤下已托管副本             |

CLI 暂无独立的 `skills add` 命令；新建包含 `SKILL.md` 的目录后使用 `skills import`，也可在 GUI 新建。

## 指令、项目和设备

| 命令                                                 | 功能                                 |
| ---------------------------------------------------- | ------------------------------------ |
| `rules list`                                         | 列出指令片段                         |
| `rules add --title <标题> --file <文件>`             | 添加指令片段                         |
| `rules edit <id或标题> --title <标题> --file <文件>` | 编辑指令片段                         |
| `rules remove <id或标题>`                            | 删除指令片段                         |
| `projects list`                                      | 列出项目身份及本机绑定目录           |
| `projects add <名称> [--path <目录>]`                | 创建稳定项目 ID，可同时绑定目录      |
| `projects bind <id或名称> <目录>`                    | 绑定或更换本机项目目录               |
| `projects remove <id或名称>`                         | 删除项目；仍有项目配置引用时拒绝删除 |
| `device show`                                        | 查看本机身份、绑定与变量             |
| `device name <名称>`                                 | 修改本机显示名                       |
| `device set <键> <值>`                               | 保存本机变量                         |
| `device unset <键>`                                  | 删除本机变量                         |

## 作用域参数

`skills import/edit` 与 `rules add/edit` 接受：

```sh
--scope global|device|project
--target <设备ID或项目ID>
--harness deepseek,opencode,codex,claude
```

默认是全局、四个 Harness。设备和项目作用域必须提供 `--target`。编辑命令同样使用这些默认值，因此编辑非全局条目或仅面向部分 Harness 的条目时，应明确传入原作用域及目标，避免扩大范围。

DeepSeek、OpenCode、Codex 共用项目 `AGENTS.md`，其项目指令必须同时选择这三者。Claude 使用单独的 `CLAUDE.md`。共享兼容技能目录可能被其他 Harness 发现，选择目标工具不等于严格的运行时隔离。

以上均为当前已实现的本机能力。尚无 `sync/push/pull/merge` 命令，未实现跨设备同步和自动冲突合并。
