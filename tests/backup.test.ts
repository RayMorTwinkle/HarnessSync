import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { Backups } from "../src/core/backup.ts";
import { Uninstaller } from "../src/core/uninstall.ts";
import { LoginService } from "../src/core/service.ts";
import { Settings } from "../src/core/settings.ts";
import { autoDeploy } from "../src/core/auto-deploy.ts";
import { createOnboarding } from "../src/core/onboarding.ts";
import { installSelfSkill } from "../src/core/self-skill.ts";
import { startServer } from "../src/server.ts";
import { fakeRunner } from "./settings-helpers.ts";
const put = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
async function fixture(t: TestContext) {
  const home = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hs-backup-"),
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = await new Store(path.join(home, ".hs"), home).init();
  const backups = new Backups(store),
    engine = new Engine(store);
  return { home, store, backups, engine };
}
const rule = (store: Store) =>
  store.saveRule({
    title: "test",
    body: "managed rule",
    enabled: true,
    scope: { kind: "global", harnesses: ["claude"] },
  });
test("registry scope includes disabled plugins and projects, excludes credentials/history; absent, links, modes and fallback", async (t) => {
  const { home, store, backups } = await fixture(t);
  await store.setHarnessEnabled("codex", false);
  const plugin = JSON.parse(
    fs.readFileSync("tests/fixtures/harnesses/acme.json", "utf8"),
  );
  put(path.join(store.root, "harnesses/acme.json"), JSON.stringify(plugin));
  await store.setHarnessEnabled("acme", false);
  fs.mkdirSync(path.join(home, "project"));
  await store.saveProject({
    name: "project",
    path: path.join(home, "project"),
  });
  put(path.join(home, ".codex/auth.json"), "secret");
  put(path.join(home, ".claude/projects/session"), "history");
  put(path.join(home, ".claude/skills/x/SKILL.md"), "skill");
  fs.chmodSync(path.join(home, ".claude/skills/x/SKILL.md"), 0o751);
  fs.symlinkSync(
    path.join(home, ".codex/auth.json"),
    path.join(home, ".claude/skills/link"),
  );
  const result = await backups.create(),
    m = backups.verify(result.dir);
  assert.equal(path.dirname(result.dir), path.join(home, "HarnessSync 备份"));
  assert.equal(fs.statSync(result.dir).mode & 0o777, 0o700);
  assert.ok(m.entries.some((e) => e.path.includes("acme")));
  assert.ok(
    m.entries.some((e) => e.path === path.join(home, "project/AGENTS.md")),
  );
  assert.ok(
    m.entries.some(
      (e) => e.path === path.join(home, ".codex/AGENTS.md") && e.absent,
    ),
  );
  assert.ok(!fs.existsSync(path.join(result.dir, "files/.codex/auth.json")));
  assert.ok(!fs.existsSync(path.join(result.dir, "files/.claude/projects")));
  assert.equal(
    fs.readlinkSync(path.join(result.dir, "files/.claude/skills/link")),
    path.join(home, ".codex/auth.json"),
  );
  assert.equal(
    fs.statSync(path.join(result.dir, "files/.claude/skills/x/SKILL.md")).mode &
      0o777,
    0o751,
  );
  // Link target changes do not invalidate the backup.
  put(path.join(home, ".codex/auth.json"), "changed");
  backups.verify(result.dir);
  put(path.join(result.dir, "files/.claude/skills/x/SKILL.md"), "broken");
  assert.throws(() => backups.verify(result.dir), /校验失败/);
});
test("Downloads and onboarding return the baseline path", async (t) => {
  const { home, store, backups } = await fixture(t);
  fs.mkdirSync(path.join(home, "Downloads"));
  const scan = await createOnboarding(store);
  assert.ok(scan.backupDir?.startsWith(path.join(home, "Downloads")));
  assert.ok(scan.prompt.includes(scan.backupDir!));
  assert.equal(backups.list().length, 1);
});
test("first apply creates baseline; owned restores, unchanged stays, pre-restore snapshot and auto deployment disabled", async (t) => {
  const { home, store, backups, engine } = await fixture(t);
  await rule(store);
  await engine.apply(engine.plan().id);
  assert.equal(backups.list().length, 1);
  const plan = backups.plan();
  assert.ok(plan.changes.some((c) => c.status === "restore"));
  assert.ok(plan.changes.some((c) => c.status === "unchanged"));
  const result = await backups.restore(plan.id);
  assert.ok(!fs.existsSync(path.join(home, ".claude/CLAUDE.md")));
  assert.ok(fs.existsSync(path.join(result.beforeDir, "manifest.json")));
  backups.verify(result.beforeDir);
  assert.equal(store.state().receipts.length, 0);
  assert.equal(new Settings(store).preferences().deploy.auto, false);
  assert.equal((await autoDeploy(engine, "test")).outcome, "disabled");
});
test("external modifications conflict; explicit overwrite, stale previews and undo snapshot", async (t) => {
  const { home, store, backups, engine } = await fixture(t);
  const target = path.join(home, ".claude/CLAUDE.md");
  put(target, "personal\n");
  await rule(store);
  await engine.apply(engine.plan().id);
  const stale = backups.plan();
  fs.appendFileSync(target, "external\n");
  await assert.rejects(backups.restore(stale.id), /重新预览/);
  let plan = backups.plan();
  assert.equal(plan.changes.find((c) => c.path === target)?.status, "conflict");
  await backups.restore(plan.id);
  assert.match(fs.readFileSync(target, "utf8"), /external/);
  plan = backups.plan();
  const result = await backups.restore(plan.id, undefined, [target]);
  assert.equal(fs.readFileSync(target, "utf8"), "personal\n");
  const undo = backups.plan(result.beforeDir);
  await backups.restore(undo.id, undefined, [target]);
  assert.match(fs.readFileSync(target, "utf8"), /external/);
});
test("reject symlink ancestors and require explicit large-backup confirmation before copying", async (t) => {
  const { home, backups } = await fixture(t);
  const target = path.join(home, ".claude/skills/huge");
  put(target, "");
  fs.truncateSync(target, 501 * 1024 * 1024);
  await assert.rejects(backups.create(), /超过 500 MB/);
  assert.equal(backups.list().length, 0);
  fs.rmSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "elsewhere"));
  fs.symlinkSync(path.join(home, "elsewhere"), path.join(home, ".claude"));
  await assert.rejects(backups.create(), /符号链接/);
});
for (const mode of ["restore", "keep-files"] as const)
  test(`uninstall ${mode}, service fake runner, installer ownership and delete-library`, async (t) => {
    const { home, store, backups, engine } = await fixture(t);
    await rule(store);
    await engine.apply(engine.plan().id);
    const dir = path.join(home, ".local/share/harness-sync"),
      launcher = path.join(home, ".local/bin/hsync"),
      cliPath = path.join(dir, "releases/test/dist/cli.js");
    put(cliPath, "program");
    put(path.join(dir, ".harness-sync-install"), "HarnessSync installer v1\n");
    put(launcher, `#!/bin/bash\n# HarnessSync launcher: ${dir}\n`);
    const fake = fakeRunner(),
      service = new LoginService(store, {
        platform: "darwin",
        runner: fake.runner,
        cliPath,
      });
    await service.install();
    const uninstall = new Uninstaller(store, service, { cliPath }),
      plan = uninstall.plan({ mode, deleteLibrary: true });
    const result = await uninstall.apply(plan.id);
    assert.equal(result.programRemoved, true);
    assert.equal(result.launcherRemoved, true);
    assert.ok(!fs.existsSync(store.root));
    assert.ok(!fs.existsSync(service.file));
    assert.ok(fs.existsSync(result.libraryDir));
    assert.ok(fs.existsSync(path.join(result.backupDir, "manifest.json")));
    assert.equal(
      fs.existsSync(path.join(home, ".claude/CLAUDE.md")),
      mode === "keep-files",
    );
    assert.ok(fake.calls.some((c) => c.args[0] === "bootout"));
  });
test("uninstall source run preserves foreign launcher/program and stale plans reject changes", async (t) => {
  const { home, store, backups } = await fixture(t);
  await backups.create();
  const launcher = path.join(home, ".local/bin/hsync");
  put(launcher, "foreign");
  const service = new LoginService(store, {
    platform: "darwin",
    runner: fakeRunner().runner,
  });
  const u = new Uninstaller(store, service, { cliPath: "/source/src/cli.ts" });
  const old = u.plan({ mode: "keep-files" });
  put(launcher, "other");
  await assert.rejects(u.apply(old.id), /重新预览/);
  const result = await u.apply(u.plan({ mode: "keep-files" }).id);
  assert.equal(result.programRemoved, false);
  assert.equal(fs.readFileSync(launcher, "utf8"), "other");
  assert.ok(fs.existsSync(store.root));
});
test("keep-files removes only owned management skills and preserves user skills", async (t) => {
  const { home, store, engine } = await fixture(t);
  put(path.join(home, ".claude/skills/personal/SKILL.md"), "personal");
  await installSelfSkill(store, undefined, ["claude"]);
  await engine.apply(engine.plan().id);
  const self = store.state().receipts.find((r) => r.kind === "skill")!;
  assert.ok(self);
  const u = new Uninstaller(
    store,
    new LoginService(store, {
      platform: "darwin",
      runner: fakeRunner().runner,
    }),
  );
  const result = await u.apply(u.plan({ mode: "keep-files" }).id);
  assert.ok(!fs.existsSync(self.path));
  assert.ok(fs.existsSync(path.join(home, ".claude/skills/personal/SKILL.md")));
  assert.ok(fs.existsSync(result.beforeDir));
});
test("uninstall refuses foreign service files without running system commands", async (t) => {
  const { store, backups } = await fixture(t);
  await backups.create();
  const fake = fakeRunner(),
    service = new LoginService(store, {
      platform: "darwin",
      runner: fake.runner,
    });
  put(service.file, "foreign service");
  const u = new Uninstaller(store, service);
  await assert.rejects(u.apply(u.plan({ mode: "keep-files" }).id));
  assert.equal(fs.readFileSync(service.file, "utf8"), "foreign service");
  assert.equal(fake.calls.length, 0);
});
test("backup API enforces session access and supports plan-ID restore and uninstall", async (t) => {
  const { home, store } = await fixture(t);
  const ui = path.join(home, "ui");
  put(path.join(ui, "index.html"), "<!--HSYNC_TOKEN-->");
  const fake = fakeRunner();
  const cliPath = path.join(home, "installed/dist/cli.js");
  put(cliPath, "program");
  const service = { platform: "darwin", runner: fake.runner, cliPath };
  await new LoginService(store, service).install();
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui,
    service,
  });
  t.after(async () => {
    if (server.server.listening) await server.close();
  });
  assert.equal((await fetch(server.url + "/api/backups")).status, 403);
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)?.[1];
  assert.ok(token, html);
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(server.url + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-harness-sync-token": token!,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  };
  const created = await request("backups", {});
  assert.ok(created.dir);
  assert.equal((await request("backups")).length, 1);
  const plan = await request("backups/restore-plan", {});
  const restored = await request("backups/restore", { planId: plan.id });
  assert.equal(restored.autoDeploy, false);
  const uninstall = await request("uninstall-plan", { mode: "keep-files" });
  const result = await request("uninstall", { planId: uninstall.id });
  assert.equal(result.mode, "keep-files");
  assert.equal(result.serviceStopDeferred, true);
  assert.ok(fake.calls.some((c) => c.args[0] === "bootout"));
  assert.ok(result.libraryDir);
});

for (const existingDirectory of [true, false])
  test(`directory children restore independently (baseline directory exists: ${existingDirectory})`, async (t) => {
    const { home, store, engine, backups } = await fixture(t);
    const root = path.join(home, ".claude/skills");
    if (existingDirectory)
      put(path.join(root, "unchanged/SKILL.md"), "original user skill");
    await store.saveSkill({
      name: "managed",
      description: "managed",
      body: "owned",
      scope: { kind: "global", harnesses: ["claude"] },
    });
    await engine.apply(engine.plan().id);
    const owned = path.join(root, "managed"),
      personal = path.join(root, "personal");
    put(path.join(personal, "SKILL.md"), "new personal skill");
    fs.chmodSync(root, 0o700);
    const plan = backups.plan();
    assert.equal(plan.changes.find((c) => c.path === owned)?.status, "remove");
    assert.equal(plan.changes.find((c) => c.path === personal)?.status, "keep");
    assert.match(
      plan.changes.find((c) => c.path === personal)!.message,
      /保留/,
    );
    assert.ok(!plan.changes.some((c) => c.path === root));
    if (existingDirectory)
      assert.equal(
        plan.changes.find((c) => c.path === path.join(root, "unchanged"))
          ?.status,
        "unchanged",
      );
    await assert.rejects(
      backups.restore(plan.id, undefined, [root]),
      /只能选择/,
    );
    const result = await backups.restore(plan.id);
    assert.ok(!fs.existsSync(owned));
    assert.equal(
      fs.readFileSync(path.join(personal, "SKILL.md"), "utf8"),
      "new personal skill",
    );
    assert.deepEqual(result.conflicts, []);
    const snapshot = backups.verify(result.beforeDir);
    assert.ok(snapshot.entries.some((e) => e.path === owned));
    assert.ok(!snapshot.entries.some((e) => e.path === root));
    assert.equal(store.state().receipts.length, 0);
    // The user's own additions can never be selected for deletion.
    await assert.rejects(
      backups.restore(backups.plan().id, undefined, [personal]),
      /只能选择/,
    );
    assert.ok(fs.existsSync(personal));
  });

test("owned child updates restore; deleted and externally edited children remain conflicts; container mode is ignored", async (t) => {
  const { home, store, engine, backups } = await fixture(t);
  const root = path.join(home, ".claude/skills");
  const original = await store.saveSkill({
    name: "owned",
    description: "test",
    body: "original",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  const { readBundle, writeBundle } = await import("../src/core/files.ts");
  writeBundle(
    path.join(root, "owned"),
    readBundle(store.skillPath(original.id)),
  );
  put(path.join(root, "deleted/SKILL.md"), "deleted later");
  put(path.join(root, "external/SKILL.md"), "external original");
  await backups.create();
  await engine.apply(engine.plan().id);
  await store.saveSkill({ ...original, body: "updated" }, original.id);
  await engine.apply(engine.plan().id);
  fs.rmSync(path.join(root, "deleted"), { recursive: true });
  put(path.join(root, "external/SKILL.md"), "edited");
  const plan = backups.plan();
  fs.chmodSync(root, 0o700);
  assert.equal(backups.plan().id, plan.id);
  assert.equal(
    plan.changes.find((c) => c.path === path.join(root, "owned"))?.status,
    "restore",
  );
  assert.equal(
    plan.changes.find((c) => c.path === path.join(root, "deleted"))?.status,
    "conflict",
  );
  assert.equal(
    plan.changes.find((c) => c.path === path.join(root, "external"))?.status,
    "conflict",
  );
  await backups.restore(plan.id, undefined, [path.join(root, "deleted")]);
  assert.match(
    fs.readFileSync(path.join(root, "owned/SKILL.md"), "utf8"),
    /original/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "deleted/SKILL.md"), "utf8"),
    "deleted later",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "external/SKILL.md"), "utf8"),
    "edited",
  );
});

test("failed child restore rolls back only touched children and keeps receipts", async (t) => {
  const { home, store, engine, backups } = await fixture(t);
  const { readBundle, writeBundle } = await import("../src/core/files.ts");
  const root = path.join(home, ".claude/skills"),
    scope = { kind: "global", harnesses: ["claude"] };
  const original = await store.saveSkill({
    name: "z-owned",
    description: "test",
    body: "original",
    scope,
  });
  writeBundle(
    path.join(root, "z-owned"),
    readBundle(store.skillPath(original.id)),
  );
  const baseline = await backups.create();
  await engine.apply(engine.plan().id);
  await store.saveSkill({ ...original, body: "updated" }, original.id);
  await store.saveSkill({
    name: "a-new",
    description: "test",
    body: "new owned",
    scope,
  });
  await engine.apply(engine.plan().id);
  put(path.join(root, "personal/SKILL.md"), "keep");
  const state = store.state(),
    plan = backups.plan();
  const copy = fs.copyFileSync;
  let injected = false;
  t.mock.method(
    fs,
    "copyFileSync",
    (source: fs.PathLike, target: fs.PathLike, mode?: number) => {
      if (
        !injected &&
        String(source).startsWith(path.join(baseline.dir, "files"))
      ) {
        injected = true;
        throw new Error("injected restore failure");
      }
      return copy(source, target, mode);
    },
  );
  await assert.rejects(backups.restore(plan.id), /injected restore failure/);
  assert.ok(injected);
  assert.deepEqual(store.state(), state);
  assert.match(
    fs.readFileSync(path.join(root, "z-owned/SKILL.md"), "utf8"),
    /updated/,
  );
  assert.ok(fs.existsSync(path.join(root, "a-new/SKILL.md")));
  assert.equal(
    fs.readFileSync(path.join(root, "personal/SKILL.md"), "utf8"),
    "keep",
  );
});

test("uninstall restore keeps the user's additions and does not stop for them", async (t) => {
  const { home, store, engine, backups } = await fixture(t);
  const root = path.join(home, ".claude/skills");
  fs.mkdirSync(root, { recursive: true });
  await installSelfSkill(store, undefined, ["claude"]);
  await engine.apply(engine.plan().id);
  const personal = path.join(root, "personal");
  put(path.join(personal, "SKILL.md"), "personal");
  const u = new Uninstaller(
    store,
    new LoginService(store, {
      platform: "darwin",
      runner: fakeRunner().runner,
    }),
  );
  const preview = u.plan({ mode: "restore" });
  assert.deepEqual(
    preview
      .restore!.changes.filter((c) => c.status === "keep")
      .map((c) => c.path),
    [personal],
  );
  const result = await u.apply(preview.id);
  assert.equal(result.mode, "restore");
  assert.deepEqual(result.restored?.conflicts, []);
  assert.equal(
    fs.readFileSync(path.join(personal, "SKILL.md"), "utf8"),
    "personal",
  );
});

test("missing or damaged baseline does not block apply; missing notice is info and restore/uninstall explain why unavailable", async (t) => {
  const { home, store, engine, backups } = await fixture(t);
  const { collectNotices } = await import("../src/core/notices.ts");
  const entry = await rule(store);
  await engine.apply(engine.plan().id);
  const baseline = backups.list()[0];
  // A damaged manifest proves deployment does not even read/verify it.
  put(path.join(baseline.dir, "manifest.json"), "invalid JSON");
  await store.saveRule({ ...entry, body: "second" }, entry.id);
  await engine.apply(engine.plan().id);
  assert.ok(!collectNotices(store).some((n) => n.code === "BACKUP_MISSING"));
  fs.rmSync(baseline.dir, { recursive: true });
  await store.saveRule({ ...entry, body: "third" }, entry.id);
  await engine.apply(engine.plan().id);
  assert.match(
    fs.readFileSync(path.join(home, ".claude/CLAUDE.md"), "utf8"),
    /third/,
  );
  const notice = collectNotices(store).find(
    (n) => n.code === "BACKUP_MISSING",
  )!;
  assert.equal(notice.severity, "info");
  assert.deepEqual(notice.paths, [baseline.dir]);
  const message =
    "初始备份已被移动或删除；恢复不可用，可运行 hsync backup create 新建";
  assert.equal(notice.message, message);
  assert.throws(() => backups.plan(), { code: "BACKUP_MISSING", message });
  const u = new Uninstaller(
    store,
    new LoginService(store, {
      platform: "darwin",
      runner: fakeRunner().runner,
    }),
  );
  assert.throws(() => u.plan({ mode: "restore" }), {
    code: "BACKUP_MISSING",
    message,
  });
});
