import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Settings } from "../src/core/settings.ts";
import { Sync } from "../src/core/sync.ts";
import { startServer } from "../src/server.ts";
import {
  UpdateChecker,
  cachedSkillUpdates,
} from "../src/core/update-checks.ts";
import { writeJson } from "../src/core/files.ts";
import { fixture, ui } from "./settings-helpers.ts";

test("settings defaults, strict validation, deep patch, persistence, sync compatibility and revision", async (t) => {
  const { settings, store } = await fixture(t);
  const first = await settings.get();
  assert.deepEqual(first.settings, {
    deploy: { auto: true },
    sync: { auto: false, pushDelaySeconds: 120, pullIntervalMinutes: 10 },
    updates: { check: true, intervalHours: 24 },
    startup: { login: false },
  });
  assert.equal(fs.existsSync(settings.file), false);
  assert.deepEqual(first.meta.allowed["updates.intervalHours"], [6, 24, 168]);
  for (const patch of [
    { deploy: { auto: "yes" } },
    { updates: { intervalHours: 12 } },
    { sync: { pushDelaySeconds: 0 } },
    { sync: { pullIntervalMinutes: 86401 } },
    { sync: { auto: 1 } },
    { bogus: true },
    { deploy: { extra: true } },
    { startup: { login: null } },
  ])
    await assert.rejects(settings.patch(patch), { code: "SETTINGS_OPTIONS" });
  await settings.patch(
    {
      deploy: { auto: false },
      updates: { intervalHours: 6 },
      sync: { auto: true, pushDelaySeconds: 1, pullIntervalMinutes: 86400 },
    },
    first.meta.revision,
  );
  await assert.rejects(
    settings.patch({ deploy: { auto: true } }, first.meta.revision),
    { code: "STALE_REVISION" },
  );
  const persisted = new Settings(store, settings.service);
  assert.equal((await persisted.get()).settings.updates.check, true);
  assert.equal((await persisted.get()).settings.deploy.auto, false);
  assert.equal(new Sync(store).autoSettings().debounceSeconds, 1);
  await new Sync(store).setAuto({ debounceSeconds: 9 });
  assert.equal((await settings.get()).settings.sync.pushDelaySeconds, 9);
  assert.ok(!fs.readFileSync(settings.file, "utf8").includes("sync"));
  assert.equal(store.git(["status", "--porcelain"]), "");
});
test("settings concurrent patches preserve fields and refuse symlink writes", async (t) => {
  const { settings, root } = await fixture(t);
  await Promise.all([
    settings.patch({ deploy: { auto: false } }),
    settings.patch({ updates: { intervalHours: 168 } }),
  ]);
  const result = await settings.get();
  assert.equal(result.settings.deploy.auto, false);
  assert.equal(result.settings.updates.intervalHours, 168);
  fs.unlinkSync(settings.file);
  const target = path.join(root, "target");
  fs.writeFileSync(target, "untouched");
  fs.symlinkSync(target, settings.file);
  await assert.rejects(settings.patch({ deploy: { auto: true } }), {
    code: "SYMLINK_TARGET",
  });
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});
test("CLI config round trip uses temp HOME/store and fake platform commands", async (t) => {
  const { root, home, store } = await fixture(t);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  // These stand-ins ensure no real launchctl/systemctl can run in the child.
  for (const name of ["launchctl", "systemctl"])
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--json", ...args],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            HOME: home,
            HARNESS_SYNC_HOME: store.root,
            PATH: `${bin}:${process.env.PATH}`,
          },
          encoding: "utf8",
        },
      ),
    );
  const call = (...args: string[]) => invoke("config", ...args);
  assert.equal(call("get", "deploy.auto"), true);
  assert.equal(call("set", "deploy.auto", "false").settings.deploy.auto, false);
  assert.equal(
    call("set", "updates.intervalHours", "168").settings.updates.intervalHours,
    168,
  );
  assert.equal(call("get", "updates.intervalHours"), 168);
  assert.equal(call("list").settings.deploy.auto, false);
  const file = path.join(root, "rule.md");
  fs.writeFileSync(file, "CLI content");
  const disabled = invoke(
    "rules",
    "add",
    "--title",
    "cli rule",
    "--file",
    file,
  );
  assert.equal(disabled.autoDeploy.outcome, "disabled");
  assert.equal(store.state().receipts.length, 0);
  const enabled = call("set", "deploy.auto", "true");
  assert.equal(enabled.autoDeploy.outcome, "applied");
  assert.equal(store.state().receipts.length, 4);
  assert.equal(invoke("service", "status").login, false);
});
test("settings HTTP authorization, facade, legacy auto-sync endpoint and cached updates GET", async (t) => {
  const { root, store, defer, settings } = await fixture(t);
  await settings.patch({ updates: { check: false } });
  const skill = await store.saveSkill({
    name: "cached",
    description: "test",
    body: "cache",
  });
  const commit = "a".repeat(40);
  await store.mutate("Git source fixture", (m) => {
    m.skills[0].source = {
      type: "git",
      url: "https://never-contact.invalid/test.git",
      ref: "main",
      subpath: ".",
      commit,
      installedHash: "test",
    };
  });
  const cached = [
    {
      id: skill.id,
      name: skill.name,
      checkedAt: new Date().toISOString(),
      commit,
      available: false,
    },
  ];
  writeJson(path.join(store.root, "skill-updates.json"), {
    [skill.id]: cached[0],
  });
  const checkerCalls: number[] = [];
  const checker = new UpdateChecker(store, async () => {
    checkerCalls.push(1);
    return cached;
  });
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    service: { platform: "test-unsupported" },
    updateChecker: checker,
  });
  defer(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const call = (route: string, method = "GET", body?: unknown, extra = {}) =>
    fetch(`${server.url}/api/${route}`, {
      method,
      headers: {
        "x-harness-sync-token": token,
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await fetch(`${server.url}/api/settings`)).status, 403);
  assert.equal(
    (await call("settings", "PUT", {}, { origin: "https://evil.test" })).status,
    403,
  );
  assert.equal(
    (await call("settings", "PUT", { updates: { intervalHours: 7 } })).status,
    400,
  );
  const first = await (await call("settings")).json();
  assert.equal(first.data.settings.deploy.auto, true);
  assert.equal(
    (
      await (
        await call("settings", "PUT", {
          deploy: { auto: false },
          sync: { pushDelaySeconds: 7 },
        })
      ).json()
    ).data.settings.sync.pushDelaySeconds,
    7,
  );
  assert.equal(
    (await (await call("sync/auto")).json()).data.debounceSeconds,
    7,
  );
  await call("sync/auto", "PUT", { debounceSeconds: 8 });
  assert.equal(
    (await (await call("settings")).json()).data.settings.sync.pushDelaySeconds,
    8,
  );
  assert.deepEqual((await (await call("skills/updates")).json()).data, cached);
  assert.equal(checkerCalls.length, 0);
  assert.equal((await call("skills/updates", "POST", {})).status, 200);
  assert.equal(checkerCalls.length, 1);
});
test("update checks obey intervals, persist backoff, honor disabled state and read cached data offline", async (t) => {
  const { store, settings } = await fixture(t);
  const start = Date.now();
  let calls = 0;
  let failing = false;
  const checker = new UpdateChecker(store, async () => {
    calls++;
    if (failing) throw new Error("网络失败");
    return [];
  });
  await checker.tick(start);
  await checker.tick(start + 1000);
  assert.equal(calls, 1);
  await settings.patch({ updates: { intervalHours: 6 } });
  failing = true;
  await assert.rejects(checker.tick(start + 6 * 3600_000), /网络失败/);
  await checker.tick(start + 6 * 3600_000 + 29_999);
  assert.equal(calls, 2);
  const restarted = new UpdateChecker(store, async () => {
    calls++;
    return [];
  });
  await restarted.tick(start + 6 * 3600_000 + 30_000);
  assert.equal(calls, 3);
  await settings.patch({ updates: { check: false } });
  await restarted.tick(start + 200 * 3600_000);
  assert.equal(calls, 3);
  assert.deepEqual(cachedSkillUpdates(store), []);
  // A cached full manual check postpones background network work.
  const manual = new UpdateChecker(store, async () => {
    calls++;
    return [];
  });
  await manual.now([], start + 7 * 3600_000);
  await settings.patch({ updates: { check: true } });
  await manual.tick(start + 8 * 3600_000);
  assert.equal(calls, 4);
  await manual.close();
});

test("failed startup side effect rolls back settings and auto-sync bytes", async (t) => {
  const { settings, store } = await fixture(t);
  await new Sync(store).setAuto({ debounceSeconds: 11 });
  const syncFile = path.join(store.root, "sync-auto.json");
  const before = fs.readFileSync(syncFile);
  await assert.rejects(
    settings.patch({
      deploy: { auto: false },
      sync: { pushDelaySeconds: 22 },
      startup: { login: true },
    }),
    { code: "SERVICE_UNSUPPORTED" },
  );
  assert.equal(fs.existsSync(settings.file), false);
  assert.deepEqual(fs.readFileSync(syncFile), before);
  assert.equal((await settings.get()).settings.deploy.auto, true);
});

test("corrupt settings fail with a Chinese AppError and starting a scheduler does not leak ownership", async (t) => {
  const { settings, store, root } = await fixture(t);
  fs.writeFileSync(settings.file, "broken JSON");
  await assert.rejects(settings.get(), { code: "SETTINGS_FILE" });
  await assert.rejects(startServer(store, { port: 0, uiDirectory: ui(root) }), {
    code: "SETTINGS_FILE",
  });
  assert.equal(
    fs.existsSync(path.join(store.root, "scheduler-owner.json")),
    false,
  );
});
