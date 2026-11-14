import { startServer } from "../src/server.ts";
import { Engine } from "../src/core/engine.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { SyncIgnore } from "../src/core/sync-ignore.ts";
import { checkSync } from "../src/core/sync-check.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-ignore-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const homeA = path.join(root, "home-a"),
    homeB = path.join(root, "home-b");
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  const a = await new Store(path.join(root, "a"), homeA).init();
  const b = await new Store(path.join(root, "b"), homeB).init();
  const sa = new Sync(a),
    sb = new Sync(b),
    ignore = new SyncIgnore(a);
  const git = (...args: string[]) =>
    execFileSync("git", ["--git-dir", remote, ...args])
      .toString()
      .trim();
  return { root, remote, a, b, sa, sb, ignore, git };
}
const skill = (name: string) => ({ name, description: "测试", body: "base" });
const put = (store: Store, id: string, file: string, text: string) =>
  fs.writeFileSync(path.join(store.skillPath(id), file), text);
const read = (store: Store, id: string, file: string) =>
  fs.readFileSync(path.join(store.skillPath(id), file), "utf8");

test("upload projection excludes ignored paths from all reachable history, preserves local files and resumes after removal", async (t) => {
  const { a, b, sa, sb, remote, ignore, git } = await fixture(t);
  const s = await a.saveSkill(skill("shared"));
  const hidden = await a.saveSkill(skill("hidden"));
  const rule = await a.saveRule({ title: "本机指令", body: "local" });
  put(a, s.id, ".env", "LOCAL_SECRET");
  a.commit("local secret predates ignore");
  await ignore.update({ add: ["shared/.env", "hidden", `rule:${rule.title}`] });
  assert.deepEqual(
    ignore
      .status()
      .matched.map((m) => m.skill)
      .sort(),
    ["hidden", "shared"],
  );
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  assert.equal(b.manifest().skills.length, 1);
  assert.equal(b.manifest().rules.length, 0);
  assert.equal(fs.existsSync(path.join(b.skillPath(s.id), ".env")), false);
  assert.ok(!git("rev-list", "--objects", "--all").includes(".env"));
  assert.ok(!git("rev-list", "--objects", "--all").includes(hidden.id));
  put(b, s.id, "readme.txt", "remote update");
  put(a, s.id, ".env", "LOCAL_CHANGED");
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 0);
  assert.equal(read(a, s.id, ".env"), "LOCAL_CHANGED");
  assert.equal(read(a, s.id, "readme.txt"), "remote update");
  assert.equal((await sa.now()).ahead, 0);
  const before = git("rev-parse", "main");
  await sa.now();
  assert.equal(git("rev-parse", "main"), before);
  await ignore.update({
    remove: ["shared/.env", "hidden", `rule:${rule.title}`],
  });
  assert.equal((await sa.now()).conflicts.length, 0);
  await sb.now();
  assert.equal(read(b, s.id, ".env"), "LOCAL_CHANGED");
  assert.equal(b.manifest().skills.length, 2);
  assert.equal(b.manifest().rules.length, 1);
  assert.equal(a.manifest().skills.length, 2);
});

test("ignoring previously uploaded files freezes remote bytes and excludes both sides from conflicts", async (t) => {
  const { a, b, sa, sb, remote, ignore, git } = await fixture(t);
  const s = await a.saveSkill(skill("shared"));
  put(a, s.id, "token.txt", "OLD");
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  await ignore.update({ add: ["shared/*token*"] });
  put(a, s.id, "token.txt", "LOCAL");
  put(b, s.id, "token.txt", "REMOTE");
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 0);
  assert.equal(read(a, s.id, "token.txt"), "LOCAL");
  assert.equal(git("show", `main:skills/${s.id}/token.txt`), "REMOTE");
  fs.rmSync(path.join(b.skillPath(s.id), "token.txt"));
  await sb.now();
  await sa.now();
  assert.equal(read(a, s.id, "token.txt"), "LOCAL");
  assert.ok(!git("ls-tree", "-r", "main").includes("token.txt"));
});

test("file ignores participate in independent same-name identity reconciliation", async (t) => {
  const { a, b, sa, sb, remote, ignore } = await fixture(t);
  const left = await a.saveSkill(skill("shared"));
  const right = await b.saveSkill(skill("shared"));
  put(a, left.id, ".env", "LOCAL");
  await sb.setup({ url: remote });
  await ignore.update({ add: ["shared/.env"] });
  assert.equal((await sa.setup({ url: remote })).conflicts.length, 0);
  assert.equal(a.manifest().skills[0].id, right.id);
  assert.equal(read(a, right.id, ".env"), "LOCAL");
});

test("whole ignored skill survives remote deletion and does not collide with independent names", async (t) => {
  const { a, b, sa, sb, remote, ignore } = await fixture(t);
  const left = await a.saveSkill(skill("shared"));
  const right = await b.saveSkill({ ...skill("shared"), body: "other" });
  await sb.setup({ url: remote });
  await ignore.update({ add: ["shared"] });
  assert.equal((await sa.setup({ url: remote })).conflicts.length, 0);
  assert.equal(a.manifest().skills[0].id, left.id);
  assert.equal((await sa.now()).ahead, 0);
  await b.remove("skills", right.id);
  await sb.now();
  await sa.now();
  assert.equal(a.manifest().skills[0].id, left.id);
});

test("rules validate and local storage rejects symlinks; glob supports nested and root files", async (t) => {
  const { root, a, ignore } = await fixture(t);
  await a.saveSkill(skill("shared"));
  await ignore.update({
    add: ["shared/**/.env", "shared/cache", "rule:中文指令"],
  });
  assert.ok(ignore.fileIgnored("shared", ".env"));
  assert.ok(ignore.fileIgnored("shared", "nested/.env"));
  assert.ok(ignore.fileIgnored("shared", "cache/a.bin"));
  for (const rule of [
    "../x",
    "shared/../x",
    "shared/SKILL.md",
    "shared/**",
    "rule:",
  ])
    await assert.rejects(ignore.update({ add: [rule] }));
  fs.rmSync(path.join(a.root, "sync-ignore.json"));
  const external = path.join(root, "external");
  fs.writeFileSync(external, "[]");
  fs.symlinkSync(external, path.join(a.root, "sync-ignore.json"));
  await assert.rejects(ignore.update({ add: ["shared"] }), /符号链接/);
  assert.equal(fs.readFileSync(external, "utf8"), "[]");
});

test("credential checks report public/private/unknown visibility and respect ignores", async (t) => {
  const { a, ignore } = await fixture(t);
  const s = await a.saveSkill(skill("shared"));
  put(a, s.id, ".env", "NEVER_DISPLAY");
  fs.writeFileSync(
    path.join(a.root, "sync.json"),
    JSON.stringify({
      url: "https://github.com/test/config.git",
      branch: "main",
      conflicts: [],
    }),
  );
  for (const [visibility, status] of [
    ["false", "fail"],
    ["true", "ok"],
    ["unknown", "warn"],
  ] as const) {
    const result = await checkSync(
      {},
      {
        store: a,
        runner: async (_command, args) => ({
          code: 0,
          stdout: args.includes(".private")
            ? visibility
            : args.includes(".login")
              ? "test"
              : args.includes(".permissions.push")
                ? "true"
                : "",
        }),
      },
    );
    const row = result.checks.find((c) => c.id === "credentials")!;
    assert.equal(row.status, status);
    assert.ok(!JSON.stringify(result).includes("NEVER_DISPLAY"));
    if (status !== "ok") {
      assert.match(row.detail, /shared\/\.env/);
      assert.match(row.fix!, /sync ignore/);
    } else assert.match(row.detail, /将同步 1 个凭证文件到私有仓库/);
  }
  await ignore.update({ add: ["shared/.env"] });
  const result = await checkSync(
    {},
    { store: a, runner: async () => ({ code: 1, stdout: "" }) },
  );
  assert.equal(
    result.checks.some((c) => c.id === "credentials"),
    false,
  );
});

test("ignore API enforces access controls, CLI shares rules, and local deployment still includes ignored files", async (t) => {
  const { root, a, ignore } = await fixture(t);
  const s = await a.saveSkill(skill("shared"));
  put(a, s.id, ".env", "LOCAL_ONLY");
  const uiDirectory = path.join(root, "ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(path.join(uiDirectory, "index.html"), "<!--HSYNC_TOKEN-->");
  const server = await startServer(a, { port: 0, uiDirectory });
  t.after(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const endpoint = `${server.url}/api/sync/ignore`;
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
  };
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, origin: "https://invalid.example" },
        body: JSON.stringify({ add: ["shared"] }),
      })
    ).status,
    403,
  );
  assert.deepEqual(ignore.rules(), []);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ add: ["shared/.env"] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(ignore.rules(), ["shared/.env"]);
  const listing = await (await fetch(endpoint, { headers })).json();
  assert.deepEqual(listing.data ?? listing, ignore.status());
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "--root",
          a.root,
          "sync",
          "ignore",
          ...args,
          "--json",
        ],
        { env: { ...process.env, HOME: a.home }, encoding: "utf8" },
      ),
    );
  const listed = cli("list");
  assert.deepEqual(listed.data ?? listed, ignore.status());
  cli("add", "shared");
  assert.ok(ignore.rules().includes("shared"));
  cli("remove", "shared");
  assert.deepEqual(ignore.rules(), ["shared/.env"]);
  const engine = new Engine(a),
    plan = engine.plan();
  await engine.apply(plan.id);
  const deployed = plan.changes.filter(
    (op) => op.kind === "skill" && op.sourceId === s.id,
  );
  assert.ok(deployed.length);
  for (const op of deployed)
    assert.equal(
      fs.readFileSync(path.join(op.path, ".env"), "utf8"),
      "LOCAL_ONLY",
    );
});

test("remote conflict resolution and undo preserve ignored local bytes", async (t) => {
  const { a, b, sa, sb, remote, ignore } = await fixture(t);
  const entry = await a.saveSkill(skill("shared"));
  put(a, entry.id, ".env", "LOCAL");
  await ignore.update({ add: ["shared/.env"] });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  await a.saveSkill({ ...skill("shared"), body: "left" }, entry.id);
  await b.saveSkill({ ...skill("shared"), body: "right" }, entry.id);
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 1);
  await sa.resolve(entry.id, "remote");
  assert.equal(read(a, entry.id, ".env"), "LOCAL");
  assert.match(read(a, entry.id, "SKILL.md"), /right/);
  await sa.undo();
  assert.equal(read(a, entry.id, ".env"), "LOCAL");
  assert.match(read(a, entry.id, "SKILL.md"), /left/);
});

test("adding ignores clears conflicts caused only by ignored files", async (t) => {
  const { a, b, sa, sb, remote, ignore } = await fixture(t);
  const entry = await a.saveSkill(skill("shared"));
  put(a, entry.id, ".env", "BASE");
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  put(a, entry.id, ".env", "LOCAL");
  put(b, entry.id, ".env", "REMOTE");
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 1);
  await ignore.update({ add: ["shared/.env"] });
  assert.equal((await sa.now()).conflicts.length, 0);
  assert.equal(read(a, entry.id, ".env"), "LOCAL");
});

test("ignored project skills retain scope when independent project IDs coalesce", async (t) => {
  const { a, b, sa, sb, remote, ignore } = await fixture(t);
  const pa = await a.saveProject({ name: "同一项目" });
  const pb = await b.saveProject({ name: "同一项目" });
  const entry = await a.saveSkill({
    ...skill("hidden"),
    scope: { kind: "project", target: pa.id, harnesses: ["codex"] },
  });
  await ignore.update({ add: ["hidden"] });
  await sb.setup({ url: remote });
  await sa.setup({ url: remote });
  assert.equal(
    a.manifest().skills.find((s) => s.id === entry.id)!.scope.target,
    pb.id,
  );
  assert.equal(b.manifest().skills.length, 0);
});
