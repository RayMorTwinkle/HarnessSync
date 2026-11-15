import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  installInfo,
  checkSelfUpdate,
  cachedSelfUpdate,
  latestStableTag,
  compareVersions,
  upgrade,
  pruneReleases,
  type InstallInfo,
} from "../src/core/self-update.ts";
import { stopOwnedScheduler } from "../src/core/scheduler-process.ts";
import { collectNotices } from "../src/core/notices.ts";
import { UpdateChecker } from "../src/core/update-checks.ts";
import { LoginService } from "../src/core/service.ts";
import { writeJson } from "../src/core/files.ts";
import { version } from "../src/core/version.ts";
import { Store } from "../src/core/store.ts";
import { startServer } from "../src/server.ts";
import { fixture, fakeRunner, ui } from "./settings-helpers.ts";

const name = (time: string, pid = 1) => `${"a".repeat(40)}-${time}-${pid}`;
const tags = (...values: string[]) =>
  values.map((v) => `${"a".repeat(40)}\trefs/tags/${v}`).join("\n");
const remote = async () => ({
  code: 0,
  stdout: "https://example.invalid/hsync.git\n",
});
// Derived from the package version so a release bump never makes them current.
const [major, minor, patch] = version.split(".").map(Number);
const newer = `v${major}.${minor + 1}.0`;
const pinned = `v${major}.${minor}.${patch + 1}`;
const latest = async () => ({ code: 0, stdout: tags(newer, pinned) });
async function installed(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const installDir = path.join(f.home, "program with spaces");
  const release = name("20261115010000");
  const releaseDir = path.join(installDir, "releases", release);
  fs.mkdirSync(path.join(releaseDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "dist/cli.js"), "");
  fs.writeFileSync(path.join(releaseDir, "install.sh"), "must never execute");
  writeJson(path.join(releaseDir, "package.json"), { version });
  fs.writeFileSync(
    path.join(installDir, ".harness-sync-install"),
    "HarnessSync installer v1\n",
  );
  fs.symlinkSync(`releases/${release}`, path.join(installDir, "current"));
  const binDir = path.join(f.home, ".local/bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "hsync"),
    `#!/bin/sh\n# HarnessSync launcher: ${installDir}\n`,
  );
  const info: InstallInfo = {
    installDir,
    release,
    releaseDir,
    repo: "https://example.invalid/hsync.git",
    binDir,
    version,
  };
  return { ...f, info, getInfo: async () => info };
}
const idleService = () => ({
  status: async () =>
    ({ installed: false, loaded: false }) as Awaited<
      ReturnType<LoginService["status"]>
    >,
  restart: async () => {
    throw new Error("unexpected restart");
  },
});

test("stable tags compare numerically and ignore prereleases, prefixes and malformed refs", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(
    latestStableTag(
      tags("v0.9.0", "v0.10.0", "v1.0.0-beta", "2.0.0", "vv3.0.0", "v01.0.0"),
      "0.9.0",
    ),
    "v0.10.0",
  );
  assert.equal(latestStableTag(tags("v0.9.0", "v0.8.0"), "0.9.0"), undefined);
  assert.equal(
    latestStableTag(
      tags("v99999999999999999999.0.0", "v99999999999999999998.0.0"),
      "0.6.0",
    ),
    "v99999999999999999999.0.0",
  );
});
test("installInfo recognizes current and resolved releases, launcher PATH and default fallback", async (t) => {
  const f = await installed(t);
  const calls: string[][] = [];
  const options = {
    home: f.home,
    envPath: "",
    runner: async (command: string, args: string[]) => {
      assert.equal(command, "git");
      calls.push(args);
      return remote();
    },
  };
  assert.deepEqual(
    await installInfo(
      path.join(f.info.installDir, "current/dist/cli.js"),
      options,
    ),
    f.info,
  );
  assert.deepEqual(
    await installInfo(path.join(f.info.releaseDir, "dist/cli.js"), options),
    f.info,
  );
  assert.deepEqual(calls[0], [
    "-C",
    f.info.releaseDir,
    "remote",
    "get-url",
    "origin",
  ]);
  const custom = path.join(f.home, "custom-bin");
  fs.mkdirSync(custom);
  fs.copyFileSync(
    path.join(f.info.binDir!, "hsync"),
    path.join(custom, "hsync"),
  );
  assert.equal(
    (
      await installInfo(path.join(f.info.releaseDir, "dist/cli.js"), {
        ...options,
        envPath: custom,
      })
    )?.binDir,
    custom,
  );
  fs.writeFileSync(path.join(f.info.binDir!, "hsync"), "foreign");
  assert.equal(
    (await installInfo(path.join(f.info.releaseDir, "dist/cli.js"), options))
      ?.binDir,
    undefined,
  );
  assert.equal(
    await installInfo(path.resolve("src/cli.ts"), options),
    undefined,
  );
  assert.equal(
    await installInfo(path.resolve("dist/cli.js"), options),
    undefined,
  );
});
test("installInfo refuses incorrect marker, symlink ancestry and escaped current links", async (t) => {
  const f = await installed(t);
  const cli = path.join(f.info.releaseDir, "dist/cli.js");
  const options = { home: f.home, envPath: "", runner: remote };
  const marker = path.join(f.info.installDir, ".harness-sync-install");
  fs.writeFileSync(marker, "foreign");
  assert.equal(await installInfo(cli, options), undefined);
  fs.writeFileSync(marker, "HarnessSync installer v1");
  const current = path.join(f.info.installDir, "current");
  fs.unlinkSync(current);
  fs.symlinkSync(f.home, current);
  assert.equal(await installInfo(cli, options), undefined);
  fs.unlinkSync(current);
  fs.mkdirSync(current);
  assert.equal(await installInfo(cli, options), undefined);
  fs.rmdirSync(current);
  fs.symlinkSync(`releases/${f.info.release}`, current);
  const alias = path.join(f.home, "alias");
  fs.symlinkSync(f.info.installDir, alias);
  assert.equal(
    await installInfo(path.join(alias, "current/dist/cli.js"), options),
    undefined,
  );
});
test("checks cache results and failures, damaged and old-version caches are ignored; notices stay offline", async (t) => {
  const f = await installed(t);
  assert.equal(cachedSelfUpdate(f.store, version).available, false);
  let calls = 0;
  const result = await checkSelfUpdate(
    f.store,
    f.info,
    async (command, args) => {
      calls++;
      assert.equal(command, "git");
      assert.deepEqual(args, ["ls-remote", "--tags", "--refs", f.info.repo]);
      return latest();
    },
  );
  assert.equal(result.latest, newer);
  assert.equal(cachedSelfUpdate(f.store, version).available, true);
  const notice = collectNotices(f.store).find((n) => n.code === "SELF_UPDATE")!;
  assert.equal(notice.command, "hsync upgrade");
  assert.match(notice.message, /确认后运行 hsync upgrade/);
  assert.equal(calls, 1);
  assert.equal(cachedSelfUpdate(f.store, "0.7.0").available, false);
  const failed = await checkSelfUpdate(f.store, f.info, async () => {
    throw new Error("假网络失败");
  });
  assert.equal(failed.error, "假网络失败");
  assert.equal(cachedSelfUpdate(f.store, version).available, false);
  const file = path.join(f.store.root, "self-update.json");
  fs.writeFileSync(file, "broken");
  assert.deepEqual(cachedSelfUpdate(f.store, version), {
    current: version,
    available: false,
  });
  writeJson(file, { current: version, latest: newer, checkedAt: "invalid" });
  assert.equal(cachedSelfUpdate(f.store, version).available, false);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.info.releaseDir, "package.json"), file);
  assert.equal(cachedSelfUpdate(f.store, version).available, false);
  await checkSelfUpdate(f.store, f.info, latest);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.info.releaseDir, "package.json"), "utf8"),
    ).version,
    version,
  );
});
test("scheduler checks self only for installer runs and honors switch and shared interval", async (t) => {
  const f = await installed(t);
  let calls = 0;
  const start = Date.now();
  const checker = new UpdateChecker(f.store, async () => [], {
    info: f.getInfo,
    runner: async () => {
      calls++;
      return latest();
    },
  });
  await checker.tick(start);
  await checker.tick(start + 1000);
  assert.equal(calls, 1);
  await f.settings.patch({ updates: { check: false } });
  await checker.tick(start + 25 * 3600_000);
  assert.equal(calls, 1);
  await f.settings.patch({ updates: { check: true } });
  await checker.tick(start + 25 * 3600_000);
  assert.equal(calls, 2);
  await new UpdateChecker(f.store, async () => [], {
    info: async () => undefined,
    runner: async () => {
      throw new Error("must not run");
    },
  }).now();
  await checker.close();
});
test("upgrade passes exact installer args, restarts an installed loaded service only after success", async (t) => {
  const f = await installed(t);
  const events: string[] = [];
  const next = name("20261115020000");
  const obsolete = path.join(
    f.info.installDir,
    "releases",
    name("20261114000000"),
  );
  fs.mkdirSync(obsolete);
  const service = {
    status: async () => {
      events.push("status");
      return { installed: true, loaded: true } as Awaited<
        ReturnType<LoginService["status"]>
      >;
    },
    restart: async () => {
      events.push("restart");
      assert.equal(
        fs.readlinkSync(path.join(f.info.installDir, "current")),
        `releases/${next}`,
      );
      return {} as Awaited<ReturnType<LoginService["status"]>>;
    },
  };
  const result = await upgrade(f.store, {
    info: f.getInfo,
    runner: latest,
    service,
    installer: async (command, args) => {
      events.push("install");
      assert.equal(command, "bash");
      assert.deepEqual(args, [
        path.join(f.info.releaseDir, "install.sh"),
        "--ref",
        newer,
        "--install-dir",
        f.info.installDir,
        "--bin-dir",
        f.info.binDir,
        "--repo",
        f.info.repo,
      ]);
      fs.mkdirSync(path.join(f.info.installDir, "releases", next));
      fs.unlinkSync(path.join(f.info.installDir, "current"));
      fs.symlinkSync(
        `releases/${next}`,
        path.join(f.info.installDir, "current"),
      );
      return 0;
    },
  });
  assert.deepEqual(events, ["install", "status", "restart"]);
  assert.equal(result.restarted, "login");
  assert.equal(result.removed, 1);
  assert.ok(fs.existsSync(f.info.releaseDir));
  assert.equal(fs.existsSync(obsolete), false);
  events.length = 0;
  const failed = await upgrade(f.store, {
    info: f.getInfo,
    ref: pinned,
    service,
    installer: async () => {
      events.push("install");
      return 23;
    },
  });
  assert.equal(failed.code, 23);
  assert.deepEqual(events, ["install"]);
});
test("successful install reports restart failure explicitly and leaves all releases intact", async (t) => {
  const f = await installed(t);
  const old = path.join(f.info.installDir, "releases", name("20261114000000"));
  fs.mkdirSync(old);
  await assert.rejects(
    upgrade(f.store, {
      info: f.getInfo,
      ref: pinned,
      installer: async () => 0,
      service: {
        ...idleService(),
        status: async () => {
          throw new Error("假服务失败");
        },
      },
    }),
    new RegExp(`已安装 ${pinned}，但服务重启未完成`),
  );
  assert.ok(fs.existsSync(old));
});
test("check, current version, invalid refs and source runs never install or restart", async (t) => {
  const f = await installed(t);
  const installer = async () => {
    throw new Error("must not install");
  };
  const options = { info: f.getInfo, installer, service: idleService() };
  const checked = await upgrade(f.store, {
    ...options,
    check: true,
    runner: latest,
  });
  assert.ok("available" in checked && checked.available);
  const current = await upgrade(f.store, {
    ...options,
    runner: async () => ({ code: 0, stdout: tags(`v${version}`) }),
  });
  assert.equal(current.code, 0);
  assert.match(current.message!, /已是最新/);
  assert.equal(
    (await upgrade(f.store, { ...options, ref: `v${version}` })).code,
    0,
  );
  await assert.rejects(upgrade(f.store, { ...options, ref: "--evil" }), {
    code: "UPGRADE_REF",
  });
  await assert.rejects(
    upgrade(f.store, { ...options, info: async () => undefined }),
    /当前从源码运行，请用 git pull 更新/,
  );
  await assert.rejects(
    upgrade(f.store, {
      ...options,
      runner: async () => {
        throw new Error("offline");
      },
    }),
    { code: "SELF_UPDATE_CHECK" },
  );
  assert.equal(
    (
      await upgrade(f.store, {
        ...options,
        check: true,
        runner: async () => {
          throw new Error("offline");
        },
      })
    ).code,
    1,
  );
});
test("upgrade stops verified scheduler and starts the stable launcher with custom root", async (t) => {
  const f = await installed(t);
  const owner = path.join(f.store.root, "scheduler-owner.json");
  writeJson(owner, { pid: 987654, startTime: "test:start" });
  let alive = true;
  const events: string[] = [];
  const options = {
    info: f.getInfo,
    ref: pinned,
    installer: async () => 0,
    service: idleService(),
    scheduler: {
      startTime: async () => (alive ? "test:start" : null),
      kill: (pid: number) => {
        assert.equal(pid, 987654);
        events.push("stop");
        alive = false;
      },
      wait: async () => {},
    },
    start: async (command: string, args: string[]) => {
      events.push("start");
      assert.equal(command, path.join(f.info.binDir!, "hsync"));
      assert.deepEqual(args, ["serve", "--background", "--root", f.store.root]);
    },
  };
  assert.equal((await upgrade(f.store, options)).restarted, "background");
  assert.deepEqual(events, ["stop", "start"]);
  assert.equal(fs.existsSync(owner), false);
  events.length = 0;
  assert.equal((await upgrade(f.store, options)).restarted, "none");
  assert.deepEqual(events, []);
  writeJson(owner, { pid: 987654, startTime: "test:old" });
  assert.equal(
    (
      await upgrade(f.store, {
        ...options,
        scheduler: {
          ...options.scheduler,
          startTime: async () => "test:reused",
        },
      })
    ).restarted,
    "none",
  );
});
test("scheduler refuses unverified live, malformed and unresponsive owners", async (t) => {
  const f = await installed(t);
  const owner = path.join(f.store.root, "scheduler-owner.json");
  writeJson(owner, { pid: 987654, startTime: "test:start" });
  await assert.rejects(
    stopOwnedScheduler(f.store, {
      startTime: async () => null,
      alive: () => true,
    }),
    { code: "SCHEDULER_IDENTITY" },
  );
  await assert.rejects(
    stopOwnedScheduler(f.store, {
      startTime: async () => "test:start",
      kill: () => {},
      wait: async () => {},
    }),
    { code: "SCHEDULER_RUNNING" },
  );
  assert.equal(
    await stopOwnedScheduler(f.store, {
      startTime: async () => null,
      alive: () => false,
    }),
    false,
  );
  writeJson(owner, { pid: -1, startTime: "test:start" });
  await assert.rejects(stopOwnedScheduler(f.store), {
    code: "SCHEDULER_IDENTITY",
  });
});
test("default-root background restart omits --root and missing launcher refuses installation", async (t) => {
  const f = await installed(t);
  const store = await new Store(
    path.join(f.home, ".harness-sync"),
    f.home,
  ).init();
  writeJson(path.join(store.root, "scheduler-owner.json"), {
    pid: 987654,
    startTime: "test:start",
  });
  let alive = true;
  const options = {
    info: f.getInfo,
    ref: pinned,
    installer: async () => 0,
    service: idleService(),
    scheduler: {
      startTime: async () => (alive ? "test:start" : null),
      kill: () => {
        alive = false;
      },
    },
    start: async (_command: string, args: string[]) => {
      assert.deepEqual(args, ["serve", "--background"]);
    },
  };
  assert.equal((await upgrade(store, options)).restarted, "background");
  await assert.rejects(
    upgrade(store, {
      ...options,
      info: async () => ({ ...f.info, binDir: undefined }),
      installer: async () => {
        throw new Error("must not install");
      },
    }),
    { code: "LAUNCHER_NOT_FOUND" },
  );
});
test("cleanup sorts timestamps, keeps current and previous, leaves foreign names/files/symlinks alone", async (t) => {
  const f = await installed(t);
  const releases = path.join(f.info.installDir, "releases");
  const previous = name("20261114010000");
  const oldest = `${"b".repeat(40)}-20261113010000-1`;
  for (const entry of [previous, oldest, "foreign", "a-20261112010000-1"])
    fs.mkdirSync(path.join(releases, entry));
  fs.writeFileSync(path.join(releases, name("20261112010000")), "file");
  fs.symlinkSync(f.home, path.join(releases, name("20261111010000")));
  assert.equal(pruneReleases(f.info.installDir), 1);
  assert.ok(fs.existsSync(path.join(releases, previous)));
  assert.ok(fs.existsSync(f.info.releaseDir));
  assert.equal(fs.existsSync(path.join(releases, oldest)), false);
  assert.ok(fs.existsSync(path.join(releases, "foreign")));
  assert.ok(
    fs.lstatSync(path.join(releases, name("20261111010000"))).isSymbolicLink(),
  );
});
for (const platform of ["darwin", "linux"])
  test(`${platform} login restart uses injected OS runner`, async (t) => {
    const f = await installed(t);
    const fake = fakeRunner();
    const service = new LoginService(f.store, {
      platform,
      runner: fake.runner,
      cliPath: path.join(f.info.installDir, "current/dist/cli.js"),
    });
    await service.install();
    fake.calls.length = 0;
    await service.restart();
    assert.ok(
      fake.calls.some((c) =>
        platform === "darwin"
          ? c.args[0] === "kickstart" && c.args[1] === "-k"
          : c.args.join(" ") === "--user restart harness-sync.service",
      ),
    );
    fake.setLoaded(false);
    fake.calls.length = 0;
    await service.restart();
    assert.ok(
      !fake.calls.some(
        (c) => c.args.includes("kickstart") || c.args.includes("restart"),
      ),
    );
  });
test("self-update API authenticates requests, GET is cache-only, check uses fake network, no upgrade route", async (t) => {
  const f = await installed(t);
  let calls = 0;
  const server = await startServer(f.store, {
    port: 0,
    uiDirectory: ui(f.root),
    service: { platform: "test-unsupported" },
    updateChecker: new UpdateChecker(f.store, async () => [], {
      info: async () => undefined,
    }),
    selfUpdate: {
      info: f.getInfo,
      runner: async () => {
        calls++;
        return latest();
      },
    },
  });
  f.defer(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${server.url}/api/self-update`)).status, 403);
  const get = () => fetch(`${server.url}/api/self-update`, { headers });
  assert.equal((await (await get()).json()).data.installed, true);
  assert.equal(calls, 0);
  assert.equal(
    (
      await fetch(`${server.url}/api/self-update/check`, {
        method: "POST",
        headers: { ...headers, origin: "https://evil.invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
  const result = await (
    await fetch(`${server.url}/api/self-update/check`, {
      method: "POST",
      headers,
      body: "{}",
    })
  ).json();
  assert.equal(result.data.latest, newer);
  assert.equal(result.data.available, true);
  assert.equal(calls, 1);
  assert.equal((await (await get()).json()).data.available, true);
  assert.equal(calls, 1);
  assert.equal(
    (
      await fetch(`${server.url}/api/self-update/upgrade`, {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    404,
  );
});
test("CLI version shares package source; source upgrade reports Chinese error and accepts trailing --json", async (t) => {
  const f = await installed(t);
  const env = {
    ...process.env,
    HOME: f.home,
    HARNESS_SYNC_HOME: f.store.root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env,
      encoding: "utf8",
    });
  assert.equal(run("--version").stdout.trim(), version);
  const result = run("upgrade", "--json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /当前从源码运行，请用 git pull 更新/);
});
