import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-install-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "source");
  const tools = path.join(root, "tools");
  const install = path.join(root, "program's directory");
  const bin = path.join(root, "command's directory");
  fs.mkdirSync(repo);
  fs.mkdirSync(tools);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  // 模拟依赖安装与构建，不在每个测试中访问 npm 网络；真实构建另行验收。
  fs.writeFileSync(
    path.join(tools, "npm"),
    '#!/usr/bin/env bash\nset -e\nif [ "${HSYNC_TEST_FAIL_BUILD:-0}" = 1 ]; then exit 42; fi\nif [ "$1" = run ]; then node fixture-build.cjs; fi\n',
  );
  fs.chmodSync(path.join(tools, "npm"), 0o755);
  fs.writeFileSync(
    path.join(repo, "fixture-build.cjs"),
    `const fs=require('node:fs'); fs.mkdirSync('dist/ui',{recursive:true}); fs.copyFileSync('fixture-cli.cjs','dist/cli.js'); fs.writeFileSync('dist/ui/index.html','<html>fixture</html>');`,
  );
  const commit = (version: string) => {
    fs.writeFileSync(
      path.join(repo, "fixture-cli.cjs"),
      `console.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2)}));`,
    );
    git("add", ".");
    git(
      "-c",
      "user.name=Installer Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      version,
    );
  };
  commit("one");
  const run = (env: Record<string, string> = {}, args: string[] = []) =>
    spawnSync(
      "bash",
      [
        installer,
        "--repo",
        repo,
        "--ref",
        "main",
        "--install-dir",
        install,
        "--bin-dir",
        bin,
        ...args,
      ],
      {
        env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, ...env },
        encoding: "utf8",
      },
    );
  return { root, repo, install, bin, run, commit };
}

test("installer preserves quoted paths and arguments, upgrades and retains previous releases", (t) => {
  const x = fixture(t);
  const first = x.run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const current = fs.readlinkSync(path.join(x.install, "current"));
  const cli = path.join(x.bin, "hsync");
  const args = ["a b", "$(touch should-not-run)", "single'quote"];
  assert.deepEqual(JSON.parse(execFileSync(cli, args, { encoding: "utf8" })), {
    version: "one",
    args,
  });
  assert.ok(!fs.existsSync(path.join(x.root, "should-not-run")));
  x.commit("two");
  const second = x.run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.notEqual(fs.readlinkSync(path.join(x.install, "current")), current);
  assert.ok(fs.existsSync(path.join(x.install, current, "dist/cli.js")));
  assert.equal(
    JSON.parse(execFileSync(cli, [], { encoding: "utf8" })).version,
    "two",
  );
  assert.ok(!fs.existsSync(path.join(x.install, ".install-lock")));
  assert.ok(!fs.existsSync(path.join(x.install, "device.json")));
});

test("failed build leaves the working launcher and current release intact and cleans staging", (t) => {
  const x = fixture(t);
  assert.equal(x.run().status, 0);
  const current = fs.readlinkSync(path.join(x.install, "current"));
  const launcher = fs.readFileSync(path.join(x.bin, "hsync"), "utf8");
  x.commit("broken");
  assert.notEqual(x.run({ HSYNC_TEST_FAIL_BUILD: "1" }).status, 0);
  assert.equal(fs.readlinkSync(path.join(x.install, "current")), current);
  assert.equal(fs.readFileSync(path.join(x.bin, "hsync"), "utf8"), launcher);
  assert.ok(!fs.existsSync(path.join(x.install, ".install-lock")));
  assert.ok(!fs.readdirSync(x.install).some((p) => p.startsWith(".staging.")));
});

test("installer refuses foreign files, symlink launchers and unowned program directories", (t) => {
  const x = fixture(t);
  fs.mkdirSync(x.bin);
  const cli = path.join(x.bin, "hsync");
  fs.writeFileSync(cli, "user program");
  assert.notEqual(x.run().status, 0);
  assert.equal(fs.readFileSync(cli, "utf8"), "user program");
  fs.unlinkSync(cli);
  const target = path.join(x.root, "foreign");
  fs.writeFileSync(target, "outside");
  fs.symlinkSync(target, cli);
  assert.notEqual(x.run().status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "outside");
  fs.unlinkSync(cli);
  fs.mkdirSync(x.install);
  fs.writeFileSync(path.join(x.install, "keep"), "original");
  assert.notEqual(x.run().status, 0);
  assert.equal(
    fs.readFileSync(path.join(x.install, "keep"), "utf8"),
    "original",
  );
});

test("installer rejects an existing install lock without clearing another install's lock", (t) => {
  const x = fixture(t);
  assert.equal(x.run().status, 0);
  fs.mkdirSync(path.join(x.install, ".install-lock"));
  assert.notEqual(x.run().status, 0);
  assert.ok(fs.existsSync(path.join(x.install, ".install-lock")));
});
