import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { adapters } from "../src/core/adapters.ts";
import { parseSkill, skillMarkdown } from "../src/core/files.ts";
import { startServer } from "../src/server.ts";
import { installSelfSkill } from "../src/core/self-skill.ts";
import type { Scope } from "../src/shared/types.ts";

const globalScope: Scope = {
  kind: "global",
  harnesses: ["deepseek", "opencode", "codex", "claude"],
};
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sync-test-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  const engine = new Engine(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, store, engine, harnesses: adapters(home) };
}
function makeSkill(dir: string, name = "test-skill") {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    skillMarkdown(
      name,
      "Test the configuration workflow",
      "# Workflow\n\nRead scripts/check.sh.",
      { "disable-model-invocation": true },
    ),
  );
  fs.writeFileSync(
    path.join(dir, "scripts/check.sh"),
    "#!/bin/sh\nprintf test\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "asset.bin"), Buffer.from([0, 255, 18, 45]));
  return dir;
}
test("global templates deploy to both native files; preserve existing text and idempotence", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  for (const h of harnesses) {
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(h.instructions, "# Existing\nKeep me.\n");
  }
  await store.saveRule({
    title: "Preferences",
    body: "Device: {{device.name}}\nHome: {{device.home}}",
    scope: globalScope,
  });
  const plan = engine.plan();
  assert.equal(plan.changes.length, 4);
  assert.equal(plan.errors.length, 0);
  const result = await engine.apply(plan.id);
  assert.equal(result.changes, 4);
  for (const h of harnesses) {
    const s = fs.readFileSync(h.instructions, "utf8");
    assert.ok(s.startsWith("# Existing\nKeep me.\n"));
    assert.ok(s.includes(store.device().name));
    assert.ok(s.includes(store.device().home));
  }
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
  assert.equal((await engine.apply(engine.plan().id)).changes, 0);
});
test("edits outside managed blocks are retained; edits inside are refused", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  const rule = await store.saveRule({ title: "Rules", body: "Original" });
  await engine.apply(engine.plan().id);
  fs.appendFileSync(harnesses[0].instructions, "\n# Outside\n");
  await store.saveRule({ ...rule, body: "Updated" }, rule.id);
  await engine.apply(engine.plan().id);
  assert.match(fs.readFileSync(harnesses[0].instructions, "utf8"), /# Outside/);
  fs.writeFileSync(
    harnesses[0].instructions,
    fs
      .readFileSync(harnesses[0].instructions, "utf8")
      .replace("Updated", "Foreign edit"),
  );
  assert.equal(engine.plan().changes[0].status, "conflict");
  await assert.rejects(engine.apply(engine.plan().id), /冲突/);
});
test("skills retain resources, unknown frontmatter and executable bits across edits and deployment", async (t) => {
  const { dir, store, engine, harnesses } = await fixture(t);
  const skill = await store.importSkill(
    makeSkill(path.join(dir, "incoming")),
    globalScope,
  );
  assert.ok(!store.git(["show", "HEAD:manifest.json"]).includes(dir));
  assert.equal(
    store.device().origins?.[skill.id],
    fs.realpathSync(path.join(dir, "incoming")),
  );
  await store.saveSkill({ ...skill, body: "Updated workflow" }, skill.id);
  await engine.apply(engine.plan().id);
  for (const h of harnesses) {
    const p = path.join(h.skills, "test-skill");
    assert.deepEqual(
      fs.readFileSync(path.join(p, "asset.bin")),
      Buffer.from([0, 255, 18, 45]),
    );
    assert.equal(
      fs.statSync(path.join(p, "scripts/check.sh")).mode & 0o777,
      0o755,
    );
    assert.equal(
      parseSkill(fs.readFileSync(path.join(p, "SKILL.md"), "utf8")).metadata[
        "disable-model-invocation"
      ],
      true,
    );
  }
});
test("foreign skills are never overwritten, even when they have identical contents", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  const incoming = makeSkill(path.join(harnesses[0].skills, "test-skill"));
  await store.importSkill(incoming, globalScope);
  assert.equal(
    engine.plan().changes.find((c) => c.harness === "deepseek")?.status,
    "conflict",
  );
  await assert.rejects(engine.apply(engine.plan().id));
  assert.ok(fs.existsSync(path.join(incoming, "asset.bin")));
});
test("explicit adoption can manage an existing native skill without replacing its content", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  const incoming = makeSkill(path.join(harnesses[0].skills, "test-skill"));
  const skill = await store.importSkill(incoming, globalScope, undefined, true);
  assert.equal(
    engine.plan().changes.find((c) => c.harness === "deepseek")?.status,
    "unchanged",
  );
  await store.saveSkill({ ...skill, body: "Adopted update" }, skill.id);
  await engine.apply(engine.plan().id);
  assert.match(
    fs.readFileSync(path.join(incoming, "SKILL.md"), "utf8"),
    /Adopted update/,
  );
});
test("adoption refuses shared or arbitrary directories and does not leave a partial source entry", async (t) => {
  const { dir, store } = await fixture(t);
  await assert.rejects(
    store.importSkill(
      makeSkill(path.join(dir, "incoming")),
      globalScope,
      undefined,
      true,
    ),
    /原生部署目录/,
  );
  assert.equal(store.manifest().skills.length, 0);
  assert.equal(store.state().receipts.length, 0);
});
test("project skills and variables stay isolated from globals and other concurrent projects", async (t) => {
  const { dir, store, engine, harnesses } = await fixture(t);
  const a = path.join(dir, "alpha"),
    b = path.join(dir, "beta");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const pa = await store.saveProject({ name: "Alpha", path: a });
  const pb = await store.saveProject({ name: "Beta", path: b });
  await store.saveRule({
    title: "Alpha rules",
    body: "{{project.name}} at {{project.path}}",
    scope: { ...globalScope, kind: "project", target: pa.id },
  });
  await store.importSkill(makeSkill(path.join(dir, "incoming")), {
    ...globalScope,
    kind: "project",
    target: pa.id,
  });
  await engine.apply(engine.plan().id);
  assert.match(fs.readFileSync(path.join(a, "AGENTS.md"), "utf8"), /Alpha at/);
  assert.ok(fs.existsSync(path.join(a, ".dsh/skills/test-skill/SKILL.md")));
  assert.ok(
    fs.existsSync(path.join(a, ".opencode/skills/test-skill/SKILL.md")),
  );
  assert.ok(!fs.existsSync(path.join(b, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(harnesses[0].skills, "test-skill")));
  assert.ok(!store.git(["show", "HEAD:manifest.json"]).includes(a));
  await store.remove("projects", pb.id);
  assert.ok(!store.device().bindings[pb.id]);
});
test("harness-specific global selection does not leak to the other harness", async (t) => {
  const { store, engine } = await fixture(t);
  await store.saveRule({
    title: "DeepSeek only",
    body: "Specific",
    scope: {
      kind: "device",
      target: store.device().id,
      harnesses: ["deepseek"],
    },
  });
  const plan = engine.plan();
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].harness, "deepseek");
});
test("unbound projects, missing variables, and incompatible project instructions block deployment", async (t) => {
  const { dir, store, engine } = await fixture(t);
  const p = await store.saveProject({ name: "Not bound" });
  await store.saveRule({
    title: "Project",
    body: "Hello",
    scope: { ...globalScope, kind: "project", target: p.id },
  });
  assert.ok(engine.plan().errors.some((e) => /未绑定/.test(e)));
  await assert.rejects(engine.apply(engine.plan().id));
  await store.saveProject({ name: p.name, path: dir }, p.id);
  await store.saveRule({ title: "Missing", body: "{{vars.UNSET}}" });
  assert.ok(engine.plan().errors.some((e) => /缺少变量/.test(e)));
  await store.saveRule({
    title: "Project only DeepSeek",
    body: "Hello",
    scope: { kind: "project", target: p.id, harnesses: ["deepseek"] },
  });
  assert.ok(engine.plan().errors.some((e) => /共用项目/.test(e)));
});
test("a reviewed plan is invalidated by a subsequent native file change", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  await store.saveRule({ title: "Test", body: "hello" });
  const plan = engine.plan();
  fs.mkdirSync(harnesses[0].home, { recursive: true });
  fs.writeFileSync(harnesses[0].instructions, "# Added after review");
  await assert.rejects(engine.apply(plan.id), /重新预览/);
  assert.equal(
    fs.readFileSync(harnesses[0].instructions, "utf8"),
    "# Added after review",
  );
});
test("optimistic revisions prevent concurrent GUI and CLI source updates from silently overwriting", async (t) => {
  const { store } = await fixture(t);
  const revision = store.revision();
  const results = await Promise.allSettled([
    store.saveRule({ title: "A", body: "A" }, undefined, revision),
    store.saveRule({ title: "B", body: "B" }, undefined, revision),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.manifest().rules.length, 1);
});
test("disable removes managed skills and deployment rollback restores the exact bundle", async (t) => {
  const { dir, store, engine, harnesses } = await fixture(t);
  const skill = await store.importSkill(
    makeSkill(path.join(dir, "incoming")),
    globalScope,
  );
  await engine.apply(engine.plan().id);
  await store.saveSkill({ ...skill, body: "Unused", enabled: false }, skill.id);
  const deployment = await engine.apply(engine.plan().id);
  assert.ok(!fs.existsSync(path.join(harnesses[0].skills, skill.name)));
  await engine.rollback(deployment.id!);
  assert.ok(
    fs.existsSync(path.join(harnesses[0].skills, skill.name, "asset.bin")),
  );
});
test("rollback refuses later native edits and restores exact original unmanaged instructions", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  fs.mkdirSync(harnesses[0].home, { recursive: true });
  fs.writeFileSync(harnesses[0].instructions, "original bytes");
  await store.saveRule({ title: "Global", body: "hello" });
  const d = await engine.apply(engine.plan().id);
  fs.appendFileSync(harnesses[0].instructions, "\nNEW");
  await assert.rejects(engine.rollback(d.id!), /新修改/);
  const text = fs.readFileSync(harnesses[0].instructions, "utf8");
  fs.writeFileSync(harnesses[0].instructions, text.slice(0, -4));
  await engine.rollback(d.id!);
  assert.equal(
    fs.readFileSync(harnesses[0].instructions, "utf8"),
    "original bytes",
  );
  assert.ok(!fs.existsSync(harnesses[1].instructions));
});
test("symlink native targets and symlink bundle resources are refused", async (t) => {
  const { dir, store, engine, harnesses } = await fixture(t);
  fs.mkdirSync(harnesses[0].home, { recursive: true });
  const target = path.join(dir, "private");
  fs.writeFileSync(target, "private");
  fs.symlinkSync(target, harnesses[0].instructions);
  await store.saveRule({ title: "Global", body: "hello" });
  assert.equal(engine.plan().changes[0].status, "conflict");
  assert.equal(fs.readFileSync(target, "utf8"), "private");
  const bundle = makeSkill(path.join(dir, "incoming"));
  fs.symlinkSync(target, path.join(bundle, "bad-link"));
  await assert.rejects(store.importSkill(bundle, globalScope), /符号链接/);
});
test("source restore creates history and keeps device bindings and native files separate", async (t) => {
  const { store, engine, harnesses } = await fixture(t);
  const base = store.history()[0].hash;
  await store.saveRule({ title: "Temporary", body: "test" });
  await engine.apply(engine.plan().id);
  await store.saveDevice({
    name: "New device name",
    variables: { ROOT: "/tmp/test" },
  });
  await store.restoreSource(base);
  assert.equal(store.manifest().rules.length, 0);
  assert.equal(store.device().name, "New device name");
  assert.ok(fs.existsSync(harnesses[0].instructions));
  assert.equal(engine.plan().changes[0].status, "remove");
});
test("self management skill resolves the real CLI path and updates in place", async (t) => {
  const { store } = await fixture(t);
  const first = await installSelfSkill(store);
  const second = await installSelfSkill(store);
  assert.equal(first.id, second.id);
  assert.equal(store.manifest().skills.length, 1);
  const body = fs.readFileSync(
    path.join(store.skillPath(first.id), "SKILL.md"),
    "utf8",
  );
  assert.match(body, /HarnessSync\/dist\/cli\.js/);
  assert.ok(!body.includes("/Fork/dist/cli.js"));
});
test("opening an initialized store and running doctor work when its directory is read-only", async (t) => {
  const { store } = await fixture(t);
  fs.chmodSync(store.root, 0o500);
  try {
    const reopened = await new Store(store.root, store.home).init();
    const plan = new Engine(reopened).plan();
    assert.equal(plan.errors.length, 0);
    assert.ok(!fs.existsSync(path.join(store.root, ".lock")));
  } finally {
    fs.chmodSync(store.root, 0o700);
  }
});
test("local HTTP API requires session token and rejects cross-site writes; GUI and API share state", async (t) => {
  const { store } = await fixture(t);
  const uiDirectory = path.join(store.root, "test-ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(
    path.join(uiDirectory, "index.html"),
    "<html><head><!--HSYNC_TOKEN--></head><body>HarnessSync</body></html>",
  );
  const running = await startServer(store, { port: 0, uiDirectory });
  t.after(() => running.close());
  const html = await (await fetch(running.url)).text();
  const token = html.match(
    /name="harness-sync-token" content="([a-f0-9]+)"/,
  )?.[1];
  assert.ok(token);
  assert.equal((await fetch(running.url + "/api/snapshot")).status, 403);
  assert.equal(
    (
      await fetch(running.url + "/api/device", {
        method: "POST",
        headers: {
          origin: "https://evil.invalid",
          "x-harness-sync-token": token,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const response = await fetch(running.url + "/api/rules", {
    method: "POST",
    headers: {
      "x-harness-sync-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      value: { title: "From API", body: "Hello" },
      revision: store.revision(),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(store.manifest().rules[0].title, "From API");
});
