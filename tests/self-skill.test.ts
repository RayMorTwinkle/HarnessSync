import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  cliCommand,
  installSelfSkill,
  refreshSelfSkill,
} from "../src/core/self-skill.ts";
import { parseSkill, readBundle, skillMarkdown } from "../src/core/files.ts";
import { renderSkillText } from "../src/core/rendering.ts";
import { collectNotices } from "../src/core/notices.ts";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { startServer } from "../src/server.ts";
import {
  bootstrapOnboarding,
  createOnboarding,
} from "../src/core/onboarding.ts";
import { fixture, ui, until } from "./settings-helpers.ts";

function app(home: string, version: string) {
  const base = path.join(home, ".local/share/harness-sync");
  const root = path.join(base, "releases", version);
  const skill = path.join(root, "skills/manage-harness-sync");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    skillMarkdown(
      "manage-harness-sync",
      `说明 ${version}`,
      `命令：\n\`__HSYNC_CLI__ status --json\`\n${version}`,
    ),
  );
  fs.writeFileSync(
    path.join(skill, `${version}.bin`),
    Buffer.from([0, 255, 12]),
  );
  fs.chmodSync(path.join(skill, `${version}.bin`), 0o755);
  const current = path.join(base, "current");
  fs.rmSync(current, { force: true });
  fs.symlinkSync(path.relative(base, root), current);
  return root;
}
function text(store: Store, id = store.manifest().skills[0].id) {
  return fs.readFileSync(path.join(store.skillPath(id), "SKILL.md"), "utf8");
}

test("stable CLI entry requires a matching current symlink; prompts keep absolute paths", async (t) => {
  const { store, home } = await fixture(t);
  const root = app(home, "old");
  assert.match(cliCommand(store, root).command, /current\/dist\/cli.js/);
  assert.ok(!cliCommand(store, root).command.includes("{{device.home}}"));
  const current = path.join(home, ".local/share/harness-sync/current");
  fs.unlinkSync(current);
  assert.ok(cliCommand(store, root).command.includes(root));
  fs.mkdirSync(current);
  assert.ok(cliCommand(store, root).command.includes(root));
  fs.rmdirSync(current);
  fs.symlinkSync("releases/elsewhere", current);
  assert.ok(cliCommand(store, root).command.includes(root));
  assert.ok(
    cliCommand(store, path.join(home, "source")).command.includes(
      "/source/dist/cli.js",
    ),
  );
  const record = await createOnboarding(store);
  assert.ok(!record.prompt.includes("{{device.home}}"));
  assert.ok(record.prompt.includes(cliCommand(store).command));
});

test("source paths are portable and deployment renders this device's absolute paths", async (t) => {
  const { store, home, engine } = await fixture(t);
  const root = app(home, "old");
  const entry = await installSelfSkill(store, undefined, ["claude"], root);
  const source = text(store);
  assert.match(
    source,
    /'\{\{device.home\}\}\/\.local\/share\/harness-sync\/current\/dist\/cli.js'/,
  );
  // This fixture's configuration root is outside HOME and must stay absolute.
  assert.ok(source.includes(store.root));
  assert.ok(!source.includes(home));
  const plan = engine.plan();
  await engine.apply(plan.id);
  const deployed = plan.changes.find((c) => c.kind === "skill")!;
  const actual = fs.readFileSync(path.join(deployed.path, "SKILL.md"), "utf8");
  assert.ok(
    actual.includes(
      path.join(home, ".local/share/harness-sync/current/dist/cli.js"),
    ),
  );
  assert.ok(!actual.includes("{{device.home}}"));
  assert.equal(store.manifest().skills[0].id, entry.id);
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
});

test("rendered commands preserve shell arguments for HOME containing spaces, dollars and backticks", async (t) => {
  const { root } = await fixture(t);
  const home = path.join(root, "some one $HOME `name`");
  fs.mkdirSync(home);
  const store = await new Store(path.join(home, ".hs"), home).init();
  const program = app(home, "old");
  await installSelfSkill(store, undefined, undefined, program);
  const rendered = renderSkillText(store, text(store));
  const command = parseSkill(rendered).body.match(
    /`(node .* status --json)`/,
  )![1];
  const args = execFileSync(
    "/bin/sh",
    ["-c", `node() { printf '%s\\n' "$@"; }; ${command}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.deepEqual(args, [
    path.join(home, ".local/share/harness-sync/current/dist/cli.js"),
    "--root",
    store.root,
    "status",
    "--json",
  ]);
});

test("refresh replaces body, description and all resources, preserving user settings and source history", async (t) => {
  const { store, home } = await fixture(t);
  assert.equal(await refreshSelfSkill(store), undefined);
  assert.equal(store.manifest().skills.length, 0);
  const first = await installSelfSkill(
    store,
    undefined,
    ["claude"],
    app(home, "old"),
  );
  await store.saveSkill(
    {
      ...first,
      body: parseSkill(text(store)).body,
      displayName: "我的管理技能",
      enabled: false,
      scope: {
        kind: "device",
        target: store.device().id,
        harnesses: ["codex"],
      },
    },
    first.id,
  );
  const before = store.git(["rev-parse", "HEAD"]);
  const program = app(home, "new");
  const refreshed = (await refreshSelfSkill(store, program))!;
  assert.equal(refreshed.id, first.id);
  assert.equal(refreshed.enabled, false);
  assert.equal(refreshed.displayName, "我的管理技能");
  assert.deepEqual(refreshed.scope, {
    kind: "device",
    target: store.device().id,
    harnesses: ["codex"],
  });
  assert.equal(refreshed.description, "说明 new");
  assert.match(text(store), /new/);
  assert.ok(!fs.existsSync(path.join(store.skillPath(first.id), "old.bin")));
  assert.equal(
    fs.statSync(path.join(store.skillPath(first.id), "new.bin")).mode & 0o111,
    0o111,
  );
  assert.notEqual(store.git(["rev-parse", "HEAD"]), before);
  const after = store.git(["rev-parse", "HEAD"]);
  await refreshSelfSkill(store, program);
  assert.equal(store.git(["rev-parse", "HEAD"]), after);
  assert.equal(store.manifest().skills.length, 1);
});

for (const edited of [
  "body",
  "description",
  "resource",
  "metadata",
  "whitespace",
  "legacy",
  "malformed",
])
  test(`refresh preserves ${edited} edits and reports an explicit update command`, async (t) => {
    const { store, home } = await fixture(t);
    const first = await installSelfSkill(
      store,
      undefined,
      undefined,
      app(home, "old"),
    );
    const old = parseSkill(text(store));
    if (edited === "malformed") {
      fs.writeFileSync(
        path.join(store.skillPath(first.id), "SKILL.md"),
        "不完整的用户草稿",
      );
    } else if (edited === "metadata") {
      fs.writeFileSync(
        path.join(store.skillPath(first.id), "SKILL.md"),
        text(store).replace("---\n", "---\ncustom: true\n"),
      );
    } else if (edited === "whitespace") {
      fs.appendFileSync(path.join(store.skillPath(first.id), "SKILL.md"), "\n");
    } else if (edited === "resource")
      fs.writeFileSync(
        path.join(store.skillPath(first.id), "old.bin"),
        "custom",
      );
    else if (edited === "legacy") {
      const metadata = { ...old.metadata };
      delete metadata["harness-sync-generated"];
      fs.writeFileSync(
        path.join(store.skillPath(first.id), "SKILL.md"),
        skillMarkdown(old.name, old.description, old.body, metadata),
      );
    } else
      await store.saveSkill(
        {
          ...first,
          body: edited === "body" ? "用户改动" : old.body,
          description:
            edited === "description" ? "自定义说明" : first.description,
        },
        first.id,
      );
    const before = readBundle(store.skillPath(first.id));
    const program = app(home, "new");
    await refreshSelfSkill(store, program);
    assert.deepEqual(readBundle(store.skillPath(first.id)), before);
    assert.equal(
      collectNotices(store).find((n) => n.code === "SELF_SKILL_UPDATE")
        ?.command,
      "hsync self-skill",
    );
    await installSelfSkill(store, undefined, undefined, program);
    assert.ok(
      !collectNotices(store).some((n) => n.code === "SELF_SKILL_UPDATE"),
    );
    assert.equal(store.manifest().skills[0].id, first.id);
  });

test("refresh refuses symlink source targets and local reminder caches", async (t) => {
  const { store, home, root } = await fixture(t);
  const program = app(home, "old");
  await installSelfSkill(store, undefined, undefined, program);
  const cache = path.join(store.root, "self-skill-update.json");
  fs.unlinkSync(cache);
  const outside = path.join(root, "outside");
  fs.writeFileSync(outside, "untouched");
  fs.symlinkSync(outside, cache);
  await assert.rejects(refreshSelfSkill(store, program), {
    code: "SYMLINK_TARGET",
  });
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  fs.unlinkSync(cache);
  const skill = store.skillPath(store.manifest().skills[0].id);
  fs.renameSync(skill, skill + "-original");
  fs.symlinkSync(skill + "-original", skill);
  await assert.rejects(refreshSelfSkill(store, program), {
    code: "SYMLINK_TARGET",
  });
});

test("two different HOME devices refresh independently and sync without conflicts", async (t) => {
  const { root } = await fixture(t);
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const stores: Store[] = [];
  for (const name of ["alice", "bob"]) {
    const home = path.join(root, name);
    fs.mkdirSync(home);
    const store = await new Store(path.join(home, ".hs"), home).init();
    await installSelfSkill(store, undefined, undefined, app(home, "old"));
    stores.push(store);
  }
  const [a, b] = stores;
  const sa = new Sync(a),
    sb = new Sync(b);
  await sa.setup({ url: remote });
  assert.equal((await sb.setup({ url: remote })).conflicts.length, 0);
  await sa.now();
  for (const store of stores)
    await refreshSelfSkill(store, app(store.home, "new"));
  assert.equal(text(a), text(b));
  await sa.now();
  assert.equal((await sb.now()).conflicts.length, 0);
  assert.equal((await sa.now()).conflicts.length, 0);
  assert.deepEqual(a.manifest(), b.manifest());
  assert.deepEqual(
    readBundle(a.skillPath(a.manifest().skills[0].id)),
    readBundle(b.skillPath(b.manifest().skills[0].id)),
  );
});

test("service startup refreshes before scheduler auto deployment; disabled auto deploy stays disabled", async (t) => {
  const { store, home, settings, engine, root, defer } = await fixture(t);
  await settings.set("updates.check", "false");
  await installSelfSkill(store, undefined, ["claude"], app(home, "old"));
  await engine.apply(engine.plan().id);
  const oldHead = store.git(["rev-parse", "HEAD"]);
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    autoDeployDelayMs: 10,
  });
  defer(() => (server.server.listening ? server.close() : Promise.resolve()));
  await until(() =>
    engine.plan().changes.every((c) => c.status === "unchanged"),
  );
  assert.notEqual(store.git(["rev-parse", "HEAD"]), oldHead);
  assert.ok(text(store).includes("HarnessSync 配置管理"));
  await server.close();
  await settings.set("deploy.auto", "false");
  await installSelfSkill(store, undefined, undefined, app(home, "old"));
  await engine.apply(engine.plan().id);
  const second = await startServer(store, {
    port: 0,
    uiDirectory: path.join(root, "ui"),
    autoDeployDelayMs: 10,
  });
  defer(() => second.close());
  assert.ok(text(store).includes("HarnessSync 配置管理"));
  assert.ok(engine.plan().changes.some((c) => c.status === "update"));
});

test("onboarding bootstrap preserves customized management content and its scope and enabled setting", async (t) => {
  const { store, home } = await fixture(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const skill = await installSelfSkill(store, undefined, ["claude"]);
  await store.saveSkill(
    { ...skill, body: "自定义管理内容", enabled: false },
    skill.id,
  );
  const record = await createOnboarding(store);
  await bootstrapOnboarding(store, record.id);
  assert.equal(parseSkill(text(store)).body.trim(), "自定义管理内容");
  assert.equal(store.manifest().skills[0].enabled, false);
  assert.deepEqual(store.manifest().skills[0].scope.harnesses, ["claude"]);
  assert.ok(collectNotices(store).some((n) => n.code === "SELF_SKILL_UPDATE"));
});

test("refresh refuses a concurrent edit instead of overwriting it", async (t) => {
  const { store, home } = await fixture(t);
  const entry = await installSelfSkill(
    store,
    undefined,
    undefined,
    app(home, "old"),
  );
  const save = store.saveSkill.bind(store);
  store.saveSkill = async (...args: Parameters<Store["saveSkill"]>) => {
    store.saveSkill = save;
    await save({ ...entry, body: "并发用户修改" }, entry.id);
    return save(...args);
  };
  await assert.rejects(refreshSelfSkill(store, app(home, "new")), {
    code: "STALE_REVISION",
  });
  assert.equal(parseSkill(text(store)).body.trim(), "并发用户修改");
});

test("a failed source commit restores the old full management bundle", async (t) => {
  const { store, home } = await fixture(t);
  const entry = await installSelfSkill(
    store,
    undefined,
    undefined,
    app(home, "old"),
  );
  const bundle = readBundle(store.skillPath(entry.id));
  const manifest = store.manifest();
  store.commit = () => {
    throw new Error("模拟源提交失败");
  };
  await assert.rejects(
    refreshSelfSkill(store, app(home, "new")),
    /模拟源提交失败/,
  );
  assert.deepEqual(readBundle(store.skillPath(entry.id)), bundle);
  assert.deepEqual(store.manifest(), manifest);
});

test("onboarding safely refreshes a generated old bundle before deploying only that skill", async (t) => {
  const { store, home, engine } = await fixture(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const entry = await installSelfSkill(
    store,
    undefined,
    ["claude"],
    app(home, "old"),
  );
  await store.saveRule({ title: "不部署", body: "pending" });
  const record = await createOnboarding(store);
  await bootstrapOnboarding(store, record.id);
  assert.equal(store.manifest().skills[0].id, entry.id);
  assert.match(text(store), /HarnessSync 配置管理/);
  assert.ok(!fs.existsSync(path.join(store.skillPath(entry.id), "old.bin")));
  assert.ok(
    engine
      .plan()
      .changes.some((c) => c.kind === "instructions" && c.status === "create"),
  );
});

test("a new service does not install a missing management skill", async (t) => {
  const { store, settings, root, defer } = await fixture(t);
  await settings.set("updates.check", "false");
  const server = await startServer(store, { port: 0, uiDirectory: ui(root) });
  defer(() => server.close());
  assert.equal(store.manifest().skills.length, 0);
});
