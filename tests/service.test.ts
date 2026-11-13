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
import { harnessEnvironmentVariables } from "../src/core/harness-registry.ts";

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

for (const platform of ["darwin", "linux"]) {
  test(`${platform} service captures only set native-path overrides, round trips escaping and detects shell drift`, async (t) => {
    const f = await serviceFixture(t, platform);
    const plugin = JSON.parse(
      fs.readFileSync("tests/fixtures/harnesses/acme.json", "utf8"),
    );
    plugin.root.default = "{env:ACME_BASE|~/.acme}";
    plugin.detect.push("{env:ACME_DETECT|~/.acme}");
    plugin.instructions.global[0].path =
      "{env:ACME_INSTRUCTIONS|~/.acme}/ACME.md";
    plugin.instructions.fragments = ["{env:ACME_FRAGMENTS|~/.acme}/**/*.md"];
    plugin.skills.global = "{env:ACME_SKILLS|~/.acme}/skills";
    plugin.skills.reads.global = [
      plugin.skills.global,
      { path: "{env:ACME_READS|~/.shared}/skills" },
    ];
    const dir = path.join(f.store.root, "harnesses");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "acme.json"), JSON.stringify(plugin));
    const names = harnessEnvironmentVariables(f.home, f.store.root);
    for (const name of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "DSH_HOME",
      "DSH_AGENTS_HOME",
      "XDG_CONFIG_HOME",
      "ACME_HOME",
      "ACME_BASE",
      "ACME_DETECT",
      "ACME_INSTRUCTIONS",
      "ACME_FRAGMENTS",
      "ACME_SKILLS",
      "ACME_READS",
    ])
      assert.ok(names.includes(name), name);
    const environment = Object.fromEntries(
      [...names, "HSYNC_UNRELATED_TEST"].map((name) => [
        name,
        process.env[name],
      ]),
    );
    t.after(() => {
      for (const name of [...names, "HSYNC_UNRELATED_TEST"]) {
        if (environment[name] === undefined) delete process.env[name];
        else process.env[name] = environment[name];
      }
    });
    const value = `${f.root}/space & < > " ' \\ %n $HOME\nnext\tline\r`;
    for (const name of names) process.env[name] = value;
    process.env.ACME_READS = "";
    delete process.env.ACME_DETECT;
    process.env.HSYNC_UNRELATED_TEST = "unrelated-test-value";
    const status = await f.service.install();
    assert.ok("environment" in status);
    for (const name of names)
      assert.equal(status.environment![name], process.env[name], name);
    assert.equal(Object.hasOwn(status.environment!, "ACME_READS"), true);
    assert.equal(Object.hasOwn(status.environment!, "ACME_DETECT"), false);
    assert.ok(
      !fs.readFileSync(f.service.file, "utf8").includes("unrelated-test-value"),
    );
    assert.deepEqual(status.overrideDifferences, []);
    process.env.ACME_HOME = "changed";
    delete process.env.CODEX_HOME;
    process.env.ACME_DETECT = "newly-set";
    const changed = await f.service.status();
    assert.deepEqual(changed.overrideDifferences?.sort(), [
      "ACME_DETECT",
      "ACME_HOME",
      "CODEX_HOME",
    ]);
    assert.match(changed.warnings!.join(""), /重新安装/);
    assert.equal((await f.service.install()).warnings!.length, 0);
  });

  for (const operation of ["install", "uninstall"] as const) {
    for (const moment of ["status", "stop"] as const) {
      test(`${platform} ${operation} preserves owned-content replacement during ${moment}`, async (t) => {
        const f = await serviceFixture(t, platform);
        await f.service.install();
        const replacement =
          fs.readFileSync(f.service.file, "utf8") + "\n# another writer\n";
        let replaced = false;
        const service = new LoginService(f.store, {
          ...f.service.options,
          envPath: "/changed",
          runner: async (command, args) => {
            const trigger =
              moment === "status"
                ? args.includes(platform === "darwin" ? "print" : "is-enabled")
                : args.includes(
                    platform === "darwin"
                      ? "bootout"
                      : operation === "install"
                        ? "stop"
                        : "disable",
                  );
            if (!replaced && trigger) {
              replaced = true;
              fs.writeFileSync(f.service.file, replacement);
            }
            return f.runner(command, args);
          },
        });
        if (
          platform === "darwin" &&
          operation === "uninstall" &&
          moment === "stop"
        )
          await service.uninstall();
        else
          await assert.rejects(service[operation](), {
            code: "SERVICE_CHANGED",
          });
        assert.equal(replaced, true);
        assert.equal(fs.readFileSync(service.file, "utf8"), replacement);
      });
    }
    test(`${platform} failed ${operation} recovery preserves another writer's replacement`, async (t) => {
      const f = await serviceFixture(t, platform);
      await f.service.install();
      const replacement =
        fs.readFileSync(f.service.file, "utf8") + "\n# replacement\n";
      const service = new LoginService(f.store, {
        ...f.service.options,
        envPath: "/changed",
        runner: async (command, args) => {
          if (
            args.includes(
              operation === "install"
                ? platform === "darwin"
                  ? "bootstrap"
                  : "enable"
                : platform === "darwin"
                  ? "bootout"
                  : "stop",
            )
          ) {
            fs.writeFileSync(f.service.file, replacement);
            return { code: 5, stdout: "failure" };
          }
          return f.runner(command, args);
        },
      });
      await assert.rejects(service[operation](), { code: "SERVICE_COMMAND" });
      assert.equal(fs.readFileSync(service.file, "utf8"), replacement);
    });
  }
  test(`${platform} recovery rejects replaced symlink ancestry`, async (t) => {
    const f = await serviceFixture(t, platform);
    const dir = path.dirname(f.service.file);
    const external = path.join(f.root, "external-service-dir");
    fs.mkdirSync(external);
    const target = path.join(external, path.basename(f.service.file));
    fs.writeFileSync(target, "external");
    const service = new LoginService(f.store, {
      ...f.service.options,
      runner: async (command, args) => {
        if (args.includes(platform === "darwin" ? "bootstrap" : "enable")) {
          fs.renameSync(dir, dir + ".saved");
          fs.symlinkSync(external, dir);
          return { code: 5, stdout: "failure" };
        }
        return f.runner(command, args);
      },
    });
    await assert.rejects(service.install(), { code: "SERVICE_COMMAND" });
    assert.equal(fs.readFileSync(target, "utf8"), "external");
  });
  test(`${platform} install refuses symlink ancestry introduced while stopping`, async (t) => {
    const f = await serviceFixture(t, platform);
    await f.service.install();
    const dir = path.dirname(f.service.file);
    const external = path.join(f.root, "external-before-write");
    fs.mkdirSync(external);
    const target = path.join(external, path.basename(f.service.file));
    fs.copyFileSync(f.service.file, target);
    const original = fs.readFileSync(target, "utf8");
    const service = new LoginService(f.store, {
      ...f.service.options,
      envPath: "/changed",
      runner: async (command, args) => {
        if (args.includes(platform === "darwin" ? "bootout" : "stop")) {
          fs.renameSync(dir, dir + ".saved");
          fs.symlinkSync(external, dir);
        }
        return f.runner(command, args);
      },
    });
    await assert.rejects(service.install(), { code: "SYMLINK_TARGET" });
    assert.equal(fs.readFileSync(target, "utf8"), original);
  });
  test(`${platform} recovery does not touch an identical replacement inode`, async (t) => {
    const f = await serviceFixture(t, platform);
    await f.service.install();
    const service = new LoginService(f.store, {
      ...f.service.options,
      envPath: "/changed",
      runner: async (command, args) => {
        if (args.includes(platform === "darwin" ? "bootstrap" : "enable")) {
          fs.copyFileSync(f.service.file, f.service.file + ".replacement");
          fs.renameSync(f.service.file + ".replacement", f.service.file);
          return { code: 5, stdout: "failure" };
        }
        return f.runner(command, args);
      },
    });
    await assert.rejects(service.install(), { code: "SERVICE_COMMAND" });
    assert.ok(fs.readFileSync(service.file, "utf8").includes("/changed"));
  });
  test(`${platform} failed update restores an unchanged previous service`, async (t) => {
    const f = await serviceFixture(t, platform);
    await f.service.install();
    const original = fs.readFileSync(f.service.file, "utf8");
    let failed = false;
    const service = new LoginService(f.store, {
      ...f.service.options,
      envPath: "/changed",
      runner: async (command, args) => {
        if (
          !failed &&
          args.includes(platform === "darwin" ? "bootstrap" : "enable")
        ) {
          failed = true;
          return { code: 5, stdout: "failure" };
        }
        return f.runner(command, args);
      },
    });
    await assert.rejects(service.install(), { code: "SERVICE_COMMAND" });
    assert.equal(fs.readFileSync(service.file, "utf8"), original);
    assert.equal((await f.service.status()).login, true);
  });
}
