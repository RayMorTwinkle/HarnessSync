import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  ignoreNativePaths,
  refreshSkills,
  skillSource,
  sourceStatus,
} from "./core/skill-sources.ts";
import { Store } from "./core/store.ts";
import { Engine, publicPlan } from "./core/engine.ts";
import { startServer } from "./server.ts";
import { scopeSchema, harnessIds } from "./shared/types.ts";
import {
  createOnboarding,
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
  .version("0.2.2")
  .option("--root <directory>", "配置库目录")
  .option("--json", "机器可读 JSON 输出");
let store: Store;
const getStore = async () =>
  (store ||= await new Store(cli.opts().root).init());
const output = (data: unknown) =>
  console.log(JSON.stringify(data, null, cli.opts().json ? 0 : 2));
const run =
  (fn: (...args: any[]) => Promise<unknown> | unknown) =>
  async (...args: any[]) => {
    const value = await fn(...args);
    if (value !== undefined) output(value);
  };
const scopeOptions = (c: Command) =>
  c
    .option("--scope <kind>", "global / device / project", "global")
    .option("--target <id>", "设备或项目 ID")
    .option("--harness <ids>", harnessIds.join(","), harnessIds.join(","));
const scope = (o: any) =>
  scopeSchema.parse({
    kind: o.scope,
    target: o.target,
    harnesses: o.harness.split(","),
  });
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
        sourceUpdates: sourceStatus(await getStore()),
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
        sourceUpdates: sourceStatus(await getStore()),
        errors: plan.errors,
        conflicts: conflicts.map((c) => ({ path: c.path, reason: c.reason })),
        pendingDeployments: pending,
        pendingChanges: plan.changes.filter(
          (c) => !["unchanged", "conflict"].includes(c.status),
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
  .description("恢复源配置版本（之后需重新部署）")
  .action(run(async (sha) => (await getStore()).restoreSource(sha)));
cli
  .command("rollback <deployment>")
  .description("回滚最近一次部署（保留源配置）")
  .action(run(async (id) => new Engine(await getStore()).rollback(id)));
cli
  .command("self-skill")
  .description("将 AI 管理 Skill 安装到源配置库，之后预览部署")
  .action(run(async () => installSelfSkill(await getStore())));
const onboard = cli
  .command("onboard")
  .description("扫描、安装管理技能并生成 AI 初始化提示词");
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
  rules
    .command("edit <id>")
    .requiredOption("--title <title>")
    .requiredOption("--file <file>"),
).action(
  run(async (id, o) => {
    const s = await getStore();
    return s.saveRule(
      {
        title: o.title,
        body: fs.readFileSync(path.resolve(o.file), "utf8"),
        scope: scope(o),
      },
      findId(s.manifest().rules, id),
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
skills
  .command("list")
  .action(run(async () => (await getStore()).manifest().skills));
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
      ...s.manifest().skills.find((x) => x.id === key),
      ...parseSkill(
        fs.readFileSync(path.join(s.skillPath(key), "SKILL.md"), "utf8"),
      ),
    };
  }),
);
scopeOptions(
  skills
    .command("import <directory>")
    .option(
      "--adopt",
      "同时接管这个已有原生目录，后续可由 HarnessSync 更新或撤下",
    ),
).action(
  run(async (dir, o) =>
    (await getStore()).importSkill(dir, scope(o), undefined, o.adopt),
  ),
);
scopeOptions(
  skills
    .command("edit <id>")
    .requiredOption("--file <file>", "包含 YAML frontmatter 的 SKILL.md"),
).action(
  run(async (id, o) => {
    const s = await getStore();
    const value = parseSkill(fs.readFileSync(path.resolve(o.file), "utf8"));
    return s.saveSkill(
      { ...value, scope: scope(o) },
      findId(s.manifest().skills, id),
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
  .option("--dev", "启用前端热更新")
  .action(async (o) => {
    const port = parsePort(o.port);
    const server = await startServer(await getStore(), { port, dev: o.dev });
    console.log(
      `HarnessSync → ${server.url}\n配置库 → ${store.root}\n按 Ctrl+C 退出`,
    );
    keepRunning(server);
  });
try {
  await cli.parseAsync();
} catch (e: any) {
  console.error(
    JSON.stringify({ ok: false, code: e.code || "ERROR", message: e.message }),
  );
  process.exitCode = 1;
}
