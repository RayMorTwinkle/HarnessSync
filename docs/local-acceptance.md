# 本机验收 · 2026-11-12

## 环境与结果

- macOS，Node.js 24.15.0。
- DeepSeek Harness 0.2.1-rc.2：真实 headless 会话加载 `manage-harness-sync`，运行 CLI `doctor --json` 成功，并从全局指令报告渲染后的设备名。
- OpenCode 2.2.7：真实独立会话加载同一管理 Skill，运行 CLI `doctor --json` 和只读状态查询成功，并读取相同的全局设备名。
- 两个 Harness 的管理 Skill 位于各自原生用户目录；共享指令位于各自全局 `AGENTS.md`。
- GUI 中新建 `HarnessSync` 命名项目，绑定当前仓库；新建 `harness-sync-development` 项目专属 Skill，并在部署预览中确认仅落入该项目的 `.dsh/skills` 与 `.opencode/skills`。
- CLI 已通过本地 npm link 暴露为 `hsync`。

## 实际发现与修复

1. 第一次 DeepSeek 会话成功加载管理 Skill 和全局指令，但 `doctor` 失败。原因是所有命令打开已有配置库时都会创建 `.lock`，被工作区沙箱拒绝。已将已有库的只读打开与初始化分开，并新增只读目录回归测试。
2. 修复后的第二次真实 DeepSeek 会话，在原工作区沙箱中直接执行 `doctor --json`，退出码 0，没有提升权限。其当时返回 `healthy: true`、无冲突、`pendingChanges: 2`；这两项是验收中新建的项目专属 Skill 的部署，随后完成部署。
3. OpenCode 原有托管服务报告端口 14096 被另一个 OpenCode 进程占用。验收使用 `--standalone`，保留原服务状态。
4. OpenCode 非交互会话读取用户目录会请求授权。验收独立会话使用命令级 `--auto`，任务限制为读取 Skill、运行只读 CLI；未修改原有权限配置。

## GUI 操作验收

已在真实浏览器操作管理 Skill 安装、共享指令保存、命名项目与路径绑定、项目专属 Skill 新建、部署差异预览及原生部署；还通过 GUI 回滚了项目技能部署，再用 CLI 按审阅后的计划重新部署，最终 doctor 返回零待部署变更。截图和原始会话 JSONL 位于本机 `artifacts/`，不进入 Git。

共享工作约定采用本次用户已经给出的独立判断、自主完成、核验与如实说明边界等要求；未批量接管本机其他已有 Skills。

## 证据边界

真实会话证明这两次验收会话成功发现并使用了配置，不能保证其他已运行会话也自动重新加载。因此 GUI 和 `doctor` 的常态会话加载状态仍显示“未观测 / unknown”。

源保存、部署、回滚及访问控制通过文件系统集成测试验证；跨设备远端同步和其他 Harness 不在本轮验收范围。
