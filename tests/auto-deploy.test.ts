import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  autoDeploy,
  lastAutoDeploy,
  createAutoDeployer,
} from "../src/core/auto-deploy.ts";
import { Engine } from "../src/core/engine.ts";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { startBackgroundScheduler } from "../src/core/sync-scheduler.ts";
import { UpdateChecker } from "../src/core/update-checks.ts";
import { writeJson, hash, skillMarkdown } from "../src/core/files.ts";
import { startServer } from "../src/server.ts";
import { openWebUi } from "../src/web-ui.ts";
import { fixture, pause, until, ui } from "./settings-helpers.ts";

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

test("symlink targets, plan errors/warnings and adopted links are never applied automatically", async (t) => {
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
  assert.equal(engine.deployments().length, 0);
});
