import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { startSyncScheduler } from "../src/core/sync-scheduler.ts";
import { stable, writeManifest } from "../src/core/layout.ts";
import { parseSkill } from "../src/core/files.ts";
import { Engine } from "../src/core/engine.ts";
import { startServer } from "../src/server.ts";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const a = await new Store(path.join(dir, "a"), home).init();
  const b = await new Store(path.join(dir, "b"), home).init();
  return { a, b, sa: new Sync(a), sb: new Sync(b), remote, dir };
}
async function connected(t: TestContext) {
  const f = await fixture(t);
  const rule = await f.a.saveRule({ title: "shared", body: "base" });
  await f.sa.setup({ url: f.remote });
  await f.sb.setup({ url: f.remote });
  await f.sa.now();
  return { ...f, rule };
}
const skill = (name: string, body = "base") => ({
  name,
  description: "test",
  body,
});

test("v1 reads without writes, migrates once on mutation; v2 opens read-only with deterministic bytes", async (t) => {
  const { a } = await fixture(t);
  const preserved = await a.saveRule({ title: "legacy", body: "preserved" });
  const legacy = a.manifest();
  fs.rmSync(path.join(a.repo, "harness-sync.json"));
  fs.rmSync(path.join(a.repo, "entries"), { recursive: true });
  fs.writeFileSync(path.join(a.repo, "manifest.json"), JSON.stringify(legacy));
  a.commit("legacy");
  const before = a.git(["status", "--porcelain"]);
  await new Store(a.root, a.home).init();
  assert.equal(a.git(["status", "--porcelain"]), before);
  assert.ok(fs.existsSync(path.join(a.repo, "manifest.json")));
  await a.saveRule({ title: "first", body: "body" });
  await a.saveRule({ title: "second", body: "body" });
  assert.ok(
    a
      .manifest()
      .rules.some((r) => r.id === preserved.id && r.body === "preserved"),
  );
  assert.equal(
    a.history().filter((h) => h.message === "迁移配置库到 v2").length,
    1,
  );
  const files = a.git(["ls-files"]).split("\n");
  const bytes = files.map((f) => fs.readFileSync(path.join(a.repo, f), "utf8"));
  writeManifest(a.repo, {
    ...a.manifest(),
    rules: a.manifest().rules.reverse(),
  });
  assert.deepEqual(
    files.map((f) => fs.readFileSync(path.join(a.repo, f), "utf8")),
    bytes,
  );
  fs.chmodSync(a.root, 0o500);
  try {
    await new Store(a.root, a.home).init();
    assert.ok(!fs.existsSync(path.join(a.root, ".lock")));
  } finally {
    fs.chmodSync(a.root, 0o700);
  }
  assert.equal(
    stable({ z: 1, a: { b: 2, a: 1 } }),
    stable({ a: { a: 1, b: 2 }, z: 1 }),
  );
});

test("setup pushes/restores, merges independent entries, is idempotent, never deploys or commits device files; restore undoes merge", async (t) => {
  const { a, b, sa, sb, remote, rule } = await connected(t);
  assert.equal(b.manifest().rules[0].id, rule.id);
  const local = await a.saveRule({ title: "A", body: "A" });
  await b.saveRule({ title: "B", body: "B" });
  await sb.now();
  const safety = a.git(["rev-parse", "HEAD"]);
  await sa.now();
  assert.equal(a.manifest().rules.length, 3);
  assert.equal(
    a.git(["show", "-s", "--format=%P", "HEAD"]).split(" ").length,
    2,
  );
  await sb.now();
  const head = b.git(["rev-parse", "HEAD"]);
  await sb.now();
  await sa.now();
  assert.equal(b.git(["rev-parse", "HEAD"]), head);
  assert.equal(a.git(["rev-parse", "HEAD"]), head);
  assert.deepEqual((await sa.status()).conflicts, []);
  const tracked = a.git(["ls-files"]);
  assert.doesNotMatch(
    tracked,
    /(^|\n)(device\.json|state\.json|sync\.json|deployments|onboarding)(\n|\/|$)/,
  );
  assert.ok(!fs.existsSync(path.join(a.home, ".claude")));
  await a.restoreSource(safety);
  assert.equal(a.manifest().rules.length, 2);
  assert.ok(a.manifest().rules.some((r) => r.id === local.id));
  await sa.disconnect();
  assert.equal((await sa.status()).connected, false);
  assert.equal(a.manifest().rules.length, 2);
  assert.ok(remote);
});

for (const keep of ["local", "remote", "both"] as const)
  test(`same-entry conflict is nonblocking; resolve ${keep}`, async (t) => {
    const { a, b, sa, sb, rule } = await connected(t);
    await a.saveRule({ ...rule, body: "local" }, rule.id);
    await b.saveRule({ ...rule, body: "remote" }, rule.id);
    await b.saveRule({ title: "unrelated", body: "accepted" });
    await sb.now();
    const result = await sa.now();
    assert.equal(result.conflicts.length, 1);
    // An open conflict must not overwrite the other device's version.
    assert.equal((result as any).pushBlocked, true);
    await sb.now();
    assert.equal(
      b.manifest().rules.find((r) => r.id === rule.id)?.body,
      "remote",
    );
    assert.equal(
      a.manifest().rules.find((r) => r.id === rule.id)?.body,
      "local",
    );
    assert.equal(a.manifest().rules.length, 2);
    const sha = a.git(["rev-parse", "HEAD"]);
    await sa.now();
    assert.equal(a.git(["rev-parse", "HEAD"]), sha);
    assert.equal((await sa.status()).conflicts.length, 1);
    await sa.resolve(rule.id, keep);
    const rules = a.manifest().rules;
    assert.equal(
      rules.find((r) => r.id === rule.id)?.body,
      keep === "remote" ? "remote" : "local",
    );
    assert.equal(rules.length, keep === "both" ? 3 : 2);
    assert.equal((await sa.status()).conflicts.length, 0);
    const resolvedHead = a.git(["rev-parse", "HEAD"]);
    await sa.undo();
    assert.equal((await sa.status()).conflicts.length, 1);
    assert.equal(
      a.manifest().rules.find((r) => r.id === rule.id)?.body,
      "local",
    );
    assert.equal(a.git(["rev-parse", "HEAD^1"]), resolvedHead);
    await sa.resolve(rule.id, keep);
    await sa.now();
    await sb.now();
    assert.deepEqual(b.manifest(), a.manifest());
  });

test("same name with different skill ids conflicts; both renames remote bundle and retains executable binary resources", async (t) => {
  const { a, b, sa, sb } = await connected(t);
  const aSkill = await a.saveSkill(skill("shared-skill", "A"));
  const bSkill = await b.saveSkill(
    skill("shared-skill", "B"),
    undefined,
    undefined,
    {
      "run.bin": {
        content: Buffer.from([0, 255]).toString("base64"),
        mode: 0o755,
      },
    },
  );
  await sb.now();
  const r = await sa.now();
  assert.equal(r.conflicts[0].reason, "name");
  assert.equal(a.manifest().skills[0].id, aSkill.id);
  await sa.resolve(bSkill.id, "both");
  assert.deepEqual(
    a
      .manifest()
      .skills.map((s) => s.name)
      .sort(),
    ["shared-skill", "shared-skill-2"],
  );
  const copy = a.manifest().skills.find((s) => s.name.endsWith("-2"))!;
  assert.equal(
    parseSkill(
      fs.readFileSync(path.join(a.skillPath(copy.id), "SKILL.md"), "utf8"),
    ).name,
    copy.name,
  );
  assert.equal(
    fs.statSync(path.join(a.skillPath(copy.id), "run.bin")).mode & 0o777,
    0o755,
  );
  await sa.now();
  await sb.now();
  assert.equal(b.manifest().skills.length, 2);
});

test("delete versus edit conflicts; remote deletion and remote edited copy can each be chosen", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  await a.saveRule({ ...rule, body: "edited" }, rule.id);
  await b.remove("rules", rule.id);
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 1);
  await assert.rejects(sa.resolve(rule.id, "both"), /删除冲突/);
  await sa.resolve(rule.id, "remote");
  assert.equal(a.manifest().rules.length, 0);
  await sa.now();
  await sb.now();
  const second = await a.saveRule({ title: "second", body: "base" });
  await sa.now();
  await sb.now();
  await a.remove("rules", second.id);
  await b.saveRule({ ...second, body: "remote-edit" }, second.id);
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 1);
  await sa.resolve(second.id, "remote");
  assert.equal(a.manifest().rules[0].body, "remote-edit");
});

test("one-sided edits, deletes, display renames, project identity and device scope sync without local bindings", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  await a.saveRule({ ...rule, title: "renamed" }, rule.id);
  const project = await a.saveProject({ name: "shared project" });
  await a.saveRule({
    title: "device",
    body: "only A",
    scope: { kind: "device", target: a.device().id, harnesses: ["claude"] },
  });
  await sa.now();
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.title,
    "renamed",
  );
  assert.equal(b.manifest().projects[0].id, project.id);
  assert.deepEqual(b.device().bindings, {});
  assert.ok(
    !new Engine(b).plan().changes.some((c) => c.after.includes("only A")),
  );
  await a.remove("rules", rule.id);
  await sa.now();
  await sb.now();
  assert.ok(!b.manifest().rules.some((r) => r.id === rule.id));
});

test("setup merges two existing libraries and rejects invalid options, credentials and unsafe remote trees", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  await a.saveRule({ title: "A", body: "a" });
  await b.saveRule({ title: "B", body: "b" });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  assert.equal(b.manifest().rules.length, 2);
  await assert.rejects(sa.setup({ url: remote }), /已连接/);
  await sa.disconnect();
  await assert.rejects(
    sa.setup({ url: "https://token@github.com/repo" }),
    /凭证/,
  );
  fs.symlinkSync("/tmp", path.join(b.repo, "unsafe"));
  b.commit("unsafe");
  b.git(["push", remote, "HEAD:main"]);
  await assert.rejects(sa.setup({ url: remote }), /符号链接/);
});

test("sync HTTP endpoints enforce token and origin and expose shared core", async (t) => {
  const { a, remote, dir } = await fixture(t);
  const ui = path.join(dir, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, "index.html"), "<!--HSYNC_TOKEN-->");
  const server = await startServer(a, { port: 0, uiDirectory: ui });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const call = (route: string, body?: unknown, headers = {}) =>
    fetch(`${server.url}/api/sync/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-harness-sync-token": token,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await fetch(`${server.url}/api/sync/status`)).status, 403);
  assert.equal(
    (await call("now", {}, { origin: "https://evil.test" })).status,
    403,
  );
  assert.equal((await call("setup", { url: remote })).status, 200);
  assert.equal((await (await call("status")).json()).data.connected, true);
  assert.equal((await call("now", {})).status, 200);
  assert.equal((await (await call("auto")).json()).data.enabled, true);
  const update = await fetch(`${server.url}/api/sync/auto`, {
    method: "PUT",
    headers: {
      "x-harness-sync-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ debounceSeconds: 4, pullIntervalMinutes: 2 }),
  });
  assert.equal((await update.json()).data.debounceSeconds, 4);
  const status = (await (await call("status")).json()).data;
  assert.ok(status.scheduler.lastSuccessAt);
  assert.equal(status.scheduler.pendingDeployment, 0);
  assert.ok(Array.isArray((await (await call("history")).json()).data));
  const before = a.git(["rev-parse", "HEAD"]);
  await a.saveRule({ title: "temporary", body: "temporary" });
  await a.restoreSource(before);
  assert.equal((await call("undo", {})).status, 200);
  assert.equal(a.manifest().rules.length, 1);
  assert.equal(
    (await call("resolve", { entryId: "missing", keep: "invalid" })).status,
    400,
  );
  assert.equal((await call("disconnect", {})).status, 200);
});

test("CLI accepts --json on every sync operation and reports configuration errors", async (t) => {
  const { a, remote } = await fixture(t);
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.resolve("node_modules/tsx/dist/cli.mjs"),
          path.resolve("src/cli.ts"),
          "--root",
          a.root,
          "sync",
          ...args,
          "--json",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: a.home, HARNESS_SYNC_HOME: a.root },
        },
      ),
    );
  assert.equal(cli("status").connected, false);
  assert.equal(cli("setup", "--url", remote).connected, true);
  assert.equal(cli("now").ahead, 0);
  assert.equal(cli("auto", "off").enabled, false);
  assert.equal(
    cli("auto", "set", "--debounce", "3", "--interval", "2").debounceSeconds,
    3,
  );
  assert.equal(cli("auto", "on").enabled, true);
  assert.ok(Array.isArray(cli("history")));
  assert.equal(cli("disconnect").connected, false);
});

test("all sync operations respect the store lock", async (t) => {
  const { a, sa } = await fixture(t);
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>((r) => (acquired = r));
  const held = a.lock(async () => {
    acquired();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  let finished = false;
  const status = sa.status().then((r) => {
    finished = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(finished, false);
  release();
  await held;
  assert.equal((await status).connected, false);
});

test("Git failures are actionable and a rejected push can safely be retried", async (t) => {
  const { a, sa, remote, dir } = await fixture(t);
  await sa.setup({ url: remote });
  await a.saveRule({ title: "pending", body: "saved" });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = push ]; then echo "rejected non-fast-forward" >&2; exit 1; fi\nif [ "$GIT_TERMINAL_PROMPT" != 0 ]; then exit 1; fi\nexec /usr/bin/git "$@"\n',
    { mode: 0o755 },
  );
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    await assert.rejects(sa.now(), /远端已更新.*sync now/);
  } finally {
    process.env.PATH = old;
  }
  assert.ok(a.manifest().rules.some((r) => r.title === "pending"));
  await sa.now();
  assert.equal((await sa.status()).ahead, 0);
  await sa.disconnect();
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/bin/sh\necho "Permission denied (publickey)" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${old}`;
  try {
    await assert.rejects(sa.setup({ url: remote }), /认证失败/);
  } finally {
    process.env.PATH = old;
  }
});

test("gh creation uses private flag and default name; missing gh reports install/login guidance", async (t) => {
  const { a, sa, remote, dir } = await fixture(t);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "gh-log");
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HSYNC_GH_LOG"\nif [ "$1 $2" = "repo view" ]; then printf "%s\\n" "$HSYNC_TEST_REMOTE"; fi\n',
    { mode: 0o755 },
  );
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  process.env.HSYNC_GH_LOG = log;
  process.env.HSYNC_TEST_REMOTE = remote;
  try {
    await sa.setup({ create: true });
  } finally {
    process.env.PATH = old;
    delete process.env.HSYNC_GH_LOG;
    delete process.env.HSYNC_TEST_REMOTE;
  }
  assert.match(
    fs.readFileSync(log, "utf8"),
    /repo create harness-sync-config --private/,
  );
  await sa.disconnect();
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 127\n", {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${old}`;
  try {
    await assert.rejects(
      sa.setup({ create: "custom" }),
      /安装 gh.*gh auth login/,
    );
  } finally {
    process.env.PATH = old;
  }
  assert.ok(a.manifest());
});

test("skill metadata plus binary bundle form one merge object; remote resolution and source restore preserve bytes", async (t) => {
  const { a, b, sa, sb } = await connected(t);
  const entry = await a.saveSkill(
    skill("bundle-object"),
    undefined,
    undefined,
    { "asset.bin": { content: "AA==", mode: 0o644 } },
  );
  await sa.now();
  await sb.now();
  await a.saveSkill({ ...entry, body: "local" }, entry.id, undefined, {
    "asset.bin": { content: "AQ==", mode: 0o644 },
  });
  await b.saveSkill(
    { ...entry, description: "remote metadata", body: "base" },
    entry.id,
    undefined,
    { "asset.bin": { content: "Ag==", mode: 0o755 } },
  );
  await sb.now();
  assert.equal((await sa.now()).conflicts[0].entryId, entry.id);
  const before = a.git(["rev-parse", "HEAD"]);
  await sa.resolve(entry.id, "remote");
  assert.equal(a.manifest().skills[0].description, "remote metadata");
  assert.deepEqual(
    fs.readFileSync(path.join(a.skillPath(entry.id), "asset.bin")),
    Buffer.from([2]),
  );
  await a.restoreSource(before);
  assert.deepEqual(
    fs.readFileSync(path.join(a.skillPath(entry.id), "asset.bin")),
    Buffer.from([1]),
  );
});

test("SSH URLs allow a username without storing credentials; URL passwords and queries are rejected", async (t) => {
  const { sa, dir } = await fixture(t);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/bin/sh\ncase "$1" in ls-remote|push) exit 0 ;; esac\nexec /usr/bin/git "$@"\n',
    { mode: 0o755 },
  );
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    await sa.setup({ url: "ssh://git@example.invalid/config.git" });
    await sa.disconnect();
    await assert.rejects(
      sa.setup({ url: "ssh://user:password@example.invalid/config.git" }),
      /凭证/,
    );
    await assert.rejects(
      sa.setup({ url: "https://example.invalid/config.git?token=secret" }),
      /凭证/,
    );
  } finally {
    process.env.PATH = old;
  }
});

test("concurrent edits to different existing entries merge without conflict", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  const second = await a.saveRule({ title: "second", body: "base" });
  await sa.now();
  await sb.now();
  await a.saveRule({ ...rule, body: "A edit" }, rule.id);
  await b.saveRule({ ...second, body: "B edit" }, second.id);
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 0);
  assert.equal(
    a.manifest().rules.find((r) => r.id === rule.id)?.body,
    "A edit",
  );
  assert.equal(
    a.manifest().rules.find((r) => r.id === second.id)?.body,
    "B edit",
  );
});

test("sync ignores hidden staging leftovers and never publishes them", async (t) => {
  const { a, b, sa, sb, remote } = await fixture(t);
  const entry = await a.saveSkill(skill("staged"));
  const root = path.join(a.repo, "skills");
  const stage = path.join(
    root,
    ".hsync-staging-11111111-1111-1111-1111-111111111111",
  );
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, "partial"), "unfinished");
  fs.writeFileSync(
    `${stage}.json`,
    JSON.stringify({ format: "harness-sync-staging-v1", target: entry.id }),
  );
  fs.mkdirSync(`${stage}-old`);
  fs.writeFileSync(path.join(`${stage}-old`, "original"), "backup");
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  await b.saveSkill(
    { ...b.manifest().skills[0], body: "remote update" },
    entry.id,
  );
  await sb.now();
  await sa.now();
  assert.match(
    fs.readFileSync(path.join(a.skillPath(entry.id), "SKILL.md"), "utf8"),
    /remote update/,
  );
  assert.equal(
    fs.readFileSync(path.join(stage, "partial"), "utf8"),
    "unfinished",
  );
  assert.equal(
    fs.readFileSync(path.join(`${stage}-old`, "original"), "utf8"),
    "backup",
  );
  assert.ok(fs.existsSync(`${stage}.json`));
  assert.ok(!a.git(["ls-tree", "-r", "HEAD"]).includes(".hsync-staging-"));
  // A failed source mutation must preserve recovery artifacts too.
  await assert.rejects(
    a.mutate("failed", () => {
      throw new Error("injected");
    }),
    /injected/,
  );
  assert.ok(fs.existsSync(`${stage}-old`));
});

test("automatic debounce tracks external edits, periodic pull marks pending deployment, full apply acknowledges it", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  assert.deepEqual(sa.autoSettings(), {
    enabled: true,
    debounceSeconds: 120,
    pullIntervalMinutes: 10,
  });
  await sa.setAuto({ debounceSeconds: 2, pullIntervalMinutes: 1 });
  const initial = (await sa.status()).scheduler.lastAttemptAt;
  const external = (body: string) => {
    const m = a.manifest();
    m.rules.find((r) => r.id === rule.id)!.body = body;
    writeManifest(a.repo, m);
  };
  const now = Date.now();
  external("first");
  await sa.tick(now);
  external("second");
  await sa.tick(now + 1500);
  await sa.tick(now + 2500);
  assert.equal((await sa.status()).scheduler.lastAttemptAt, initial);
  await sa.tick(now + 3501);
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.body,
    "second",
  );
  await b.saveRule({ title: "远端新增", body: "需要部署" });
  await sb.now();
  const stateBefore = stable(a.state());
  await sa.tick(Date.parse((await sa.status()).scheduler.nextRunAt!) + 1);
  assert.equal((await sa.status()).scheduler.pendingDeployment, 1);
  assert.equal(stable(a.state()), stateBefore);
  const engine = new Engine(a);
  await engine.apply(engine.plan().id);
  assert.equal((await sa.status()).scheduler.pendingDeployment, 0);
  const history = await sa.history();
  assert.ok(
    history.some(
      (h) =>
        h.device === a.device().name &&
        h.changes.some((c) => c.action === "新增" && c.name === "远端新增"),
    ),
  );
  assert.doesNotMatch(
    a.git(["ls-tree", "-r", "--name-only", "HEAD"]),
    /sync-auto|sync-undo/,
  );
  await sa.setAuto({ enabled: false });
  const attempt = (await sa.status()).scheduler.lastAttemptAt;
  external("关闭后不推送");
  await sa.tick(now + 99999999);
  assert.equal((await sa.status()).scheduler.lastAttemptAt, attempt);
  for (const input of [
    { debounceSeconds: 0 },
    { pullIntervalMinutes: 1.5 },
    { enabled: "yes" },
    { unknown: true },
  ])
    await assert.rejects(sa.setAuto(input as any), /自动同步参数/);
});

test("offline automatic attempts back off to 30 minutes, status remains available, recovery resets errors", async (t) => {
  const { sa, remote } = await connected(t);
  const moved = `${remote}.offline`;
  fs.renameSync(remote, moved);
  try {
    for (let i = 1; i <= 8; i++) {
      const due = Date.parse((await sa.status()).scheduler.nextRunAt!);
      await assert.rejects(sa.tick(due + 1), /Git 操作失败/);
      const state = (await sa.status()).scheduler;
      assert.equal(state.failures, i);
      assert.ok(state.lastError);
      assert.ok(
        Math.abs(
          Date.parse(state.nextRunAt!) -
            Date.parse(state.lastAttemptAt!) -
            Math.min(1800000, 30000 * 2 ** (i - 1)),
        ) < 2000,
      );
      await sa.tick(Date.parse(state.nextRunAt!) - 1);
      assert.equal(
        (await sa.status()).scheduler.lastAttemptAt,
        state.lastAttemptAt,
      );
    }
  } finally {
    fs.renameSync(moved, remote);
  }
  await sa.tick(Date.parse((await sa.status()).scheduler.nextRunAt!) + 1);
  assert.equal((await sa.status()).scheduler.failures, 0);
  assert.equal((await sa.status()).scheduler.lastError, undefined);
});

test("restore undo is a new commit, preserves uncommitted source and refuses subsequent external edits and symlinks", async (t) => {
  const { a, sa } = await fixture(t);
  const original = a.git(["rev-parse", "HEAD"]);
  const r = await a.saveRule({ title: "保留", body: "已提交" });
  const m = a.manifest();
  m.rules[0].body = "未提交";
  const raw = JSON.stringify(m.rules[0], null, 4) + "\n";
  fs.writeFileSync(path.join(a.repo, "entries/rules", `${r.id}.json`), raw);
  await a.restoreSource(original);
  const restored = a.git(["rev-parse", "HEAD"]);
  await sa.undo();
  assert.equal(a.manifest().rules[0].body, "未提交");
  assert.equal(
    fs.readFileSync(path.join(a.repo, "entries/rules", `${r.id}.json`), "utf8"),
    raw,
  );
  assert.equal(a.git(["status", "--porcelain"]), "");
  assert.equal(a.git(["rev-parse", "HEAD^1"]), restored);
  await assert.rejects(sa.undo(), /没有可撤销/);
  await a.restoreSource(original);
  const file = path.join(a.repo, "entries/rules", `${r.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...r, body: "外部修改" }));
  await assert.rejects(sa.undo(), /拒绝覆盖/);
  assert.equal(a.manifest().rules[0].body, "外部修改");
  const auto = path.join(a.root, "sync-auto.json"),
    outside = path.join(a.home, "untouched");
  fs.writeFileSync(outside, "preserved");
  fs.symlinkSync(outside, auto);
  await assert.rejects(sa.setAuto({ enabled: true }));
  assert.equal(fs.readFileSync(outside, "utf8"), "preserved");
});

test("interrupted restore and interrupted undo retain journals and recover after a dead process lock", async (t) => {
  const { a, sa, dir } = await fixture(t);
  const original = a.git(["rev-parse", "HEAD"]);
  const r = await a.saveRule({ title: "安全快照", body: "保留" });
  const child = path.join(dir, "crash.mts");
  const imports = `import fs from 'node:fs'; import {Store} from ${JSON.stringify(path.resolve("src/core/store.ts"))}; import {Sync} from ${JSON.stringify(path.resolve("src/core/sync.ts"))}; const store = await new Store(${JSON.stringify(a.root)}, ${JSON.stringify(a.home)}).init(); const sync = new Sync(store);`;
  const crash = (code: string, exit: number) => {
    fs.writeFileSync(child, imports + code);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.resolve("node_modules/tsx/dist/cli.mjs"), child],
          {
            env: { ...process.env, HOME: a.home, HARNESS_SYNC_HOME: a.root },
            stdio: "pipe",
          },
        ),
      (error: any) => error.status === exit,
    );
  };
  crash(
    `sync.write = () => { fs.rmSync(${JSON.stringify(path.join(a.repo, "entries/rules", `${r.id}.json`))}); process.exit(73); }; await sync.restore(${JSON.stringify(original)});`,
    73,
  );
  await assert.rejects(
    sa.now(),
    /请先运行 hsync sync undo|请先运行 hsync sync setup/,
  );
  await sa.undo();
  assert.equal(a.manifest().rules[0].body, "保留");
  await a.restoreSource(original);
  crash(
    `const git = sync.git.bind(sync); sync.git = args => { if(args[0] === 'reset') process.exit(74); return git(args); }; await sync.undo();`,
    74,
  );
  await sa.undo();
  assert.equal(a.manifest().rules[0].body, "保留");
  assert.equal(fs.existsSync(path.join(a.root, ".lock")), false);
  assert.equal(fs.existsSync(path.join(a.root, "sync-undo.json")), false);
});

test("two scheduler processes and manual sync share the filesystem lock", async (t) => {
  const { a, sa, dir } = await connected(t);
  const script = path.join(dir, "concurrent.mts"),
    marker = path.join(dir, "active"),
    audit = path.join(dir, "audit");
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
    import {Store} from ${JSON.stringify(path.resolve("src/core/store.ts"))};
    import {Sync} from ${JSON.stringify(path.resolve("src/core/sync.ts"))};
    const store = await new Store(${JSON.stringify(a.root)}, ${JSON.stringify(a.home)}).init();
    const sync = new Sync(store), original = sync.nowLocked.bind(sync);
    sync.nowLocked = (...args) => {
      fs.writeFileSync(${JSON.stringify(marker)}, 'running', {flag:'wx'});
      fs.appendFileSync(${JSON.stringify(audit)}, 'begin\\n');
      try {
        execFileSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300)']);
        return original(...args);
      } finally {
        fs.appendFileSync(${JSON.stringify(audit)}, 'end\\n');
        fs.rmSync(${JSON.stringify(marker)});
      }
    };
    await (process.argv[2] === 'now' ? sync.now() : sync.tick());
  `,
  );
  const statePath = path.join(a.root, "sync-auto.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.runtime.nextRunAt = state.runtime.pullDueAt = new Date(0).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state));
  await Promise.all(
    ["tick", "tick", "now"].map(
      (mode) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [path.resolve("node_modules/tsx/dist/cli.mjs"), script, mode],
            {
              env: { ...process.env, HOME: a.home, HARNESS_SYNC_HOME: a.root },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let error = "";
          child.stderr.on("data", (data) => {
            error += data;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(error)),
          );
        }),
    ),
  );
  assert.match(fs.readFileSync(audit, "utf8"), /^(begin\nend\n)+$/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal((await sa.status()).scheduler.failures, 0);
});

test("scheduler stop waits for its active tick and prevents overlapping timer callbacks", async () => {
  let active = 0,
    maximum = 0,
    calls = 0;
  const stop = startSyncScheduler(
    {
      tick: async () => {
        calls++;
        maximum = Math.max(maximum, ++active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
      },
    } as Sync,
    5,
  );
  await new Promise((r) => setTimeout(r, 15));
  await stop();
  assert.equal(active, 0);
  assert.equal(maximum, 1);
  const before = calls;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, before);
});

test("external malformed source is recorded with backoff and never deployed", async (t) => {
  const { a, sa, rule } = await connected(t);
  const file = path.join(a.repo, "entries/rules", `${rule.id}.json`),
    original = fs.readFileSync(file);
  fs.writeFileSync(file, "{broken");
  await sa.tick();
  await assert.rejects(
    sa.tick(Date.parse((await sa.status()).scheduler.nextRunAt!) + 1),
  );
  const failed = (await sa.status()).scheduler;
  assert.ok(failed.lastError);
  assert.equal(failed.failures, 1);
  await sa.tick(Date.parse(failed.nextRunAt!) - 1);
  fs.writeFileSync(file, original);
  await sa.tick(Date.parse(failed.nextRunAt!) + 1);
  assert.equal((await sa.status()).scheduler.failures, 0);
});

test("periodic pull during debounce merges remote entries without pushing in-progress local edits", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  await sa.setAuto({ debounceSeconds: 120, pullIntervalMinutes: 1 });
  const m = a.manifest();
  m.rules.find((r) => r.id === rule.id)!.body = "正在编辑";
  writeManifest(a.repo, m);
  const now = Date.now();
  await sa.tick(now);
  await b.saveRule({ title: "间隔拉取", body: "远端新增" });
  await sb.now();
  await sa.tick(now + 60001);
  assert.ok(a.manifest().rules.some((r) => r.title === "间隔拉取"));
  await sb.now();
  assert.equal(b.manifest().rules.find((r) => r.id === rule.id)?.body, "base");
  await sa.tick(now + 120001);
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.body,
    "正在编辑",
  );
});

test("interrupted remote merge blocks automatic publication until its safety snapshot is recovered", async (t) => {
  const { a, b, sa, sb, dir } = await connected(t);
  await b.saveRule({ title: "远端事务", body: "远端内容" });
  await sb.now();
  const before = a.manifest();
  const child = path.join(dir, "merge-crash.mts");
  fs.writeFileSync(
    child,
    `
    import {Store} from ${JSON.stringify(path.resolve("src/core/store.ts"))};
    import {Sync} from ${JSON.stringify(path.resolve("src/core/sync.ts"))};
    const store = await new Store(${JSON.stringify(a.root)}, ${JSON.stringify(a.home)}).init();
    const sync = new Sync(store), write = sync.write.bind(sync);
    sync.write = library => { write(library); process.exit(75); };
    await sync.now();
  `,
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.resolve("node_modules/tsx/dist/cli.mjs"), child],
        {
          env: { ...process.env, HOME: a.home, HARNESS_SYNC_HOME: a.root },
          stdio: "pipe",
        },
      ),
    (error: any) => error.status === 75,
  );
  assert.ok(a.manifest().rules.some((r) => r.title === "远端事务"));
  await assert.rejects(sa.now(), /请先运行 hsync sync undo/);
  await sa.undo();
  assert.deepEqual(a.manifest(), before);
  assert.equal(fs.existsSync(path.join(a.root, "sync-recovery.json")), false);
  await sa.now();
  assert.ok(a.manifest().rules.some((r) => r.title === "远端事务"));
});

test("undo preserves binary modes and handles a bundle path changing from file to directory", async (t) => {
  const { a, sa } = await fixture(t);
  const entry = await a.saveSkill(skill("path-swap"), undefined, undefined, {
    asset: {
      content: Buffer.from([0, 255, 42]).toString("base64"),
      mode: 0o755,
    },
  });
  const before = a.git(["rev-parse", "HEAD"]);
  const asset = path.join(a.skillPath(entry.id), "asset");
  fs.rmSync(asset);
  fs.mkdirSync(asset);
  fs.writeFileSync(path.join(asset, "nested"), "new");
  a.commit("资源路径变化");
  await a.restoreSource(before);
  await sa.undo();
  assert.equal(fs.readFileSync(path.join(asset, "nested"), "utf8"), "new");
  const nested = a.git(["rev-parse", "HEAD"]);
  await a.restoreSource(before);
  await a.restoreSource(nested);
  await sa.undo();
  assert.deepEqual(fs.readFileSync(asset), Buffer.from([0, 255, 42]));
  assert.ok(fs.statSync(asset).mode & 0o111);
  assert.equal(a.git(["status", "--porcelain"]), "");
});

test("review 0: idle polling reads no skill bodies and does not wait for a source writer lock", async (t) => {
  const { a, sa, remote } = await fixture(t);
  const entry = await a.saveSkill(skill("poll-cost"), undefined, undefined, {
    "large.bin": {
      content: Buffer.alloc(3 * 1024 * 1024, 42).toString("base64"),
      mode: 0o644,
    },
  });
  await sa.setup({ url: remote });
  await sa.tick();
  let bundleReads = 0;
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, "readFileSync", (...args: any[]) => {
    if (String(args[0]).startsWith(a.skillPath(entry.id) + path.sep))
      bundleReads++;
    return (read as any)(...args);
  });
  await sa.tick();
  spy.mock.restore();
  assert.equal(bundleReads, 0, "空闲轮询不得读取技能正文或资源");
  let release!: () => void, ready!: () => void;
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const writer = a.lock(async () => {
    ready();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await acquired;
  try {
    await Promise.race([
      sa.tick(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("空闲轮询等待了写锁")), 200),
      ),
    ]);
  } finally {
    release();
    await writer;
  }
});

test("review 1: undo recovers a verified directory-swap backup after process exit", async (t) => {
  const { a, sa, dir } = await fixture(t);
  const entry = await a.saveSkill(skill("swap-crash"), undefined, undefined, {
    "unchanged.bin": { content: "AP8=", mode: 0o755 },
  });
  const original = a.git(["rev-parse", "HEAD"]);
  await a.saveSkill({ ...entry, body: "修改后的本机版本" }, entry.id);
  const before = fs.readFileSync(path.join(a.skillPath(entry.id), "SKILL.md"));
  const child = path.join(dir, "swap-crash.mts");
  fs.writeFileSync(
    child,
    `
    import fs from 'node:fs';
    import {Store} from ${JSON.stringify(path.resolve("src/core/store.ts"))};
    import {Sync} from ${JSON.stringify(path.resolve("src/core/sync.ts"))};
    const store = await new Store(${JSON.stringify(a.root)}, ${JSON.stringify(a.home)}).init();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (String(from) === ${JSON.stringify(a.skillPath(entry.id))} && String(to).endsWith('-old')) process.exit(76);
    };
    await new Sync(store).restore(${JSON.stringify(original)});
  `,
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.resolve("node_modules/tsx/dist/cli.mjs"), child],
        {
          env: { ...process.env, HOME: a.home, HARNESS_SYNC_HOME: a.root },
          stdio: "pipe",
        },
      ),
    (error: any) => error.status === 76,
  );
  assert.equal(fs.existsSync(a.skillPath(entry.id)), false);
  const stage = fs
    .readdirSync(path.dirname(a.skillPath(entry.id)))
    .find((n) => n.endsWith("-old"))!;
  const backup = path.join(path.dirname(a.skillPath(entry.id)), stage);
  // Edited or linked backups must never be treated as trusted recovery data.
  const unchanged = path.join(backup, "unchanged.bin");
  fs.writeFileSync(unchanged, "external");
  await assert.rejects(sa.undo(), /拒绝|改变|恢复/);
  assert.equal(fs.readFileSync(unchanged, "utf8"), "external");
  fs.rmSync(unchanged);
  const outside = path.join(dir, "outside-backup");
  fs.writeFileSync(outside, "不得覆盖");
  fs.symlinkSync(outside, unchanged);
  await assert.rejects(sa.undo(), /符号链接/);
  assert.equal(fs.readFileSync(outside, "utf8"), "不得覆盖");
  fs.rmSync(unchanged);
  fs.writeFileSync(unchanged, Buffer.from([0, 255]));
  fs.chmodSync(unchanged, 0o755);
  await sa.undo();
  assert.deepEqual(
    fs.readFileSync(path.join(a.skillPath(entry.id), "SKILL.md")),
    before,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(a.skillPath(entry.id), "unchanged.bin")),
    Buffer.from([0, 255]),
  );
  assert.ok(
    fs.statSync(path.join(a.skillPath(entry.id), "unchanged.bin")).mode & 0o111,
  );
  assert.equal(fs.existsSync(path.join(a.root, "sync-undo.json")), false);
  assert.equal(fs.existsSync(backup), false);
});

async function interceptedGit(
  dir: string,
  intercept: string,
  operation: () => Promise<void>,
) {
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(dir, "git-intercept");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
${intercept}
const result = spawnSync(${JSON.stringify(git)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    await operation();
  } finally {
    process.env.PATH = previous;
  }
}

for (const operation of ["resolve", "merge"] as const)
  test(`review 2: ${operation} failure restores exact JSON bytes and permissions and remains undoable`, async (t) => {
    const { a, b, sa, sb, rule, dir } = await connected(t);
    if (operation === "resolve") {
      await a.saveRule({ ...rule, body: "本机" }, rule.id);
      await b.saveRule({ ...rule, body: "远端" }, rule.id);
    } else await b.saveRule({ title: "远端新增", body: "内容" });
    await sb.now();
    if (operation === "resolve") await sa.now();
    const file = path.join(a.repo, "entries/rules", `${rule.id}.json`);
    const raw =
      JSON.stringify(
        a.manifest().rules.find((r) => r.id === rule.id),
        null,
        4,
      ) + "\n";
    fs.writeFileSync(file, raw);
    fs.chmodSync(file, 0o640);
    a.commit("保留原始格式");
    const reject =
      operation === "resolve"
        ? "args.includes('commit') && args.some(a => a.startsWith('解决同步冲突：remote'))"
        : "args[0] === 'write-tree'";
    await interceptedGit(
      dir,
      `if (${reject}) { process.stderr.write('fatal: 测试注入 Git 失败\\n'); process.exit(1); }`,
      async () => {
        await assert.rejects(
          operation === "resolve" ? sa.resolve(rule.id, "remote") : sa.now(),
        );
      },
    );
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    await sa.undo();
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    assert.equal(
      (await sa.status()).conflicts.length,
      operation === "resolve" ? 1 : 0,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          a.root,
          operation === "resolve" ? "sync-undo.json" : "sync-recovery.json",
        ),
      ),
      false,
    );
  });

test("review 3: an edit during fetch is retained in the checkpoint HEAD after merge failure", async (t) => {
  const { a, b, sa, sb, rule, dir } = await connected(t);
  await b.saveRule({ title: "远端新条目", body: "内容" });
  await sb.now();
  const file = path.join(a.repo, "entries/rules", `${rule.id}.json`);
  const edited =
    JSON.stringify({ ...rule, body: "拉取期间的外部编辑" }, null, 4) + "\n";
  const initial = a.git(["rev-parse", "HEAD"]);
  await interceptedGit(
    dir,
    `
    if (args[0] === 'fetch') fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(edited)});
    if (args[0] === 'write-tree') { process.stderr.write('fatal: 测试注入写树失败\\n'); process.exit(1); }
  `,
    async () => {
      await assert.rejects(sa.now());
    },
  );
  const record = JSON.parse(
    fs.readFileSync(path.join(a.root, "sync-recovery.json"), "utf8"),
  );
  assert.notEqual(record.before, initial, "快照必须包含拉取期间的编辑");
  assert.equal(a.git(["rev-parse", "HEAD"]), record.before);
  assert.equal(fs.readFileSync(file, "utf8"), edited);
  await sa.undo();
  assert.equal(fs.readFileSync(file, "utf8"), edited);
  await sa.now();
  assert.equal(
    a.manifest().rules.find((r) => r.id === rule.id)?.body,
    "拉取期间的外部编辑",
  );
});

test("review 4: keeping the last conflict local resumes automatic publication without another edit", async (t) => {
  const { a, b, sa, sb, rule } = await connected(t);
  await a.saveRule({ ...rule, body: "保留本机" }, rule.id);
  await b.saveRule({ ...rule, body: "远端选择" }, rule.id);
  await sb.now();
  await sa.now();
  assert.equal((await sa.status()).conflicts.length, 1);
  await sa.resolve(rule.id, "local");
  const status = await sa.status();
  assert.equal(status.scheduler.pendingPush, true);
  // A fresh scheduler must use persisted intent, even when keep-local changes no source bytes.
  const fresh = new Sync(a);
  await fresh.tick();
  const next = (await fresh.status()).scheduler.nextRunAt!;
  await fresh.tick(Date.parse(next) + 1);
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.body,
    "保留本机",
  );
  assert.equal((await fresh.status()).scheduler.pendingPush, false);
});

test("review 5: a recovered retry pulls remote changes but waits for the last edit debounce before pushing", async (t) => {
  const { a, b, sa, sb, rule, remote } = await connected(t);
  await sa.setAuto({ debounceSeconds: 120 });
  fs.renameSync(remote, `${remote}.offline`);
  try {
    await assert.rejects(sa.now());
  } finally {
    fs.renameSync(`${remote}.offline`, remote);
  }
  const retryAt = Date.parse((await sa.status()).scheduler.nextRunAt!) + 1;
  const manifest = a.manifest();
  manifest.rules.find((r) => r.id === rule.id)!.body = "刚发生的编辑";
  writeManifest(a.repo, manifest);
  await b.saveRule({ title: "重试时拉取", body: "远端新增" });
  await sb.now();
  await sa.tick(retryAt);
  assert.ok(a.manifest().rules.some((r) => r.title === "重试时拉取"));
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.body,
    "base",
    "重试不应提前推送刚发生的编辑",
  );
  assert.equal((await sa.status()).scheduler.failures, 0);
  assert.equal((await sa.status()).scheduler.pendingPush, true);
  await sa.tick(retryAt + 119999);
  await sb.now();
  assert.equal(b.manifest().rules.find((r) => r.id === rule.id)?.body, "base");
  await sa.tick(retryAt + 120001);
  await sb.now();
  assert.equal(
    b.manifest().rules.find((r) => r.id === rule.id)?.body,
    "刚发生的编辑",
  );
  assert.equal((await sa.status()).scheduler.pendingPush, false);
});
