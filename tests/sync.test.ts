import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
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
