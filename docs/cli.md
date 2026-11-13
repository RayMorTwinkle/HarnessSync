# CLI 完整命令

所有命令以 `hsync` 开头。`--root <目录>` 指定配置库，默认使用 `HARNESS_SYNC_HOME` 或 `~/.harness-sync`；`--json` 输出紧凑 JSON，便于 AI 与脚本使用。`--help` 查看对应层级帮助，`--version` 查看版本。失败返回非零退出码和 JSON 错误。

## 状态、部署和版本

| 命令                    | 功能                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `init`                  | 初始化本地配置库                                               |
| `status`                | 查看源配置、设备、适配器和部署状态                             |
| `scan`                  | 扫描已知原生技能与全局指令，不保存初始化清单                   |
| `plan`                  | 预览完整部署计划、文本差异和冲突，返回计划 ID                  |
| `apply --plan <id>`     | 执行对应计划，过期或冲突时拒绝部署                             |
| `doctor`                | 检查部署偏离、变量、作用域和未完成部署                         |
| `history`               | 查看源 Git 历史和部署历史                                      |
| `restore <commit>`      | 恢复源配置并产生新提交，之后仍需部署                           |
| `rollback <deployment>` | 回滚最近一次有效部署，保留源配置                               |
| `self-skill`            | 在源库中安装或更新中文管理技能，之后需预览部署                 |
| `open [--port <端口>]`  | 自动打开 Web UI；别名 `gui`、`webui`。复用同库服务或启动新服务 |
| `serve [--port <端口>]` | 启动本机 GUI，默认 47821；`--dev` 用于源码开发                 |

`doctor` 的 `healthy` 表示没有阻断性错误，不代表没有待部署变更；同时检查 `pendingChanges`。`observed: filesystem-only` 与 `sessionLoaded: unknown` 表示尚未观测会话加载。

`open` 新启动的服务在当前终端运行，按 Ctrl+C 停止；复用已有服务时命令立即结束。默认端口 47821，浏览器启动失败时输出可手动访问的 URL。其他程序占用端口、或该端口的 HarnessSync 使用另一配置库时拒绝打开，可换用 `--port`。`serve` 保留仅启动服务、不打开浏览器的行为。

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

默认是全局、四个 Harness。设备和项目作用域必须提供 `--target`。编辑命令只覆盖显式传入的作用域参数，未传入的保持原值；`rules edit` 的 `--title`、`--file` 也都可省略。

DeepSeek、OpenCode、Codex 共用项目 `AGENTS.md`，其项目指令必须同时选择这三者。Claude 使用单独的 `CLAUDE.md`。共享兼容技能目录可能被其他 Harness 发现，选择目标工具不等于严格的运行时隔离。

## 远端同步

所有命令支持 `--json`，仅修改源库，不自动部署。请使用用户拥有的私有、专用 Git 仓库；非 GitHub URL 的私有性由用户管理。

| 命令                                                 | 功能                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sync setup --url <git-url> [--branch <分支>]`       | 连接远端；新机器恢复、空远端推送、双方已有数据则合并；默认使用远端 HEAD 分支，空远端使用 main |
| `sync setup --create [name]`                         | 通过已登录的 gh 创建私有 GitHub 仓库，默认 harness-sync-config                                |
| `sync status`                                        | 离线显示最近 fetch 的 ahead/behind、自动设置、调度记录、待部署标记及冲突                      |
| `sync now`                                           | 保存本地更改、fetch、按对象三方合并并 push                                                    |
| `sync resolve <entry-id> --keep local\|remote\|both` | 保留本地、采用远端或生成远端副本；之后自动或手动推送                                          |
| `sync auto on` / `sync auto off`                     | 开启或关闭本机自动同步                                                                        |
| `sync auto set --debounce <秒> --interval <分钟>`    | 设置编辑等待与定期拉取间隔                                                                    |
| `sync watch`                                         | 前台运行与 GUI 服务相同的调度器，Ctrl+C 退出                                                  |
| `sync history`                                       | 最近 40 条源提交、设备名及条目变更摘要                                                        |
| `sync undo`                                          | 以新提交撤销最近一次 resolve/restore，并恢复冲突记录                                          |
| `sync disconnect`                                    | 只断开本机，保留源库、Git 历史；远端仓库仍在                                                  |

认证使用 Git 凭证助手或 SSH；不会保存令牌。GitHub 可运行 `gh auth login`、`gh auth setup-git`。网络调用禁用交互提示，60 秒超时；失败后修复网络或认证再运行 `sync now`。推送被其他设备抢先更新时重新运行即可。setup 连接失败后设置会保留，重试 now 或 disconnect 后更换地址。

不同条目的单方变更自动合并；同条目双方不同修改、删除对编辑、不同 ID 的同名技能记录冲突并保留本地，其余内容仍拉取合并；有冲突时暂停全部推送。冲突的远端版本由所记录的提交 SHA 固定，后续同步不会静默替换该选择。`both` 创建新 ID，技能包 frontmatter 名称同步改为唯一数字后缀；删除冲突不能选择 both。

`history` 中的合并前提交可通过 `restore <SHA>` 恢复源库；原生目录只在显式 plan/apply 后变化。旧版 manifest 在首次源修改或同步时自动迁移，单纯打开、查询不会写入。

GUI 接口：`GET /api/sync/status`（也支持 `/api/sync`），`POST /api/sync/setup`（`{url?,create?,branch?}`）、`POST /api/sync/now`、`POST /api/sync/resolve`（`{entryId,keep}`）、`POST /api/sync/disconnect`；沿用会话 token、Host 和 Origin 校验。

自动同步在 setup 成功后默认开启（120 秒 debounce、10 分钟拉取），仅在 serve/open 服务或 sync watch 运行时执行。状态查询不访问网络。失败指数退避至最多 30 分钟；不自动部署。完整协议、恢复规则、请求/响应示例和限制见 [自动同步与撤销](sync-api.md)。
