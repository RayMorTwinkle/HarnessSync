# 本机同名技能冲突（v0.4）

选择存放在配置库根目录的 `state.json`（`repo/` 外），以目标绝对路径为键，不进入源 Git。选择、源库版本和原生指纹共同参与计划 ID。默认冲突仍阻止整次部署。

## 使用

```sh
hsync conflicts list
hsync conflicts choose my-skill --use library
hsync conflicts choose /临时设备目录/skills/my-skill --use native
hsync conflicts choose /临时设备目录/skills/another-skill --use skip
hsync conflicts clear /临时设备目录/skills/my-skill
hsync conflicts clear
hsync plan
hsync apply --plan <新的计划ID>
```

名称必须唯一匹配一个冲突；多个目标同名时使用完整路径。clear 的可选参数是完整路径，省略清除所有选择。plan 中每个可解决冲突均有 `conflictOptions: ["library","native","skip"]`。

- `library`：计划状态 `replace`。预先保存完整原件，再写入库版本并登记收据。原件包括隐藏文件、空目录、二进制、权限和符号链接；回滚在暂存目录按父子顺序重建全部内容，成功后切换目标，重建失败保留当前目标并可重试。仅允许解除最终目标链接，父目录链接仍拒绝。绝不通过链接写入。
- `native`：选择时立即修改源库并产生源配置 Git 提交；保留条目 ID、作用域、启停、显示名及原 frontmatter 中原生未提供的字段。原生提供的字段覆盖库中同名字段。必须有合法 SKILL.md，name 必须与对应条目一致。源库资源以原生包完整替换，移除原生已不存在的库资源。仍需 plan/apply 才登记收据；普通目录按 `adopt` 处理，不改写原生。为避免仅因保留元数据而反复部署，收据记录收库后的源指纹，源库再次变化才更新。最终目标是链接时部署为 `replace` 副本，快照和回滚保留链接。
- `skip`：状态 `skipped`，不写入、不登记收据，其余目标继续部署。doctor 的 `skipped` 数组列为待处理；不计入可部署变更数量，不单独使 healthy 变为 false。

选择绑定原生完整指纹（含权限、隐藏文件、目录、链接路径；最终链接还包含可读取的目标内容）。指纹采用流式读取，不受快照容量限制。变化后选择不再生效，状态回到 conflict；重新选择或 clear 即可。失效记录保留供诊断，不在只读 plan 中写盘。成功部署后记录仍保留，但不会覆盖已托管路径的外部修改保护。

## HTTP API

沿用会话 token（`x-harness-sync-token`）、Host 和 Origin 校验。响应统一为 `{ "ok": true, "data": ... }`；失败为 `{ "ok": false, "code": "STALE_TARGET", "message": "..." }`。

| 方法和路径                   | 请求                      | data                                                 |
| ---------------------------- | ------------------------- | ---------------------------------------------------- |
| `GET /api/conflicts`         | 无                        | 含已选 replace/skipped 的冲突数组                    |
| `POST /api/conflicts/choose` | `{path,use,fingerprint?}` | `{path,use,fingerprint}`                             |
| `POST /api/conflicts/clear`  | `{path?}`                 | `{choices: {...}}`                                   |
| `GET /api/plan`              | 无                        | 完整公开计划，含 ID、版本、changes、errors、warnings |

`path` 在 choose 中也可以是唯一技能名；clear 只接受路径。建议前端提交列表响应中的 `conflictFingerprint` 作为请求 `fingerprint`，以拒绝基于旧预览的选择（HTTP 409）。未提供时针对调用时的当前冲突选择。设备锁串行化所有选择和部署；请求未携带旧指纹时，后到的选择可以覆盖先前选择。请求不自动部署。

请求示例：

```json
{
  "path": "/临时设备目录/skills/my-skill",
  "use": "library",
  "fingerprint": "原生完整指纹"
}
```

列表与计划 change 示例（省略普通路径、harness 等字段）：

```json
{
  "status": "replace",
  "sourceId": "技能UUID",
  "conflictFingerprint": "原生完整指纹",
  "conflictOptions": ["library", "native", "skip"],
  "diff": "SKILL.md 的 unified diff（链接目标另附链接说明）",
  "fileChanges": [
    {
      "path": "SKILL.md",
      "status": "modified",
      "binary": false,
      "beforeSize": 80,
      "afterSize": 90,
      "beforeHash": "指纹",
      "afterHash": "指纹",
      "diff": "unified diff"
    },
    {
      "path": "asset.bin",
      "status": "removed",
      "binary": true,
      "beforeSize": 3,
      "afterSize": 0,
      "beforeHash": "指纹",
      "afterHash": "指纹"
    }
  ]
}
```

`fileChanges.status` 为 added/removed/modified，含权限变化；文本提供 diff，二进制只提供大小和内容指纹（base64 内容的 SHA-256）。内部符号链接同样列入摘要，`beforeLink` 提供链接目标路径，diff 明确标注链接；不会读取内部链接目标。链接的 beforeSize/beforeHash 取链接路径文本，之后的大小和指纹取库文件内容。源包仍拒绝链接，因此不会创建新的链接或替链接改指向。无法读取的链接目标仅显示链接说明，仍能替换和恢复链接本身。`GET /api/snapshot` 的 plan 同样包含这些字段。快照正文不通过计划 API 暴露。

## 保留上限和边界

原生单目录快照最多 64 MiB 原始文件、10000 条目；单次部署快照序列化后最多 64 MiB，超出在修改原生前拒绝。超限的冲突仍会列出并可选择 skip，差异说明会提示无法生成完整预览；选择 library 时先检查原件能否完整保存。成功部署后清理到最多 20 条、总计 128 MiB；优先保留 pending 恢复记录和最新 applied 回滚点，failed 记录可被淘汰。新指纹使用版本前缀，仍兼容校验旧版快照；旧选择需要重新预览确认。旧版本或人工加入的超大恢复记录不会强制删除，可能使总量超预算，需先恢复并处理历史。清理失败会返回部署成功但清理失败的 warning。

原生快照和源包的路径字典均使用无原型对象，保留 `__proto__`、`constructor` 等合法文件名。完整恢复覆盖文件字节、POSIX mode、目录结构和链接路径；不保存 ACL、扩展属性、所有者、时间戳和硬链接关系。源技能包沿用现有限制：16 MiB、1000 文件，跳过 `.git`、`node_modules`、`.DS_Store`，拒绝包内链接；take-native 同样遵守。原生快照不跳过这些目录。源配置提交使用现有 Store.mutate 回滚机制；它不是防断电的源库事务日志。

新增测试位于 `tests/conflicts.test.ts`，覆盖替换/回滚、隐藏文件、二进制和执行位、元数据、失效、skip 隔离、并发串行化、过期计划、链接与 pending 中断恢复、提交及部署失败、CLI、HTTP 断连、鉴权和容量上限。此功能不访问远端网络，HTTP 请求在完整解析后才调用 core；测试没有模拟真实断电或操作系统故障。

## 前端接入检查

共享 `Change.status` 已新增 `replace`、`skipped`。前端当前 `src/ui/main.tsx` 的 labels 尚未包含这两项，`tsc --noEmit` 在 1975、1993、2018 行报告 TS7053；按后端任务分工未修改 UI。前端需补齐 labels、状态排序和计数，展示 `fileChanges`、选择按钮及 doctor 待处理项。后端无类型检查错误，但全项目类型检查需要这项前端接入才能通过。
