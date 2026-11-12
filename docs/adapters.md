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

DeepSeek、OpenCode、Codex 共用项目根 `AGENTS.md`，项目指令面向其中任一工具时需要同时选择三者。Claude Code 使用独立项目 `CLAUDE.md`，兼容本机较早版本。项目技能可以选择独立原生目录，但共享兼容目录会影响其他工具的可见性，计划会给出提示。

本机原有全局技能、共享兼容目录、插件与自定义配置可能提供额外内容。GUI 列出的“目标技能”是管理器计划部署的集合，不能当成模型当前上下文的完整清单。权限和资源依赖也不由文件复制统一。

## Codex · v0.2 新增

- 本机版本：`0.167.0-alpha.3.2`；原生用户技能目录为 `~/.agents/skills`，旧 `~/.codex/skills` 只作为兼容扫描来源。
- 全局指令默认 `$CODEX_HOME/AGENTS.md`；存在非空 `AGENTS.override.md` 时选用覆盖文件，扫描同时展示两者。
- 项目技能使用 `.agents/skills`，项目指令使用 `AGENTS.md`。技能元数据可自动发现、正文按需加载；命名重复不应推断为内容合并。
- 已用真实只读 `codex exec` 会话读取中文安装副本并调用 `doctor --json`，返回退出码 0、健康且零待部署项。
- 依据：[OpenAI Skills 文档](https://learn.chatgpt.com/docs/build-skills)、[全局指令发现](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。

## Claude Code · v0.2 新增

- 本机版本：`2.1.148`；原生用户技能目录为 `~/.claude/skills`，全局指令为 `~/.claude/CLAUDE.md`。
- 项目使用 `.claude/skills` 和 `CLAUDE.md`，不依赖较新版本对 `AGENTS.md` 的支持。扫描额外列出用户 `.claude/rules` Markdown 片段。
- 中文管理包已部署至原生目录；真实 `claude --print` 会话读取中文安装副本并成功调用 CLI。该次结果证明可调用性；没有把模型自行选择的具体加载来源或所有已有会话更新视为已验证。
- 原有全局 `CLAUDE.md` 内容保持；初始化引导阶段只部署管理技能。
- 依据：[Claude Skills](https://code.claude.com/docs/en/skills)、[Claude 指令](https://code.claude.com/docs/en/memory)。

## v0.3 部署放置复核（2026-11-13）

本节覆盖前文的技能放置结论；前文真实会话记录保留为历史验收。此次没有调用模型 API。所有命令在独立临时 HOME、HARNESS_SYNC_HOME 下执行，未加载真实配置或凭证。实际命令版本与历史记录不同：`dsh 0.1.5-rc.1`、`opencode v2.0.32`、`codex-cli 0.166.0-alpha.5.1`、`Claude Code 2.1.311`。版本命令使用绝对可执行路径，并将 HOME、DSH_HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、XDG_CONFIG_HOME 指向临时目录。

默认 reader map（自定义插件目录、远端技能和内置技能不在覆盖保证内）：

| 相对目录（全局 / 项目） | DeepSeek | OpenCode | Codex | Claude |
| --- | --- | --- | --- | --- |
| `.dsh/skills` / `.dsh/skills` | 是 | | | |
| `.config/opencode/skills` / `.opencode/skills` | | 是 | | |
| `.agents/skills` / `.agents/skills` | 是 | 是 | 是 | |
| `.claude/skills` / `.claude/skills` | | 是 | | 是 |
| `.codex/skills` / `.codex/skills`（旧版） | | | 是 | |

全局路径尊重已有适配器的环境变量。特别是 DSH_AGENTS_HOME 与 `~/.agents` 分离时，其技能目录仅标记 DeepSeek 可读，不能推断 OpenCode/Codex 也读取它。CLAUDE_CONFIG_DIR 重定向时，仅 Claude 使用重定向目录，OpenCode 的兼容读取仍指向 HOME 下的 `.claude/skills`。

### 证据及复现入口

DeepSeek：通过本机安装包导出的 `FileSystemSkillProvider` 在临时 HOME 下直接调用 `list({cwd: tempProject})`，`watch:false`、无模型。四个测试包分别返回 `source: project-dsh / project-agents / user-dsh / user-agents`，rank 分别为 `100 / 200 / 400 / 500`。上下文仅提供 `get: () => undefined` 和 logger，provider 的 invalidate 为空函数，调用后 dispose。

```js
const { FileSystemSkillProvider } = await import(
  '/Users/Ray/.dsh/profiles/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js'
);
const p = new FileSystemSkillProvider(
  { get() {}, logger: console },
  { invalidate() {}, signal: new AbortController().signal },
  { watch: false, dshHome: `${tempHome}/.dsh`, agentsHome: `${tempHome}/.agents` }
);
try { console.log(await p.list({ cwd: tempProject })); }
finally { await p.dispose(); }
```

源码：上述 `dsh-skill-filesystem/lib/index.js:21` 定义 rank，`:149–182` 枚举全局和项目目录；同级 `@deepseek-ai/dsh-skill/lib/index.js:312–324` 按 rank 排序，重复 name 记录 `ignored because a higher-priority skill already exists` 并跳过。结论：同名不是合并，项目原生优先于项目共享，其次用户原生和用户共享。

Codex：在临时 HOME 创建全局和项目 `.agents`、`.codex`、`.claude`、`.dsh` 测试包，执行绝对路径 `/Users/Ray/.local/bin/codex app-server`，stdin 仅发送以下 RPC，没有创建 thread 或 turn：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"hsync-probe","version":"1"}}}
{"method":"initialized"}
{"id":2,"method":"skills/list","params":{"cwds":["TEMP_PROJECT"],"forceReload":true}}
```

输出包含项目 `.agents/skills`、`.codex/skills`（scope `repo`），全局 `.agents/skills`、`.codex/skills`（scope `user`）；没有 Claude/DeepSeek 的测试包。再次把四份 frontmatter name 全设为 `duplicate-probe`，结果仍包含四个同名条目，路径分别对应上述四个目录。因此旧目录仍是实际读取目录，不能只把它当作扫描历史。[官方技能文档](https://learn.chatgpt.com/docs/build-skills) 同样说明同名技能不会合并，选择器可展示多个条目。

OpenCode：本机 `opencode debug --help` 只有 agents/config/paths，没有技能列表子命令。在临时 HOME 启动 `opencode serve --hostname 127.0.0.1 --port TEMP_PORT`，为六类全局/项目目录放入不同名称的测试包；`GET /api/skill?location=...` 返回 `UnauthorizedError: Authentication required`。未读取真实服务 token。运行时列表未核验成功，采用本机二进制内嵌 JS 的证据和原适配表：

- `/Users/Ray/.opencode/bin/opencode2`，`ConfigDiscovery.discover`，字节偏移约 `120710540`：用户 `.agents`、`.claude`，项目向上搜索 `.claude`、`.agents`、`.opencode`。
- `ConfigSkillPlugin`，偏移约 `121024000–121026900`：原生目录枚举 `skill` 和 `skills`，扫描 `{*.md,**/SKILL.md}`；按 skill ID `Map.set`，后者覆盖前者。
- `ConfigCompatibilityPlugin`，偏移约 `121027678`：`[...N.claude,...N.agents].map(..."skills")`，同样按 ID `Map.set`。
- `Skill` editor，偏移约 `120632811`：`skills.set(i.id,{...i})`。ID 是目录名或平铺 Markdown 文件名（`ww` 解析器，偏移约 `121023704`），不应把 frontmatter name 相同误认为一定合并。原生与兼容插件之间的最终注册优先级未用会话验证。

这些是编译可执行文件中的内嵌 JS，使用字节定位而非伪造源码行号。可用 Python `Path(binary).read_bytes()[start:end].decode('utf8','replace')` 复核指定范围；本次未依赖上游新版实现推断本机行为。

Claude：以临时 HOME、CLAUDE_CONFIG_DIR，清空继承环境中的认证变量，运行绝对路径 `claude --bare --print --verbose --input-format stream-json --output-format stream-json`，只发送 `control_request` 的 `initialize`，不发送用户消息。初始化成功、`tokenSource: none`，但 commands 没有列出测试技能，因此此模式不能证明默认技能发现行为，目录表保持原适配器结论。

本机二进制 `/Users/Ray/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` 内嵌 JS 偏移约 `223000535` 同时含工作目录及 HOME 下 `.claude/skills`；偏移约 `229639353` 包含按实际文件身份去重的 `Skipping duplicate skill ... (same file already loaded from ...)`。这证明存在文件去重代码，不能据此推断不同目录的同名包如何最终选中；该同名优先级仍未独立验证。不扩大 Claude 的 reader map 到 `.agents`。

### 放置与迁移决定

`adapters.ts` 的 `skillReaders` 提供数据，`placeSkills` 是纯枚举函数。覆盖所有所选 Harness 后，比较以下分数（按顺序）：会列出重复副本的 Harness 多看到的副本数、额外可见的未选 Harness 数、旧版目录数、物理副本数。

DeepSeek 按 rank 只保留同名中优先级最高的一份，OpenCode 以目录名为 ID、后者覆盖前者，因此 HarnessSync 写入的同名副本在这两者中会合并为一份，不计入重复；Codex 会列出全部同名条目，Claude 未验证，按会列出处理。全选四个工具时选择 `.agents/skills` 与 `.claude/skills` 两份：Codex、DeepSeek 各读到一份，OpenCode 两份合并，Claude 一份，且不使用旧版目录。只选 DeepSeek+OpenCode+Codex 时，一份 `.agents/skills` 就覆盖全部。测试列出全局和项目的全部 16 个选择子集。

计划只撤下已有收据且无外部修改的多余路径，不会为减少副本删除未拥有的目录。未管理副本、自定义目录、跨全局/项目同名包仍可能导致运行时重复；所选集合的最优放置不意味着这些外部副本已经消失。完整 bundle 指纹相同的计划目标显示“接管”，apply/rollback 均只改收据；内容不同仍冲突。

### 哈希、暂存与保留

v2 bundle 哈希对排序后的路径、权限和各文件字节哈希流式汇总；单文件哈希缓存包含 path、size、mtimeMs、ino，并额外检查 ctimeMs、mode。revision 只包含 manifest/device/state 与 bundle 哈希。plan 不构造 base64 bundle；apply 仅在实际写入和快照备份时加载完整包。未变化的旧版收据及旧部署快照仍接受 v1 JSON/base64 哈希；兼容哈希按当前 v2 哈希缓存，不会把升级本身当成本地偏离。

bundle 暂存使用 `.hsync-staging-UUID`，相邻 JSON sidecar 标记 HarnessSync 所有权；普通原子文件使用 `.hsync-file-UUID`。plan/doctor 只检测，apply 在锁内清理有合法 sidecar 的安全残留。存在 `-old` 原件备份的中断重命名会阻止部署并保留证据，需要先恢复未完成部署并检查；不能把唯一原件当垃圾删除。旧版本未写所有权标记的残留、未知命名目录和损坏标记不自动删除。

成功 apply 后保留最新 20 条部署及更旧的 pending/failed 记录；未完成检查扫描全部记录，不受 GUI 列表长度限制。最新部署回滚仍保留权限和原始 bundle。指令新文件使用 0644，已有文件保留 mode；bundle 和 atomicWrite 显式 chmod，避免 umask 丢失源权限。原先指令部署已有明确的 0644/保留权限分支，原子写入的默认 0600 用于本地 JSON，没有盲目改为 0644。

最终验证：ARM64 Node 22 下 core 18 项、deployment 14 项测试通过，`npx tsc --noEmit` 通过。40 个小技能（各 SKILL.md + 4 KiB 资源）冷 plan 约 101–124 ms、80 次文件字节读取；热 plan 不重新读取哈希字节。这是合成夹具的读取复杂度验证，未将它宣称为真实 35 个技能、3 MB 数据的等量性能对比。
