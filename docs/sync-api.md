# 自动同步与撤销（v0.4）

自动同步只修改源配置，绝不自动部署。使用 `hsync plan` 审阅，再 `hsync apply --plan <id>`。

## 运行与设置

成功 setup 后默认开启自动同步：停止编辑 120 秒后同步，每 10 分钟拉取一次。仅在 `serve`、`open` 新启动的服务或 `sync watch` 运行期间调度；关闭进程后停止，不安装系统后台服务。

```sh
hsync sync auto on
hsync sync auto off
hsync sync auto set --debounce 120 --interval 10
hsync sync watch
hsync sync status --json
hsync sync history --json
hsync sync undo
```

间隔均为 1–86400 的整数，set 支持只改其中一个参数。`sync-auto.json` 保存本机设置与运行记录，`sync-undo.json` 保存最近一次可撤销操作，`sync-recovery.json` 记录进行中的远端合并；都位于配置根目录，Git 外。不要把整个配置根目录上传到远端，Git 源库仍是其 `repo/` 子目录。

调度器每 5 秒在锁外检查 HEAD 与文件的 inode、mtime、ctime、size 和 mode，不读取技能正文或资源。空闲轮询不等待源库写锁；发现变更时短暂加锁保存调度状态，到期同步时再持有跨进程锁。这样既能识别外部编辑器的原子替换，也能识别同一未提交文件的连续编辑。编辑会重新计算 debounce；周期拉取遇到 debounce 未到期的本机编辑时只拉取合并，稍后推送。所有同步、设置和撤销共用跨进程 Store 锁。多个服务/watch 同时运行也会重新检查共享到期时间；没有独立的常驻进程租约。

失败时从 30 秒开始指数退避，最多 30 分钟；新编辑不会跳过退避。退避期间仍观测编辑时间；重试可以拉取，推送仍须等最后一次编辑的 debounce 到期。成功后清除 lastError 和失败次数。手动 `sync now` 可立即重试。错误保存在状态中，后台不反复打印。Git 调用沿用同步子进程与 60 秒超时，网络操作期间服务请求可能等待；这版没有把 Git 移到独立 worker。

冲突条目继续保留本机版本，其余条目继续拉取合并；未解决冲突时停止全部推送。远端实际合并进本机的条目变更累计为 `scheduler.pendingDeployment`；这是变更次数，同条目多次远端更新可能重复计数，并非部署文件数。完整显式 apply 成功（包括无需改文件的完整预览应用）后清零；失败或单技能部署不清零。

`sync status` 改为离线可读，不再 fetch；ahead/behind 根据最近一次 fetch 保存的提交计算，因此可能滞后。`lastSuccessAt` 表示一次同步流程或拉取合并成功，即使仍有冲突阻止推送；只有 `lastSyncedCommit` 表示完成推送的源提交。不表示 Harness 会话已经加载。

## 恢复与撤销

resolve 和 restore 前先提交包括未提交编辑在内的源配置，并写入 `refs/hsync/safety/<UUID>`，再保存本机恢复日志。`sync undo` 撤销最近一次 resolve/restore，同时恢复当时的冲突记录，以新的子提交留存，不重写已有历史。撤销不自动部署，也不立即推送。目录交换中断时，恢复前会核对所有权标记、旧目录备份及新暂存包是否与事务快照相符；不匹配或有符号链接时拒绝覆盖。失败回滚按快照恢复原始字节和权限，并回到快照提交，不重新序列化源配置。只保留一个直接撤销入口；更早的恢复点仍由 Git 引用保留。

操作后源内容、Git HEAD、远端连接或冲突被进一步修改时，undo 拒绝覆盖；可从 history 选择完整 SHA 显式 restore，再预览部署。远端合并也有独立的进行中日志，不会覆盖最近一次 resolve/restore 的撤销入口。中途退出会保留日志；未完成的源操作阻止后续同步/恢复/解决冲突，先运行 `sync undo`（优先恢复未完成的远端合并）。恢复检查当前文件是否仍属于操作前后版本；出现无法识别的外部编辑或符号链接时拒绝覆盖。部署和设备绑定不参与源撤销。

`sync history` 返回最近 40 条源提交（包含可能参与同步的普通编辑提交），比较第一父提交，摘要覆盖技能、指令和项目的新增/修改/删除，以及技能资源变化。新提交带设备名；旧提交无法可靠补全设备名，返回“未知设备（旧提交）”。

`sync disconnect` 只删除本机连接设置，保留源库、历史、本机自动同步偏好。**远端仓库仍在，不会删除远端仓库或远端分支。**

## HTTP 协议

沿用 token、Host、Origin 校验。请求头需要 `x-harness-sync-token: <当前会话 token>`；写入还需 `Content-Type: application/json`。成功外壳为 `{"ok":true,"data":...}`；失败为 `{"ok":false,"code":"...","message":"中文说明"}`。

| 方法 | 端点                                   | 请求                 | data 返回        |
| ---- | -------------------------------------- | -------------------- | ---------------- |
| GET  | `/api/sync/auto`                       | 无                   | 自动同步设置     |
| PUT  | `/api/sync/auto`                       | 设置的部分或全部字段 | 更新后的完整设置 |
| GET  | `/api/sync/status`（兼容 `/api/sync`） | 无                   | 下述同步状态     |
| POST | `/api/sync/now`                        | `{}`                 | 同步状态         |
| GET  | `/api/sync/history`                    | 无                   | 历史数组         |
| POST | `/api/sync/undo`                       | `{}`                 | 撤销后的同步状态 |

已有 setup、resolve、disconnect 端点不变；`POST /api/restore` 也使用同一套安全快照和撤销逻辑。

设置请求与响应示例：

```http
PUT /api/sync/auto
Content-Type: application/json
x-harness-sync-token: <token>

{"enabled":true,"debounceSeconds":120,"pullIntervalMinutes":10}
```

```json
{
  "ok": true,
  "data": { "enabled": true, "debounceSeconds": 120, "pullIntervalMinutes": 10 }
}
```

状态 data 示例（不存在的可选字段省略；无冲突时 pushBlocked 可以省略）：

```json
{
  "connected": true,
  "remote": "git@example.com:owner/config.git",
  "branch": "main",
  "ahead": 0,
  "behind": 0,
  "lastFetchedCommit": "<40 位 SHA>",
  "lastSyncedCommit": "<40 位 SHA>",
  "lastSyncTime": "2026-11-13T00:00:00.000Z",
  "auto": {
    "enabled": true,
    "debounceSeconds": 120,
    "pullIntervalMinutes": 10
  },
  "scheduler": {
    "lastAttemptAt": "2026-11-13T00:00:00.000Z",
    "lastSuccessAt": "2026-11-13T00:00:00.000Z",
    "nextRunAt": "2026-11-13T00:10:00.000Z",
    "pullDueAt": "2026-11-13T00:10:00.000Z",
    "failures": 0,
    "pendingDeployment": 2,
    "pendingPush": false,
    "observedSource": "<HEAD 与文件元数据指纹>"
  },
  "conflicts": [],
  "remoteRepositoryRetained": true,
  "message": "同步仅更新源配置；请运行 hsync plan 审查后再 apply"
}
```

`scheduler.pendingPush` 表示还有源提交等待推送，独立于编辑指纹保存；最后一个冲突保留本机也会重新调度推送。`scheduler.lastError` 为最近错误的中文字符串；`changedAt` 为最后观测到源内容变化的 ISO 时间。nextRunAt 是调度到期时间，只有调度进程在运行时才会执行；关闭自动同步后不调度。`conflicts` 沿用 `{entryId,kind,localCommit,remoteCommit,reason,localId?}`。前端可显示“远端带来了 N 项变更，待部署”；不要据此自动 apply。

历史响应示例：

```json
{
  "ok": true,
  "data": [
    {
      "hash": "<40 位 SHA>",
      "date": "2026-11-13T08:00:00+08:00",
      "message": "保存指令",
      "device": "我的电脑",
      "changes": [
        {
          "kind": "rules",
          "id": "<条目 ID>",
          "name": "开发规范",
          "action": "新增"
        }
      ]
    }
  ]
}
```

撤销请求 `POST /api/sync/undo`、请求体 `{}`，返回上面的状态结构。没有恢复点返回 `SYNC_UNDO`；有后续修改返回 `SYNC_UNDO_CHANGED`；未完成操作阻止其他源操作时返回 `SYNC_RECOVERY`。设置类型或范围不正确返回 `SYNC_OPTIONS`。
