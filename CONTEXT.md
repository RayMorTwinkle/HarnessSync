# HarnessSync 领域与实现

## 核心对象

- **源配置**：`repo/harness-sync.json`、`repo/entries/<kind>/<id>.json` 和完整 Skill 包（兼容读取 v1 manifest），由本地 Git 留存。
- **设备**：本机稳定 UUID、显示名、本地变量、项目路径绑定，位于 Git 外。
- **项目**：稳定 UUID 和可改名显示名称；路径只是当前设备绑定。
- **作用域**：global / device / project，加 Harness 选择集合。
- **部署计划**：由源版本及原生目标内容确定的 SHA-256 ID。预览后任何相关内容变化均使旧计划失效。
- **收据**：记录已管理原生路径及内容指纹；只撤下已拥有的文件。
- **部署快照**：原生文件、权限和部署收据的备份，支持失败恢复和最近一次部署回滚。

## 结构

- `src/core/store.ts`：持久化、输入校验、锁、乐观版本检查、项目、设备、Git。
- `src/core/engine.ts`：指令合成、变量、原生差异、冲突、事务部署、回滚、只读扫描。
- `src/core/files.ts`：原子文件写入、完整技能包、权限、链接检查、frontmatter。
- `src/core/scanner.ts`：真实目录去重、完整包指纹、指令来源与异常清单。
- `src/core/onboarding.ts`：扫描快照、仅管理技能引导部署、中文交接提示词、主指令替换登记。
- `src/core/adapters.ts`：四种 Harness 的原生位置。
- `src/core/settings.ts`：设备本机设置门面；自动同步偏好继续复用 sync-auto.json。
- `src/core/auto-deploy.ts`：保守检查完整计划、排队自动部署及本机结果记录。
- `src/core/service.ts`：可注入命令执行器的登录服务与日志轮转。
- `src/core/update-checks.ts`、`sync-scheduler.ts`：上游更新检查、退避、同库调度器独占及关闭。
- `src/core/self-skill.ts`：从仓库内模板安装管理 Skill，注入本机 CLI 路径。
- `src/server.ts`：只监听本机的 HTTP API 与前端服务。
- `src/cli.ts`：CLI。`src/ui/`：React GUI。

## 不变量

GUI 不直接操作文件；CLI 和 HTTP 调用同一个 core。

指令只替换 HarnessSync 管理区块；区块外内容保持。Skill 按完整目录复制，保留未知 frontmatter、二进制资源和执行位。

外部同名目录内容完全一致时可通过部署计划接管（仅登记收据）；内容不同时仍拒绝覆盖。外部修改阻止部署；过期计划必须重新计算。回滚不覆盖后续新修改。

自动部署默认开启，仍经过完整 plan → apply，只是干净计划无需点击。干净计划仅含 unchanged、指纹有效的显式 skipped、新建不存在目标，以及有收据且无外部修改的 update/remove。任何错误或警告、未托管已有文件更新、adopt/replace/conflict、链接接管、初始化完整指令替换登记、未完成部署、未恢复的源操作或同步冲突均转 needs-review，不自动确认。持有 apply 锁后再次核对开关和冲突；过期计划不强制执行。自动与手动部署共用收据、快照、回滚和跨进程 Store 锁。API 修改合并排队、CLI 修改末尾执行、同步拉取和调度器启动补做；回滚不立即重部署。详见 docs/settings.md。

设置、自动部署结果、调度器独占和检查缓存都留在 Git 外。登录开关读取真实服务状态。同库只能有一个 serve/open/watch 调度器；关闭取消全部计时器并等待在途工作。Git 技能后台只检查更新，不自动更新源技能。

初始化已有配置库不应写文件，否则只读命令会被 Harness 的工作区沙箱拒绝。实际修改依然遵守原生权限。

项目配置直接部署到各自目录，不通过切换全局目录来模拟“当前项目”。

## 当前范围

本机已适配 DeepSeek、OpenCode、Codex、Claude Code，并提供扫描—管理技能安装—中文提示词交接的初始化流程。初始化不自动挑选同名变体或解决自然语言冲突。已提供私有 Git 远端同步与对象三方合并；多个本机路径绑定及桌面封装留待后续。
