import { SyncIgnore } from "./core/sync-ignore.ts";
import { Backups } from "./core/backup.ts";
import { Uninstaller } from "./core/uninstall.ts";
import {
  registry,
  pluginDirectory,
  validateHarnessFile,
} from "./core/harness-registry.ts";
import {
  installGitSkills,
  updateGitSkills,
  diffGitSkill,
  detachGitSkill,
  listedSkills,
} from "./core/git-skills.ts";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { cliNoticeOutput } from "./core/notices.ts";
import { UpdateChecker } from "./core/update-checks.ts";
import { Settings } from "./core/settings.ts";
import { LoginService, rotateServiceLog } from "./core/service.ts";
import { autoDeploy, lastAutoDeploy } from "./core/auto-deploy.ts";
import { startBackgroundScheduler } from "./core/sync-scheduler.ts";
import { Sync } from "./core/sync.ts";
import { checkSync } from "./core/sync-check.ts";
import {
  ignoreNativePaths,
  refreshSkills,
  skillSource,
  sourceStatus,
} from "./core/skill-sources.ts";
import { Store } from "./core/store.ts";
import { Engine, publicPlan } from "./core/engine.ts";
import { startServer } from "./server.ts";
import { scopeSchema, harnessIds, type Scope } from "./shared/types.ts";
import {
  createOnboarding,
  findOnboardingRepository,
  getOnboarding,
  bootstrapOnboarding,
  stageInstructions,
  unstageInstructions,
} from "./core/onboarding.ts";
import { AppError, parseSkill } from "./core/files.ts";
import { installSelfSkill } from "./core/self-skill.ts";
import { openWebUi, parsePort } from "./web-ui.ts";

const cli = new Command()
  .name("hsync")
  .description("HarnessSync · 统一管理四种 AI Harness 的指令与技能")
  .version("0.5.0")
  .option("--root <directory>", "配置库目录")
  .option("--json", "机器可读 JSON 输出");
let store: Store | undefined;
const getStore = async () =>
  (store ||= await new Store(cli.opts().root).init());
const output = (data: unknown) =>
  console.log(JSON.stringify(data, null, cli.opts().json ? 0 : 2));
const run =
  (fn: (...args: any[]) => Promise<unknown> | unknown) =>
  async (...args: any[]) => {
    let value = await fn(...args);
    const cmd =
      args.at(-1) instanceof Command ? (args.at(-1) as Command) : undefined;
    const group = cmd?.parent?.name(),
      name = cmd?.name();
    const mutates =
      group &&
      name &&
      ((["rules", "skills", "projects", "device"].includes(group) &&
        !["list", "show", "updates", "diff"].includes(name)) ||
        (group === "conflicts" && ["choose", "clear"].includes(name)) ||
        (group === "sync" &&
          ["setup", "now", "resolve", "undo"].includes(name)) ||
        (group === "hsync" && ["restore", "self-skill"].includes(name)) ||
        (group === "onboard" &&
          ["ignore", "unstage-instructions"].includes(name)) ||
        (group === "config" &&
          name === "set" &&
          args[0] === "deploy.auto" &&
          args[1] === "true"));
    if (
      mutates &&
      store &&
      !(value as { selectionRequired?: boolean })?.selectionRequired
    ) {
      const result = await autoDeploy(
        new Engine(store),
        `cli:${group}/${name}`,
      );
      if (group === "sync")
        value = { ...(value as object), ...(await new Sync(store).status()) };
      if (!Array.isArray(value))
        value = { ...(value as object), autoDeploy: result };
    }
    if (value !== undefined)
      output(
        // After uninstalling there is nothing left to remind about.
        store && fs.existsSync(store.root) && name !== "uninstall"
          ? await cliNoticeOutput(store, value, {
              quiet:
                (group === "hsync" && name === "status") ||
                (group === "sync" &&
                  ["status", "conflicts"].includes(name || "")),
            })
          : value,
      );
  };
const scopeOptions = (c: Command) =>
  c
    .option("--scope <kind>", "global / device / project", "global")
    .option("--target <id>", "设备或项目 ID")
    .option(
      "--harness <ids>",
      "已注册 ID（逗号分隔）或 all",
      harnessIds.join(","),
    );
const validateHarnessIds = (ids: string[]) => {
  if (ids.length === 1 && ids[0] === "all") return [...harnessIds];
  const known = registry(
    store?.home,
    store?.root || cli.opts().root,
  ).entries.map((e) => e.manifest.id);
  for (const id of ids)
    if (!known.includes(id))
      throw new AppError("UNKNOWN_HARNESS", `未知 Harness：${id}`);
  return ids;
};
const scope = (o: any) =>
  scopeSchema.parse({
    kind: o.scope,
    target: o.target,
    harnesses: validateHarnessIds(o.harness.split(",")),
  });
// Edits keep the stored scope; only options given on the command line override it.
const editScope = (o: any, cmd: Command, current: Scope) => {
  const given = (name: string) => cmd.getOptionValueSource(name) === "cli";
  const kind = given("scope") ? o.scope : current.kind;
  return scopeSchema.parse({
    kind,
    target: given("target")
      ? o.target
      : kind === current.kind
        ? current.target
        : undefined,
    harnesses: given("harness")
      ? validateHarnessIds(o.harness.split(","))
      : current.harnesses,
  });
};
const findId = (
  list: { id: string; name?: string; title?: string }[],
  input: string,
) => {
  const matches = list.filter(
    (x) => x.id === input || x.name === input || x.title === input,
  );
  if (matches.length !== 1)
    throw new AppError("NOT_FOUND", "未找到唯一条目，请使用完整 ID");
  return matches[0].id;
};
const harness = cli.command("harness").description("管理声明式 Harness 插件");
harness
  .command("list")
  .option("--json", "JSON 输出")
  .action(run(async () => (await getStore()).harnesses()));
harness
  .command("dir")
  .action(() => console.log(pluginDirectory(undefined, cli.opts().root)));
harness.command("validate <file>").action(
  run((file: string) => {
    const result = validateHarnessFile(
      path.resolve(file),
      undefined,
      cli.opts().root,
    );
    if (result.error) {
      process.exitCode = 1;
      return result.error;
    }
    return { valid: true, id: result.manifest!.id };
  }),
);
for (const action of ["enable", "disable"])
  harness
    .command(`${action} <id>`)
    .action(
      run(async (id: string) =>
        (await getStore()).setHarnessEnabled(id, action === "enable"),
      ),
    );
cli
  .command("init")
  .description("初始化本地配置库")
  .action(run(async () => ({ root: (await getStore()).root })));
cli
  .command("status")
  .description("查看所有源配置和部署状态")
  .action(
    run(async () => {
      const x = new Engine(await getStore()).snapshot();
      return {
        ...x,
        sourceUpdates: sourceStatus(await getStore()).filter(
          (s) => s.changed || s.note.startsWith("源目录无法读取"),
        ),
        plan: publicPlan(x.plan),
      };
    }),
  );
cli
  .command("scan")
  .description("扫描已有原生 Skills 和全局指令（只读）")
  .action(run(async () => new Engine(await getStore()).inspect()));
cli
  .command("plan")
  .description("预览完整部署差异")
  .action(run(async () => publicPlan(new Engine(await getStore()).plan())));
const conflicts = cli.command("conflicts").description("处理本机同名技能冲突");
conflicts
  .command("list")
  .action(run(async () => new Engine(await getStore()).conflicts()));
conflicts
  .command("choose <target>")
  .requiredOption("--use <choice>", "library / native / skip")
  .action(
    run(async (target, o) =>
      new Engine(await getStore()).chooseConflict(target, o.use),
    ),
  );
conflicts
  .command("clear [path]")
  .action(
    run(async (target) => new Engine(await getStore()).clearConflicts(target)),
  );
cli
  .command("apply")
  .description("部署已预览的计划")
  .requiredOption("--plan <id>", "来自 plan 的计划 ID")
  .action(run(async (o) => new Engine(await getStore()).apply(o.plan)));
cli
  .command("doctor")
  .description("检查部署偏离、变量和作用域")
  .action(
    run(async () => {
      const engine = new Engine(await getStore());
      const plan = engine.plan();
      const conflicts = plan.changes.filter((c) => c.status === "conflict");
      const pending = engine
        .deployments()
        .filter((d) => d.status === "pending");
      const healthy =
        !conflicts.length && !plan.errors.length && !pending.length;
      if (!healthy) process.exitCode = 1;
      return {
        healthy,
        autoDeploy: lastAutoDeploy(engine.store),
        sourceUpdates: sourceStatus(await getStore()).filter(
          (s) => s.changed || s.note.startsWith("源目录无法读取"),
        ),
        errors: plan.errors,
        warnings: plan.warnings,
        conflicts: conflicts.map((c) => ({ path: c.path, reason: c.reason })),
        skipped: plan.changes
          .filter((c) => c.status === "skipped")
          .map((c) => ({ path: c.path, reason: c.reason })),
        pendingDeployments: pending,
        pendingChanges: plan.changes.filter(
          (c) => !["unchanged", "conflict", "skipped"].includes(c.status),
        ).length,
        observed: "filesystem-only",
        sessionLoaded: "unknown",
      };
    }),
  );
cli
  .command("history")
  .description("查看源配置 Git 历史和部署历史")
  .action(
    run(async () => {
      const s = await getStore();
      return { source: s.history(), deployments: new Engine(s).deployments() };
    }),
  );
cli
  .command("restore <commit>")
  .description("恢复源配置版本（自动部署开启时写入干净计划）")
  .action(run(async (sha) => (await getStore()).restoreSource(sha)));
cli
  .command("rollback <deployment>")
  .description("回滚最近一次部署（保留源配置）")
  .action(run(async (id) => new Engine(await getStore()).rollback(id)));
cli
  .command("self-skill")
  .description("将 AI 管理 Skill 安装到源配置库，按自动部署设置写入各工具")
  .action(run(async () => installSelfSkill(await getStore())));
const backup = cli.command("backup").description("备份与恢复原生配置");
backup
  .command("create")
  .option("--confirm-large", "确认复制超过 500 MB 的备份")
  .action(
    run(async (o) => new Backups(await getStore()).create(o.confirmLarge)),
  );
backup
  .command("list")
  .action(run(async () => new Backups(await getStore()).list()));
backup
  .command("verify <dir>")
  .action(
    run(async (dir) => ({
      valid: true,
      manifest: new Backups(await getStore()).verify(dir),
    })),
  );
backup
  .command("restore [dir]")
  .option("--plan <id>", "执行已预览的计划")
  .option("--overwrite <paths...>", "覆盖指定冲突路径")
  .action(
    run(async (dir, o) => {
      const b = new Backups(await getStore());
      return o.plan ? b.restore(o.plan, dir, o.overwrite) : b.plan(dir);
    }),
  );
cli
  .command("uninstall")
  .option("--restore", "恢复备份（推荐）")
  .option("--keep-files", "保留已部署文件")
  .option("--delete-library", "删除本机配置库")
  .option("--plan <id>", "执行已预览的计划")
  .action(
    run(async (o) => {
      const u = new Uninstaller(await getStore());
      if (o.plan) return u.apply(o.plan);
      if (!!o.restore === !!o.keepFiles)
        throw new AppError(
          "UNINSTALL_MODE",
          "请选择 --restore 或 --keep-files",
        );
      return u.plan({
        mode: o.restore ? "restore" : "keep-files",
        deleteLibrary: !!o.deleteLibrary,
      });
    }),
  );

const onboard = cli
  .command("onboard")
  .description("扫描、安装管理技能并生成 AI 初始化提示词");
onboard
  .command("repository")
  .description("检查是否已连接同步或已存在默认 GitHub 同步仓库（不连接）")
  .action(run(async () => findOnboardingRepository(await getStore())));
onboard
  .command("scan")
  .description("保存一份可追溯的本机扫描清单")
  .action(run(async () => createOnboarding(await getStore())));
onboard
  .command("show [id]")
  .description("读取初始化扫描清单和提示词")
  .action(run(async (id) => getOnboarding(await getStore(), id)));
onboard
  .command("prepare")
  .description("扫描并仅部署管理技能，准备交给任意 Harness 的提示词")
  .action(
    run(async () => {
      const s = await getStore();
      const record = await createOnboarding(s);
      return bootstrapOnboarding(s, record.id);
    }),
  );
onboard
  .command("bootstrap <id>")
  .description("给检测到的 Harness 安装或更新中文管理技能")
  .action(run(async (id) => bootstrapOnboarding(await getStore(), id)));
onboard
  .command("stage-instructions <id>")
  .requiredOption("--keys <keys>", "扫描指令 key，逗号分隔")
  .description("登记主全局指令完整替换，之后必须预览并部署")
  .action(
    run(async (id, o) =>
      stageInstructions(await getStore(), id, o.keys.split(",")),
    ),
  );
onboard
  .command("unstage-instructions")
  .description("取消尚未发布的全局指令替换登记")
  .action(run(async () => unstageInstructions(await getStore())));
const sync = cli.command("sync").description("通过用户私有 Git 仓库同步源配置");
sync
  .command("check")
  .description("连接前检查 Git、GitHub 登录及仓库权限")
  .option("--url <git-url>")
  .option("--create [name]")
  .action(run(async (o) => checkSync(o, { store: await getStore() })));
sync
  .command("setup")
  .option("--url <git-url>")
  .option("--create [name]")
  .option("--branch <branch>")
  .action(run(async (o) => new Sync(await getStore()).setup(o)));
sync
  .command("status")
  .action(run(async () => new Sync(await getStore()).status()));
sync
  .command("conflicts")
  .action(run(async () => new Sync(await getStore()).conflicts()));
sync.command("now").action(run(async () => new Sync(await getStore()).now()));
const ignore = sync.command("ignore").description("本机上传忽略规则");
ignore
  .command("list")
  .action(run(async () => new SyncIgnore(await getStore()).status()));
for (const action of ["add", "remove"] as const)
  ignore
    .command(`${action} <rules...>`)
    .action(
      run(async (rules) =>
        new SyncIgnore(await getStore()).update({ [action]: rules }),
      ),
    );
const auto = sync.command("auto").description("设置本机自动同步");
for (const mode of ["on", "off"])
  auto
    .command(mode)
    .action(
      run(async () =>
        new Sync(await getStore()).setAuto({ enabled: mode === "on" }),
      ),
    );
auto
  .command("set")
  .option("--debounce <秒>", "编辑停止后的等待秒数")
  .option("--interval <分钟>", "定期同步间隔")
  .action(
    run(async (o) =>
      new Sync(await getStore()).setAuto({
        ...(o.debounce !== undefined
          ? { debounceSeconds: Number(o.debounce) }
          : {}),
        ...(o.interval !== undefined
          ? { pullIntervalMinutes: Number(o.interval) }
          : {}),
      }),
    ),
  );
sync
  .command("history")
  .action(run(async () => new Sync(await getStore()).history()));
sync.command("undo").action(run(async () => new Sync(await getStore()).undo()));
sync
  .command("watch")
  .description("前台自动同步，按 Ctrl+C 退出")
  .action(async () => {
    const background = await startBackgroundScheduler(await getStore());
    const stop = () => background.close();
    output({
      message: "自动同步调度器已启动，按 Ctrl+C 退出；设置关闭时等待开启",
    });
    const close = async () => {
      await stop();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
sync
  .command("resolve <entry-id>")
  .requiredOption("--keep <choice>", "local / remote / both / merged")
  .option("--from <dir>", "完整合并结果目录")
  .action(
    run(async (id, o) =>
      new Sync(await getStore()).resolve(id, o.keep, o.from),
    ),
  );
sync
  .command("disconnect")
  .action(run(async () => new Sync(await getStore()).disconnect()));
onboard
  .command("ignore <paths...>")
  .description("将链接入口标记为本机外部保留，后续不再推荐导入")
  .option("--remove", "取消外部保留")
  .action(
    run(async (paths, o) =>
      ignoreNativePaths(await getStore(), paths, !o.remove),
    ),
  );
const rules = cli.command("rules").description("管理全局、设备或项目指令");
rules
  .command("list")
  .action(run(async () => (await getStore()).manifest().rules));
scopeOptions(
  rules
    .command("add")
    .requiredOption("--title <title>")
    .requiredOption("--file <file>"),
).action(
  run(async (o) =>
    (await getStore()).saveRule({
      title: o.title,
      body: fs.readFileSync(path.resolve(o.file), "utf8"),
      scope: scope(o),
    }),
  ),
);
scopeOptions(
  rules.command("edit <id>").option("--title <title>").option("--file <file>"),
).action(
  run(async (id, o, cmd) => {
    const s = await getStore();
    const key = findId(s.manifest().rules, id);
    const current = s.manifest().rules.find((r) => r.id === key)!;
    return s.saveRule(
      {
        ...current,
        title: o.title ?? current.title,
        body: o.file
          ? fs.readFileSync(path.resolve(o.file), "utf8")
          : current.body,
        scope: editScope(o, cmd, current.scope),
      },
      key,
    );
  }),
);
rules.command("remove <id>").action(
  run(async (id) => {
    const s = await getStore();
    return s.remove("rules", findId(s.manifest().rules, id));
  }),
);
const skills = cli.command("skills").description("管理完整 Skill 包");
skills.command("list").action(run(async () => listedSkills(await getStore())));
scopeOptions(
  skills
    .command("install <source>")
    .description("从 Git 仓库安装技能，安装后按自动部署设置写入各工具")
    .option("--skill <names>", "逗号分隔的名称或仓库子路径")
    .option("--all", "安装所有候选技能")
    .option("--ref <ref>", "分支、标签或提交"),
).action(
  run(async (source, o) => {
    const result = await installGitSkills(await getStore(), source, {
      skills: o.skill?.split(","),
      all: o.all,
      ref: o.ref,
      scope: scope(o),
    });
    if (result.selectionRequired) process.exitCode = 1;
    return result;
  }),
);
skills
  .command("updates [ids...]")
  .description("检查 Git 上游更新，不下载内容")
  .action(
    run(async (ids) => {
      const results = await new UpdateChecker(await getStore()).now(ids);
      if (results.some((result) => result.error)) process.exitCode = 1;
      return results;
    }),
  );
skills
  .command("update <ids...>")
  .option("--force", "覆盖源库中的本地修改")
  .action(
    run(async (ids, o) =>
      updateGitSkills(await getStore(), ids, Boolean(o.force)),
    ),
  );
skills
  .command("diff <id>")
  .description("比较库版本与最新 Git 上游")
  .action(run(async (id) => diffGitSkill(await getStore(), id)));
skills
  .command("detach <id>")
  .description("删除 Git 来源，保留技能内容")
  .action(run(async (id) => detachGitSkill(await getStore(), id)));
skills
  .command("refresh [id]")
  .description("从本机源目录刷新完整技能包，保留范围、启停和显示名")
  .option("--all", "刷新所有有本机源目录的技能")
  .action(
    run(async (id, o) => {
      const s = await getStore();
      if (Boolean(id) === Boolean(o.all))
        throw new AppError("INVALID_ARGUMENT", "请选择技能 ID 或 --all");
      return refreshSkills(
        s,
        o.all
          ? s
              .manifest()
              .skills.filter((x) => skillSource(s, x.id))
              .map((x) => x.id)
          : [findId(s.manifest().skills, id)],
      );
    }),
  );
skills.command("show <id>").action(
  run(async (id) => {
    const s = await getStore();
    const key = findId(s.manifest().skills, id);
    return {
      ...listedSkills(s).find((x) => x.id === key),
      ...parseSkill(
        fs.readFileSync(path.join(s.skillPath(key), "SKILL.md"), "utf8"),
      ),
    };
  }),
);
scopeOptions(
  skills
    .command("import <directory>")
    .option("--use-library", "用共享库版本接管，部署前显示替换差异")
    .option("--replace-library", "用此目录替换共享库同名技能，需用户明确同意")
    .option("--name <name>", "改名导入，两个版本都保留")
    .option(
      "--adopt",
      "同时接管这个已有原生目录，后续可由 HarnessSync 更新或撤下",
    ),
).action(
  run(async (dir, o) =>
    (await getStore()).importSkill(dir, scope(o), undefined, o.adopt, {
      useLibrary: o.useLibrary,
      replaceLibrary: o.replaceLibrary,
      name: o.name,
    }),
  ),
);
scopeOptions(
  skills
    .command("edit <id>")
    .requiredOption("--file <file>", "包含 YAML frontmatter 的 SKILL.md"),
).action(
  run(async (id, o, cmd) => {
    const s = await getStore();
    const value = parseSkill(fs.readFileSync(path.resolve(o.file), "utf8"));
    const key = findId(s.manifest().skills, id);
    const current = s.manifest().skills.find((x) => x.id === key)!;
    return s.saveSkill(
      {
        ...value,
        enabled: current.enabled,
        displayName: current.displayName,
        scope: editScope(o, cmd, current.scope),
      },
      key,
    );
  }),
);
for (const enabled of [true, false])
  skills.command(`${enabled ? "enable" : "disable"} <id>`).action(
    run(async (id) => {
      const s = await getStore();
      const key = findId(s.manifest().skills, id);
      const value = s.manifest().skills.find((x) => x.id === key)!;
      return s.saveSkill(
        {
          ...value,
          enabled,
          body: parseSkill(
            fs.readFileSync(path.join(s.skillPath(key), "SKILL.md"), "utf8"),
          ).body,
        },
        key,
      );
    }),
  );
skills.command("remove <id>").action(
  run(async (id) => {
    const s = await getStore();
    return s.remove("skills", findId(s.manifest().skills, id));
  }),
);
const projects = cli
  .command("projects")
  .description("按名称管理项目身份与本机目录");
projects.command("list").action(
  run(async () => {
    const s = await getStore();
    return s
      .manifest()
      .projects.map((p) => ({ ...p, path: s.device().bindings[p.id] }));
  }),
);
projects
  .command("add <name>")
  .option("--path <directory>")
  .action(
    run(async (name, o) =>
      (await getStore()).saveProject({ name, path: o.path }),
    ),
  );
projects.command("bind <id> <directory>").action(
  run(async (id, dir) => {
    const s = await getStore();
    const key = findId(s.manifest().projects, id);
    return s.saveProject(
      {
        name: s.manifest().projects.find((x) => x.id === key)!.name,
        path: dir,
      },
      key,
    );
  }),
);
projects.command("remove <id>").action(
  run(async (id) => {
    const s = await getStore();
    return s.remove("projects", findId(s.manifest().projects, id));
  }),
);
const device = cli.command("device").description("本机身份和本地变量");
device.command("show").action(run(async () => (await getStore()).device()));
device.command("name <name>").action(
  run(async (name) => {
    const s = await getStore();
    return s.saveDevice({ ...s.device(), name });
  }),
);
device.command("set <key> <value>").action(
  run(async (key, value) => {
    const s = await getStore();
    const d = s.device();
    return s.saveDevice({
      name: d.name,
      variables: { ...d.variables, [key]: value },
    });
  }),
);
device.command("unset <key>").action(
  run(async (key) => {
    const s = await getStore();
    const d = s.device();
    delete d.variables[key];
    return s.saveDevice(d);
  }),
);
function keepRunning(server: Awaited<ReturnType<typeof startServer>>) {
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
cli
  .command("open")
  .aliases(["gui", "webui"])
  .description("打开 Web UI，复用已有服务或启动本机服务")
  .option("--port <number>", "监听端口", "47821")
  .action(async (o) => {
    const result = await openWebUi(await getStore(), {
      port: parsePort(o.port),
    });
    const { running, ...info } = result;
    if (cli.opts().json) output(info);
    else {
      console.log(
        `HarnessSync → ${info.url}\n${info.reused ? "已复用当前配置库的本机服务" : "本机服务已启动，按 Ctrl+C 退出"}`,
      );
      if (info.warning) console.error(info.warning);
    }
    if (running) keepRunning(running);
  });
cli
  .command("serve")
  .description("启动本机 GUI")
  .option("--port <number>", "监听端口", "47821")
  .option("--background", "安静运行后台服务，不打开浏览器")
  .option("--dev", "启用前端热更新")
  .action(async (o) => {
    const port = parsePort(o.port);
    const s = await getStore();
    if (o.background) rotateServiceLog(s);
    const server = await startServer(s, {
      port,
      dev: o.dev,
      background: o.background,
    });
    if (!o.background)
      console.log(
        `HarnessSync → ${server.url}\n配置库 → ${s.root}\n按 Ctrl+C 退出`,
      );
    keepRunning(server);
  });
// Device-local configuration and login startup use the same core as HTTP.
const config = cli.command("config").description("本机设置（不跨设备同步）");
config
  .command("list")
  .action(run(async () => new Settings(await getStore()).get()));
config
  .command("get <key>")
  .action(run(async (key) => new Settings(await getStore()).read(key)));
config
  .command("set <key> <value>")
  .action(
    run(async (key, value) => new Settings(await getStore()).set(key, value)),
  );
const service = cli.command("service").description("管理登录启动服务");
for (const action of ["install", "uninstall", "status"] as const)
  service.command(action).action(
    run(async () => {
      const s = await getStore();
      return action === "status"
        ? new LoginService(s).status()
        : s.lock(() => new LoginService(s)[action]());
    }),
  );
try {
  await cli.parseAsync();
} catch (e: any) {
  const failure = { ok: false, code: e.code || "ERROR", message: e.message };
  console.error(
    JSON.stringify(store ? await cliNoticeOutput(store, failure) : failure),
  );
  process.exitCode = 1;
}
