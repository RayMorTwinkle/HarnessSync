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

## 同名技能冲突

`conflicts list` 列出冲突和逐文件差异；`conflicts choose <路径或技能名> --use library|native|skip` 分别选择库版本覆盖、原生收库或跳过；`conflicts clear [完整路径]` 清除单个或全部本机选择。选择之后重新 plan/apply。原生变化使选择失效；多路径同名需给完整路径。doctor 的 skipped 列为待处理。

`native` 会立即产生源库提交，之后仍需预览部署；`library` 的计划状态为 replace，`skip` 为 skipped。完整 API、返回结构、恢复和大小限制见 [同名冲突说明](conflicts.md)。

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

不同条目的单方变更自动合并；同条目双方不同修改、删除对编辑、不同 ID 的同名技能记录冲突并保留本地，其余内容仍拉取合并；有冲突时暂停全部推送。冲突的远端版本由所记录的提交 SHA 固定，后续同步不会静默替换该选择。`both` 创建新 ID，技能包 frontmatter 名称同步改为唯一数字后缀；Git 技能的改名副本会删除 Git 来源，成为普通本地技能，原条目的 Git 来源保留。删除冲突不能选择 both。

`history` 中的合并前提交可通过 `restore <SHA>` 恢复源库；原生目录只在显式 plan/apply 后变化。旧版 manifest 在首次源修改或同步时自动迁移，单纯打开、查询不会写入。

GUI 接口：`GET /api/sync/status`（也支持 `/api/sync`），`POST /api/sync/setup`（`{url?,create?,branch?}`）、`POST /api/sync/now`、`POST /api/sync/resolve`（`{entryId,keep}`）、`POST /api/sync/disconnect`；沿用会话 token、Host 和 Origin 校验。

自动同步在 setup 成功后默认开启（120 秒 debounce、10 分钟拉取），仅在 serve/open 服务或 sync watch 运行时执行。状态查询不访问网络。失败指数退避至最多 30 分钟；不自动部署。完整协议、恢复规则、请求/响应示例和限制见 [自动同步与撤销](sync-api.md)。

## Git 技能与上游（v0.4）

只更新源库，不自动部署；安装或更新后仍需 `plan` → `apply --plan <id>`。

| 命令                                                               | 功能                                             |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| `skills install <来源> [--skill <名称,...>] [--all] [--ref <ref>]` | 安装完整技能包；也接受 import 的作用域参数       |
| `skills updates [id...]`                                           | 用 ls-remote 检查上游；省略 ID 检查所有 Git 技能 |
| `skills update <id...> [--force]`                                  | 更新源库并保存源库 Git 提交；返回逐文件差异      |
| `skills diff <id>`                                                 | 比较当前源库内容与上游最新内容                   |
| `skills detach <id>`                                               | 删除 Git 来源记录，保留技能包                    |

来源接受 `owner/repo`、`owner/repo/子路径`、`https://github.com/owner/repo/tree/ref/子路径`、HTTPS/SSH Git URL、`file://` 和已存在的本地仓库路径。GitHub tree URL 自动按最长匹配的分支或标签识别含 `/` 的 ref，也可显式指定 `--ref`。默认 ref 是远端 HEAD；完整提交 SHA 固定版本，不跟随分支更新。标签检查支持 annotated tag 的 peeled commit。

```sh
hsync skills install owner/repo --skill research,writer --ref main
hsync skills install owner/repo/skills/research
hsync skills install file:///tmp/skills.git --all
hsync skills updates
hsync skills diff research
hsync skills update research
hsync plan
```

仓库或选定子路径下递归查找含 `SKILL.md` 的目录，跳过 `.git`、`node_modules` 和目录链接。只有一个候选时直接安装；多个候选未选择时，返回 `selectionRequired: true` 与候选列表，CLI 退出码为 1。`--skill` 也可用候选的仓库相对子路径消除同名歧义；`--all` 与 `--skill` 互斥。同名技能一律拒绝安装，提示使用 update；多选安装作为一次事务，任一包校验失败不导入其他包。

发现阶段会在无效候选上返回 `error`，不会让未选中的模板阻止安装合法技能。无效候选的 `name` 仅使用目录名作显示标签，不参与按技能名匹配，可通过 `subpath` 定位；选择无效候选或使用 `--all` 时仍会整体失败。

技能的 `source` 现在兼容旧字符串与以下 Git 记录，写入 `entries/skills/<id>.json`，随源库同步：

```json
{
  "type": "git",
  "url": "https://github.com/owner/repo.git",
  "ref": "main",
  "subpath": "skills/research",
  "commit": "<完整SHA>",
  "installedHash": "v2:<SHA256>",
  "tree": "<该 commit 下技能 subpath 的 Git tree SHA>"
}
```

Git 包在安装、比较上游及更新时将文件权限统一为 `0644`（普通文件）或 `0755`（可执行文件），再计算指纹和写入，避免不同 umask 或跨设备同步造成误判。`installedHash` 覆盖完整包的文件路径、内容和规范化权限；源库文件被用户修改权限仍会被识别为本地修改。更新时库内容偏离该值会返回 `LOCAL_SKILL_CHANGED`，`--force` 显式覆盖本地修改；下载期间源库变化会返回 `STALE_REVISION`，即使 force 也要重试。技能名发生变化时拒绝更新，应单独安装。保留启停、显示名和作用域。`detach` 后不再检查 Git 上游。原有本机开发目录 `refresh` 机制不变；`skills list/show` 和 HTTP 查询增加设备本地的 `localSource` 字段，Git 技能使用结构化 `source`，普通本地技能没有 Git 来源。

安装和更新会记录可选的 `source.tree`。检查时 commit 不变则无更新；commit 前进时只比较技能目录的 tree，不会因同仓库其他技能变化而误报。仓库根技能使用根 tree。即使目录未变化，检查结果仍返回观测到的 `latestCommit`，但不改写来源记录。旧记录缺少 tree 时继续比较 commit，下次更新后补齐 tree。上游目录被删除或获取失败时返回 `error`，省略 `available`；目录删除时仍保留 `latestCommit`。

安装、更新和冲突收库的源提交包含技能名，例如“从 Git 安装技能：paper-reader、commit-writer”“更新 Git 技能：paper-reader”“收进技能库：paper-reader”。批量标题最多 100 字符，过长时保留能放下的完整技能名，并以“等 N 个”标注本次操作的技能总数；部署提示不写入提交标题。

旧版本已经留下的错误权限指纹不会自动改写，需先核对 `skills diff`，再用 `skills update --force` 生成规范化记录。旧版本已创建且仍带 Git 来源的改名冲突副本，可用 `skills detach` 脱离上游；新的 `sync resolve --keep both` 会自动完成脱离。

下载使用 `HARNESS_SYNC_HOME/cache/git-skills`（显式 `--root` 时位于该目录），`git init` + `fetch --depth=1`，支持分支、标签和完整提交 SHA。成功或异常后删除临时目录；进程崩溃留下的目录在下次下载时按已退出 PID 清理。缓存、检查结果与设备信息均不进入源库 Git。检查结果带 `checkedAt`，保存在设备本地 `skill-updates.json`。同批及并发请求中的同一 URL 只执行一次 ls-remote，即使技能 ref 不同。需要比较 tree 时，同批同仓库只执行一次 `fetch --depth=1 --filter=blob:none`，一次取回所需的不同 commit，不检出工作树；并发请求对相同 URL 和 commit 集合复用进行中的获取。远端不支持过滤时 Git 可能退回普通浅获取。全进程最多三个 Git 命令并发，检查更新中的 Git 命令超时均为 15 秒，安装和更新命令超时 60 秒。队列等待不计入命令超时。

沿用 Git 凭证助手或 SSH；安装了 gh 时，GitHub HTTPS 命令临时借用 `gh auth git-credential`，不修改全局配置，也不保存令牌。拒绝带密码、HTTP 用户名、查询参数或片段的 URL。不要使用含凭证的 URL。

### HTTP API

沿用现有 token、Host、Origin 和 JSON 请求校验。成功统一为 `{"ok":true,"data":...}`，参数/操作错误为 `{"ok":false,"code":"...","message":"中文原因"}`。多候选是 HTTP 200 的选择状态；检查更新的单仓库失败记录在对应条目的 `error` 中，不阻止其他仓库返回结果。

| 方法与端点                     | 请求                                                                                       | data 返回                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `POST /api/skills/install`     | `{source, skills?: string[], all?: boolean, ref?: string, commit?: string, scope?: Scope}` | `{selectionRequired,url,ref,commit,candidates:[{name,description,subpath,error?}],installed:Skill[]}` |
| `POST /api/skills/updates`     | `{ids?: string[]}`                                                                         | `[{id,name,checkedAt,commit,latestCommit?,available?,error?}]`                                        |
| `POST /api/skills/update`      | `{ids:string[],force?:boolean}`                                                            | `[{id,name,commit,files:FileDiff[],note}]`                                                            |
| `GET /api/skills/<id>/diff`    | 无                                                                                         | `{id,commit,latestCommit,files:FileDiff[]}`                                                           |
| `POST /api/skills/<id>/detach` | `{}`                                                                                       | 删除 source 后的 Skill                                                                                |
| `GET /api/skills`              | 无                                                                                         | 含 `source`、`localSource?` 的技能数组                                                                |
| `GET /api/skills/<id>`         | 无                                                                                         | 含 `source`、`localSource?` 和 `body` 的技能详情                                                      |

两步安装示例（以下为 data 内容，SHA 使用占位符）：

```json
// 第一步：POST /api/skills/install
{"source":"owner/repo"}
// 返回
{"selectionRequired":true,"url":"https://github.com/owner/repo.git","ref":"HEAD","commit":"<完整SHA>","candidates":[{"name":"research","description":"研究技能","subpath":"skills/research"},{"name":"writer","description":"写作技能","subpath":"skills/writer"}],"installed":[]}
// 第二步：带回上一步的 commit，锁定用户看到的候选版本
{"source":"owner/repo","commit":"<上一步完整SHA>","skills":["research"]}
// 返回 selectionRequired:false，installed 为新建 Skill（含结构化 source）
```

```json
// POST /api/skills/updates
{"ids":["<id>"]}
// 返回 data
[{"id":"<id>","name":"research","checkedAt":"2026-11-13T00:00:00.000Z","commit":"<已安装SHA>","latestCommit":"<上游SHA>","available":true}]
// POST /api/skills/update
{"ids":["<id>"],"force":false}
// 返回 data
[{"id":"<id>","name":"research","commit":"<上游SHA>","files":[{"path":"SKILL.md","status":"modified","binary":false,"beforeMode":420,"afterMode":420,"diff":"--- 库/SKILL.md\n+++ 上游/SKILL.md\n..."}],"note":"已更新源库，请预览部署"}]
```

`FileDiff` 为 `{path,status:"added"|"removed"|"modified",binary,beforeMode?,afterMode?,diff}`。文本返回 unified diff；二进制只返回变化提示，不返回原始数据。权限变化也列入文件摘要。GUI 应保留候选查询的 `commit` 用于第二步，并用检查结果的 `commit` 确认它仍对应当前技能版本。

限制：不递归获取 Git submodule，不下载 Git LFS 对象（保留仓库中的指针文件）；固定提交需要远端允许 depth-one fetch 该 SHA。临时下载不复用工作树；批量更新可能重复下载同仓库，但检查更新会按 URL 去重。检查结果是上一次观测，不代表运行中的 Harness 已加载该配置。

## Harness plugins

- `hsync harness list [--json]`: list built-in and local plugins, enabled state, validation errors and plugin directory.
- `hsync harness validate <file>`: validate JSON anywhere; errors include file and JSON paths; invalid files exit 1. Does not initialize a store or run version commands.
- `hsync harness dir`: print the device-local plugin directory (`--root` is respected).
- `hsync harness enable <id>` / `hsync harness disable <id>`: change device-local management state. Re-plan before applying.
- Existing `--harness <ids>` accepts registered IDs separated by commas, or `all`. Unknown CLI IDs are errors. Stored unknown IDs remain readable and produce planning warnings.

Paths wanted by enabled tools remain managed, including shared copies. Only
unwanted receipts owned by disabled or missing tools are retained unchanged.
Re-enabling resumes management. The original four-ID scope
means all enabled tools, including future plugins. See [plugins.md](plugins.md)
for contributor setup, path semantics, API contracts and security boundaries.
