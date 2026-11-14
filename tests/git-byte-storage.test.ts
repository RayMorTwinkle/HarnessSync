import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "./settings-helpers.ts";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { SyncIgnore } from "../src/core/sync-ignore.ts";
import { installGitSkills } from "../src/core/git-skills.ts";
import { pathToFileURL } from "node:url";

const scope = { kind: "global" as const, harnesses: ["codex"] };
const packageFiles = {
  "SKILL.md": Buffer.from(
    "---\nname: byte-test\ndescription: 测试\n---\n原始正文\n",
  ),
  ".gitignore": Buffer.from(".env\nruntime.conf\n.git*\n"),
  ".gitattributes": Buffer.from("* text eol=crlf filter=blocked ident\n"),
  ".gitmodules": Buffer.from("# ordinary package data\r\n"),
  ".env": Buffer.from("SYNTHETIC_TEST_VALUE=yes\r\n"),
  "runtime.conf": Buffer.concat([
    Buffer.from([0, 255, 13, 10, 128, 0]),
    Buffer.alloc(96 * 1024, 255),
  ]),
  run: Buffer.from("#!/bin/sh\nprintf test\r\n"),
  "nested/.gitattributes": Buffer.from(
    "* text eol=lf working-tree-encoding=UTF-16\n",
  ),
  "nested/line\tbreak\nfile": Buffer.from("$Id$\r\n保留\r\n"),
  'nested/中文 "引号"\\路径': Buffer.from("原始字节\r\n"),
};
async function imported(t: TestContext) {
  const f = await fixture(t);
  const source = path.join(f.root, "package");
  for (const [name, bytes] of Object.entries(packageFiles)) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, name === "run" ? 0o755 : 0o644);
  }
  fs.mkdirSync(path.join(source, ".git"));
  fs.writeFileSync(path.join(source, ".git", "not-package-data"), "excluded");
  f.store.git(["config", "core.autocrlf", "true"]);
  f.store.git(["config", "core.fileMode", "false"]);
  f.store.git(["config", "filter.blocked.clean", "false"]);
  f.store.git(["config", "filter.blocked.smudge", "false"]);
  f.store.git(["config", "filter.blocked.required", "true"]);
  const entry = await f.store.importSkill(source, scope);
  return { ...f, source, entry };
}
function blob(store: Store, commit: string, file: string) {
  return execFileSync("git", ["cat-file", "blob", `${commit}:${file}`], {
    cwd: store.repo,
  });
}
function checkPackage(store: Store, id: string, commit = "HEAD") {
  for (const [name, bytes] of Object.entries(packageFiles)) {
    assert.deepEqual(
      fs.readFileSync(path.join(store.skillPath(id), name)),
      bytes,
      name,
    );
    assert.deepEqual(blob(store, commit, `skills/${id}/${name}`), bytes, name);
  }
  assert.ok(fs.statSync(path.join(store.skillPath(id), "run")).mode & 0o111);
  assert.match(store.git(["ls-tree", commit, `skills/${id}/run`]), /^100755 /);
  assert.equal(fs.existsSync(path.join(store.skillPath(id), ".git")), false);
}
async function peer(t: TestContext, f: Awaited<ReturnType<typeof imported>>) {
  const remote = path.join(f.root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], {
    stdio: "ignore",
  });
  const home = path.join(f.root, "peer-home");
  fs.mkdirSync(home);
  const b = await new Store(path.join(f.root, "peer"), home).init();
  const sa = new Sync(f.store),
    sb = new Sync(b);
  return { remote, a: f.store, b, sa, sb };
}

test("imports all package bytes and executable bits despite ignore, attributes and filters", async (t) => {
  const { store, entry } = await imported(t);
  checkPackage(store, entry.id);
  const tracked = store.git(["ls-files", "-z"]).split("\0");
  for (const name of Object.keys(packageFiles))
    assert.ok(tracked.includes(`skills/${entry.id}/${name}`));
  const before = store.git(["rev-parse", "HEAD"]);
  store.commit("未修改包");
  assert.equal(store.git(["rev-parse", "HEAD"]), before);
  assert.equal(
    fs.readdirSync(store.root).some((name) => name.startsWith("source-index-")),
    false,
  );
});

test("next commit repairs legacy omitted files and rebuilds the index including removals and mode changes", async (t) => {
  const { store, entry } = await imported(t);
  store.git([
    "update-index",
    "--force-remove",
    "--",
    `skills/${entry.id}/.env`,
    `skills/${entry.id}/runtime.conf`,
  ]);
  const tree = store.git(["write-tree"]);
  const legacy = store.git([
    "commit-tree",
    tree,
    "-p",
    "HEAD",
    "-m",
    "模拟旧版本遗漏",
  ]);
  store.git(["update-ref", "HEAD", legacy]);
  assert.ok(!store.git(["ls-tree", "-r", "HEAD"]).includes("/.env"));
  await store.saveRule({ title: "触发普通提交", body: "测试" });
  checkPackage(store, entry.id);
  fs.rmSync(path.join(store.skillPath(entry.id), "runtime.conf"));
  fs.chmodSync(path.join(store.skillPath(entry.id), "run"), 0o644);
  store.commit("删除资源并撤销执行位");
  assert.equal(
    store.git(["ls-tree", "HEAD", `skills/${entry.id}/runtime.conf`]),
    "",
  );
  assert.match(
    store.git(["ls-tree", "HEAD", `skills/${entry.id}/run`]),
    /^100644 /,
  );
  const changes = (await new Sync(store).history())[0].changes;
  assert.ok(changes.some((c) => c.kind === "skills" && c.id === entry.id));
  const envFile = path.join(store.skillPath(entry.id), ".env");
  const stamp = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(envFile, stamp, stamp);
  store.commit("记录固定修改时间");
  const stat = fs.statSync(envFile);
  const changed = Buffer.from(
    packageFiles[".env"].toString().replace("yes", "no!"),
  );
  fs.writeFileSync(envFile, changed);
  fs.utimesSync(envFile, stat.atime, stat.mtime);
  assert.equal(fs.statSync(envFile).size, stat.size);
  assert.equal(fs.statSync(envFile).mtimeMs, stat.mtimeMs);
  store.commit("相同大小和修改时间的内容变化");
  assert.deepEqual(blob(store, "HEAD", `skills/${entry.id}/.env`), changed);
});

test("two devices merge, upload and restore byte-exact packages", async (t) => {
  const f = await imported(t);
  const { a, b, sa, sb, remote } = await peer(t, f);
  const original = a.git(["rev-parse", "HEAD"]);
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  checkPackage(b, f.entry.id);
  fs.writeFileSync(
    path.join(a.skillPath(f.entry.id), ".env"),
    "SYNTHETIC_CHANGED\r\n",
  );
  await b.saveRule({ title: "另一台设备的修改", body: "保留" });
  await sb.now();
  assert.equal((await sa.now()).conflicts.length, 0);
  await sb.now();
  assert.deepEqual(
    fs.readFileSync(path.join(b.skillPath(f.entry.id), ".env")),
    Buffer.from("SYNTHETIC_CHANGED\r\n"),
  );
  assert.deepEqual(
    blob(b, "HEAD", `skills/${f.entry.id}/.env`),
    Buffer.from("SYNTHETIC_CHANGED\r\n"),
  );
  const history = await sa.history();
  assert.ok(
    history.some((h) =>
      h.changes.some((c) => c.kind === "skills" && c.id === f.entry.id),
    ),
  );
  await a.restoreSource(original);
  checkPackage(a, f.entry.id);
  await sa.undo();
  assert.deepEqual(
    fs.readFileSync(path.join(a.skillPath(f.entry.id), ".env")),
    Buffer.from("SYNTHETIC_CHANGED\r\n"),
  );
  await a.restoreSource(original);
  checkPackage(a, f.entry.id);
  await sa.now();
  await sb.now();
  checkPackage(b, f.entry.id);
});

test("local sync ignore alone excludes env while projected uploads retain other raw bytes", async (t) => {
  const f = await imported(t);
  const { a, b, sa, sb, remote } = await peer(t, f);
  const ignore = new SyncIgnore(a);
  await ignore.update({ add: ["byte-test/.env"] });
  await sa.setup({ url: remote });
  await sb.setup({ url: remote });
  checkPackage(a, f.entry.id);
  assert.equal(
    fs.existsSync(path.join(b.skillPath(f.entry.id), ".env")),
    false,
  );
  const objects = execFileSync(
    "git",
    ["--git-dir", remote, "rev-list", "--objects", "--all"],
    { encoding: "utf8" },
  );
  assert.ok(!objects.includes("/.env"));
  for (const [name, bytes] of Object.entries(packageFiles)) {
    if (name === ".env") continue;
    assert.deepEqual(
      fs.readFileSync(path.join(b.skillPath(f.entry.id), name)),
      bytes,
    );
  }
  await ignore.update({ remove: ["byte-test/.env"] });
  await sa.now();
  await sb.now();
  checkPackage(b, f.entry.id);
});

test("commit refuses symlink targets and leaves source history unchanged", async (t) => {
  const { store, entry, root } = await imported(t);
  const before = store.git(["rev-parse", "HEAD"]);
  const external = path.join(root, "external");
  fs.writeFileSync(external, "unchanged");
  fs.symlinkSync(external, path.join(store.skillPath(entry.id), "linked"));
  assert.throws(() => store.commit("拒绝链接"), /符号链接/);
  assert.equal(store.git(["rev-parse", "HEAD"]), before);
  assert.equal(fs.readFileSync(external, "utf8"), "unchanged");
  assert.equal(
    fs.readdirSync(store.root).some((name) => name.startsWith("source-index-")),
    false,
  );
});

test("Git skill downloads materialize raw blobs without checkout conversion", async (t) => {
  const f = await imported(t);
  const commit = f.store.git(["rev-parse", "HEAD"]);
  const target = await new Store(
    path.join(f.root, "git-import"),
    f.home,
  ).init();
  const result = await installGitSkills(
    target,
    pathToFileURL(f.store.repo).href,
    { all: true, commit },
  );
  assert.equal(result.installed.length, 1);
  checkPackage(target, result.installed[0].id);
});

test("500-file commits and in-memory trees use a fixed number of Git processes", async (t) => {
  const { store, root } = await fixture(t);
  const entry = await store.saveSkill({
    name: "batch",
    description: "测试",
    body: "正文",
  });
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(root, "count-git");
  const log = path.join(root, "git-count.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = {args};
if (args[0] === 'hash-object') {
  const temp = path.dirname(process.env.GIT_INDEX_FILE);
  const blobs = fs.readdirSync(temp).filter(name => name.startsWith('blob-'));
  record.directoryMode = fs.statSync(temp).mode & 0o777;
  record.blobModes = blobs.map(name => fs.statSync(path.join(temp, name)).mode & 0o777);
  record.inputMode = fs.statSync(path.join(temp, 'input')).mode & 0o777;
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + '\\n');
if (args[0] === 'hash-object' && process.env.HSYNC_TEST_FAIL_BATCH === '1') {
  process.stderr.write('fatal: 测试注入批量哈希失败\\n');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(git)}, args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  type Call = {
    args: string[];
    directoryMode?: number;
    inputMode?: number;
    blobModes?: number[];
  };
  const measure = (action: () => unknown) => {
    fs.writeFileSync(log, "");
    const start = performance.now();
    const result = action();
    const ms = performance.now() - start;
    const calls: Call[] = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { calls, result, ms };
  };
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    fs.writeFileSync(
      path.join(store.skillPath(entry.id), "resource-0"),
      "zero",
    );
    const small = measure(() => store.commit("小包"));
    for (let i = 1; i < 499; i++)
      fs.writeFileSync(
        path.join(store.skillPath(entry.id), `resource-${i}`),
        `资源 ${i}\r\n`,
      );
    const large = measure(() => store.commit("五百文件包"));
    assert.equal(large.calls.length, small.calls.length);
    assert.ok(large.calls.length <= 10, "提交进程数应固定，与文件数无关");
    for (const { calls } of [small, large]) {
      const hashes = calls.filter((call) => call.args[0] === "hash-object");
      assert.equal(hashes.length, 1);
      assert.ok(hashes[0].args.includes("--stdin-paths"));
      assert.ok(hashes[0].args.includes("--no-filters"));
      assert.equal(
        hashes[0].blobModes!.length,
        0,
        "磁盘文件不应复制到临时目录",
      );
      assert.equal(hashes[0].directoryMode, 0o700);
      assert.equal(hashes[0].inputMode, 0o600);
    }
    const memory = Array.from(
      { length: 500 },
      (_, i): [string, { content: string; mode: number }] => [
        `memory/file-${i}`,
        {
          content: Buffer.from(`内存 ${i}\r\n`).toString("base64"),
          mode: 0o644,
        },
      ],
    );
    const projected = measure(() => store.writeTree(memory));
    assert.ok(projected.calls.length <= 4);
    const batch = projected.calls.find(
      (call) => call.args[0] === "hash-object",
    )!;
    assert.equal(batch.directoryMode, 0o700);
    assert.equal(batch.blobModes!.length, 500);
    assert.ok(batch.blobModes!.every((mode) => mode === 0o600));
    assert.equal(batch.inputMode, 0o600);
    assert.deepEqual(
      blob(store, projected.result as string, "memory/file-499"),
      Buffer.from("内存 499\r\n"),
    );
    const fail = process.env.HSYNC_TEST_FAIL_BATCH;
    process.env.HSYNC_TEST_FAIL_BATCH = "1";
    try {
      assert.throws(() => store.writeTree(memory), /测试注入批量哈希失败/);
    } finally {
      if (fail === undefined) delete process.env.HSYNC_TEST_FAIL_BATCH;
      else process.env.HSYNC_TEST_FAIL_BATCH = fail;
    }
    assert.equal(
      fs
        .readdirSync(store.root)
        .some((name) => name.startsWith("source-index-")),
      false,
    );
    t.diagnostic(
      `Git processes: small=${small.calls.length}, 500 files=${large.calls.length}, memory=${projected.calls.length}; commit=${large.ms.toFixed(1)} ms (counting wrapper included)`,
    );
  } finally {
    process.env.PATH = previous;
  }
});
