import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  attachNotices,
  collectNotices,
  cliNoticeOutput,
  noticeName,
  agentNotice,
} from "../src/core/notices.ts";
import { autoDeploy } from "../src/core/auto-deploy.ts";
import { writeJson } from "../src/core/files.ts";
import { startServer } from "../src/server.ts";
import { UpdateChecker } from "../src/core/update-checks.ts";
import { fixture, ui } from "./settings-helpers.ts";

async function conflictFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const entry = await f.store.saveRule({
    title: 'review\u001b\n\u202e"' + "长".repeat(90),
    body: "SECRET INSTRUCTION CONTENT",
  });
  writeJson(path.join(f.store.root, "sync.json"), {
    url: "https://never-contact.invalid/config.git",
    branch: "main",
    conflicts: Array.from({ length: 7 }, (_, n) => ({
      entryId: n ? `entry-${n}` : entry.id,
      kind: "rules",
      localCommit: "a",
      remoteCommit: "b",
      reason: "entry",
    })),
  });
  return { ...f, entry };
}

test("cache-only notices bound and quote names without leaking content or errors", async (t) => {
  const { store } = await conflictFixture(t);
  const skill = await store.saveSkill({
    name: "update-me",
    description: "SECRET DESCRIPTION",
    body: "SECRET SKILL CONTENT",
  });
  await store.mutate("source fixture", (m) => {
    m.skills[0].source = {
      type: "git",
      url: "https://never-contact.invalid/skill.git",
      ref: "main",
      subpath: ".",
      commit: "a".repeat(40),
      installedHash: "unused",
    };
  });
  writeJson(path.join(store.root, "skill-updates.json"), {
    [skill.id]: {
      id: skill.id,
      name: skill.name,
      commit: "a".repeat(40),
      checkedAt: new Date().toISOString(),
      available: true,
    },
  });
  writeJson(path.join(store.root, "auto-deploy.json"), {
    at: new Date().toISOString(),
    outcome: "needs-review",
    changes: { create: 1, update: 0, remove: 0 },
    blockers: [{ reason: "SECRET BLOCKER" }],
  });
  writeJson(path.join(store.root, "sync-auto.json"), {
    runtime: { failures: 3, pendingPush: true, lastError: "SECRET ERROR" },
  });
  const start = performance.now();
  const notices = collectNotices(store);
  assert.ok(
    performance.now() - start < 500,
    "cached collection must remain fast",
  );
  assert.deepEqual(
    notices.map((n) => n.code),
    ["SYNC_CONFLICTS", "AUTO_DEPLOY_REVIEW", "SKILL_UPDATES", "SYNC_FAILED"],
  );
  const text = JSON.stringify(notices);
  for (const secret of ["SECRET", "\\u001b", "\\n", "\u202e"])
    assert.ok(!text.includes(secret));
  assert.equal(notices[0].items?.length, 5);
  assert.match(notices[0].message, /等 7 个/);
  assert.match(notices[0].items![0], /^“review长+…”$/);
  assert.equal(notices[0].paths?.length, 7);
  assert.equal(notices[0].command, "hsync sync conflicts");
  assert.equal(notices[2].command, `hsync skills update ${skill.id}`);
  assert.ok(notices.every((n) => n.message.endsWith(agentNotice)));
  // Notice collection must not read any package file, even when the cache reports an update.
  fs.rmSync(store.skillPath(skill.id), { recursive: true });
  assert.deepEqual(collectNotices(store), notices);
});

test("name sanitation counts Unicode characters and strips all line and formatting controls", () => {
  assert.equal(noticeName('a\r\n\t\u0085\u2028\u2029\u2066"“”\\b'), "“ab”");
  assert.equal(noticeName("😀".repeat(61)), `“${"😀".repeat(60)}…”`);
});

test("auto-deploy reminder requires pending changes and clears after successful full apply", async (t) => {
  const { store, engine, settings } = await fixture(t);
  await store.saveRule({ title: "rule", body: "test" });
  const native = path.join(store.home, ".claude/CLAUDE.md");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "external");
  await autoDeploy(engine, "test");
  assert.equal(collectNotices(store)[0]?.code, "AUTO_DEPLOY_REVIEW");
  await engine.apply(engine.plan().id);
  assert.deepEqual(collectNotices(store), []);
  writeJson(path.join(store.root, "auto-deploy.json"), {
    at: "2099-01-01T00:00:00.000Z",
    outcome: "failed",
    changes: { create: 0, update: 0, remove: 0 },
    error: "secret",
    pendingChanges: false,
  });
  assert.deepEqual(collectNotices(store), []);
  await settings.patch({ deploy: { auto: false } });
});

test("stderr fingerprint dedup retains full JSON, expires in six hours and reacts to changes", async (t) => {
  const { store } = await conflictFixture(t);
  const blocks: string[] = [];
  const output = (value: unknown, at: number, quiet = false) =>
    cliNoticeOutput(store, value, {
      at,
      quiet,
      env: {},
      stderr: (b) => blocks.push(b),
    });
  const first = (await output({ ok: true }, 1000)) as any;
  assert.match(blocks[0], /查看：hsync sync conflicts/);
  assert.ok(!blocks[0].includes("127.0.0.1"), "probePort is not a UI port");
  const second = (await output({ ok: true }, 1001)) as any;
  assert.deepEqual(second.reminders, first.reminders);
  assert.ok(!blocks[1].includes("\n"));
  await output({}, 1000 + 6 * 3600_000);
  assert.match(blocks[2], /查看：/);
  const config = JSON.parse(
    fs.readFileSync(path.join(store.root, "sync.json"), "utf8"),
  );
  config.conflicts.pop();
  writeJson(path.join(store.root, "sync.json"), config);
  await output({}, 1001 + 6 * 3600_000);
  assert.match(blocks[3], /6 个同步冲突/);
  assert.deepEqual(await output([1, 2], 1002 + 6 * 3600_000), [1, 2]);
  await output({}, 1003 + 6 * 3600_000, true);
  assert.equal(blocks.length, 5);
});

test("preferences and env disable CLI notices without disabling core notices; caches refuse symlinks", async (t) => {
  const { store, settings, root } = await conflictFixture(t);
  assert.equal(settings.preferences().notices.cli, true);
  await settings.set("notices.cli", "false");
  assert.deepEqual(
    await cliNoticeOutput(
      store,
      { ok: true },
      { env: {}, stderr: () => assert.fail("disabled") },
    ),
    { ok: true },
  );
  await settings.set("notices.cli", "true");
  assert.deepEqual(
    await cliNoticeOutput(
      store,
      {},
      { env: { HSYNC_NO_NOTICES: "1" }, stderr: () => assert.fail("disabled") },
    ),
    {},
  );
  assert.ok(collectNotices(store).length);
  const outside = path.join(root, "outside");
  fs.writeFileSync(outside, "untouched");
  fs.symlinkSync(outside, path.join(store.root, "cli-notices.json"));
  const value = (await cliNoticeOutput(
    store,
    {},
    { env: {}, stderr: () => {} },
  )) as any;
  assert.ok(value.reminders.length);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  fs.unlinkSync(path.join(store.root, "sync.json"));
  fs.symlinkSync(outside, path.join(store.root, "sync.json"));
  assert.deepEqual(collectNotices(store), []);
});

test("CLI success, arrays, AppError, quiet status, settings and environment use one wrapper", async (t) => {
  const { store, home, root } = await conflictFixture(t);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const name of ["launchctl", "systemctl", "gh"])
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
  const invoke = (args: string[], noNotices = false) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          HARNESS_SYNC_HOME: store.root,
          PATH: `${bin}:${process.env.PATH}`,
          HSYNC_NO_NOTICES: noNotices ? "1" : "0",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  const success = invoke(["init"]);
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).reminders[0].code, "SYNC_CONFLICTS");
  assert.match(success.stderr, /查看：/);
  const array = invoke(["rules", "list"]);
  assert.ok(Array.isArray(JSON.parse(array.stdout)));
  assert.ok(!array.stderr.includes("\n  查看"));
  const failure = invoke(["skills", "remove", "missing"]);
  assert.equal(failure.status, 1);
  const error = JSON.parse(failure.stderr.trim().split("\n").at(-1)!);
  assert.equal(error.code, "NOT_FOUND");
  assert.ok(error.reminders.length);
  const status = invoke(["sync", "status"]);
  assert.equal(status.stderr, "");
  assert.ok(JSON.parse(status.stdout).reminders.length);
  assert.equal(invoke(["init"], true).stderr, "");
  assert.equal(
    JSON.parse(invoke(["config", "set", "notices.cli", "false"]).stdout)
      .settings.notices.cli,
    false,
  );
  assert.equal(invoke(["init"]).stderr, "");
  assert.equal(JSON.parse(invoke(["init"]).stdout).reminders, undefined);
});

test("snapshot API exposes notices even when CLI notices are disabled", async (t) => {
  const { store, settings, root, defer } = await conflictFixture(t);
  await settings.patch({
    notices: { cli: false },
    deploy: { auto: false },
    updates: { check: false },
  });
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    service: {
      platform: "test-unsupported",
      runner: async () => {
        throw new Error("must not run");
      },
    },
    updateChecker: new UpdateChecker(store, async () => {
      throw new Error("must not check");
    }),
  });
  defer(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const response = await fetch(`${server.url}/api/snapshot`, {
    headers: { "x-harness-sync-token": token },
  });
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as any;
  assert.equal(snapshot.data.notices[0].code, "SYNC_CONFLICTS");
  const updated = await fetch(`${server.url}/api/settings`, {
    method: "PUT",
    headers: {
      "x-harness-sync-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ notices: { cli: true } }),
  });
  assert.equal(((await updated.json()) as any).data.settings.notices.cli, true);
});

test("adding CLI notices preserves deployment plan notices and leaves primitives and arrays intact", () => {
  const notices = [
    { code: "SYNC_FAILED", severity: "action" as const, message: "同步失败" },
  ];
  const plan = {
    id: "plan",
    notices: [
      { code: "skill-source-changed", blocking: true, message: "原生计划消息" },
    ],
  };
  const result = attachNotices(plan, notices) as any;
  assert.deepEqual(result.notices, plan.notices);
  assert.deepEqual(result.reminders, notices);
  assert.equal(attachNotices(plan, []), plan);
  for (const value of [null, undefined, 1, "string", []])
    assert.equal(attachNotices(value, notices), value);
});

test("long push failures produce a fixed reminder without lastError and legacy settings default to enabled", async (t) => {
  const { store, settings } = await fixture(t);
  writeJson(settings.file, {
    deploy: { auto: true },
    updates: { check: true, intervalHours: 24 },
  });
  assert.equal(settings.preferences().notices.cli, true);
  writeJson(path.join(store.root, "sync-auto.json"), {
    runtime: { failures: 3, pendingPush: true },
  });
  assert.equal(collectNotices(store)[0]?.code, "SYNC_FAILED");
  writeJson(path.join(store.root, "sync-auto.json"), {
    runtime: { failures: 2, pendingPush: true },
  });
  assert.deepEqual(collectNotices(store), []);
  await assert.rejects(settings.patch({ notices: { cli: "false" } }), {
    code: "SETTINGS_OPTIONS",
  });
});

test("a reminder that clears and reappears prints its full block again", async (t) => {
  const { store } = await conflictFixture(t);
  const blocks: string[] = [];
  const options = { env: {}, stderr: (block: string) => blocks.push(block) };
  await cliNoticeOutput(store, {}, options);
  const file = path.join(store.root, "sync.json");
  const config = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  await cliNoticeOutput(store, {}, options);
  assert.equal(blocks.length, 1);
  fs.writeFileSync(file, config);
  await cliNoticeOutput(store, {}, options);
  assert.match(blocks[1], /查看：hsync sync conflicts/);
});
