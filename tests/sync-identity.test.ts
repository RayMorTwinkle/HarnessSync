import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { Engine } from "../src/core/engine.ts";
import { autoDeploy } from "../src/core/auto-deploy.ts";
import { readBundle, writeJson, skillMarkdown } from "../src/core/files.ts";
import { writeManifest } from "../src/core/layout.ts";
import { startServer } from "../src/server.ts";

const scope = { kind: "global" as const, harnesses: ["claude"] };
const skill = (name = "shared", body = "相同正文") => ({
  name,
  description: "测试",
  body,
  scope,
});
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const stores = await Promise.all(
    ["a", "b"].map(async (name) => {
      const home = path.join(dir, name);
      fs.mkdirSync(home);
      return new Store(path.join(home, ".hs"), home).init();
    }),
  );
  return {
    dir,
    remote,
    a: stores[0],
    b: stores[1],
    sa: new Sync(stores[0]),
    sb: new Sync(stores[1]),
  };
}
async function deployed(store: Store) {
  const engine = new Engine(store);
  await engine.apply(engine.plan().id);
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
}
async function same(a: Store, b: Store) {
  assert.deepEqual(a.manifest(), b.manifest());
  for (const s of a.manifest().skills)
    assert.deepEqual(
      readBundle(a.skillPath(s.id)),
      readBundle(b.skillPath(s.id)),
    );
}
for (const reverse of [false, true])
  test(`independent imports retain first remote ID and all local references, reverse=${reverse}`, async (t) => {
    const f = await fixture(t);
    const [a, b, sa, sb] = reverse
      ? [f.b, f.a, f.sb, f.sa]
      : [f.a, f.b, f.sa, f.sb];
    const entries = [];
    for (const store of [a, b]) {
      const source = path.join(store.home, "source");
      fs.mkdirSync(source);
      fs.writeFileSync(
        path.join(source, "SKILL.md"),
        skillMarkdown("shared", "测试", "相同正文"),
      );
      fs.writeFileSync(path.join(source, "asset.bin"), Buffer.from([0, 255]));
      fs.chmodSync(path.join(source, "asset.bin"), 0o755);
      fs.chmodSync(path.join(source, "SKILL.md"), 0o640);
      entries.push(await store.importSkill(source, scope));
      await deployed(store);
    }
    const old = entries[1].id,
      canonical = entries[0].id;
    const state = b.state();
    state.conflictChoices = {
      "/fixture-choice": { sourceId: old, use: "skip", fingerprint: "x" },
    };
    writeJson(path.join(b.root, "state.json"), state);
    writeJson(path.join(b.root, "skill-updates.json"), {
      [old]: { id: old, commit: "fixture" },
    });
    // A snapshot can later restore receipts: those references must also move.
    writeJson(path.join(b.root, "deployments/reference-fixture.json"), {
      beforeState: state,
    });
    await sa.setup({ url: f.remote });
    assert.equal((await sb.setup({ url: f.remote })).conflicts.length, 0);
    assert.equal(b.manifest().skills[0].id, canonical);
    assert.ok(!fs.existsSync(b.skillPath(old)));
    assert.equal(b.state().receipts[0].sourceId, canonical);
    assert.equal(
      b.state().conflictChoices!["/fixture-choice"].sourceId,
      canonical,
    );
    assert.equal(b.device().origins![canonical], path.join(b.home, "source"));
    assert.ok(!b.device().origins![old]);
    const cache = JSON.parse(
      fs.readFileSync(path.join(b.root, "skill-updates.json"), "utf8"),
    );
    assert.equal(cache[canonical].id, canonical);
    assert.ok(!cache[old]);
    const snapshot = JSON.parse(
      fs.readFileSync(
        path.join(b.root, "deployments/reference-fixture.json"),
        "utf8",
      ),
    );
    assert.equal(snapshot.beforeState.receipts[0].sourceId, canonical);
    assert.ok(
      new Engine(b).plan().changes.every((c) => c.status === "unchanged"),
    );
    assert.equal((await autoDeploy(new Engine(b), "test")).outcome, "nothing");
    await sa.now();
    await same(a, b);
  });

test("same projects and scoped rules/skills coalesce without losing local bindings", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  const entries = [];
  for (const store of [a, b]) {
    const dir = path.join(store.home, "project");
    fs.mkdirSync(dir);
    const p = await store.saveProject({ name: "同一项目", path: dir });
    const scoped = { ...scope, kind: "project", target: p.id };
    const r = await store.saveRule({
      title: "同一规则",
      body: "正文",
      scope: scoped,
    });
    const s = await store.saveSkill({ ...skill(), scope: scoped });
    entries.push({ p, r, s });
    await deployed(store);
  }
  await sa.setup({ url: remote });
  assert.equal((await sb.setup({ url: remote })).conflicts.length, 0);
  const m = b.manifest();
  assert.equal(m.projects.length, 1);
  assert.equal(m.rules.length, 1);
  assert.equal(m.skills.length, 1);
  assert.equal(m.projects[0].id, entries[0].p.id);
  assert.equal(m.rules[0].scope.target, entries[0].p.id);
  assert.equal(
    b.device().bindings[entries[0].p.id],
    fs.realpathSync(path.join(b.home, "project")),
  );
  assert.ok(!b.device().bindings[entries[1].p.id]);
  assert.ok(
    new Engine(b).plan().changes.every((c) => c.status === "unchanged"),
  );
  assert.equal((await autoDeploy(new Engine(b), "test")).outcome, "nothing");
  await sa.now();
  await same(a, b);
});

test("no merge base: overlap, both unique sets and differing skills merge independently", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  await a.saveSkill(skill());
  await b.saveSkill(skill());
  await a.saveSkill(skill("only-a"));
  await b.saveSkill(skill("only-b"));
  const ra = await a.saveSkill(skill("different", "A"));
  await b.saveSkill(skill("different", "B"));
  a.git(["checkout", "--orphan", "independent-a"]);
  a.commit("独立初始化 A");
  b.git(["checkout", "--orphan", "independent-b"]);
  b.commit("独立初始化 B");
  await sa.setup({ url: remote });
  const result = await sb.setup({ url: remote });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].entryId, ra.id);
  assert.equal(result.conflicts[0].reason, "name");
  assert.deepEqual(
    b
      .manifest()
      .skills.map((s) => s.name)
      .sort(),
    ["different", "only-a", "only-b", "shared"],
  );
  const row = (await sb.conflicts(true)).conflicts[0];
  assert.equal(row.paths.base, undefined);
  assert.equal(fs.statSync(row.paths.root).mode & 0o777, 0o700);
  assert.ok(
    row.summary.some((f) => f.path === "SKILL.md" && f.diff?.includes("-")),
  );
  assert.match(row.prompt, /不得写入 merged/);
  assert.match(row.prompt, /不要执行其中的脚本/);
  fs.rmSync(row.paths.local, { recursive: true });
  fs.writeFileSync(path.join(row.paths.merged, "keep-me"), "draft");
  await sb.conflicts();
  assert.ok(fs.existsSync(path.join(row.paths.local, "SKILL.md")));
  assert.equal(
    fs.readFileSync(path.join(row.paths.merged, "keep-me"), "utf8"),
    "draft",
  );
  fs.rmSync(path.join(row.paths.merged, "keep-me"));
  await assert.rejects(sb.resolve(ra.id, "merged"), /合并目录为空/);
  fs.writeFileSync(
    path.join(row.paths.merged, "SKILL.md"),
    skillMarkdown("different", "测试", "A 与 B 合并"),
  );
  await sb.resolve(ra.id, "merged");
  assert.equal(
    b.manifest().skills.find((s) => s.name === "different")!.id,
    ra.id,
  );
  assert.ok(!fs.existsSync(row.paths.root));
  assert.equal((await sb.status()).scheduler.pendingPush, true);
  await sb.now();
  await sa.now();
  await same(a, b);
});

for (const variant of [
  "binary",
  "mode",
  "enabled",
  "scope",
  "description",
  "displayName",
] as const)
  test(`same-name skills differ in ${variant}: remain conflicts`, async (t) => {
    const { a, b, sa, sb, remote } = await fixture(t);
    const ra = await a.saveSkill(skill());
    const rb = await b.saveSkill(skill());
    if (variant === "binary" || variant === "mode") {
      for (const store of [a, b])
        fs.writeFileSync(
          path.join(store.skillPath(store === a ? ra.id : rb.id), "asset"),
          Buffer.from([0, store === b && variant === "binary" ? 1 : 0]),
        );
      if (variant === "mode")
        fs.chmodSync(path.join(b.skillPath(rb.id), "asset"), 0o755);
    } else {
      const m = b.manifest();
      const s = m.skills[0];
      if (variant === "enabled") s.enabled = false;
      if (variant === "scope")
        s.scope = {
          kind: "device",
          target: b.device().id,
          harnesses: ["claude"],
        };
      if (variant === "description") s.description = "不同描述";
      if (variant === "displayName") s.displayName = "不同显示名";
      writeManifest(b.repo, m);
    }
    await sa.setup({ url: remote });
    assert.equal((await sb.setup({ url: remote })).conflicts[0].reason, "name");
    const row = (await sb.conflicts(true)).conflicts[0];
    if (variant === "binary")
      assert.equal(
        row.summary.find((f) => f.path === "asset")!.diff,
        "二进制不同",
      );
  });

test("rule name conflicts support merged, undo and external --from; same-ID identical changes stay conflict-free", async (t) => {
  const { a, b, sa, sb, remote, dir } = await fixture(t);
  const ra = await a.saveRule({ title: "规则", body: "A", scope });
  const rb = await b.saveRule({ title: "规则", body: "B", scope });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  const row = (await sb.conflicts()).conflicts[0];
  assert.equal(row.reason, "name");
  const from = path.join(dir, "merged-rule");
  fs.mkdirSync(from);
  fs.copyFileSync(
    path.join(row.paths.remote, "meta.json"),
    path.join(from, "meta.json"),
  );
  fs.writeFileSync(path.join(from, "rule.md"), "");
  await assert.rejects(sb.resolve(ra.id, "merged", from), /正文不能为空/);
  fs.writeFileSync(path.join(from, "rule.md"), "合并");
  await sb.resolve(ra.id, "merged", from);
  assert.equal(b.manifest().rules[0].id, ra.id);
  assert.ok(!fs.existsSync(row.paths.root));
  await sb.undo();
  assert.equal(b.manifest().rules[0].id, rb.id);
  assert.ok(fs.existsSync(row.paths.root));
  await sb.resolve(ra.id, "merged", from);
  await sb.now();
  await sa.now();
  await same(a, b);
  for (const store of [a, b])
    await store.saveRule(
      { ...store.manifest().rules[0], body: "双方一致" },
      ra.id,
    );
  await sa.now();
  assert.equal((await sb.now()).conflicts.length, 0);
  await same(a, b);
});

test("workspace and merged input reject symlinks; invalid names and duplicate names leave source intact", async (t) => {
  const { a, b, sa, sb, remote, dir } = await fixture(t);
  const ra = await a.saveSkill(skill("shared", "A"));
  await b.saveSkill(skill("shared", "B"));
  await b.saveSkill(skill("taken"));
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  const row = (await sb.conflicts()).conflicts[0],
    before = b.manifest();
  fs.writeFileSync(path.join(row.paths.merged, "SKILL.md"), "invalid");
  await assert.rejects(sb.resolve(ra.id, "merged"), /合并结果无效/);
  fs.writeFileSync(
    path.join(row.paths.merged, "SKILL.md"),
    skillMarkdown("taken", "测试", "x"),
  );
  await assert.rejects(sb.resolve(ra.id, "merged"), /名称.*重复/);
  fs.symlinkSync(dir, path.join(row.paths.merged, "link"));
  await assert.rejects(sb.resolve(ra.id, "merged"), /符号链接/);
  await assert.rejects(sb.conflicts(), /符号链接/);
  fs.rmSync(path.join(row.paths.merged, "link"));
  fs.rmSync(row.paths.local, { recursive: true });
  fs.symlinkSync(dir, row.paths.local);
  await assert.rejects(sb.conflicts(), /符号链接/);
  await assert.rejects(sb.resolve(ra.id, "local"), /符号链接/);
  assert.deepEqual(b.manifest(), before);
  fs.rmSync(row.paths.local);
  await sb.resolve(ra.id, "remote");
  assert.ok(!fs.existsSync(row.paths.root));
});

test("HTTP conflicts and merged resolution require token/origin and expose diffs; CLI conflicts uses shared core", async (t) => {
  const { a, b, sa, sb, remote, dir } = await fixture(t);
  const rule = await a.saveRule({ title: "规则", body: "基础", scope });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  await a.saveRule({ ...rule, body: "远端" }, rule.id);
  await b.saveRule({ ...rule, body: "本机" }, rule.id);
  await sa.now();
  await sb.now();
  await sb.setAuto({ enabled: false });
  const ui = path.join(dir, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, "index.html"), "<!--HSYNC_TOKEN-->");
  const server = await startServer(b, { port: 0, uiDirectory: ui });
  t.after(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${server.url}/api/sync/conflicts`)).status, 403);
  assert.equal(
    (
      await fetch(`${server.url}/api/sync/conflicts`, {
        headers: { ...headers, origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const result = await (
    await fetch(`${server.url}/api/sync/conflicts`, { headers })
  ).json();
  const row = result.data.conflicts[0];
  assert.ok(row.paths.base);
  assert.match(
    row.summary.find((f: any) => f.path === "rule.md").diff,
    /-本机/,
  );
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("src/cli.ts"),
        "--root",
        b.root,
        "sync",
        "conflicts",
        "--json",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: b.home, HARNESS_SYNC_HOME: b.root },
      },
    ),
  );
  assert.equal(cli.conflicts[0].entryId, rule.id);
  fs.copyFileSync(
    path.join(row.paths.remote, "meta.json"),
    path.join(row.paths.merged, "meta.json"),
  );
  fs.writeFileSync(path.join(row.paths.merged, "rule.md"), "合并");
  const response = await fetch(`${server.url}/api/sync/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entryId: rule.id, keep: "merged" }),
  });
  assert.equal(response.status, 200);
  assert.equal(b.manifest().rules[0].body, "合并");
  assert.ok(!fs.existsSync(row.paths.root));
});

test("rule ID reconciliation preserves deployed order of multiple instruction fragments", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  for (const store of [a, b]) {
    const m = store.manifest();
    m.rules = [
      {
        id: store === a ? "a" : "z",
        title: "第一",
        body: "第一正文",
        enabled: true,
        scope,
      },
      {
        id: store === a ? "z" : "a",
        title: "第二",
        body: "第二正文",
        enabled: true,
        scope,
      },
    ];
    writeManifest(store.repo, m);
    store.commit("不同顺序的独立规则");
    await deployed(store);
  }
  // Use distinct identities with reversed lexical order on B.
  const m = b.manifest();
  m.rules = m.rules.map((r) => ({ ...r, id: `b-${r.id}` }));
  writeManifest(b.repo, m);
  b.commit("独立 ID");
  await sa.setup({ url: remote });
  assert.equal((await sb.setup({ url: remote })).conflicts.length, 0);
  assert.ok(
    new Engine(b).plan().changes.every((c) => c.status === "unchanged"),
  );
  assert.equal((await autoDeploy(new Engine(b), "test")).outcome, "nothing");
  await sa.now();
  await same(a, b);
});

test("project rename conflict supports merged and restores local bindings on undo", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  const p = await a.saveProject({ name: "项目" });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  const localPath = path.join(b.home, "project");
  fs.mkdirSync(localPath);
  await b.saveProject({ name: "本机名称", path: localPath }, p.id);
  await a.saveProject({ name: "远端名称" }, p.id);
  await sa.now();
  await sb.now();
  const row = (await sb.conflicts()).conflicts[0];
  assert.equal(row.kind, "projects");
  assert.ok(row.paths.base);
  writeJson(path.join(row.paths.merged, "project.json"), { name: "合并名称" });
  await sb.resolve(p.id, "merged");
  assert.equal(b.manifest().projects[0].name, "合并名称");
  assert.equal(b.device().bindings[p.id], fs.realpathSync(localPath));
  await sb.undo();
  assert.equal(b.manifest().projects[0].name, "本机名称");
  await sb.resolve(p.id, "remote");
  await sb.now();
  await sa.now();
  await same(a, b);
});

test("interrupted identity merge recovers source and receipts atomically, refuses edited local references", async (t) => {
  const { a, b, sa, sb, remote, dir } = await fixture(t);
  const ra = await a.saveSkill(skill());
  const rb = await b.saveSkill(skill());
  await deployed(b);
  const before = fs.readFileSync(path.join(b.root, "state.json"));
  await sa.setup({ url: remote });
  const script = path.join(dir, "crash.mts");
  fs.writeFileSync(
    script,
    `
    import {Store} from ${JSON.stringify(path.resolve("src/core/store.ts"))};
    import {Sync} from ${JSON.stringify(path.resolve("src/core/sync.ts"))};
    import fs from "node:fs";
    const store = await new Store(${JSON.stringify(b.root)},${JSON.stringify(b.home)}).init();
    const sync = new Sync(store);
    // Crash while building the merged tree, after the recovery checkpoint exists.
    const writeTree = store.writeTree.bind(store);
    store.writeTree = files => { if (fs.existsSync(${JSON.stringify(path.join(b.root, "sync-recovery.json"))})) process.exit(77); return writeTree(files); };
    await sync.setup({url:${JSON.stringify(remote)}});
  `,
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.resolve("node_modules/tsx/dist/cli.mjs"), script],
        {
          env: { ...process.env, HOME: b.home, HARNESS_SYNC_HOME: b.root },
          stdio: "pipe",
        },
      ),
    (e: any) => e.status === 77,
  );
  assert.equal(b.manifest().skills[0].id, ra.id);
  assert.equal(b.state().receipts[0].sourceId, ra.id);
  const after = fs.readFileSync(path.join(b.root, "state.json"));
  writeJson(path.join(b.root, "state.json"), {
    ...b.state(),
    instructionReplacements: [{ path: "fixture", hash: "changed" }],
  });
  await assert.rejects(sb.undo(), /本机引用已改变/);
  fs.writeFileSync(path.join(b.root, "state.json"), after);
  await sb.undo();
  assert.equal(b.manifest().skills[0].id, rb.id);
  assert.deepEqual(fs.readFileSync(path.join(b.root, "state.json")), before);
  assert.ok(
    new Engine(b).plan().changes.every((c) => c.status === "unchanged"),
  );
  await sb.now();
  assert.equal(b.state().receipts[0].sourceId, ra.id);
  await sa.now();
  await same(a, b);
});

test("merged resolution remaps receipts and undo restores their original identity", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  const ra = await a.saveSkill(skill("shared", "A"));
  const rb = await b.saveSkill(skill("shared", "B"));
  await deployed(b);
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  const row = (await sb.conflicts()).conflicts[0];
  fs.copyFileSync(
    path.join(row.paths.local, "SKILL.md"),
    path.join(row.paths.merged, "SKILL.md"),
  );
  await sb.resolve(ra.id, "merged");
  assert.equal(b.state().receipts[0].sourceId, ra.id);
  assert.ok(
    new Engine(b).plan().changes.every((c) => c.status === "unchanged"),
  );
  await sb.undo();
  assert.equal(b.state().receipts[0].sourceId, rb.id);
  assert.equal(b.manifest().skills[0].id, rb.id);
  assert.ok(fs.existsSync(row.paths.root));
});

test("different provenance and harness order do not change content identity", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  const ra = await a.saveSkill({
    ...skill(),
    scope: { ...scope, harnesses: ["claude", "codex"] },
  });
  const rb = await b.saveSkill({
    ...skill(),
    scope: { ...scope, harnesses: ["codex", "claude"] },
  });
  const am = a.manifest(),
    bm = b.manifest();
  am.skills[0].source = {
    type: "git",
    url: "https://example.invalid/fixture.git",
    ref: "main",
    subpath: "shared",
    commit: "a".repeat(40),
    installedHash: "fixture",
  };
  bm.skills[0].source = path.join(b.home, "legacy-source");
  writeManifest(a.repo, am);
  writeManifest(b.repo, bm);
  const d = b.device();
  d.originRealPaths = { [rb.id]: path.join(b.home, "real-origin") };
  writeJson(path.join(b.root, "device.json"), d);
  await sa.setup({ url: remote });
  assert.equal((await sb.setup({ url: remote })).conflicts.length, 0);
  assert.equal(b.manifest().skills[0].id, ra.id);
  assert.equal(
    b.device().originRealPaths![ra.id],
    path.join(b.home, "real-origin"),
  );
  assert.ok(!b.device().originRealPaths![rb.id]);
  assert.equal(b.device().origins![ra.id], path.join(b.home, "legacy-source"));
  await sa.now();
  await same(a, b);
});

test("identity mapping refuses symlinked receipts before source changes", async (t) => {
  const { a, b, sa, sb, remote, dir } = await fixture(t);
  await a.saveSkill(skill());
  const rb = await b.saveSkill(skill());
  const outside = path.join(dir, "external-state");
  fs.writeFileSync(outside, JSON.stringify(b.state()));
  fs.rmSync(path.join(b.root, "state.json"));
  fs.symlinkSync(outside, path.join(b.root, "state.json"));
  await sa.setup({ url: remote });
  await assert.rejects(sb.setup({ url: remote }), /符号链接/);
  assert.equal(b.manifest().skills[0].id, rb.id);
  assert.equal(fs.readFileSync(outside, "utf8"), '{"receipts":[]}');
});
