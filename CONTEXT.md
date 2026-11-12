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
- `src/core/self-skill.ts`：从仓库内模板安装管理 Skill，注入本机 CLI 路径。
- `src/server.ts`：只监听本机的 HTTP API 与前端服务。
- `src/cli.ts`：CLI。`src/ui/`：React GUI。

## 不变量

GUI 不直接操作文件；CLI 和 HTTP 调用同一个 core。

指令只替换 HarnessSync 管理区块；区块外内容保持。Skill 按完整目录复制，保留未知 frontmatter、二进制资源和执行位。

外部同名目录内容完全一致时可通过部署计划接管（仅登记收据）；内容不同时仍拒绝覆盖。外部修改阻止部署；过期计划必须重新预览。回滚不覆盖后续新修改。

初始化已有配置库不应写文件，否则只读命令会被 Harness 的工作区沙箱拒绝。实际修改依然遵守原生权限。

项目配置直接部署到各自目录，不通过切换全局目录来模拟“当前项目”。

## 当前范围

本机已适配 DeepSeek、OpenCode、Codex、Claude Code，并提供扫描—管理技能安装—中文提示词交接的初始化流程。初始化不自动挑选同名变体或解决自然语言冲突。已提供私有 Git 远端同步与对象三方合并；多个本机路径绑定及桌面封装留待后续。
