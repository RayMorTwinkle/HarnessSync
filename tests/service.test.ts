import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  LoginService,
  rotateServiceLog,
  serviceLabel,
} from "../src/core/service.ts";
import { Settings } from "../src/core/settings.ts";
import { fixture, fakeRunner } from "./settings-helpers.ts";

async function serviceFixture(
  t: Parameters<typeof fixture>[0],
  platform = "darwin",
) {
  const f = await fixture(t);
  const cliPath = path.join(f.root, 'installed & "quoted"/dist/cli.js');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "// installed cli");
  const fake = fakeRunner();
  const service = new LoginService(f.store, {
    platform,
    cliPath,
    execPath: process.execPath,
    uid: 501,
    envPath: '/bin:<&"test>',
    runner: fake.runner,
  });
  return { ...f, ...fake, service, cliPath };
}
test("macOS plist escapes paths/env and uses crash-only restart; fake runner installs/status/uninstalls", async (t) => {
  const f = await serviceFixture(t);
  assert.equal((await f.service.status()).login, false);
  assert.equal((await f.service.install()).login, true);
  const content = fs.readFileSync(f.service.file, "utf8");
  assert.match(content, /installed &amp; &quot;quoted&quot;/);
  assert.match(content, /\/bin:&lt;&amp;&quot;test&gt;/);
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(content, /<key>SuccessfulExit<\/key><false\/>/);
  assert.ok(content.includes(`<string>${process.execPath}</string>`));
  assert.ok(content.includes(`<string>${f.store.root}</string>`));
  assert.match(
    content,
    /<string>serve<\/string><string>--background<\/string>/,
  );
  assert.ok(content.includes(path.join(f.store.root, "logs/service.log")));
  assert.ok(
    f.calls.some(
      (c) => c.args.join(" ") === `bootstrap gui/501 ${f.service.file}`,
    ),
  );
  const count = f.calls.filter((c) => c.args[0] === "bootstrap").length;
  await f.service.install();
  assert.equal(f.calls.filter((c) => c.args[0] === "bootstrap").length, count);
  f.setLoaded(false);
  assert.equal((await f.service.status()).login, false);
  f.setLoaded(true);
  assert.equal((await f.service.uninstall()).login, false);
  assert.ok(!fs.existsSync(f.service.file));
  assert.ok(
    f.calls.some((c) => c.args.join(" ") === `bootout gui/501/${serviceLabel}`),
  );
});
test("settings startup.login reflects service state and toggles through the same implementation", async (t) => {
  const f = await serviceFixture(t);
  const settings = new Settings(f.store, f.service);
  assert.equal(
    (await settings.patch({ startup: { login: true } })).settings.startup.login,
    true,
  );
  f.setLoaded(false);
  assert.equal((await settings.get()).settings.startup.login, false);
  f.setLoaded(true);
  assert.equal(
    (await settings.patch({ startup: { login: false } })).settings.startup
      .login,
    false,
  );
});
test("service refuses dev checkout, unsupported OS, foreign files and symlink targets", async (t) => {
  const f = await serviceFixture(t);
  await assert.rejects(
    new LoginService(f.store, {
      platform: "darwin",
      cliPath: path.resolve("src/cli.ts"),
      runner: f.runner,
    }).install(),
    { code: "SERVICE_DEV_CHECKOUT" },
  );
  assert.equal(fs.existsSync(f.service.file), false);
  const unsupported = new LoginService(f.store, {
    platform: "win32",
    runner: async () => assert.fail("runner called"),
  });
  assert.equal((await unsupported.status()).supported, false);
  await assert.rejects(unsupported.install(), { code: "SERVICE_UNSUPPORTED" });
  fs.mkdirSync(path.dirname(f.service.file), { recursive: true });
  fs.writeFileSync(f.service.file, "foreign plist");
  await assert.rejects(f.service.uninstall(), { code: "FOREIGN_SERVICE" });
  await assert.rejects(f.service.install(), { code: "FOREIGN_SERVICE" });
  assert.equal(fs.readFileSync(f.service.file, "utf8"), "foreign plist");
  fs.unlinkSync(f.service.file);
  fs.symlinkSync(f.cliPath, f.service.file);
  await assert.rejects(f.service.uninstall(), { code: "SYMLINK_TARGET" });
});
test("Linux user service uses injected systemctl and quotes specifiers", async (t) => {
  const f = await serviceFixture(t, "linux");
  assert.equal((await f.service.install()).login, true);
  const content = fs.readFileSync(f.service.file, "utf8");
  assert.match(content, /Restart=on-failure/);
  assert.match(content, /HARNESS_SYNC_HOME=/);
  assert.ok(
    f.calls.some(
      (c) =>
        c.command === "systemctl" &&
        c.args.join(" ") === "--user enable --now harness-sync.service",
    ),
  );
  await f.service.uninstall();
  assert.ok(!fs.existsSync(f.service.file));
  assert.ok(
    f.calls.some(
      (c) => c.args.join(" ") === "--user disable harness-sync.service",
    ),
  );
});
test("failed bootstrap restores original service file and reports AppError", async (t) => {
  const f = await serviceFixture(t);
  const service = new LoginService(f.store, {
    ...f.service.options,
    runner: async (command, args) =>
      args[0] === "bootstrap"
        ? { code: 5, stdout: "failure" }
        : f.runner(command, args),
  });
  await assert.rejects(service.install(), { code: "SERVICE_COMMAND" });
  assert.ok(!fs.existsSync(service.file));
});
test("size-based log rotation stays in the temporary store and refuses links", async (t) => {
  const { store, root } = await fixture(t);
  rotateServiceLog(store, 10);
  const log = path.join(store.root, "logs/service.log");
  fs.writeFileSync(log, "0123456789");
  const inode = fs.statSync(log).ino;
  rotateServiceLog(store, 10);
  assert.equal(fs.readFileSync(log + ".1", "utf8"), "0123456789");
  assert.equal(fs.statSync(log).ino, inode);
  assert.equal(fs.statSync(log).size, 0);
  fs.unlinkSync(log);
  fs.symlinkSync(path.join(root, "unrelated"), log);
  assert.throws(() => rotateServiceLog(store), { code: "SYMLINK_TARGET" });
});
