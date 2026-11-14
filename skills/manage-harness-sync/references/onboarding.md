# 首次初始化的整理流程

先运行 `sync status`。已经连接时跳过第一台判断；未连接先问“这是你第一台使用 HarnessSync 的设备吗？”。无论答案如何，gh 已登录时查 `gh repo view harness-sync-config --json name,url,visibility`（也可用 `onboard repository`）；说明可能使用了其他名字，失败不等于没有仓库。已有仓库或不是第一台时，先确认仓库 URL、`sync setup --url <url>` 拉取共享库，再比较扫描结果并导入。

先读取提示词中的扫描 ID：`onboard show <id> --json`。扫描范围是已知用户技能目录、兼容目录与本机已绑定项目；不是全盘搜索，也不是模型有效上下文的完整列表。

## 技能整理

`onboard show` 每次按当前共享库重算 `inventory.skills[].library`（same/differs/absent）及 `inventory.summary.library` 三类计数。same 复用已有 ID 并接管原生副本；absent 普通导入。differs 先集中说明关键差异并给建议：`skills import <目录> --use-library` 用共享库版本，`--replace-library` 替换共享库，`--name <新名称>` 两份都留。Agent 合并先写到独立目录，再用 `--replace-library` 导入。替换共享库或合并之前必须得到用户明确同意，替换会同步到其他设备。

使用 `inventory.skills` 中的 `hash` 比较完整目录（普通权限规范化为 Git 可保存的 644/755，执行位参与比较）。`paths` 表示同一真实目录的多个入口，不应重复导入；`duplicates` 中的 `variants` 大于一，表示同名但内容不同。

先按 `origin` 筛选：`user` 为用户来源；`platform` 为 Claude 云端同步（`skills/synced/<uuid>/`）或插件；`system` 为 `.system` 目录或 `.codex-system-skills.marker` 标记的系统内置；`tool-managed` 为技能锁文件列出的工具托管条目（含来源 URL）。后三类默认排除，说明 `originReason` / `sourceUrl`，避免复制会被其他工具覆写的内容。损坏锁文件在 warnings 中报告，分类仍可继续；无已知托管证据不等于已验证用户所有权。

默认处理 `valid=true`、`origin=user`、`ignored=false` 的通用技能；明确属于项目的保留项目范围，已有管理条目不重复创建。相同名称和完整内容的多个副本可共用一份源配置，并逐个显式接管匹配的原生目录。包内部有链接、无效元数据或平铺文件时，先说明问题，保留原件；不要批量执行扫描到的脚本。

对同名不同内容的版本，先对比正文、脚本、资源与适用范围。不能仅按时间戳选新文件覆盖旧文件。需要用户判断时，将差异集中成少量问题。为保留不同版本可在临时目录整理不同的有效技能名称后导入，原件保持可恢复。

## 链接技能的集中选择

将所有尚未管理且未忽略的用户链接技能列为一个分组问题，给出原始 `paths` 和真实 `path`，默认全部导入副本，用户可逐项选择外部保留。不要每个技能单独询问；得到选择后再处理。

导入副本：使用原始入口 `skills import <链接入口>`，核心从真实目录复制完整包。原生部署位置需显式 `--adopt`；导入后链接仍在，`plan` 显示“以副本替换链接”，`apply` 才替换，回滚恢复原始链接文本。包内链接仍然拒绝；链接父目录仍禁止写入。一个真实目录有多个原生入口时，接管完整内容相同且范围匹配的入口；兼容目录不属于可接管目标，应保留并报告。

外部保留：`onboard ignore <绝对入口路径...>` 记录所有相应 `paths` 到设备本地，不进入 Git。后续扫描标记 `ignored`，不再询问；同名部署目标显示“外部保留”信息且不写入。取消用 `onboard ignore <路径...> --remove`。

## 源目录刷新

导入记录原始入口和链接真实源目录，按技能 ID 保存在本机。即使原生链接已替换为副本，开发仓库的变化仍可检测。`status --json` / `doctor --json` 的 `sourceUpdates` 报告“源目录有更新”或无法读取；不会声称开发源与部署实时同步。

`skills refresh <id>` / `skills refresh --all` 用源目录完整包替换库内副本，包含资源删除、二进制内容及权限，保留范围、启停和显示名。之后仍需 `plan` / `apply`。名称改变则拒绝刷新，要求单独导入；不会自动改名或修复无效技能。旧 manifest 中的绝对 source 在下一次源修改时迁移到设备本地。

## 指令整理

`inventory.instructions` 包含主文件、覆盖文件、共享指令和规则片段。`active: false` 的覆盖关系应明确说明；不要把它视为运行时已经加载。比较文本、识别公共约定和冲突，把本机路径提取为变量，把真实的工具或项目差异保留。

先通过 `rules` 保存整理后的源指令。需要把主全局文件整体转为生成内容时，运行 `onboard stage-instructions <id> --keys <key1,key2>`。该命令只登记清单文件的完整指纹；不会立即覆盖原件。`plan` 会显示删除原内容和替换为合成结果的完整差异；源片段缺失或扫描后原件变化会阻止部署。部署前有完整快照，回滚恢复原件。

非主文件、规则片段与链接仍属于外部来源，不得借初始化名义静默删除。若它们仍可能与合成指令重复或矛盾，报告尚未解决的项。

## 发布与验收

把批量整理的具体结果汇总给用户，不要求用户逐条勾选每一个无歧义文件。先生成 `plan --json`，用户确认具体结果后再执行 `apply --plan <id>`。执行 `doctor --json` 并说明剩余冲突和外部来源。

Codex 的 `.agents/skills`、Claude 的 `.claude/skills` 可能被其他工具兼容扫描。选择单一 Harness 并不一定能严格排除其他工具，部署预览会提示此边界。共享配置的默认值适用于四个工具；旧条目保留原有选择，不自动扩大作用域。

提示词和扫描快照只保存在本机初始化目录，不进入源配置 Git。用户主动粘贴给哪个 Harness，由用户决定；不要自行上传扫描资料。

## 跨设备同步（可选）

如果之后才连接已有仓库，同内容条目会自动合并，不同内容会成为冲突，用 `hsync sync conflicts` 查看 `<store>/conflicts/<entryId>/` 并处理。

第一台且没有已有同步仓库时，本机初始化完成后可介绍 `hsync sync setup --create` 或 `hsync sync setup --url <仓库URL>`。按可用命令帮助执行；这是可选末步，不把本地 Git 历史当作已完成跨设备同步。
