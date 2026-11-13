import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  autoDeploy,
  lastAutoDeploy,
  createAutoDeployer,
  autoDeployBlockers,
} from "../src/core/auto-deploy.ts";
import { Engine, publicPlan } from "../src/core/engine.ts";
import { ignoreNativePaths } from "../src/core/skill-sources.ts";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import {
  startBackgroundScheduler,
  processStartTime,
} from "../src/core/sync-scheduler.ts";
import { UpdateChecker } from "../src/core/update-checks.ts";
import { writeJson, hash, skillMarkdown } from "../src/core/files.ts";
import { startServer } from "../src/server.ts";
import { openWebUi } from "../src/web-ui.ts";
import { fixture, pause, until, ui } from "./settings-helpers.ts";

test("existing CLAUDE.md consent survives disable/re-enable while empty self-created AGENTS.md files are deleted and rollback restores them", async (t) => {
  const { engine, store, home } = await fixture(t);
  const claude = path.join(home, ".claude/CLAUDE.md");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, "用户已有指令\n");
  const rule = await store.saveRule({ title: "全局规则", body: "保留内容" });
  const paused = await autoDeploy(engine, "first-write");
  assert.equal(paused.outcome, "needs-review");
  assert.deepEqual(
    paused.blockers?.map((b) => b.path),
    [claude],
  );
  assert.equal(store.state().receipts.length, 0);
  await engine.apply(engine.plan().id);
  assert.equal(store.state().instructionConsents?.length, 1);
  assert.equal(store.state().instructionConsents?.[0].path, claude);
  const agents = store
    .state()
    .receipts.filter((r) => r.path !== claude)
    .map((r) => r.path);
  assert.equal(agents.length, 3);
  assert.ok(
    store
      .state()
      .receipts.every((r) => r.instructionCreated === (r.path !== claude)),
  );
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  const removal = await autoDeploy(engine, "disable");
  assert.equal(removal.outcome, "applied");
  assert.ok(agents.every((p) => !fs.existsSync(p)));
  assert.match(fs.readFileSync(claude, "utf8"), /^用户已有指令\n\s*$/);
  await engine.rollback(removal.deploymentId!);
  assert.ok(
    agents.every((p) =>
      fs.readFileSync(p, "utf8").includes("harness-sync:begin"),
    ),
  );
  assert.equal(store.state().instructionConsents?.length, 1);
  assert.equal((await autoDeploy(engine, "disable-again")).outcome, "applied");
  await store.saveRule({ ...rule, enabled: true }, rule.id);
  const enabled = await autoDeploy(engine, "enable");
  assert.equal(enabled.outcome, "applied");
  assert.equal(enabled.changes.create, 3);
  assert.equal(enabled.changes.update, 1);
  assert.match(fs.readFileSync(claude, "utf8"), /^用户已有指令\n/);
  // Consent remains usable over multiple cycles, including separators inserted by the engine.
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await autoDeploy(engine, "disable-third");
  await store.saveRule({ ...rule, enabled: true }, rule.id);
  assert.equal((await autoDeploy(engine, "enable-third")).outcome, "applied");
  const snapshot = JSON.parse(
    fs.readFileSync(
      path.join(store.root, "deployments", `${enabled.deploymentId}.json`),
      "utf8",
    ),
  );
  assert.ok(snapshot.beforeState.instructionConsents.length);
});

for (const modification of [
  "outside",
  "missing",
  "malformed",
  "symlink",
] as const) {
  test(`instruction consent is revoked on ${modification} and does not return when old text returns`, async (t) => {
    const { engine, store, root } = await fixture(t);
    const rule = await store.saveRule({ title: "rule", body: "text" });
    const target = engine.plan().changes[0].path;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "用户内容\n");
    await engine.apply(engine.plan().id);
    await store.saveRule({ ...rule, enabled: false }, rule.id);
    await autoDeploy(engine, "disable");
    const original = fs.readFileSync(target, "utf8");
    if (modification === "outside") fs.appendFileSync(target, "外部变化\n");
    if (modification === "missing") fs.unlinkSync(target);
    if (modification === "malformed")
      fs.appendFileSync(target, "<!-- harness-sync:begin -->");
    if (modification === "symlink") {
      fs.unlinkSync(target);
      const external = path.join(root, "external.md");
      fs.writeFileSync(external, original);
      fs.symlinkSync(external, target);
    }
    await autoDeploy(engine, "observe-change");
    assert.deepEqual(store.state().instructionConsents, []);
    if (modification === "symlink") fs.unlinkSync(target);
    fs.writeFileSync(target, original);
    await store.saveRule({ ...rule, enabled: true }, rule.id);
    assert.equal((await autoDeploy(engine, "enable")).outcome, "needs-review");
    await engine.apply(engine.plan().id);
    assert.equal(store.state().instructionConsents?.length, 1);
  });
}

test("instruction consent is per store/path, legacy receipts preserve files, and manual rollback revokes new consent", async (t) => {
  const { engine, store } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "text" });
  const paths = engine.plan().changes.map((c) => c.path);
  fs.mkdirSync(path.dirname(paths[0]), { recursive: true });
  fs.writeFileSync(paths[0], "已有内容\n");
  const first = await engine.apply(engine.plan().id);
  await engine.rollback(first.id!);
  assert.equal(store.state().instructionConsents?.length || 0, 0);
  assert.equal(
    (await autoDeploy(engine, "after-rollback")).outcome,
    "needs-review",
  );
  await engine.apply(engine.plan().id);
  const other = await fixture(t);
  await other.store.saveRule({ title: "rule", body: "text" });
  const otherPath = other.engine.plan().changes[0].path;
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, "已有内容\n");
  assert.equal(
    (await autoDeploy(other.engine, "other-device")).outcome,
    "needs-review",
  );
  const state = store.state();
  delete state.receipts.find((r) => r.path === paths[1])!.instructionCreated;
  writeJson(path.join(store.root, "state.json"), state);
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await autoDeploy(engine, "remove");
  assert.equal(fs.existsSync(paths[1]), true);
  fs.writeFileSync(paths[2], "另一个未授权路径\n");
  await store.saveRule({ ...rule, enabled: true }, rule.id);
  const blocked = await autoDeploy(engine, "enable");
  assert.equal(blocked.outcome, "needs-review");
  assert.ok(blocked.blockers?.some((b) => b.path === paths[2]));
  assert.ok(!blocked.blockers?.some((b) => b.path === paths[0]));
});

test("scheduler takes over reused/legacy/invalid PIDs but rejects a matching live process start time", async (t) => {
  const { store, engine } = await fixture(t);
  const file = path.join(store.root, "scheduler-owner.json");
  assert.ok(await processStartTime(process.pid));
  assert.equal(await processStartTime(-1), null);
  for (const previous of [
    { pid: process.pid, startTime: "ps:old process" },
    { pid: process.pid },
    { pid: -1, startTime: "old" },
    { pid: 2147483647, startTime: "old" },
  ]) {
    writeJson(file, { ...previous, token: "stale" });
    const scheduler = await startBackgroundScheduler(store, engine);
    try {
      const owner = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.startTime, await processStartTime(process.pid));
      await assert.rejects(startBackgroundScheduler(store), {
        code: "SCHEDULER_RUNNING",
      });
      writeJson(file, { ...owner, token: "new-owner" });
    } finally {
      await scheduler.close();
    }
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "new-owner");
  }
});

test("scheduler identity fallback rejects another real scheduler process and releases its probe on close", async (t) => {
  const { store, home, defer } = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { Store } from './src/core/store.ts';
    import { startBackgroundScheduler } from './src/core/sync-scheduler.ts';
    const scheduler = await startBackgroundScheduler(new Store(${JSON.stringify(store.root)}, ${JSON.stringify(home)}));
    process.send('ready');
    process.on('message', async () => { await scheduler.close(); process.exit(0); });
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  defer(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  let errors = "";
  child.stderr!.on("data", (data) => {
    errors += data.toString();
  });
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(() => {
      throw new Error(errors);
    }),
  ]);
  assert.equal(ready, "ready");
  const file = path.join(store.root, "scheduler-owner.json");
  const owner = JSON.parse(fs.readFileSync(file, "utf8"));
  // Force the probe path even where ps works: runtime identities are process-local.
  writeJson(file, { ...owner, startTime: "runtime:other-process" });
  await assert.rejects(startBackgroundScheduler(store), {
    code: "SCHEDULER_RUNNING",
  });
  writeJson(file, {
    ...owner,
    startTime: "runtime:other-process",
    token: "wrong-token",
  });
  const replacement = await startBackgroundScheduler(store);
  child.send("close");
  await once(child, "exit");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  await replacement.close();
  assert.equal(fs.existsSync(file), false);
});

test("failed removal restores deleted self-created instruction files and their receipts", async (t) => {
  const { store, engine } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "text" });
  await autoDeploy(engine, "create");
  const state = store.state();
  const paths = state.receipts.map((r) => r.path);
  const contents = paths.map((p) => fs.readFileSync(p, "utf8"));
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  const remove = fs.rmSync;
  const mock = t.mock.method(
    fs,
    "rmSync",
    (target: fs.PathLike, options?: fs.RmOptions) => {
      if (target === paths[1]) throw new Error("injected removal failure");
      return remove(target, options);
    },
  );
  try {
    await assert.rejects(
      engine.apply(engine.plan().id),
      /injected removal failure/,
    );
  } finally {
    mock.mock.restore();
  }
  assert.deepEqual(store.state(), state);
  assert.deepEqual(
    paths.map((p) => fs.readFileSync(p, "utf8")),
    contents,
  );
  assert.equal(engine.deployments()[0].status, "failed");
});

test("a fresh manual plan can reauthorize changed outside text without a false stale-plan rejection", async (t) => {
  const { store, engine } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "text" });
  const target = engine.plan().changes[0].path;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "原内容\n");
  await engine.apply(engine.plan().id);
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await autoDeploy(engine, "disable");
  fs.appendFileSync(target, "新内容\n");
  await store.saveRule({ ...rule, enabled: true }, rule.id);
  await engine.apply(engine.plan().id);
  assert.equal(store.state().instructionConsents?.length, 1);
  assert.match(fs.readFileSync(target, "utf8"), /新内容/);
});

test("outside edits while managed revoke consent without losing the user's text on owned updates", async (t) => {
  const { store, engine } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "text" });
  const target = engine.plan().changes[0].path;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "用户内容\n");
  await engine.apply(engine.plan().id);
  fs.appendFileSync(target, "区块外修改\n");
  await store.saveRule({ ...rule, body: "updated" }, rule.id);
  assert.equal((await autoDeploy(engine, "owned-update")).outcome, "applied");
  assert.deepEqual(store.state().instructionConsents, []);
  assert.match(fs.readFileSync(target, "utf8"), /区块外修改/);
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await autoDeploy(engine, "disable");
  await store.saveRule({ ...rule, enabled: true }, rule.id);
  assert.equal((await autoDeploy(engine, "enable")).outcome, "needs-review");
});

test("clean automatic deployment uses normal receipts/snapshots and can roll back", async (t) => {
  const { engine, store } = await fixture(t);
  await store.saveRule({ title: "rule", body: "original" });
  const first = await autoDeploy(engine, "test");
  assert.equal(first.outcome, "applied");
  assert.equal(first.changes.create, 4);
  assert.equal(store.state().receipts.length, 4);
  assert.equal(engine.deployments()[0].id, first.deploymentId);
  assert.equal(engine.deployments()[0].status, "applied");
  assert.deepEqual(lastAutoDeploy(store), first);
  assert.equal(engine.snapshot().autoDeploy?.outcome, "applied");
  assert.equal((await new Sync(store).status()).autoDeploy?.outcome, "applied");
  assert.equal((await autoDeploy(engine, "repeat")).outcome, "nothing");
  await engine.rollback(first.deploymentId!);
  assert.equal(store.state().receipts.length, 0);
  assert.equal(fs.existsSync(engine.plan().changes[0].path), false);
});
test("owned updates and removals deploy while preserving outside instruction text", async (t) => {
  const { engine, store } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "original" });
  await autoDeploy(engine, "create");
  const target = engine.plan().changes[0].path;
  fs.appendFileSync(target, "\nOutside text\n");
  await store.saveRule({ ...rule, body: "updated" }, rule.id);
  assert.equal((await autoDeploy(engine, "update")).changes.update, 4);
  assert.match(fs.readFileSync(target, "utf8"), /Outside text/);
  await store.remove("rules", rule.id);
  const result = await autoDeploy(engine, "remove");
  assert.equal(result.outcome, "applied");
  assert.equal(result.changes.remove, 4);
  assert.match(fs.readFileSync(target, "utf8"), /Outside text/);
  assert.equal(store.state().receipts.length, 0);
});
test("disabled automatic deployment does not plan or mutate native paths", async (t) => {
  const { store, engine, settings } = await fixture(t);
  await settings.patch({ deploy: { auto: false } });
  await store.saveRule({ title: "rule", body: "text" });
  engine.plan = () => assert.fail("disabled deployment planned");
  assert.equal((await autoDeploy(engine, "disabled")).outcome, "disabled");
  assert.equal(engine.deployments().length, 0);
  assert.equal(store.state().receipts.length, 0);
});
test("unowned identical skills need adoption; collisions and explicit replacement need review", async (t) => {
  const { store, engine, defer } = await fixture(t);
  await store.saveSkill({
    name: "collision",
    description: "test",
    body: "text",
  });
  const p = engine.plan().changes[0].path;
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(
    path.join(p, "SKILL.md"),
    skillMarkdown("collision", "test", "text"),
  );
  assert.equal(
    engine.plan().changes.find((c) => c.path === p)?.status,
    "adopt",
  );
  assert.equal((await autoDeploy(engine, "adopt")).outcome, "needs-review");
  fs.appendFileSync(path.join(p, "SKILL.md"), "external");
  const conflict = await autoDeploy(engine, "conflict");
  assert.equal(conflict.outcome, "needs-review");
  assert.ok(conflict.blockers?.some((b) => b.status === "conflict"));
  await engine.chooseConflict(p, "library");
  assert.equal((await autoDeploy(engine, "replace")).outcome, "needs-review");
  assert.equal(engine.deployments().length, 0);
  await engine.chooseConflict(p, "skip");
  const skip = await autoDeploy(engine, "skip");
  assert.equal(skip.outcome, "applied");
  assert.ok(!store.state().receipts.some((r) => r.path === p));
  assert.match(fs.readFileSync(path.join(p, "SKILL.md"), "utf8"), /external/);
});
test("drifted deployments, staged initialization replacement and unowned instruction updates stop", async (t) => {
  const { store, engine, defer } = await fixture(t);
  await store.saveRule({ title: "rule", body: "base" });
  const p = engine.plan().changes[0].path;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "Existing instructions\n");
  assert.equal(
    (await autoDeploy(engine, "unowned-update")).outcome,
    "needs-review",
  );
  writeJson(path.join(store.root, "state.json"), {
    ...store.state(),
    instructionReplacements: [
      { path: p, hash: hash(fs.readFileSync(p, "utf8")) },
    ],
  });
  const staged = await autoDeploy(engine, "staged");
  assert.equal(staged.outcome, "needs-review");
  assert.ok(staged.blockers?.some((b) => b.status === "staged-replacement"));
  assert.match(fs.readFileSync(p, "utf8"), /Existing instructions/);
  writeJson(path.join(store.root, "state.json"), { receipts: [] });
  fs.unlinkSync(p);
  await autoDeploy(engine, "create");
  fs.writeFileSync(
    p,
    fs.readFileSync(p, "utf8").replace("base", "external edit"),
  );
  const drift = await autoDeploy(engine, "drift");
  assert.equal(drift.outcome, "needs-review");
  assert.ok(drift.blockers?.some((b) => /外部修改/.test(b.reason)));
});
test("unresolved sync conflicts block even an otherwise clean plan", async (t) => {
  const { store, engine, defer } = await fixture(t);
  await store.saveRule({ title: "rule", body: "text" });
  writeJson(path.join(store.root, "sync.json"), {
    url: "unused",
    branch: "main",
    conflicts: [
      {
        entryId: "x",
        kind: "rules",
        localCommit: "a",
        remoteCommit: "b",
        reason: "conflict",
      },
    ],
  });
  const result = await autoDeploy(engine, "sync-conflict");
  assert.equal(result.outcome, "needs-review");
  assert.ok(result.blockers?.some((b) => b.status === "sync-conflict"));
  assert.equal(store.state().receipts.length, 0);
});
test("automatic deploy refuses stale plans after manual apply wins the store lock", async (t) => {
  const { store, engine, defer } = await fixture(t);
  await store.saveRule({ title: "rule", body: "text" });
  const apply = engine.apply.bind(engine);
  engine.apply = async (id, options) => {
    await new Engine(store).apply(id);
    return apply(id, options);
  };
  const result = await autoDeploy(engine, "race");
  assert.equal(result.outcome, "needs-review");
  assert.match(result.error!, /重新预览/);
  assert.equal(engine.deployments().length, 1);
  assert.equal(store.state().receipts.length, 4);
});
test("apply-lock policy guard catches sync conflicts introduced after planning", async (t) => {
  const { store, engine, defer } = await fixture(t);
  await store.saveRule({ title: "rule", body: "text" });
  const apply = engine.apply.bind(engine);
  engine.apply = async (id, options) => {
    writeJson(path.join(store.root, "sync.json"), {
      url: "unused",
      branch: "main",
      conflicts: [
        {
          entryId: "x",
          kind: "rules",
          localCommit: "a",
          remoteCommit: "b",
          reason: "conflict",
        },
      ],
    });
    return apply(id, options);
  };
  assert.equal((await autoDeploy(engine, "guard")).outcome, "needs-review");
  assert.equal(engine.deployments().length, 0);
});
test("deployer debounces mutation bursts and cancels pending timers on close", async (t) => {
  const { store, engine, defer } = await fixture(t);
  const deployer = createAutoDeployer(engine, 30);
  defer(() => deployer.close());
  await store.saveRule({ title: "rule", body: "text" });
  for (let i = 0; i < 10; i++) deployer.queue(`burst-${i}`);
  await until(() => lastAutoDeploy(store)?.outcome === "applied");
  assert.equal(engine.deployments().length, 1);
  assert.equal(lastAutoDeploy(store)?.reason, "burst-9");
  deployer.queue("cancelled");
  await deployer.close();
  await pause(60);
  assert.equal(lastAutoDeploy(store)?.reason, "burst-9");
});
test("scheduler catches up, has one owner, awaits checks, and clears all timers on close", async (t) => {
  const { store, engine, defer } = await fixture(t);
  let ticks = 0;
  const checker = new UpdateChecker(store, async () => {
    ticks++;
    await pause(40);
    return [];
  });
  await store.saveRule({ title: "rule", body: "text" });
  const scheduler = await startBackgroundScheduler(store, engine, {
    intervalMs: 10,
    debounceMs: 20,
    checker,
  });
  await assert.rejects(startBackgroundScheduler(store), {
    code: "SCHEDULER_RUNNING",
  });
  await until(() => engine.deployments().length === 1);
  await scheduler.close();
  const before = ticks;
  await pause(60);
  assert.equal(ticks, before);
  assert.equal(
    fs.existsSync(path.join(store.root, "scheduler-owner.json")),
    false,
  );
  const restarted = await startBackgroundScheduler(store);
  await restarted.close();
});
test("scheduler deploys changed library after remote pull and clears pending deployment", async (t) => {
  const { root, home, store, engine, defer } = await fixture(t);
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const otherHome = path.join(root, "other-home");
  fs.mkdirSync(otherHome);
  const other = await new Store(
    path.join(root, "other-store"),
    otherHome,
  ).init();
  const a = new Sync(store),
    b = new Sync(other);
  await a.setup({ url: remote });
  await b.setup({ url: remote });
  await other.saveRule({ title: "remote", body: "from other device" });
  await b.now();
  const autoFile = path.join(store.root, "sync-auto.json");
  const state = JSON.parse(fs.readFileSync(autoFile, "utf8"));
  state.runtime.nextRunAt = state.runtime.pullDueAt = new Date(0).toISOString();
  writeJson(autoFile, state);
  const scheduler = await startBackgroundScheduler(store, engine, {
    intervalMs: 30,
    debounceMs: 5,
  });
  defer(() => scheduler.close());
  await until(() => engine.deployments().length > 0);
  assert.equal(store.manifest().rules[0].body, "from other device");
  assert.equal((await a.status()).scheduler.pendingDeployment, 0);
  assert.equal(engine.deployments().length, 1);
  assert.ok(store.state().receipts.every((r) => r.path.startsWith(home)));
});
test("HTTP mutation queue envelope, snapshot/status, background reuse and server close", async (t) => {
  const { root, store, engine, settings, defer } = await fixture(t);
  await settings.patch({ updates: { check: false } });
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    background: true,
    autoDeployDelayMs: 30,
    schedulerIntervalMs: 20,
  });
  defer(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
  };
  const saved = await (
    await fetch(`${server.url}/api/rules`, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: { title: "api", body: "text" } }),
    })
  ).json();
  assert.equal(saved.autoDeployQueued, true);
  assert.equal(saved.data.title, "api");
  await until(() => lastAutoDeploy(store)?.outcome === "applied");
  assert.equal(
    (await (await fetch(`${server.url}/api/snapshot`, { headers })).json()).data
      .autoDeploy.outcome,
    "applied",
  );
  assert.equal(
    (await (await fetch(`${server.url}/api/sync/status`, { headers })).json())
      .data.autoDeploy.outcome,
    "applied",
  );
  const reused = await openWebUi(store, {
    port: server.port,
    launch: async () => {},
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.running, undefined);
  await assert.rejects(
    startServer(store, { port: 0, uiDirectory: path.join(root, "ui") }),
    { code: "SCHEDULER_RUNNING" },
  );
  assert.equal(engine.deployments().length, 1);
});

test("symlink targets and plan errors are never applied automatically", async (t) => {
  const { store, engine, root } = await fixture(t);
  const rule = await store.saveRule({ title: "rule", body: "text" });
  const p = engine.plan().changes[0].path;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const other = path.join(root, "unowned");
  fs.writeFileSync(other, "untouched");
  fs.symlinkSync(other, p);
  assert.equal((await autoDeploy(engine, "link")).outcome, "needs-review");
  assert.equal(fs.readFileSync(other, "utf8"), "untouched");
  fs.unlinkSync(p);
  await store.remove("rules", rule.id);
  const project = await store.saveProject({ name: "unbound" });
  await store.saveRule({
    title: "project rule",
    body: "text",
    scope: { kind: "project", target: project.id, harnesses: ["claude"] },
  });
  assert.equal((await autoDeploy(engine, "unbound")).outcome, "needs-review");
  assert.equal(engine.deployments().length, 0);
});
test("startup respects disabled deploy and raw HTTP server close releases scheduler ownership", async (t) => {
  const { store, root, settings } = await fixture(t);
  await settings.patch({ deploy: { auto: false }, updates: { check: false } });
  await store.saveRule({ title: "rule", body: "text" });
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    schedulerIntervalMs: 10,
    autoDeployDelayMs: 5,
  });
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const response = await (
    await fetch(`${server.url}/api/rules`, {
      method: "POST",
      headers: {
        "x-harness-sync-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: { title: "second", body: "text" } }),
    })
  ).json();
  assert.equal(response.autoDeployQueued, false);
  await pause(30);
  assert.equal(new Engine(store).deployments().length, 0);
  await new Promise<void>((resolve) => server.server.close(() => resolve()));
  await until(
    () => !fs.existsSync(path.join(store.root, "scheduler-owner.json")),
  );
});

test("adopted native links require manual copy replacement and unfinished sync recovery blocks", async (t) => {
  const { store, engine, root, home } = await fixture(t);
  const incoming = path.join(root, "incoming");
  fs.mkdirSync(incoming);
  fs.writeFileSync(
    path.join(incoming, "SKILL.md"),
    skillMarkdown("adopted", "test", "text"),
  );
  const target = path.join(home, ".claude/skills/adopted");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(incoming, target);
  await store.importSkill(
    target,
    { kind: "global", harnesses: ["claude"] },
    undefined,
    true,
  );
  const result = await autoDeploy(engine, "adopted-link");
  assert.equal(result.outcome, "needs-review");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(engine.deployments().length, 0);
  writeJson(path.join(store.root, "sync-recovery.json"), {
    operation: "merge",
    at: new Date().toISOString(),
  });
  const recovery = await autoDeploy(engine, "recovery");
  assert.ok(recovery.blockers?.some((b) => b.status === "sync-recovery"));
});
test("source-directory warnings stop automatic deployment of an outdated library copy", async (t) => {
  const { store, engine, root } = await fixture(t);
  const incoming = path.join(root, "incoming");
  fs.mkdirSync(incoming);
  fs.writeFileSync(
    path.join(incoming, "SKILL.md"),
    skillMarkdown("source-warning", "test", "text"),
  );
  await store.importSkill(incoming, {
    kind: "global",
    harnesses: ["deepseek", "opencode", "codex", "claude"],
  });
  fs.appendFileSync(path.join(incoming, "SKILL.md"), "changed source");
  const result = await autoDeploy(engine, "source-warning");
  assert.equal(result.outcome, "needs-review");
  assert.ok(result.blockers?.some((b) => b.status === "blocked"));
  assert.ok(
    result.blockers?.some(
      (b) => b.code === "skill-source-changed" && b.path === incoming,
    ),
  );
  assert.equal(engine.deployments().length, 0);
});

test("informational plugin, retained-path, scope, exposure and external-preservation notices still auto-apply", async (t) => {
  const { store, engine, home } = await fixture(t);
  const retained = await store.saveRule({
    title: "retained",
    body: "original",
    scope: { harnesses: ["codex"] },
  });
  assert.equal((await autoDeploy(engine, "initial")).outcome, "applied");
  const receipt = store.state().receipts.find((r) => r.harness === "codex")!;
  const original = fs.readFileSync(receipt.path);
  await store.setHarnessEnabled("codex", false);
  await store.saveRule({ ...retained, body: "keep frozen" }, retained.id);
  await store.saveRule({
    title: "unknown",
    body: "ignored",
    scope: { harnesses: ["unknown-tool"] },
  });
  const skill = await store.saveSkill({
    name: "subset",
    description: "test",
    body: "new skill",
    scope: { harnesses: ["claude"] },
  });
  const pluginDir = path.join(store.root, "harnesses");
  fs.mkdirSync(pluginDir);
  const invalid = path.join(pluginDir, "invalid.json");
  writeJson(invalid, { id: "invalid-user-plugin", name: "" });
  const external = path.join(home, ".claude/skills/external");
  fs.mkdirSync(external, { recursive: true });
  const externalFile = path.join(external, "SKILL.md");
  fs.writeFileSync(
    externalFile,
    skillMarkdown("external", "test", "keep external"),
  );
  await ignoreNativePaths(store, [external]);
  await store.saveSkill({
    name: "external",
    description: "test",
    body: "library copy",
    scope: { harnesses: ["claude"] },
  });

  const plan = engine.plan();
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    new Set(plan.notices.map((n) => n.code)),
    new Set([
      "plugin-manifest-error",
      "unknown-harness",
      "retained-harness-paths",
      "shared-skill-exposure",
      "ignored-native-path",
    ]),
  );
  assert.ok(plan.notices.every((n) => n.blocking === false));
  assert.deepEqual(plan.warnings, [
    ...new Set(plan.notices.map((n) => n.message)),
  ]);
  assert.deepEqual(publicPlan(plan).notices, plan.notices);
  assert.deepEqual(autoDeployBlockers(engine, plan), []);
  assert.ok(engine.snapshot().harnesses.every((h) => h.note));
  const result = await autoDeploy(engine, "informational");
  assert.equal(result.outcome, "applied");
  assert.equal(result.blockers, undefined);
  assert.equal(engine.deployments().length, 2);
  assert.deepEqual(fs.readFileSync(receipt.path), original);
  assert.deepEqual(
    store.state().receipts.find((r) => r.path === receipt.path),
    receipt,
  );
  assert.match(fs.readFileSync(externalFile, "utf8"), /keep external/);
  assert.ok(!store.state().receipts.some((r) => r.path === external));
  const target = store.state().receipts.find((r) => r.sourceId === skill.id)!;
  assert.match(
    fs.readFileSync(path.join(target.path, "SKILL.md"), "utf8"),
    /new skill/,
  );
  assert.ok(fs.existsSync(invalid));
});

test("missing plugin retains its owned paths without blocking other harness deployments", async (t) => {
  const { store, engine, home } = await fixture(t);
  const plugin = JSON.parse(
    fs.readFileSync(
      new URL("fixtures/harnesses/acme.json", import.meta.url),
      "utf8",
    ),
  );
  const file = path.join(store.root, "harnesses/acme.json");
  fs.mkdirSync(path.dirname(file));
  writeJson(file, plugin);
  await store.saveRule({
    title: "plugin rule",
    body: "frozen",
    scope: { harnesses: ["acme"] },
  });
  assert.equal((await autoDeploy(engine, "plugin-first")).outcome, "applied");
  const target = path.join(home, ".acme/ACME.md");
  const before = fs.readFileSync(target);
  fs.unlinkSync(file);
  await store.saveRule({
    title: "active",
    body: "active",
    scope: { harnesses: ["claude"] },
  });
  const plan = engine.plan();
  assert.ok(
    plan.notices.some(
      (n) => n.code === "retained-harness-paths" && !n.blocking,
    ),
  );
  assert.equal((await autoDeploy(engine, "missing-plugin")).outcome, "applied");
  assert.deepEqual(fs.readFileSync(target), before);
  assert.ok(store.state().receipts.some((r) => r.path === target));
});

test("owned staging leftovers require review and rename backups remain blocking plan errors", async (t) => {
  const { store, engine, home } = await fixture(t);
  await store.saveRule({ title: "new", body: "text" });
  const stage = path.join(
    home,
    ".agents/skills",
    `.hsync-staging-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "SKILL.md"), "partial package");
  writeJson(`${stage}.json`, {
    format: "harness-sync-staging-v1",
    target: "partial",
  });
  const plan = engine.plan();
  const notice = plan.notices.find((n) => n.code === "staging-leftover")!;
  assert.equal(notice.blocking, true);
  const result = await autoDeploy(engine, "staging");
  assert.equal(result.outcome, "needs-review");
  assert.ok(
    result.blockers?.some(
      (b) =>
        b.code === notice.code &&
        b.path === stage &&
        b.reason === notice.message,
    ),
  );
  assert.equal(engine.deployments().length, 0);
  assert.ok(fs.existsSync(stage));
  assert.ok(fs.existsSync(`${stage}.json`));
  fs.mkdirSync(`${stage}-old`);
  fs.writeFileSync(path.join(`${stage}-old`, "SKILL.md"), "original package");
  const recovery = engine.plan();
  assert.ok(recovery.errors.length);
  assert.deepEqual(recovery.notices, []);
  const blocked = await autoDeploy(engine, "backup");
  assert.equal(blocked.outcome, "needs-review");
  assert.ok(blocked.blockers?.some((b) => b.reason === recovery.errors[0]));
  assert.equal(
    fs.readFileSync(path.join(`${stage}-old`, "SKILL.md"), "utf8"),
    "original package",
  );
});

test("unreadable local source produces a blocking notice with its source path", async (t) => {
  const { store, engine, root } = await fixture(t);
  const incoming = path.join(root, "unreadable");
  fs.mkdirSync(incoming);
  fs.writeFileSync(
    path.join(incoming, "SKILL.md"),
    skillMarkdown("unreadable", "test", "text"),
  );
  await store.importSkill(incoming, { kind: "global", harnesses: ["claude"] });
  fs.rmSync(incoming, { recursive: true });
  const plan = engine.plan();
  const notice = plan.notices.find(
    (n) => n.code === "skill-source-unreadable",
  )!;
  assert.equal(notice.blocking, true);
  const result = await autoDeploy(engine, "source-unreadable");
  assert.equal(result.outcome, "needs-review");
  assert.ok(
    result.blockers?.some(
      (b) =>
        b.code === notice.code &&
        b.path === incoming &&
        b.reason === notice.message,
    ),
  );
  assert.equal(engine.deployments().length, 0);
});

test("notice blocking flags decide policy independently of codes, translated messages and legacy warnings", async (t) => {
  const { engine, store, root } = await fixture(t);
  await store.saveRule({ title: "clean", body: "text" });
  const plan = engine.plan();
  const informational = {
    code: "shared-skill-exposure" as const,
    message: "源目录无法读取，需人工确认（仅测试显示文案）",
    blocking: false,
  };
  assert.deepEqual(
    autoDeployBlockers(engine, {
      ...plan,
      notices: [informational],
      warnings: ["这段显示文案不参与策略"],
    }),
    [],
  );
  const blocking = {
    code: "skill-source-changed" as const,
    message: "提示",
    blocking: true,
    path: root,
  };
  assert.deepEqual(
    autoDeployBlockers(engine, { ...plan, notices: [blocking], warnings: [] }),
    [
      {
        path: root,
        status: "blocked",
        reason: "提示",
        code: "skill-source-changed",
      },
    ],
  );
  assert.deepEqual(
    autoDeployBlockers(engine, {
      ...plan,
      notices: [informational],
      errors: ["计划错误"],
    }),
    [{ path: "", status: "blocked", reason: "计划错误" }],
  );
});
