# Git 字节存储

技能包中的 `.gitignore`、`.gitattributes`、`.gitmodules` 等普通文件是包数据。它们不决定配置库提交范围，也不转换技能文件的字节。包内 `.git` 由现有 `readBundle` 导入规则跳过；原有 `node_modules`、`.DS_Store` 导入排除不变。上传范围由设备本地 `sync-ignore.json` 控制，源库始终保存已导入的完整包。

## 方案与依据

已核对本机 Git 随附的 `gitattributes(5)` 和 `git-hash-object(1)` 手册（`git help gitattributes`、`git help hash-object`）：`$GIT_DIR/info/attributes` 优先级最高，其次是文件所在目录和祖先目录的 `.gitattributes`，最后是全局及系统属性。子目录属性不会覆盖 info/attributes。`hash-object --no-filters` 忽略属性及换行转换；不带 `--path` 的 `--stdin` 也隐含此行为。

采用底层命令，避免依赖属性覆盖列表：仅加 `-text -diff -merge` 不能完整覆盖 clean/smudge、ident、编码等转换。也不修改用户已有的仓库属性配置。

1. 从磁盘枚举文件，拒绝符号链接与特殊文件；跳过 Git 内部目录和技能交换暂存目录。
2. 在配置根创建权限为 0700 的唯一临时目录和独立索引，以 `read-tree --empty` 开始。磁盘文件直接提供路径；内存包先写成目录内的 0600 临时文件。一次 `hash-object -w --no-filters --stdin-paths` 批量保存全部原始字节，不套用路径对应的属性。路径按 UTF-8 字节作 Git 的 C 风格引用，支持换行、制表符、引号、反斜杠及中文文件名。路径清单与索引清单通过临时文件描述符传入，避免同步管道阻塞。
3. 用 NUL 分隔的 `update-index -z --index-info` 保存路径、blob 与 100644/100755，支持制表符及换行文件名。`write-tree` 生成树，正常或异常返回时清理整个临时目录（含包数据、输入清单、索引及锁文件）。每次建树最多 4 个 Git 进程，与文件数无关。
4. 普通提交、同步合并共用上述逻辑，以 `commit-tree` 留存；普通提交用带旧提交校验的 `update-ref` 更新 HEAD。`read-tree` 只更新常规索引，不检出工作区。树未改变时不新增普通提交。
5. 忽略上传投影共用建树逻辑，但只继承远端提交，保持原有上传历史隔离。
6. 恢复、冲突和 Git 技能下载直接读取 blob 后写文件；不使用 checkout、archive 或属性驱动的文件合并。执行位来自树模式，普通权限按 Git 模型规范化为 644/755。恢复索引的 `reset --mixed --no-refresh` 不刷新工作区，避免内容比较触发过滤器。

不缓存 size/mtime 对应的旧 blob：同大小、同修改时间的文件也可能已改变。直接比较旧 blob 同样需要读取全部字节，因此目前每次批量重新哈希，由 Git 复用已有对象，优先保证遗漏补收、外部修改和恢复的正确性。磁盘路径不再经过 Node 读取、转 base64 或复制到临时目录。

每次提交重新枚举，因此现有安装中工作区仍在的 `.env`、`runtime.conf` 等遗漏文件会自动进入下一次本地提交和后续同步。不会重写旧历史；旧提交没有保存且工作区也已丢失的字节无法重建。手工在库内执行 `git add`、`checkout` 或其他 Git porcelain 命令仍受 Git 自身规则影响；保真保证适用于 HarnessSync 的 core 操作。

## Git 调用盘点

通过检索 `git(`、`execFileSync("git"`，并补查异步 `execFile`、命令执行器与 runner，覆盖以下全部入口：

| 位置                                                    | 调用用途与字节处理                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/store.ts`                                     | 初始化与仓库级配置；普通提交通过独立索引和原始 blob 建树；历史 log 只读提交元数据；失败时只恢复索引和引用，不检出文件。                                                                                                   |
| `src/core/sync.ts` 的 history/read                      | `log`、`ls-tree`、`diff-tree --name-status` 比较提交树、blob ID 与模式；包内容用二进制 `cat-file blob` 读取，不 trim 或解码文件字节；JSON 元数据单独解析。                                                                |
| `src/core/sync.ts` 的合并、解决、恢复、撤销             | 现有对象三方合并和快照直接写包；合并改用 Store 建树，解决与恢复调用 Store.commit；撤销提交复用已保存的树；`reset --soft` 或 `--mixed --no-refresh` 只更新引用/索引。                                                      |
| `src/core/sync.ts` 的上传                               | `uploadCommit` 先应用本机忽略并保留远端既有忽略版本，然后共用 Store.writeTree；桥接提交复用树。`fetch`、`push`、`ls-remote`、`merge-base`、`rev-parse`、`rev-list`、`check-ref-format`、安全 refs 操作不检出或改写 blob。 |
| `src/core/git-skills.ts`                                | 上游 init/fetch/ls-remote/rev-parse/ls-tree；安装、比较和更新从 ls-tree/cat-file 具体化原始字节，替代原有 checkout；选中包中的链接仍由 readBundle 拒绝，不执行包内脚本。                                                  |
| `src/core/sync-check.ts`                                | runner 执行 Git 版本检查与 ls-remote 连接检查，不操作包内容。                                                                                                                                                             |
| `src/core/backup.ts`、`native-snapshot.ts`、`uninstall.ts` | 备份与可读源库导出直接复制文件，不使用 Git archive/checkout；因此包内属性不会影响备份或导出，卸载导出仍排除源库根的 `.git`。                                                                                              |

## 回归覆盖

`tests/git-byte-storage.test.ts` 使用假 HOME、本地裸仓库和合成凭证数据，验证带 Git 忽略/属性规则的完整导入、CRLF 与二进制、无扩展名脚本执行位、过滤器不执行、换行文件名、旧遗漏补收、删除与执行位修改、双设备合并上传、历史、源恢复与撤销、本机上传忽略、链接拒绝和 Git 来源安装。500 文件测试实际拦截 Git 命令，比较小包和大包的提交调用数，实测有父版本的小包与 500 文件包新增提交均为 9 次调用，内存建树为 4 次，并校验临时权限和失败清理；另验证大小和修改时间相同的内容更新仍被保存。不访问外部仓库。
