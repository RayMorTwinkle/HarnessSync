import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../src/core/store.ts";
import { startServer } from "../src/server.ts";
import { Sync } from "../src/core/sync.ts";
import { bundleHash, readBundle } from "../src/core/files.ts";
import { refreshSkills } from "../src/core/skill-sources.ts";
import {
  installGitSkills,
  checkGitSkillUpdates,
  updateGitSkills,
  diffGitSkill,
  detachGitSkill,
  listedSkills,
  parseGitSkillSource,
} from "../src/core/git-skills.ts";

async function fixture(t: TestContext, names = ["alpha"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-git-skills-"));
  const saved = { ...process.env };
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  Object.assign(process.env, {
    HOME: home,
    HARNESS_SYNC_HOME: path.join(dir, "state"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  const write = (name: string, body = "base") => {
    const target = path.join(work, "packages", name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "SKILL.md"),
      `---\nname: ${name}\ndescription: 测试\nextra: 保留\n---\n${body}\n`,
    );
    fs.writeFileSync(
      path.join(target, "asset.bin"),
      Buffer.from([0, 1, 2, body.length]),
    );
    fs.writeFileSync(path.join(target, "run.sh"), "#!/bin/sh\ntrue\n", {
      mode: 0o755,
    });
  };
  for (const name of names) write(name);
  git("add", ".");
  git("commit", "-m", "base");
  git("tag", "v1");
  const remote = path.join(dir, "remote.git");
  git("clone", "--bare", work, remote);
  const url = pathToFileURL(remote).href;
  const store = await new Store().init();
  const push = (name = names[0], body = "upstream change") => {
    write(name, body);
    git("add", ".");
    git("commit", "-m", body);
    git("push", url, "main");
    return git("rev-parse", "HEAD");
  };
  return { dir, home, work, remote, url, git, store, push, write };
}
function source(store: Store, id: string) {
  const s = store.manifest().skills.find((s) => s.id === id)!.source;
  assert.equal(typeof s, "object");
  return s as Exclude<typeof s, string | undefined>;
}
function emptyCache(store: Store) {
  assert.deepEqual(
    fs.readdirSync(path.join(store.root, "cache", "git-skills")),
    [],
  );
  assert.ok(!store.git(["ls-files"]).includes("cache/"));
}

test("Git 安装和更新提交包含技能名，同步历史不含部署提示", async (t) => {
  const f = await fixture(t, ["paper-reader", "commit-writer"]);
  const { installed } = await installGitSkills(f.store, f.url, {
    skills: ["paper-reader", "commit-writer"],
  });
  assert.equal(
    f.store.history()[0].message,
    "从 Git 安装技能：paper-reader、commit-writer",
  );
  f.push("paper-reader");
  await updateGitSkills(f.store, [installed[0].id]);
  const history = await new Sync(f.store).history();
  assert.equal(history[0].message, "更新 Git 技能：paper-reader");
});

test("批量 Git 技能提交过长时保留完整技能名并标注总数", async (t) => {
  const names = ["a", "b", "c"].map((letter) => `skill-${letter.repeat(58)}`);
  const f = await fixture(t, names);
  const { installed } = await installGitSkills(f.store, f.url, { all: true });
  const assertSubject = (prefix: string) => {
    const subject = f.store.history()[0].message;
    assert.equal(subject, `${prefix}：${names[0]} 等 3 个`);
    assert.ok(subject.length <= 100);
  };
  assertSubject("从 Git 安装技能");
  for (const name of names) f.write(name, "updated all");
  f.git("add", ".");
  f.git("commit", "-m", "update all");
  f.git("push", f.url, "main");
  await updateGitSkills(
    f.store,
    installed.map((s) => s.id),
  );
  assertSubject("更新 Git 技能");
  emptyCache(f.store);
});

test("安装完整单技能包，来源随源库同步，编辑保留来源；脱离后成为本地技能", async (t) => {
  const f = await fixture(t);
  const result = await installGitSkills(f.store, f.url);
  const entry = result.installed[0];
  assert.equal(result.selectionRequired, false);
  assert.equal(source(f.store, entry.id).subpath, "packages/alpha");
  assert.equal(
    source(f.store, entry.id).installedHash,
    bundleHash(readBundle(f.store.skillPath(entry.id))),
  );
  assert.equal(
    fs.statSync(path.join(f.store.skillPath(entry.id), "run.sh")).mode & 0o777,
    0o755,
  );
  assert.equal(listedSkills(f.store)[0].localSource, undefined);
  assert.ok(
    fs
      .readFileSync(path.join(f.store.skillPath(entry.id), "SKILL.md"), "utf8")
      .includes("extra: 保留"),
  );
  await assert.rejects(installGitSkills(f.store, f.url), /skills update/);
  const configRemote = path.join(f.dir, "config.git");
  f.git("init", "--bare", configRemote);
  await new Sync(f.store).setup({ url: configRemote });
  const other = await new Store(path.join(f.dir, "other"), f.home).init();
  await new Sync(other).setup({ url: configRemote });
  assert.deepEqual(source(other, entry.id), source(f.store, entry.id));
  await f.store.saveSkill(
    { name: "alpha", description: "编辑", body: "local" },
    entry.id,
  );
  assert.equal(source(f.store, entry.id).commit, result.commit);
  await detachGitSkill(f.store, entry.id);
  assert.equal(f.store.manifest().skills[0].source, undefined);
  assert.equal((await checkGitSkillUpdates(f.store)).length, 0);
  await assert.rejects(diffGitSkill(f.store, entry.id), /没有 Git 上游/);
  emptyCache(f.store);
});

test("多技能候选、选择固定提交、子路径、标签、提交 ref、本地路径与批量碰撞回滚", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const candidates = await installGitSkills(f.store, f.url);
  assert.equal(candidates.selectionRequired, true);
  assert.deepEqual(
    candidates.candidates.map((c) => c.name),
    ["alpha", "beta"],
  );
  assert.equal(f.store.manifest().skills.length, 0);
  f.push();
  const selected = await installGitSkills(f.store, f.url, {
    skills: ["alpha"],
    commit: candidates.commit,
  });
  assert.equal(
    source(f.store, selected.installed[0].id).commit,
    candidates.commit,
  );
  await assert.rejects(
    installGitSkills(f.store, f.url, { all: true }),
    /skills update/,
  );
  assert.equal(f.store.manifest().skills.length, 1);
  await installGitSkills(f.store, f.remote, {
    skills: ["packages/beta"],
    ref: "v1",
  });
  assert.equal(
    source(
      f.store,
      f.store.manifest().skills.find((s) => s.name === "beta")!.id,
    ).ref,
    "v1",
  );
  const another = await new Store(path.join(f.dir, "another"), f.home).init();
  await installGitSkills(another, f.url, { all: true, ref: candidates.commit });
  assert.equal(another.manifest().skills.length, 2);
  assert.deepEqual(parseGitSkillSource("owner/repo/packages/alpha"), {
    url: "https://github.com/owner/repo.git",
    ref: "HEAD",
    subpath: "packages/alpha",
  });
  assert.deepEqual(
    parseGitSkillSource(
      "https://github.com/owner/repo/tree/release/v1/packages/alpha",
      "release/v1",
    ),
    {
      url: "https://github.com/owner/repo.git",
      ref: "release/v1",
      subpath: "packages/alpha",
    },
  );
  assert.throws(() => parseGitSkillSource("owner/repo/../secret"), /越界/);
  assert.throws(
    () => parseGitSkillSource("https://token@github.com/owner/repo.git"),
    /认证信息/,
  );
  // Subpaths are persisted per skill, so an update never imports sibling packages.
  assert.equal(
    source(f.store, selected.installed[0].id).subpath,
    "packages/alpha",
  );
  emptyCache(f.store);
  emptyCache(another);
});

test("检查、文本与二进制差异、本地修改拒绝、force 更新、标签固定且不部署", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const result = await installGitSkills(f.store, f.url, { all: true });
  const id = result.installed[0].id;
  const head = f.push();
  const checks = await checkGitSkillUpdates(f.store);
  assert.equal(checks[0].latestCommit, head);
  assert.equal(checks.find((c) => c.name === "alpha")!.available, true);
  assert.equal(checks.find((c) => c.name === "beta")!.available, false);
  assert.ok(checks.every((c) => c.checkedAt));
  for (const entry of result.installed)
    assert.equal(
      source(f.store, entry.id).tree,
      f.git("rev-parse", `${result.commit}:packages/${entry.name}`),
    );
  assert.ok(fs.existsSync(path.join(f.store.root, "skill-updates.json")));
  const delta = await diffGitSkill(f.store, id);
  assert.ok(
    delta.files.some(
      (f) => f.path === "SKILL.md" && f.diff.includes("+upstream change"),
    ),
  );
  assert.ok(delta.files.some((f) => f.binary && f.diff === "二进制文件有变化"));
  fs.appendFileSync(path.join(f.store.skillPath(id), "SKILL.md"), "local edit");
  await assert.rejects(updateGitSkills(f.store, [id]), /已在本地修改/);
  const before = f.store.git(["rev-parse", "HEAD"]);
  const updates = await updateGitSkills(f.store, [id], true);
  assert.ok(updates[0].files.length);
  assert.notEqual(f.store.git(["rev-parse", "HEAD"]), before);
  assert.equal(source(f.store, id).commit, head);
  assert.equal(
    source(f.store, id).tree,
    f.git("rev-parse", `${head}:packages/alpha`),
  );
  assert.equal((await checkGitSkillUpdates(f.store, [id]))[0].available, false);
  assert.equal(fs.existsSync(path.join(f.home, ".claude")), false);
  emptyCache(f.store);
});

test("ls-remote 失败缓存错误；克隆失败、无效技能、链接均不留下残缺技能；清理崩溃缓存", async (t) => {
  const f = await fixture(t);
  const {
    installed: [entry],
  } = await installGitSkills(f.store, f.url);
  fs.renameSync(f.remote, f.remote + ".away");
  assert.ok((await checkGitSkillUpdates(f.store))[0].error);
  const before = f.store.git(["rev-parse", "HEAD"]);
  await assert.rejects(
    updateGitSkills(f.store, [entry.id]),
    /Git 技能操作失败/,
  );
  await assert.rejects(installGitSkills(f.store, f.url), /Git 技能操作失败/);
  assert.equal(f.store.git(["rev-parse", "HEAD"]), before);
  fs.renameSync(f.remote + ".away", f.remote);
  // Obtain a definitely dead PID rather than guessing an unused one.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => child.on("exit", resolve));
  const abandoned = path.join(
    f.store.root,
    "cache",
    "git-skills",
    `${child.pid}-aaaaaaaa`,
  );
  fs.mkdirSync(abandoned);
  fs.writeFileSync(path.join(abandoned, "partial"), "incomplete");
  const link = path.join(f.work, "packages", "alpha", "link");
  fs.symlinkSync("SKILL.md", link);
  f.git("add", ".");
  f.git("commit", "-m", "symlink");
  f.git("push", f.url, "main");
  await assert.rejects(installGitSkills(f.store, f.url), /符号链接/);
  assert.equal(f.store.manifest().skills.length, 1);
  assert.equal(fs.existsSync(abandoned), false);
  emptyCache(f.store);
});

test("旧 Git 来源无 tree 时退回 commit 比较，更新后使用目录 tree", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const {
    installed: [entry],
  } = await installGitSkills(f.store, f.url, { skills: ["alpha"] });
  await f.store.mutate("模拟旧来源", (m) => {
    const s = m.skills[0].source;
    if (typeof s === "object") delete s.tree;
  });
  assert.equal((await checkGitSkillUpdates(f.store))[0].available, false);
  const head = f.push("beta");
  const [legacy] = await checkGitSkillUpdates(f.store);
  assert.equal(legacy.available, true);
  assert.equal(legacy.latestCommit, head);
  await updateGitSkills(f.store, [entry.id]);
  assert.equal(
    source(f.store, entry.id).tree,
    f.git("rev-parse", "HEAD:packages/alpha"),
  );
  f.push("beta", "another beta change");
  const revision = f.store.revision();
  assert.equal((await checkGitSkillUpdates(f.store))[0].available, false);
  assert.equal(f.store.revision(), revision);
  emptyCache(f.store);
});

test("上游技能子目录删除返回 error，同仓库未变技能仍无更新", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  await installGitSkills(f.store, f.url, { all: true });
  f.git("rm", "-r", "packages/alpha");
  f.git("commit", "-m", "remove alpha");
  f.git("push", f.url, "main");
  const checks = await checkGitSkillUpdates(f.store);
  const deleted = checks.find((c) => c.name === "alpha")!;
  assert.match(deleted.error!, /上游技能目录不存在.*packages\/alpha/);
  assert.equal(deleted.available, undefined);
  assert.equal(deleted.latestCommit, f.git("rev-parse", "HEAD"));
  assert.equal(checks.find((c) => c.name === "beta")!.available, false);
  emptyCache(f.store);
});

test("获取远端 tree 失败返回并缓存 error，不误报更新且清理临时仓库", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  await installGitSkills(f.store, f.url, { all: true });
  const head = f.push();
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ncase "$*" in\n *fetch*) echo 'fatal: simulated tree fetch failure' >&2; exit 1 ;;\nesac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const checks = await checkGitSkillUpdates(f.store);
  for (const check of checks) {
    assert.match(check.error!, /simulated tree fetch failure/);
    assert.equal(check.available, undefined);
    assert.equal(check.latestCommit, head);
  }
  const cached = JSON.parse(
    fs.readFileSync(path.join(f.store.root, "skill-updates.json"), "utf8"),
  );
  for (const check of checks) assert.deepEqual(cached[check.id], check);
  emptyCache(f.store);
});

test("并发检查按仓库合并 ls-remote；并发安装只成功一次；下载期间外部修改使更新过期", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  await installGitSkills(f.store, f.url, { all: true });
  await f.store.mutate("另一个技能使用显式分支", (m) => {
    if (typeof m.skills[1].source === "object") m.skills[1].source.ref = "main";
  });
  f.push("alpha", "first upstream change");
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const calls = path.join(f.dir, "calls");
  const gate = path.join(f.dir, "gate");
  const started = path.join(f.dir, "started");
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ncase "$*" in\n *ls-remote*) echo check >> '${calls}'; sleep 0.2 ;;\n *fetch*) echo "$*" >> '${calls}.fetch'; if [ -f '${gate}' ]; then touch '${started}'; while [ -f '${gate}' ]; do sleep 0.02; done; fi ;;\nesac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const checks = await Promise.all([
    checkGitSkillUpdates(f.store),
    checkGitSkillUpdates(f.store),
  ]);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  const fetches = fs
    .readFileSync(calls + ".fetch", "utf8")
    .trim()
    .split("\n");
  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /--depth=1.*--filter=blob:none/);
  for (const batch of checks) {
    assert.equal(batch.find((c) => c.name === "alpha")!.available, true);
    assert.equal(batch.find((c) => c.name === "beta")!.available, false);
  }
  const fresh = await new Store(path.join(f.dir, "fresh"), f.home).init();
  const results = await Promise.allSettled([
    installGitSkills(fresh, f.url, { all: true }),
    installGitSkills(fresh, f.url, { all: true }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(fresh.manifest().skills.length, 2);
  f.push();
  fs.writeFileSync(gate, "wait");
  const id = f.store.manifest().skills[0].id;
  const pending = updateGitSkills(f.store, [id]);
  for (let i = 0; i < 200 && !fs.existsSync(started); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(started));
  fs.appendFileSync(path.join(f.store.skillPath(id), "SKILL.md"), "external");
  fs.unlinkSync(gate);
  await assert.rejects(pending, /下载期间被修改/);
  assert.ok(
    fs
      .readFileSync(path.join(f.store.skillPath(id), "SKILL.md"), "utf8")
      .endsWith("external"),
  );
  emptyCache(f.store);
  emptyCache(fresh);
});

test("本机开发目录 refresh 保持原有行为，Git 与本机来源显示清晰", async (t) => {
  const f = await fixture(t);
  const local = await f.store.importSkill(
    path.join(f.work, "packages", "alpha"),
    { kind: "global", harnesses: ["claude"] },
  );
  assert.equal(
    listedSkills(f.store)[0].localSource,
    path.join(f.work, "packages", "alpha"),
  );
  f.write("alpha", "development");
  assert.equal((await refreshSkills(f.store, [local.id]))[0].changed, true);
  await assert.rejects(
    checkGitSkillUpdates(f.store, [local.id]),
    /没有 Git 上游/,
  );
});

test("HTTP 两步安装固定候选提交，更新、差异、脱离与访问控制", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const ui = path.join(f.dir, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(
    path.join(ui, "index.html"),
    "<html><head><!--HSYNC_TOKEN--></head><body>test</body></html>",
  );
  const server = await startServer(f.store, { port: 0, uiDirectory: ui });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const request = async (route: string, body?: unknown, auth = true) => {
    const response = await fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { "x-harness-sync-token": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  assert.equal(
    (await request("/api/skills/install", { source: f.url }, false)).status,
    403,
  );
  const candidates = await request("/api/skills/install", { source: f.url });
  assert.equal(candidates.data.selectionRequired, true);
  const installed = await request("/api/skills/install", {
    source: f.url,
    commit: candidates.data.commit,
    skills: ["alpha"],
  });
  assert.equal(installed.ok, true);
  const id = installed.data.installed[0].id;
  assert.equal((await request("/api/skills")).data[0].source.type, "git");
  assert.equal((await request(`/api/skills/${id}`)).data.source.type, "git");
  f.push();
  assert.equal(
    (await request("/api/skills/updates", { ids: [id] })).data[0].available,
    true,
  );
  assert.ok((await request(`/api/skills/${id}/diff`)).data.files.length);
  assert.equal((await request("/api/skills/update", { ids: [id] })).ok, true);
  assert.equal((await request(`/api/skills/${id}/detach`, {})).ok, true);
  assert.equal((await request(`/api/skills/${id}`)).data.source, undefined);
});

test("下载中途失败只清理缓存，ls-remote 在十五秒内超时且不阻塞其他请求", async (t) => {
  const f = await fixture(t);
  await installGitSkills(f.store, f.url);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  const script = path.join(bin, "git");
  fs.writeFileSync(
    script,
    `#!/bin/sh\ncase "$*" in\n *fetch*) echo incomplete > partial-pack; exit 23 ;;\nesac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const before = f.store.git(["rev-parse", "HEAD"]);
  await assert.rejects(installGitSkills(f.store, f.url), /Git 技能操作失败/);
  assert.equal(f.store.git(["rev-parse", "HEAD"]), before);
  emptyCache(f.store);
  fs.writeFileSync(
    script,
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nif (process.argv.includes('ls-remote')) setInterval(() => {}, 1000);\nelse { const r = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(r.status || 0); }\n`,
    { mode: 0o755 },
  );
  const start = Date.now();
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 50);
  const results = await checkGitSkillUpdates(f.store);
  clearTimeout(timer);
  assert.ok(ticked);
  assert.match(results[0].error!, /超时/);
  assert.ok(Date.now() - start < 19_000);
  assert.equal(f.store.manifest().skills.length, 1);
});

test("CLI 多候选返回非零 JSON；安装、检查、差异、更新、脱离命令可用", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--json", ...args],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  try {
    cli("skills", "install", f.url);
    assert.fail("应要求选择技能");
  } catch (e: any) {
    assert.equal(e.status, 1);
    assert.equal(JSON.parse(e.stdout).candidates.length, 2);
  }
  const result = JSON.parse(
    cli("skills", "install", f.url, "--skill", "alpha", "--ref", "main"),
  );
  const id = result.installed[0].id;
  assert.equal(JSON.parse(cli("skills", "list"))[0].source.type, "git");
  assert.equal(JSON.parse(cli("skills", "show", id)).source.type, "git");
  f.push();
  assert.equal(JSON.parse(cli("skills", "updates", id))[0].available, true);
  assert.ok(JSON.parse(cli("skills", "diff", id)).files.length);
  assert.equal(JSON.parse(cli("skills", "update", id))[0].id, id);
  assert.equal(JSON.parse(cli("skills", "detach", id)).source, undefined);
});

test("GitHub 简写子路径与含斜杠 tree ref 使用本地裸仓库验证，仓库根技能可安装", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  f.git("branch", "release/v1", "v1");
  f.git("push", f.url, "release/v1");
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${f.url}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/test/fixture.git",
  });
  const one = await installGitSkills(f.store, "test/fixture/packages/alpha", {
    ref: "v1",
  });
  assert.equal(one.installed.length, 1);
  assert.equal(source(f.store, one.installed[0].id).subpath, "packages/alpha");
  const two = await installGitSkills(
    f.store,
    "https://github.com/test/fixture/tree/release/v1/packages/beta",
  );
  assert.equal(two.installed.length, 1);
  assert.equal(source(f.store, two.installed[0].id).ref, "release/v1");
  assert.equal(source(f.store, two.installed[0].id).subpath, "packages/beta");
  f.git("mv", "packages/alpha/SKILL.md", "SKILL.md");
  f.git("rm", "packages/beta/SKILL.md");
  f.git("commit", "-m", "root skill");
  f.git("push", f.url, "main");
  const rootStore = await new Store(
    path.join(f.dir, "root-skill"),
    f.home,
  ).init();
  const root = await installGitSkills(rootStore, f.url);
  assert.equal(root.installed[0].name, "alpha");
  assert.equal(source(rootStore, root.installed[0].id).subpath, "");
  assert.equal(
    source(rootStore, root.installed[0].id).tree,
    f.git("rev-parse", "HEAD^{tree}"),
  );
  emptyCache(f.store);
  emptyCache(rootStore);
});

test("缓存写入路径是符号链接时拒绝，批量写入异常回滚已导入技能", async (t) => {
  const f = await fixture(t, ["alpha", "beta"]);
  const outside = path.join(f.dir, "outside");
  fs.mkdirSync(outside);
  const cache = path.join(f.store.root, "cache");
  fs.symlinkSync(outside, cache);
  await assert.rejects(
    installGitSkills(f.store, f.url, { all: true }),
    /拒绝写入符号链接/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(cache);
  const original = fs.renameSync;
  let published = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (
      String(to).startsWith(path.join(f.store.repo, "skills") + path.sep) &&
      !path.basename(String(to)).startsWith(".")
    ) {
      if (++published === 2) throw new Error("模拟第二个包发布失败");
    }
    return original(from, to);
  });
  await assert.rejects(
    installGitSkills(f.store, f.url, { all: true }),
    /第二个包发布失败/,
  );
  assert.equal(f.store.manifest().skills.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.store.repo, "skills")), []);
  emptyCache(f.store);
});

test("回归1：严格 umask 安装和更新后，跨设备同步仍可正常更新", async (t) => {
  const f = await fixture(t);
  const previousMask = process.umask(0o077);
  let id: string;
  try {
    id = (await installGitSkills(f.store, f.url)).installed[0].id;
  } finally {
    process.umask(previousMask);
  }
  const configRemote = path.join(f.dir, "config.git");
  f.git("init", "--bare", configRemote);
  const sa = new Sync(f.store);
  await sa.setup({ url: configRemote });
  const other = await new Store(path.join(f.dir, "other"), f.home).init();
  const sb = new Sync(other);
  await sb.setup({ url: configRemote });
  f.push();
  await updateGitSkills(other, [id]);
  process.umask(0o077);
  try {
    f.push("alpha", "second upstream change");
    await updateGitSkills(other, [id]);
  } finally {
    process.umask(previousMask);
  }
  await sb.now();
  await sa.now();
  assert.equal(
    source(f.store, id).installedHash,
    bundleHash(readBundle(f.store.skillPath(id))),
  );
  const bundle = readBundle(f.store.skillPath(id));
  assert.equal(bundle["SKILL.md"].mode, 0o644);
  assert.equal(bundle["run.sh"].mode, 0o755);
  f.push("alpha", "third upstream change");
  await updateGitSkills(f.store, [id]);
});

test("回归2：无效模板作为候选错误返回，只阻止选中它的安装", async (t) => {
  const f = await fixture(t, ["alpha", "missing-description", "placeholder"]);
  fs.writeFileSync(
    path.join(f.work, "packages", "missing-description", "SKILL.md"),
    "---\nname: missing-description\n---\n模板\n",
  );
  fs.writeFileSync(
    path.join(f.work, "packages", "placeholder", "SKILL.md"),
    "---\nname: '<skill-name>'\ndescription: 模板\n---\n模板\n",
  );
  const template = path.join(f.work, "templates", "alpha");
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(
    path.join(template, "SKILL.md"),
    "---\nname: '<skill-name>'\ndescription: 模板\n---\n模板\n",
  );
  f.git("add", ".");
  f.git("commit", "-m", "invalid templates");
  f.git("push", f.url, "main");
  const ui = path.join(f.dir, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, "index.html"), "<!--HSYNC_TOKEN-->");
  const server = await startServer(f.store, { port: 0, uiDirectory: ui });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const response = await fetch(server.url + "/api/skills/install", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-sync-token": token,
    },
    body: JSON.stringify({ source: f.url }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.data.selectionRequired, true);
  assert.equal(result.data.candidates.length, 4);
  assert.equal(
    result.data.candidates.find((c: { name: string }) => c.name === "alpha")
      .error,
    undefined,
  );
  assert.match(
    result.data.candidates.find((c: { subpath: string }) =>
      c.subpath.endsWith("missing-description"),
    ).error,
    /description/,
  );
  assert.match(
    result.data.candidates.find((c: { subpath: string }) =>
      c.subpath.endsWith("placeholder"),
    ).error,
    /name/,
  );
  await assert.rejects(
    installGitSkills(f.store, f.url, { all: true }),
    /description|name/,
  );
  await assert.rejects(
    installGitSkills(f.store, f.url, { skills: ["packages/placeholder"] }),
    /name/,
  );
  assert.equal(f.store.manifest().skills.length, 0);
  const installed = await installGitSkills(f.store, f.url, {
    skills: ["alpha"],
    commit: result.data.commit,
  });
  assert.deepEqual(
    installed.installed.map((s) => s.name),
    ["alpha"],
  );
  emptyCache(f.store);
});

test("回归3：显式含斜杠 ref 等于 tree 路径时，从仓库根发现技能", async (t) => {
  const f = await fixture(t);
  f.git("branch", "release/v1", "v1");
  f.git("push", f.url, "release/v1");
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${f.url}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/test/fixture.git",
  });
  const input = "https://github.com/test/fixture/tree/release/v1";
  const result = await installGitSkills(f.store, input, { ref: "release/v1" });
  assert.equal(result.installed[0].name, "alpha");
  assert.equal(
    source(f.store, result.installed[0].id).subpath,
    "packages/alpha",
  );
  assert.equal(parseGitSkillSource(input, "release/v1").subpath, "");
  assert.equal(parseGitSkillSource(input + "/", "release/v1").subpath, "");
  assert.equal(
    parseGitSkillSource(input + "/packages/alpha", "release/v1").subpath,
    "packages/alpha",
  );
});

test("回归4：同步冲突保留双方时，改名副本脱离 Git，原条目保留上游", async (t) => {
  const f = await fixture(t);
  const id = (await installGitSkills(f.store, f.url)).installed[0].id;
  const configRemote = path.join(f.dir, "config.git");
  f.git("init", "--bare", configRemote);
  const sa = new Sync(f.store);
  await sa.setup({ url: configRemote });
  const other = await new Store(path.join(f.dir, "other"), f.home).init();
  const sb = new Sync(other);
  await sb.setup({ url: configRemote });
  await f.store.saveSkill(
    { name: "alpha", description: "测试", body: "local edit" },
    id,
  );
  await other.saveSkill(
    { name: "alpha", description: "测试", body: "remote edit" },
    id,
  );
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 1);
  await sa.resolve(id, "both");
  const copy = f.store.manifest().skills.find((s) => s.name === "alpha-2")!;
  assert.ok(copy);
  assert.equal(copy.source, undefined);
  const markdown = fs.readFileSync(
    path.join(f.store.skillPath(copy.id), "SKILL.md"),
    "utf8",
  );
  assert.match(markdown, /name: alpha-2/);
  assert.match(markdown, /remote edit/);
  assert.equal(source(f.store, id).type, "git");
  assert.deepEqual(
    (await checkGitSkillUpdates(f.store)).map((s) => s.id),
    [id],
  );
  await assert.rejects(diffGitSkill(f.store, copy.id), {
    code: "NO_GIT_SOURCE",
  });
  await assert.rejects(updateGitSkills(f.store, [copy.id], true), {
    code: "NO_GIT_SOURCE",
  });
  f.push();
  assert.ok((await diffGitSkill(f.store, id)).files.length);
  await updateGitSkills(f.store, [id], true);
  await sa.now();
  await sb.now();
  assert.equal(
    other.manifest().skills.find((s) => s.id === copy.id)!.source,
    undefined,
  );
});
