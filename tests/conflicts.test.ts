import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import {
  hash,
  parseSkill,
  skillMarkdown,
  writeJson,
} from "../src/core/files.ts";
import { readNative } from "../src/core/native-snapshot.ts";
import { startServer } from "../src/server.ts";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-conflict-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  const skill = await store.saveSkill({
    name: "sample",
    description: "库说明",
    body: "库正文",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  const engine = new Engine(store);
  const target = engine
    .plan()
    .changes.find((c) => c.sourceId === skill.id)!.path;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "SKILL.md"),
    skillMarkdown("sample", "原生说明", "原生正文"),
  );
  fs.writeFileSync(path.join(target, "run"), Buffer.from([0, 255, 9]), {
    mode: 0o751,
  });
  fs.mkdirSync(path.join(target, ".git", "empty"), { recursive: true });
  fs.chmodSync(target, 0o750);
  return { dir, store, engine, target, skill };
}

test("replace 完整快照、差异与 rollback 字节和权限恢复", async (t) => {
  const { engine, target, store } = await fixture(t);
  const before = readNative(target);
  const c = engine.conflicts()[0];
  assert.equal(c.status, "conflict");
  assert.match(c.diff, /原生正文/);
  assert.equal(c.fileChanges!.find((x) => x.path === "run")!.binary, true);
  const old = engine.plan().id;
  await engine.chooseConflict(target, "library");
  assert.equal(engine.plan().changes[0].status, "replace");
  await assert.rejects(engine.apply(old), { code: "STALE_PLAN" });
  const result = await engine.apply(engine.plan().id);
  assert.equal(store.state().receipts.length, 1);
  await engine.rollback(result.id!);
  assert.deepEqual(readNative(target), before);
});

test("选择失效、skip 隔离、并发选择与过期计划", async (t) => {
  const { engine, target, store } = await fixture(t);
  await store.saveSkill({
    name: "other",
    description: "其他",
    body: "其他",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  const selected = engine.conflicts()[0];
  await engine.chooseConflict(target, "skip", selected.conflictFingerprint);
  const plan = engine.plan();
  assert.equal(plan.changes.find((c) => c.path === target)!.status, "skipped");
  const before = readNative(target);
  await engine.apply(plan.id);
  assert.deepEqual(readNative(target), before);
  fs.writeFileSync(path.join(target, "run"), "新修改");
  assert.equal(engine.conflicts()[0].status, "conflict");
  await assert.rejects(
    engine.chooseConflict(target, "library", selected.conflictFingerprint),
    { code: "STALE_TARGET" },
  );
  const results = await Promise.allSettled([
    engine.chooseConflict(target, "skip"),
    engine.chooseConflict(target, "library"),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.ok(["skipped", "replace"].includes(engine.conflicts()[0].status));
  await engine.clearConflicts(target);
  assert.equal(engine.conflicts()[0].status, "conflict");
});

test("take-native 保留 id、作用域与未知元数据，登记 adopt 后保持稳定", async (t) => {
  const { engine, target, store, skill } = await fixture(t);
  const file = path.join(store.skillPath(skill.id), "SKILL.md");
  fs.writeFileSync(
    file,
    skillMarkdown("sample", "库说明", "库正文", {
      custom: "保留",
      shared: "旧",
    }),
  );
  fs.writeFileSync(
    path.join(target, "SKILL.md"),
    skillMarkdown("sample", "原生说明", "原生正文", { shared: "新" }),
  );
  const history = store.history().length;
  await engine.chooseConflict("sample", "native");
  assert.equal(store.history().length, history + 1);
  assert.deepEqual(store.manifest().skills[0].scope, skill.scope);
  assert.equal(store.manifest().skills[0].id, skill.id);
  const parsed = parseSkill(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.metadata.custom, "保留");
  assert.equal(parsed.metadata.shared, "新");
  assert.equal(engine.plan().changes[0].status, "adopt");
  await engine.apply(engine.plan().id);
  assert.equal(engine.plan().changes[0].status, "unchanged");
});

test("符号链接 replace 不写目标，rollback 恢复链接，链接目标变化使选择失效", async (t) => {
  const { engine, target, dir } = await fixture(t);
  const upstream = path.join(dir, "upstream");
  fs.renameSync(target, upstream);
  fs.symlinkSync(upstream, target);
  const before = readNative(upstream);
  await engine.chooseConflict(target, "library");
  fs.writeFileSync(path.join(upstream, "new"), "变化");
  assert.equal(engine.conflicts()[0].status, "conflict");
  await engine.chooseConflict(target, "library");
  const result = await engine.apply(engine.plan().id);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  fs.unlinkSync(path.join(upstream, "new"));
  assert.deepEqual(readNative(upstream), before);
  await engine.rollback(result.id!);
  assert.equal(fs.readlinkSync(target), upstream);
});

test("无效原生技能拒绝收库；源库提交失败恢复源与选择", async (t) => {
  const { engine, target, store } = await fixture(t);
  const revision = store.revision();
  fs.writeFileSync(path.join(target, "SKILL.md"), "无效");
  await assert.rejects(engine.chooseConflict(target, "native"), {
    code: "INVALID_SKILL",
  });
  assert.equal(store.revision(), revision);
  fs.writeFileSync(
    path.join(target, "SKILL.md"),
    skillMarkdown("sample", "原生", "正文"),
  );
  const commit = store.commit;
  store.commit = () => {
    throw new Error("模拟提交失败");
  };
  await assert.rejects(engine.chooseConflict(target, "native"), /模拟提交失败/);
  store.commit = commit;
  assert.equal(store.revision(), revision);
});

test("HTTP 冲突 API、指纹校验、清除及访问控制", async (t) => {
  const { engine, target, store, dir } = await fixture(t);
  const uiDirectory = path.join(dir, "ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(path.join(uiDirectory, "index.html"), "<!--HSYNC_TOKEN-->");
  const running = await startServer(store, { port: 0, uiDirectory });
  t.after(() => running.close());
  const html = await (await fetch(running.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
  };
  const originalPlan = engine.plan().id;
  await new Promise<void>((resolve) => {
    const req = http.request(`${running.url}/api/conflicts/choose`, {
      method: "POST",
      headers: { ...headers, "content-length": "1000" },
    });
    req.on("error", () => resolve());
    req.on("socket", (socket) =>
      socket.once("connect", () => {
        req.write('{"path":');
        setImmediate(() => req.destroy(new Error("模拟网络断开")));
      }),
    );
  });
  assert.equal(engine.plan().id, originalPlan);

  assert.equal((await fetch(`${running.url}/api/conflicts`)).status, 403);
  const list = await (
    await fetch(`${running.url}/api/conflicts`, { headers })
  ).json();
  assert.equal(list.data[0].path, target);
  const choose = (body: unknown, extra = {}) =>
    fetch(`${running.url}/api/conflicts/choose`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await choose({ path: target, use: "library", fingerprint: "旧" })).status,
    409,
  );
  assert.equal(
    (
      await choose(
        { path: target, use: "skip" },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal((await choose({ path: target, use: "skip" })).status, 200);
  const plan = await (
    await fetch(`${running.url}/api/plan`, { headers })
  ).json();
  assert.equal(plan.data.changes[0].status, "skipped");
  assert.equal(
    (
      await fetch(`${running.url}/api/conflicts/clear`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: target }),
      })
    ).status,
    200,
  );
  assert.equal(engine.conflicts()[0].status, "conflict");
});

test("快照清理同时限制数量和总大小，保留待恢复记录", async (t) => {
  const { engine, store } = await fixture(t);
  const dir = path.join(store.root, "deployments");
  const data = "x".repeat(7 * 1024 * 1024);
  for (let i = 0; i < 23; i++)
    writeJson(path.join(dir, `${1000 + i}-abc.json`), {
      id: `${1000 + i}-abc`,
      date: "",
      changes: 1,
      status: i === 0 ? "pending" : "applied",
      files: [],
      beforeState: { receipts: [] },
      data,
    });
  (engine as any).pruneDeployments();
  const files = fs.readdirSync(dir);
  assert.ok(files.length <= 20);
  assert.ok(
    files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) <=
      128 * 1024 * 1024,
  );
  assert.ok(files.includes("1000-abc.json"));
});

test("replace 部署失败自动恢复；pending 中断可恢复链接原件", async (t) => {
  const { engine, target, dir, store } = await fixture(t);
  const upstream = path.join(dir, "upstream");
  fs.renameSync(target, upstream);
  fs.symlinkSync(upstream, target);
  await engine.chooseConflict(target, "library");
  const before = readNative(upstream);
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (
      path.basename(String(from)).startsWith(".hsync-staging-") &&
      String(to) === target
    )
      throw new Error("模拟写入失败");
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(engine.apply(engine.plan().id), /模拟写入失败/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readlinkSync(target), upstream);
  assert.deepEqual(readNative(upstream), before);
  const result = await engine.apply(engine.plan().id);
  const recordPath = path.join(store.root, "deployments", `${result.id}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.status = "pending";
  writeJson(recordPath, record);
  // A new process sees only the durable journal, not in-memory recovery state.
  await new Engine(store).rollback(result.id!);
  assert.equal(fs.readlinkSync(target), upstream);
});

test("replace 回滚拒绝覆盖部署后新增的隐藏文件", async (t) => {
  const { engine, target } = await fixture(t);
  await engine.chooseConflict(target, "library");
  const result = await engine.apply(engine.plan().id);
  fs.writeFileSync(path.join(target, ".DS_Store"), "外部修改");
  await assert.rejects(engine.rollback(result.id!), { code: "ROLLBACK_DRIFT" });
});

test("pending 在解除链接后中断仍恢复链接；快照包含资源权限", async (t) => {
  const { engine, target, store, dir } = await fixture(t);
  const upstream = path.join(dir, "upstream");
  fs.renameSync(target, upstream);
  fs.symlinkSync(upstream, target);
  await engine.chooseConflict(target, "library");
  const before = store.state();
  const fingerprint = engine.conflicts()[0].conflictFingerprint;
  writeJson(path.join(store.root, "deployments", "9999999999999-abc.json"), {
    id: "9999999999999-abc",
    status: "pending",
    date: "",
    changes: 1,
    beforeState: before,
    files: [
      {
        path: target,
        kind: "skill",
        existed: true,
        native: readNative(target),
        beforeHash: fingerprint,
        afterHash: "待写入",
        files: {},
      },
    ],
  });
  fs.unlinkSync(target);
  await new Engine(store).rollback("9999999999999-abc");
  assert.equal(fs.readlinkSync(target), upstream);
});

test("CLI 冲突列表、选择、doctor 与清除共用 core", async (t) => {
  const { store, target, engine } = await fixture(t);
  const run = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--json", ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: store.home,
            HARNESS_SYNC_HOME: store.root,
          },
        },
      ),
    );
  assert.equal(run("conflicts", "list")[0].path, target);
  run("conflicts", "choose", "sample", "--use", "skip");
  assert.equal(run("doctor").skipped[0].path, target);
  run("conflicts", "clear", target);
  assert.equal(engine.conflicts()[0].status, "conflict");
});

test("数字路径 replace 后 rollback 完整恢复原件", async (t) => {
  const { engine, target } = await fixture(t);
  fs.writeFileSync(path.join(target, "123"), Buffer.from([0, 1, 255]), {
    mode: 0o751,
  });
  fs.mkdirSync(path.join(target, "assets", "9", "10"), { recursive: true });
  fs.writeFileSync(path.join(target, "assets", "9", "456"), "数字路径内容");
  const original = readNative(target);
  await engine.chooseConflict(target, "library");
  const deployment = await engine.apply(engine.plan().id);
  await engine.rollback(deployment.id!);
  assert.deepEqual(readNative(target), original);
  assert.deepEqual(
    fs.readFileSync(path.join(target, "123")),
    Buffer.from([0, 1, 255]),
  );
});

test("回滚重建失败保留当前目标并可重试", async (t) => {
  const { engine, target } = await fixture(t);
  fs.writeFileSync(path.join(target, "123"), "原件");
  const original = readNative(target);
  await engine.chooseConflict(target, "library");
  const deployment = await engine.apply(engine.plan().id);
  const deployed = readNative(target);
  const write = fs.writeFileSync;
  fs.writeFileSync = ((file, ...args) => {
    if (path.basename(String(file)) === "123")
      throw new Error("模拟恢复写入失败");
    return write(file, ...args);
  }) as typeof fs.writeFileSync;
  try {
    await assert.rejects(engine.rollback(deployment.id!), /模拟恢复写入失败/);
  } finally {
    fs.writeFileSync = write;
  }
  assert.deepEqual(readNative(target), deployed);
  await engine.rollback(deployment.id!);
  assert.deepEqual(readNative(target), original);
});

test("__proto__ 原生文件参与指纹并在回滚后恢复", async (t) => {
  const { engine, target } = await fixture(t);
  const file = path.join(target, "__proto__");
  fs.writeFileSync(file, Buffer.from([0, 255, 33]), { mode: 0o751 });
  await engine.chooseConflict(target, "library");
  const plan = engine.plan();
  fs.writeFileSync(file, Buffer.from([0, 255, 34]));
  assert.equal(engine.conflicts()[0].status, "conflict");
  await assert.rejects(engine.apply(plan.id), { code: "STALE_PLAN" });
  await engine.chooseConflict(target, "library");
  const original = fs.readFileSync(file);
  const deployment = await engine.apply(engine.plan().id);
  await engine.rollback(deployment.id!);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o751);
});

test("原型同名资源经过收库、编辑与部署不丢失", async (t) => {
  const { store, engine, target, skill } = await fixture(t);
  for (const name of ["__proto__", "constructor", "toString"])
    fs.writeFileSync(path.join(target, name), `资源 ${name}`);
  await engine.chooseConflict(target, "native");
  for (const name of ["__proto__", "constructor", "toString"])
    assert.equal(
      fs.readFileSync(path.join(store.skillPath(skill.id), name), "utf8"),
      `资源 ${name}`,
    );
  await engine.apply(engine.plan().id);
  await store.saveSkill({ ...skill, body: "编辑后的正文" }, skill.id);
  await engine.apply(engine.plan().id);
  for (const name of ["__proto__", "constructor", "toString"])
    assert.equal(
      fs.readFileSync(path.join(target, name), "utf8"),
      `资源 ${name}`,
    );
});

test("新建技能保留 __proto__ 资源自有属性", async (t) => {
  const { store } = await fixture(t);
  const resources = JSON.parse(
    '{"__proto__":{"content":"5Y6f5Lu2","mode":493}}',
  );
  const entry = await store.saveSkill(
    { name: "prototype-resource", description: "资源", body: "正文" },
    undefined,
    undefined,
    resources,
  );
  assert.equal(
    fs.readFileSync(path.join(store.skillPath(entry.id), "__proto__"), "utf8"),
    "原件",
  );
});

for (const limit of ["size", "entries"] as const)
  test(`超出快照上限仍可 skip（${limit}）`, async (t) => {
    const { store, engine, target } = await fixture(t);
    if (limit === "size") {
      const large = path.join(target, "large.bin");
      fs.writeFileSync(large, "");
      fs.truncateSync(large, 65 * 1024 * 1024);
    } else {
      const many = path.join(target, ".git", "many");
      fs.mkdirSync(many);
      for (let i = 0; i < 10001; i++)
        fs.writeFileSync(path.join(many, String(i)), "");
    }
    await store.saveSkill({
      name: "other",
      description: "其他",
      body: "其他",
      scope: { kind: "global", harnesses: ["claude"] },
    });
    const conflict = engine.conflicts().find((c) => c.path === target);
    assert.ok(conflict);
    assert.ok(conflict.conflictOptions?.includes("skip"));
    await assert.rejects(engine.chooseConflict(target, "library"), {
      code: "SNAPSHOT_TOO_LARGE",
    });
    await engine.chooseConflict(target, "skip", conflict.conflictFingerprint);
    const plan = engine.plan();
    assert.equal(
      plan.changes.find((c) => c.path === target)!.status,
      "skipped",
    );
    const other = plan.changes.find((c) => c.path !== target)!;
    await engine.apply(plan.id);
    assert.ok(fs.existsSync(path.join(other.path, "SKILL.md")));
    if (limit === "size") {
      const fd = fs.openSync(path.join(target, "large.bin"), "r+");
      try {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 32 * 1024 * 1024);
      } finally {
        fs.closeSync(fd);
      }
    } else fs.writeFileSync(path.join(target, "after-choice"), "外部修改");
    assert.equal(
      engine.conflicts().find((c) => c.path === target)!.status,
      "conflict",
    );
  });

test("内部链接删除和链接改为文件均列入差异且不写链接目标", async (t) => {
  const { store, skill, engine, target, dir } = await fixture(t);
  const outside = path.join(dir, "outside");
  fs.writeFileSync(outside, "链接目标原件");
  fs.symlinkSync(outside, path.join(target, "manual"));
  fs.symlinkSync("旧链接目标", path.join(target, "guide"));
  fs.writeFileSync(path.join(store.skillPath(skill.id), "guide"), "库文件");
  const changes = engine.conflicts()[0].fileChanges!;
  const manual = changes.find((c) => c.path === "manual");
  assert.ok(manual, "删除的内部链接应出现在预览中");
  assert.equal(manual.status, "removed");
  assert.match(manual.diff!, /符号链接/);
  assert.ok(manual.diff!.includes(outside));
  const guide = changes.find((c) => c.path === "guide")!;
  assert.equal(guide.status, "modified");
  assert.match(guide.diff!, /旧链接目标/);
  assert.match(guide.diff!, /库文件/);
  await engine.chooseConflict(target, "library");
  const deployment = await engine.apply(engine.plan().id);
  assert.equal(fs.existsSync(path.join(target, "manual")), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "链接目标原件");
  await engine.rollback(deployment.id!);
  assert.equal(fs.readlinkSync(path.join(target, "manual")), outside);
  assert.equal(fs.readlinkSync(path.join(target, "guide")), "旧链接目标");
});

test("旧版完整快照的指纹仍可校验并回滚", async (t) => {
  const { store, engine, target } = await fixture(t);
  const original = readNative(target);
  await engine.chooseConflict(target, "library");
  const deployment = await engine.apply(engine.plan().id);
  const recordPath = path.join(
    store.root,
    "deployments",
    `${deployment.id}.json`,
  );
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.files[0].afterNativeHash = hash(JSON.stringify(readNative(target)));
  writeJson(recordPath, record);
  await new Engine(store).rollback(deployment.id!);
  assert.deepEqual(readNative(target), original);
});

test("内部链接新增或目标变化更新差异并使选择失效", async (t) => {
  const { engine, target } = await fixture(t);
  await engine.chooseConflict(target, "library");
  fs.symlinkSync("第一目标", path.join(target, "manual"));
  const added = engine.conflicts()[0];
  assert.equal(added.status, "conflict");
  assert.equal(
    added.fileChanges!.find((c) => c.path === "manual")!.beforeLink,
    "第一目标",
  );
  await engine.chooseConflict(target, "library");
  fs.unlinkSync(path.join(target, "manual"));
  fs.symlinkSync("第二目标", path.join(target, "manual"));
  const changed = engine.conflicts()[0];
  assert.equal(changed.status, "conflict");
  assert.equal(
    changed.fileChanges!.find((c) => c.path === "manual")!.beforeLink,
    "第二目标",
  );
  assert.match(
    changed.fileChanges!.find((c) => c.path === "manual")!.diff!,
    /第二目标/,
  );
});
