import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSync,
  type SyncCheckRunner,
  type SyncCheckResult,
} from "../src/core/sync-check.ts";
import { Store } from "../src/core/store.ts";
import { Sync } from "../src/core/sync.ts";
import { AppError } from "../src/core/files.ts";
import { createOnboarding } from "../src/core/onboarding.ts";
import { redactSyncOutput } from "../src/core/sync-remote.ts";
import { startServer } from "../src/server.ts";

const url = "https://github.com/alice/config.git";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "") => ({ code: 1, stdout: "", stderr });
const authText = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: ghp_DO_NOT_EXPOSE
  - Token scopes: 'gist', 'repo', 'read:org'`;
type Reply = ReturnType<typeof ok>;
function fake(overrides: Record<string, Reply | Error> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const runner: SyncCheckRunner = async (command, args, options) => {
    calls.push({ command, args });
    assert.equal(options.timeout, 15_000);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.GIT_ASKPASS, "/usr/bin/false");
    assert.equal(options.env.GH_PROMPT_DISABLED, "1");
    assert.equal(options.env.GCM_INTERACTIVE, "Never");
    assert.equal(options.env.SSH_ASKPASS_REQUIRE, "never");
    assert.equal(options.env.SSH_ASKPASS, "/usr/bin/false");
    assert.match(options.env.GIT_SSH_COMMAND!, /BatchMode=yes/);
    const key = `${command} ${args.join(" ")}`;
    const reply = overrides[key];
    if (reply instanceof Error) throw reply;
    if (reply) return reply;
    if (key === "git --version")
      return ok("git version 2.49.0 (Apple Git-154)");
    if (key === "gh --version") return ok("gh version 2.74.0 (2025-05-20)");
    if (key === "brew --version") return ok("Homebrew 4.5.0");
    if (key === "gh auth status --hostname github.com") return ok(authText);
    if (key === "gh api user --hostname github.com --jq .login")
      return ok("alice\n");
    if (key === "gh config get git_protocol --host github.com")
      return ok("https");
    if (
      key === "gh api repos/alice/harness-sync-config --hostname github.com" ||
      key === "gh api repos/alice/custom --hostname github.com"
    )
      return fail("gh: Not Found (HTTP 404)");
    if (
      key ===
      "gh api repos/alice/config --hostname github.com --jq .permissions.push"
    )
      return ok("true\n");
    if (command === "git" && args.includes("ls-remote")) return ok();
    if (command === "ssh")
      return fail(
        "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.",
      );
    assert.fail(`Unexpected command: ${key}`);
  };
  return { runner, calls };
}
const row = (result: SyncCheckResult, id: string) =>
  result.checks.find((check) => check.id === id)!;

test("HTTPS checks run in order, borrow gh without global configuration and never return tokens", async () => {
  const f = fake();
  const result = await checkSync({ url }, f);
  assert.equal(result.ready, true);
  assert.equal(result.recommended, "url");
  assert.deepEqual(
    result.checks.map((c) => [c.id, c.status]),
    [
      ["git", "ok"],
      ["gh", "ok"],
      ["gh-auth", "ok"],
      ["gh-scopes", "ok"],
      ["repository", "ok"],
      ["push", "ok"],
      ["ssh", "skip"],
    ],
  );
  assert.match(row(result, "git").detail, /2\.49\.0/);
  assert.match(row(result, "gh-auth").detail, /alice.*https/);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_EXPOSE"));
  assert.deepEqual(f.calls.find((c) => c.args.includes("ls-remote"))?.args, [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "ls-remote",
    "--",
    url,
  ]);
  assert.ok(
    !f.calls.some(
      (c) => c.args.includes("--global") || c.args.includes("create"),
    ),
  );
});

test("missing Git fails with macOS installation command and skips reading", async () => {
  const result = await checkSync(
    { url },
    { ...fake({ "git --version": new Error("ENOENT") }), platform: "darwin" },
  );
  assert.equal(result.ready, false);
  assert.equal(result.recommended, null);
  assert.equal(row(result, "git").status, "fail");
  assert.match(row(result, "git").fix!, /xcode-select --install/);
  assert.equal(row(result, "repository").status, "skip");
});

test("version output uses only numeric versions, never helper diagnostics or token suffixes", async () => {
  const result = await checkSync(
    { url },
    fake({
      "git --version": ok("git version 2.49.0-ghp_SECRET\nToken: SECRET"),
      "gh --version": ok("gh version 2.74.0\nToken: SECRET"),
    }),
  );
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

for (const brew of [true, false])
  test(`missing gh allows existing URL and skips push; Homebrew=${brew}`, async () => {
    const f = fake({
      "gh --version": new Error("ENOENT ghp_SECRET"),
      "brew --version": brew ? ok() : fail(),
    });
    const result = await checkSync({ url }, { ...f, platform: "darwin" });
    assert.equal(result.ready, true);
    assert.equal(row(result, "gh").status, "warn");
    assert.match(
      row(result, "gh").fix!,
      brew ? /brew install gh/ : /https:\/\/cli.github.com/,
    );
    assert.equal(row(result, "gh-auth").status, "skip");
    assert.equal(row(result, "gh-scopes").status, "skip");
    assert.equal(row(result, "push").status, "skip");
    assert.match(row(result, "push").detail, /首次同步/);
    assert.deepEqual(f.calls.find((c) => c.args.includes("ls-remote"))?.args, [
      "ls-remote",
      "--",
      url,
    ]);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    const create = await checkSync(
      { create: true },
      { ...f, platform: "darwin" },
    );
    assert.equal(create.ready, false);
    assert.equal(row(create, "gh").status, "fail");
  });

test("logged out gh warns for URL, fails for creation and explains user browser login", async () => {
  const f = fake({
    "gh auth status --hostname github.com": fail("token: ghp_SECRET"),
  });
  const result = await checkSync({ create: true }, f);
  assert.equal(result.ready, false);
  assert.equal(row(result, "gh-auth").status, "fail");
  assert.match(row(result, "gh-auth").fix!, /终端运行 gh auth login.*浏览器/);
  assert.match(row(result, "gh-auth").fix!, /! gh auth login/);
  assert.equal(row(result, "repository").status, "skip");
  assert.equal(row(await checkSync({ url }, f), "gh-auth").status, "warn");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("missing repo scope blocks creation but does not block connecting an existing repository", async () => {
  const f = fake({
    "gh auth status --hostname github.com": ok(
      authText.replace("'gist', 'repo', 'read:org'", "'public_repo'"),
    ),
  });
  const result = await checkSync({ create: true }, f);
  assert.equal(result.ready, false);
  assert.equal(row(result, "gh-scopes").status, "fail");
  assert.match(
    row(result, "gh-scopes").fix!,
    /gh auth refresh -h github.com -s repo/,
  );
  const connected = await checkSync({ url }, f);
  assert.equal(connected.ready, true);
  assert.equal(row(connected, "gh-scopes").status, "warn");
});

test("unreadable scopes warn; active account scopes are selected instead of inactive account", async () => {
  const inactive = authText.replace(
    "Active account: true",
    "Active account: false",
  );
  const active = authText.replace("'gist', 'repo', 'read:org'", "'gist'");
  const f = fake({
    "gh auth status --hostname github.com": {
      code: 0,
      stdout: "",
      stderr: `${inactive}\n${active}`,
    },
  });
  assert.equal(
    row(await checkSync({ create: true }, f), "gh-scopes").status,
    "fail",
  );
  const hidden = fake({
    "gh auth status --hostname github.com": ok(
      authText.replace(/.*Token scopes:.*/, ""),
    ),
  });
  const result = await checkSync({ create: true }, hidden);
  assert.equal(row(result, "gh-scopes").status, "warn");
  assert.equal(result.ready, true);
});

test("creation uses default or custom name, treats only HTTP 404 as available and recommends URL if existing", async () => {
  const f = fake();
  for (const create of [true, "custom"]) {
    const result = await checkSync({ create }, f);
    assert.equal(result.ready, true);
    assert.equal(result.recommended, "create");
    assert.equal(row(result, "repository").status, "ok");
  }
  const existing = await checkSync(
    { create: true },
    fake({
      "gh api repos/alice/harness-sync-config --hostname github.com":
        ok('{"token":"SECRET"}'),
    }),
  );
  assert.equal(existing.ready, false);
  assert.equal(existing.recommended, "url");
  assert.equal(row(existing, "repository").status, "fail");
  assert.match(
    row(existing, "repository").fix!,
    /sync setup --url https:\/\/github.com\/alice\/harness-sync-config.git/,
  );
  assert.ok(!JSON.stringify(existing).includes("SECRET"));
  const unknown = await checkSync(
    { create: true },
    fake({
      "gh api repos/alice/harness-sync-config --hostname github.com": fail(
        "network unavailable",
      ),
    }),
  );
  assert.equal(row(unknown, "repository").status, "fail");
  assert.equal(unknown.ready, false);
});

test("unreadable account cannot declare creation ready or construct an unsafe path", async () => {
  const result = await checkSync(
    { create: true },
    fake({ "gh api user --hostname github.com --jq .login": ok("ghp_SECRET") }),
  );
  assert.equal(result.ready, false);
  assert.equal(row(result, "repository").status, "skip");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("ls-remote failure, timeout and permission rejection never return raw diagnostics", async () => {
  const f = fake();
  const gitArgs =
    "git -c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential ls-remote -- " +
    url;
  for (const failure of [
    fail("fatal: https://SECRET@github.com token ghp_SECRET"),
    new Error("ETIMEDOUT SECRET"),
  ]) {
    const result = await checkSync({ url }, fake({ [gitArgs]: failure }));
    assert.equal(result.ready, false);
    assert.equal(row(result, "repository").status, "fail");
    assert.match(row(result, "repository").fix!, /凭证助手/);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
  assert.equal((await checkSync({ url }, f)).ready, true);
});

test("push false fails and unknown permission warns", async () => {
  const key =
    "gh api repos/alice/config --hostname github.com --jq .permissions.push";
  const denied = await checkSync({ url }, fake({ [key]: ok("false") }));
  assert.equal(denied.ready, false);
  assert.equal(row(denied, "push").status, "fail");
  assert.match(row(denied, "push").fix!, /写入权限/);
  for (const response of [ok("null"), fail("token SECRET")]) {
    const unknown = await checkSync({ url }, fake({ [key]: response }));
    assert.equal(row(unknown, "push").status, "warn");
    assert.equal(unknown.ready, true);
  }
});

for (const sshUrl of [
  "git@github.com:alice/config.git",
  "ssh://git@github.com/alice/config.git",
])
  test(`GitHub SSH succeeds with exit code 1: ${sshUrl}`, async () => {
    const f = fake();
    const result = await checkSync({ url: sshUrl }, f);
    assert.equal(result.ready, true);
    assert.equal(row(result, "ssh").status, "ok");
    assert.equal(row(result, "push").status, "ok");
    assert.deepEqual(f.calls.at(-1), {
      command: "ssh",
      args: ["-T", "-oBatchMode=yes", "-oConnectTimeout=10", "git@github.com"],
    });
  });

test("GitHub SSH needs success message AND exit code 1, failure gives key and HTTPS advice", async () => {
  const key = "ssh -T -oBatchMode=yes -oConnectTimeout=10 git@github.com";
  for (const response of [
    fail("Permission denied (publickey) token SECRET"),
    ok("successfully authenticated"),
    { code: 255, stdout: "successfully authenticated", stderr: "" },
    new Error("timeout SECRET"),
  ]) {
    const result = await checkSync(
      { url: "git@github.com:alice/config.git" },
      fake({ [key]: response }),
    );
    assert.equal(result.ready, false);
    assert.equal(row(result, "ssh").status, "fail");
    assert.match(row(result, "ssh").fix!, /SSH.*HTTPS/);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

test("SSH URL with an explicit port still checks GitHub push permissions", async () => {
  const f = fake();
  const result = await checkSync(
    { url: "ssh://git@github.com:22/alice/config.git" },
    f,
  );
  assert.equal(row(result, "push").status, "ok");
  assert.equal(row(result, "ssh").status, "ok");
  assert.deepEqual(f.calls.at(-1)?.args, [
    "-T",
    "-oBatchMode=yes",
    "-oConnectTimeout=10",
    "-p",
    "22",
    "git@github.com",
  ]);
});

test("non-GitHub URL skips push; environment-only check gives a recommendation", async () => {
  const f = fake();
  const result = await checkSync({ url: "https://example.org/config.git" }, f);
  assert.equal(result.ready, true);
  assert.equal(row(result, "push").status, "skip");
  assert.ok(!f.calls.some((c) => c.args.includes(".permissions.push")));
  assert.equal((await checkSync({}, fake())).recommended, "create");
  const missing = await checkSync({}, fake({ "gh --version": fail() }));
  assert.equal(missing.ready, false);
  assert.equal(missing.recommended, "url");
});

test("invalid input and embedded credentials are rejected before running any command", async () => {
  const runner: SyncCheckRunner = async () =>
    assert.fail("must not run commands");
  for (const input of [
    { url, create: true },
    { create: "-bad/name" },
    { url: "https://SECRET@github.com/alice/config" },
    { url: "HTTPS://SECRET@github.com/alice/config" },
    { url: "ssh://git:SECRET@github.com/alice/config" },
    { url: url + "?token=SECRET" },
    { url: "-bad" },
    { url: "bad\nurl" },
    { url: "" },
  ]) {
    await assert.rejects(
      checkSync(input, { runner }),
      (error: Error) => !error.message.includes("SECRET"),
    );
  }
});

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-check-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  return { dir, store: await new Store(path.join(dir, "store"), home).init() };
}

test("API check requires session token and valid origin; query options use the injected runner", async (t) => {
  const { dir, store } = await fixture(t);
  const uiDirectory = path.join(dir, "ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(path.join(uiDirectory, "index.html"), "<!--HSYNC_TOKEN-->");
  const f = fake();
  const server = await startServer(store, {
    port: 0,
    uiDirectory,
    syncCheck: f,
  });
  t.after(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const endpoint = `${server.url}/api/sync/check`;
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal(f.calls.length, 0);
  const headers = { "x-harness-sync-token": token };
  assert.equal(
    (
      await fetch(endpoint, {
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
  for (const query of [
    `url=${encodeURIComponent(url)}`,
    "create=true",
    "create=custom",
    "create=",
  ]) {
    const response = await fetch(`${endpoint}?${query}`, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      data: SyncCheckResult;
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.ready, true);
    assert.equal(body.data.checks.length, 7);
  }
  assert.equal(
    (
      await fetch(`${endpoint}?url=${encodeURIComponent(url)}&create=true`, {
        headers,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        `${endpoint}?url=${encodeURIComponent("https://SECRET@github.com/alice/config")}`,
        { headers },
      )
    ).status,
    400,
  );
  assert.equal(fs.existsSync(path.join(store.root, "sync.json")), false);
});

test("setup failures preserve AppError codes and point to sync check", async (t) => {
  const { store } = await fixture(t);
  const sync = new Sync(store);
  await assert.rejects(
    sync.setup({}),
    (error: AppError) =>
      error.code === "SYNC_OPTIONS" &&
      /运行 hsync sync check 查看缺少什么/.test(error.message),
  );
  await assert.rejects(
    sync.setup({ url: "https://SECRET@github.com/alice/config" }),
    /sync check/,
  );
  // Replace the existing command seam: no real gh or network command runs.
  const commands = sync as unknown as {
    command: (command: string, args: string[]) => string;
  };
  commands.command = () => {
    throw new AppError("SYNC_GIT", "认证失败", 409);
  };
  await assert.rejects(
    sync.setup({ url: "https://example.org/config.git" }),
    (error: AppError) =>
      error.code === "SYNC_GIT" &&
      error.status === 409 &&
      /sync check/.test(error.message),
  );
  commands.command = () => {
    throw new Error("无法访问本机配置库");
  };
  await assert.rejects(
    sync.setup({ url: "https://example.org/config.git" }),
    (error: AppError) =>
      error.code === "SYNC_SETUP" &&
      /无法访问本机配置库.*sync check/.test(error.message),
  );
});

test("onboarding sync instructions require preflight and personal login without touching backup text", async (t) => {
  const { store } = await fixture(t);
  const { prompt } = await createOnboarding(store);
  for (const text of [
    "先运行 sync check --url <url>",
    "hsync sync check --create [name]",
    "用一两句话",
    "用户本人在终端",
    "! gh auth login",
    "不得向用户索要 token、密码或私钥",
    "指令正文或 URL",
  ])
    assert.ok(prompt.includes(text), text);
});

test("existing sync diagnostic redaction strips token lines, GitHub tokens and URL credentials", () => {
  const text = redactSyncOutput(
    "Token: SECRET\nAuthorization: Bearer SECRET\nfatal: ghp_SECRET github_pat_SECRET https://SECRET@example.org/repo\nToken scopes: repo",
  );
  assert.ok(!text.includes("SECRET"));
  assert.match(text, /fatal/);
});
