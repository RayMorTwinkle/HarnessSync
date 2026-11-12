# 本机适配记录

记录日期：2026-11-12。证据分为官方文档、已安装源码检查、文件系统集成测试、真实会话验收。

## DeepSeek Harness

- 本机版本：`dsh 0.2.1-rc.2`。
- 全局指令：`$DSH_HOME/AGENTS.md`，还会读取共享 `$DSH_AGENTS_HOME/AGENTS.md`。默认分别为 `~/.dsh`、`~/.agents`。
- 原生技能目录：用户 `.dsh/skills`、项目 `.dsh/skills`；还读取共享 `.agents/skills`。
- 发现元数据后按需加载正文，资源按 skill 基目录解析。Skill 文件监听使目录变更进入后续目录列表；已加载正文不会被自动替换为新内容。
- 指令不是持续监控刷新，而是通过相关结构化文件操作、会话恢复等触发。
- 适配器部署到原生目录；兼容目录只扫描，不自动接管。
- 真实 headless 会话成功加载管理 Skill、读取解析后的设备名、运行只读 `doctor --json`，未提升沙箱权限。

来源：[指令插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)、[技能插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)。本机同版本 provider 源码位于 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js`。

## OpenCode V2

- 本机版本：`2.2.7`。
- 原生全局指令：`~/.config/opencode/AGENTS.md`；项目指令：`AGENTS.md`。
- 原生技能目录：用户 `~/.config/opencode/skills`、项目 `.opencode/skills`；还读取 `.claude/skills` 与 `.agents/skills` 兼容目录。
- 元数据进入目录列表，正文由 skill 工具按需加载。多个来源同 ID 的后注册来源可能覆盖前者；管理器不将部署成功等同于最终选中该来源。
- 全局指令和向上发现的指令变更进入下一次模型请求；已加载的嵌套指令刷新有不同边界。
- 真实独立会话成功加载管理 Skill，运行 CLI 并读取全局设备名。
- 本机原有 managed service 有端口占用问题，验收使用 `--standalone`，没有停止或修改原服务。

来源：[Skills](https://opencode.ai/docs/skills/)、[Instructions](https://opencode.ai/docs/instructions/)、[API](https://opencode.ai/docs/api)。

## 共用边界

同一项目只有一个原生根 `AGENTS.md`，因此第一版只允许项目指令选择两个 Harness。项目技能各用原生独立目录，可单独选择。

本机原有全局技能、共享兼容目录、插件与自定义配置可能提供额外内容。GUI 列出的“目标技能”是管理器计划部署的集合，不能当成模型当前上下文的完整清单。权限和资源依赖也不由文件复制统一。
