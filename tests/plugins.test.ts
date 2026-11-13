import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { registry, validateHarnessFile } from "../src/core/harness-registry.ts";
import {
  harnessJSONSchema,
  harnessManifestSchema,
} from "../src/shared/harness-manifest.ts";
import { harnessIds, scopeSchema } from "../src/shared/types.ts";
import { placeSkills, type SkillReader } from "../src/core/adapters.ts";
import { startServer } from "../src/server.ts";
const acme = JSON.parse(
  fs.readFileSync(
    new URL("fixtures/harnesses/acme.json", import.meta.url),
    "utf8",
  ),
);
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-plugins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  const pluginDir = path.join(store.root, "harnesses");
  fs.mkdirSync(pluginDir);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(
      path.join(pluginDir, name + ".json"),
      JSON.stringify(value),
    );
  return { dir, home, store, engine: new Engine(store), pluginDir, write };
}
test("built-ins validate and committed JSON Schema matches zod", async (t) => {
  const { home, store } = await fixture(t);
  const r = registry(home, store.root);
  assert.deepEqual(r.errors, []);
  assert.equal(r.entries.length, 4);
  for (const { manifest } of r.entries) {
    assert.ok(manifest.notes.en);
    assert.ok(manifest.notes["zh-CN"]);
    assert.ok(manifest.homepage?.startsWith("https://"));
  }
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        new URL("../schema/harness.schema.json", import.meta.url),
        "utf8",
      ),
    ),
    harnessJSONSchema(),
  );
  assert.deepEqual(scopeSchema.parse({}).harnesses, harnessIds);
  assert.equal(scopeSchema.safeParse({ harnesses: [] }).success, false);
});
test("invalid files report JSON paths; listing invalidation and duplicate rejection", async (t) => {
  const { home, store, write, pluginDir } = await fixture(t);
  write("bad", { ...acme, skills: { ...acme.skills, typo: true } });
  write("override", { ...acme, id: "codex" });
  write("a", acme);
  write("b", acme);
  let r = registry(home, store.root);
  assert.equal(r.entries.length, 4);
  assert.equal(r.errors.length, 4);
  assert.ok(
    r.errors.some((e) => e.issues.some((i) => i.path === "$.skills.typo")),
  );
  fs.unlinkSync(path.join(pluginDir, "b.json"));
  assert.equal(registry(home, store.root).entries.length, 4);
  fs.unlinkSync(path.join(pluginDir, "bad.json"));
  r = registry(home, store.root);
  assert.equal(r.entries.length, 5);
  fs.writeFileSync(path.join(pluginDir, "a.json"), "{");
  assert.equal(registry(home, store.root).entries.length, 4);
});
test("version execution inputs and malformed paths are rejected", () => {
  for (const command of [
    "/bin/sh",
    "../acme",
    "acme;touch",
    "acme --version",
    "$(id)",
  ])
    assert.equal(
      harnessManifestSchema.safeParse({
        ...acme,
        version: { command, args: ["--version"] },
      }).success,
      false,
    );
  for (const args of [["-c"], ["--version", "anything"], [], ["--help"]])
    assert.equal(
      harnessManifestSchema.safeParse({
        ...acme,
        version: { command: "acme", args },
      }).success,
      false,
    );
  assert.equal(
    harnessManifestSchema.safeParse({ ...acme, root: { default: "{rot}" } })
      .success,
    false,
  );
  assert.equal(
    harnessManifestSchema.safeParse({
      ...acme,
      instructions: { ...acme.instructions, project: "../escape" },
    }).success,
    false,
  );
});
test("plugin receives all scope; disable freezes files and receipts; re-enable resumes; remove owned only", async (t) => {
  const { home, store, engine, write } = await fixture(t);
  const skill = await store.saveSkill({
    name: "sample",
    description: "sample",
    body: "one",
  });
  await engine.apply(engine.plan().id);
  write("acme", acme);
  assert.ok(
    engine
      .plan()
      .changes.some((c) => c.harness === "acme" && c.status === "create"),
  );
  await engine.apply(engine.plan().id);
  const target = path.join(home, ".acme/skills/sample/SKILL.md");
  const before = fs.readFileSync(target, "utf8");
  const receipt = store.state().receipts.find((r) => r.harness === "acme");
  await store.setHarnessEnabled("acme", false);
  await store.saveSkill({ ...skill, body: "two" }, skill.id);
  assert.ok(!engine.plan().changes.some((c) => c.harness === "acme"));
  await engine.apply(engine.plan().id);
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.deepEqual(
    store.state().receipts.find((r) => r.harness === "acme"),
    receipt,
  );
  await store.setHarnessEnabled("acme", true);
  await engine.apply(engine.plan().id);
  assert.match(fs.readFileSync(target, "utf8"), /two/);
  const unowned = path.join(home, ".acme/skills/unowned");
  fs.mkdirSync(unowned);
  fs.writeFileSync(path.join(unowned, "SKILL.md"), "keep");
  await store.saveSkill({ ...skill, body: "two", enabled: false }, skill.id);
  await engine.apply(engine.plan().id);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(unowned, "SKILL.md"), "utf8"), "keep");
});
test("enabled readers update and remove shared skills while Codex-only receipts stay", async (t) => {
  const { home, store, engine } = await fixture(t);
  const shared = await store.saveSkill({
    name: "shared",
    description: "shared",
    body: "before",
    scope: { harnesses: ["deepseek", "opencode", "codex"] },
  });
  const codexOnly = await store.saveSkill({
    name: "codex-only",
    description: "private",
    body: "original",
    scope: { harnesses: ["codex"] },
  });
  await engine.apply(engine.plan().id);
  const sharedTarget = path.join(home, ".agents/skills/shared/SKILL.md");
  const privateReceipt = store
    .state()
    .receipts.find((r) => r.sourceId === codexOnly.id)!;
  const privateTarget = path.join(privateReceipt.path, "SKILL.md");
  const privateBefore = fs.readFileSync(privateTarget, "utf8");
  assert.equal(
    store.state().receipts.find((r) => r.sourceId === shared.id)!.harness,
    "codex",
  );
  await store.setHarnessEnabled("codex", false);
  await store.saveSkill({ ...shared, body: "after" }, shared.id);
  await store.saveSkill(
    { ...codexOnly, body: "changed", enabled: false },
    codexOnly.id,
  );
  const plan = engine.plan();
  assert.ok(
    plan.changes.some(
      (c) => c.path === path.dirname(sharedTarget) && c.status === "update",
    ),
  );
  assert.equal(
    plan.warnings!.filter((w) => w.includes("Codex 已停用")).length,
    1,
  );
  assert.ok(plan.warnings!.some((w) => w.includes("Codex 已停用：1 个")));
  await engine.apply(plan.id);
  assert.match(fs.readFileSync(sharedTarget, "utf8"), /after/);
  assert.equal(fs.readFileSync(privateTarget, "utf8"), privateBefore);
  assert.deepEqual(
    store.state().receipts.find((r) => r.sourceId === codexOnly.id),
    privateReceipt,
  );
  await store.saveSkill(
    { ...shared, body: "after", enabled: false },
    shared.id,
  );
  await engine.apply(engine.plan().id);
  assert.equal(fs.existsSync(sharedTarget), false);
  assert.equal(fs.readFileSync(privateTarget, "utf8"), privateBefore);
  await store.setHarnessEnabled("codex", true);
  await engine.apply(engine.plan().id);
  assert.equal(fs.existsSync(privateTarget), false);
});
test("unknown stored ids warn, and manifest edits invalidate plans", async (t) => {
  const { store, engine, write } = await fixture(t);
  await store.saveRule({
    title: "unknown",
    body: "x",
    scope: { harnesses: ["removed"] },
  });
  assert.equal(engine.plan().errors.length, 0);
  assert.ok(engine.plan().warnings?.some((w) => w.includes("removed")));
  write("acme", acme);
  const before = engine.plan();
  write("acme", { ...acme, name: "Changed" });
  await assert.rejects(engine.apply(before.id), /计划|变化|过期/);
});
function brute(selected: string[], readers: SkillReader[], collapse: string[]) {
  let best: SkillReader[] | undefined,
    score: number[] = [];
  const ids = [...new Set(readers.flatMap((r) => r.readers))];
  for (let mask = 1; mask < 2 ** readers.length; mask++) {
    const dirs = readers.filter((_, i) => mask & (2 ** i));
    const counts = ids.map(
      (id) => dirs.filter((d) => d.readers.includes(id)).length,
    );
    if (selected.some((id) => !counts[ids.indexOf(id)])) continue;
    const s = [
      counts.reduce(
        (n, c, i) => n + (collapse.includes(ids[i]) ? 0 : Math.max(0, c - 1)),
        0,
      ),
      counts.reduce(
        (n, c, i) => n + Number(!selected.includes(ids[i]) && c > 0),
        0,
      ),
      dirs.filter((d) => d.legacy).length,
      dirs.length,
    ];
    const i = s.findIndex((n, i) => n !== score[i]);
    if (!best || (i >= 0 && s[i] < score[i])) {
      best = dirs;
      score = s;
    }
  }
  return selected.length ? best : [];
}
test("exact placement matches brute force on 500 seeded random maps", () => {
  let seed = 42;
  const rand = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const ids = ["aa", "bb", "cc", "dd", "ee"];
  for (let k = 0; k < 500; k++) {
    const readers = Array.from(
      { length: 1 + Math.floor(rand() * 10) },
      (_, i) => ({
        dir: String(i),
        readers: ids.filter(() => rand() < 0.45),
        legacy: rand() < 0.3,
      }),
    );
    const selected = ids.filter(() => rand() < 0.5),
      collapse = ids.filter(() => rand() < 0.5);
    const expected = brute(selected, readers, collapse);
    if (!expected)
      assert.throws(() => placeSkills(selected, readers, collapse));
    else
      assert.deepEqual(
        placeSkills(selected, readers, collapse),
        expected,
        `seed case ${k}`,
      );
  }
});
test("24 directory exact placement stays below 100ms", () => {
  const readers = Array.from({ length: 24 }, (_, i) => ({
    dir: String(i),
    readers: [`tool-${i}`],
  }));
  const start = performance.now();
  assert.equal(
    placeSkills(
      readers.flatMap((r) => r.readers),
      readers,
      [],
    ).length,
    24,
  );
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `${elapsed} ms`);
});
test("plugin API validates writes and retains access controls", async (t) => {
  const { store, dir, write } = await fixture(t);
  write("acme", acme);
  const ui = path.join(dir, "ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(
    path.join(ui, "index.html"),
    "<html><head><!--HSYNC_TOKEN--></head></html>",
  );
  const server = await startServer(store, { port: 0, uiDirectory: ui });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const url = server.url + "/api/harnesses";
  assert.equal((await fetch(url)).status, 403);
  const headers = {
    "x-harness-sync-token": token,
    "content-type": "application/json",
    origin: server.url,
  };
  const get = await (await fetch(url, { headers })).json();
  assert.equal(get.ok, true);
  assert.equal(get.data.harnesses.length, 5);
  const revision = store.revision();
  const changed = await (
    await fetch(url + "/acme", {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false, revision }),
    })
  ).json();
  assert.equal(
    changed.data.harnesses.find((h: any) => h.id === "acme").enabled,
    false,
  );
  assert.equal(
    (
      await fetch(url + "/acme", {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: true, revision }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(url + "/acme", {
        method: "PUT",
        headers: { ...headers, origin: "https://evil.test" },
        body: '{"enabled":true}',
      })
    ).status,
    403,
  );
  assert.deepEqual(store.device().disabledHarnesses, ["acme"]);
  assert.notEqual(
    (
      await fetch(url + "/acme", {
        method: "PUT",
        headers,
        body: '{"enabled":"false"}',
      })
    ).status,
    200,
  );
});
test("CLI validate/list/disable/enable/dir round trips with isolated HOME", async (t) => {
  const { home, store, pluginDir, write } = await fixture(t);
  write("acme", acme);
  const env = { ...process.env, HOME: home, HARNESS_SYNC_HOME: store.root };
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env,
      encoding: "utf8",
    });
  assert.equal(cli("harness", "dir").trim(), pluginDir);
  assert.equal(
    JSON.parse(cli("harness", "validate", path.join(pluginDir, "acme.json")))
      .valid,
    true,
  );
  assert.equal(
    JSON.parse(cli("harness", "list", "--json")).harnesses.length,
    5,
  );
  cli("harness", "disable", "acme");
  assert.deepEqual(store.device().disabledHarnesses, ["acme"]);
  cli("harness", "enable", "acme");
  assert.deepEqual(store.device().disabledHarnesses, []);
  write("bad", { ...acme, version: { command: "/bin/sh", args: ["-c"] } });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "harness",
      "validate",
      path.join(pluginDir, "bad.json"),
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\$\.version\.command/);
  assert.ok(validateHarnessFile(path.join(pluginDir, "bad.json")).error);
});

test("plugin project targets and shared instruction peers are declarative", async (t) => {
  const { home, store, engine, dir, write } = await fixture(t);
  write("acme", acme);
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir);
  const project = await store.saveProject({
    name: "Acme project",
    path: projectDir,
  });
  await store.saveRule({
    title: "project",
    body: "Project only",
    scope: { kind: "project", target: project.id, harnesses: ["acme"] },
  });
  await store.saveSkill({
    name: "project-skill",
    description: "project",
    body: "Project",
    scope: { kind: "project", target: project.id, harnesses: ["acme"] },
  });
  await engine.apply(engine.plan().id);
  assert.match(
    fs.readFileSync(path.join(projectDir, "ACME.md"), "utf8"),
    /Project only/,
  );
  assert.equal(
    fs.existsSync(path.join(projectDir, ".acme/skills/project-skill/SKILL.md")),
    true,
  );
  assert.equal(fs.existsSync(path.join(home, ".acme")), false);
  write("peer", { ...acme, id: "acme-peer" });
  assert.ok(engine.plan().errors.some((e) => e.includes("acme-peer")));
});
test("disabled instructions and owned removals remain untouched", async (t) => {
  const { store, engine, home, write } = await fixture(t);
  write("acme", acme);
  const rule = await store.saveRule({
    title: "acme",
    body: "original",
    scope: { harnesses: ["acme"] },
  });
  const skill = await store.saveSkill({
    name: "keep",
    description: "keep",
    body: "keep",
    scope: { harnesses: ["acme"] },
  });
  await engine.apply(engine.plan().id);
  const receipts = store.state().receipts;
  await store.setHarnessEnabled("acme", false);
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await store.saveSkill({ ...skill, body: "keep", enabled: false }, skill.id);
  await engine.apply(engine.plan().id);
  assert.deepEqual(store.state().receipts, receipts);
  assert.match(
    fs.readFileSync(path.join(home, ".acme/ACME.md"), "utf8"),
    /original/,
  );
  await store.setHarnessEnabled("acme", true);
  assert.equal(
    engine.plan().changes.filter((c) => c.status === "remove").length,
    2,
  );
});
test("plugin targets retain conflict, symlink, rollback and removed-plugin protections", async (t) => {
  const { store, engine, home, write, pluginDir, dir } = await fixture(t);
  write("acme", acme);
  await store.saveSkill({
    name: "safe",
    description: "safe",
    body: "source",
    scope: { harnesses: ["acme"] },
  });
  const target = path.join(home, ".acme/skills/safe");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), "foreign");
  assert.ok(engine.plan().changes.some((c) => c.status === "conflict"));
  fs.rmSync(target, { recursive: true });
  fs.symlinkSync(dir, target);
  assert.ok(engine.plan().changes.some((c) => c.status === "conflict"));
  fs.unlinkSync(target);
  const deployment = await engine.apply(engine.plan().id);
  await engine.rollback(deployment.id!);
  assert.equal(fs.existsSync(target), false);
  await engine.apply(engine.plan().id);
  const receipt = store.state().receipts;
  fs.unlinkSync(path.join(pluginDir, "acme.json"));
  await engine.apply(engine.plan().id);
  assert.deepEqual(store.state().receipts, receipt);
  write("acme", acme);
  fs.appendFileSync(path.join(target, "SKILL.md"), "external edit");
  assert.ok(engine.plan().changes.some((c) => c.status === "conflict"));
});
test("all tool selections store the v0.4-compatible four-ID sentinel", async (t) => {
  const { store, write } = await fixture(t);
  write("acme", acme);
  const rule = await store.saveRule({
    title: "all",
    body: "all",
    scope: { harnesses: [...harnessIds, "acme"] },
  });
  assert.deepEqual(rule.scope.harnesses, harnessIds);
  assert.deepEqual(store.manifest().rules[0].scope.harnesses, harnessIds);
});
test("24 overlapping directories preserve exact placement within 100ms", () => {
  const ids = ["aa", "bb", "cc", "dd", "ee", "ff"];
  const readers = Array.from({ length: 24 }, (_, i) => ({
    dir: String(i),
    readers: [ids[i % 6], ids[(i + 1) % 6]],
    legacy: i >= 12,
  }));
  const start = performance.now();
  assert.equal(placeSkills(ids, readers, []).length, 3);
  assert.ok(performance.now() - start < 100);
});

test("bundled CLI finds packaged manifests outside the source tree", async (t) => {
  const { dir, home, store } = await fixture(t);
  const { buildSync } = await import("esbuild");
  const install = path.join(dir, "installed");
  for (const asset of ["harnesses", "schema", "skills"])
    fs.cpSync(path.resolve(asset), path.join(install, asset), {
      recursive: true,
    });
  fs.symlinkSync(
    path.resolve("node_modules"),
    path.join(install, "node_modules"),
    "dir",
  );
  buildSync({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(install, "dist/cli.js"),
  });
  fs.writeFileSync(path.join(install, "package.json"), '{"type":"module"}');
  const output = execFileSync(
    process.execPath,
    [path.join(install, "dist/cli.js"), "harness", "list", "--json"],
    {
      cwd: dir,
      env: { ...process.env, HOME: home, HARNESS_SYNC_HOME: store.root },
      encoding: "utf8",
    },
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.errors, []);
  assert.equal(result.harnesses.length, 4);
});

test("disabled scan-only readers do not block shared instruction updates or removals", async (t) => {
  const { store, engine, home, write } = await fixture(t);
  write("acme", {
    ...acme,
    instructions: {
      ...acme.instructions,
      global: [{ path: "~/.agents/AGENTS.md", kind: "main" }],
    },
  });
  const rule = await store.saveRule({
    title: "shared",
    body: "original",
    scope: { harnesses: ["acme"] },
  });
  await engine.apply(engine.plan().id);
  const target = path.join(home, ".agents/AGENTS.md");
  await store.setHarnessEnabled("deepseek", false);
  await store.saveRule({ ...rule, body: "changed" }, rule.id);
  await engine.apply(engine.plan().id);
  assert.match(fs.readFileSync(target, "utf8"), /changed/);
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await engine.apply(engine.plan().id);
  // A file HarnessSync created is removed with its last managed block.
  assert.ok(
    !fs.existsSync(target) ||
      !/original|changed/.test(fs.readFileSync(target, "utf8")),
  );
});

test("enabled instruction owner can replace a disabled owner's shared receipt", async (t) => {
  const { store, engine, home, write } = await fixture(t);
  write("acme", acme);
  write("peer", { ...acme, id: "peer" });
  const rule = await store.saveRule({
    title: "shared",
    body: "before",
    scope: { harnesses: ["acme", "peer"] },
  });
  await engine.apply(engine.plan().id);
  const target = path.join(home, ".acme/ACME.md");
  assert.equal(
    store.state().receipts.find((r) => r.path === target)!.harness,
    "acme",
  );
  await store.setHarnessEnabled("acme", false);
  await store.saveRule({ ...rule, body: "after" }, rule.id);
  await engine.apply(engine.plan().id);
  assert.match(fs.readFileSync(target, "utf8"), /after/);
  assert.equal(
    store.state().receipts.find((r) => r.path === target)!.harness,
    "peer",
  );
  await store.saveRule({ ...rule, enabled: false }, rule.id);
  await engine.apply(engine.plan().id);
  // A file HarnessSync created is removed with its last managed block.
  assert.ok(
    !fs.existsSync(target) ||
      !/before|after/.test(fs.readFileSync(target, "utf8")),
  );
});

test("plan warnings aggregate retained paths per owner, unknown IDs and invalid files", async (t) => {
  const { store, engine, write, pluginDir } = await fixture(t);
  write("acme", acme);
  for (const name of ["one", "two", "three"])
    await store.saveSkill({
      name,
      description: name,
      body: name,
      scope: { harnesses: ["acme"] },
    });
  await engine.apply(engine.plan().id);
  await store.setHarnessEnabled("acme", false);
  for (const title of ["first", "second"])
    await store.saveRule({
      title,
      body: "unknown",
      scope: { harnesses: ["unknown-tool"] },
    });
  write("bad", {
    ...acme,
    id: "bad",
    name: "",
    version: { command: "/bin/sh", args: ["-c"] },
  });
  let warnings = engine.plan().warnings!;
  assert.equal(warnings.filter((w) => w.includes("已停用")).length, 1);
  assert.ok(
    warnings.some((w) =>
      w.includes("Acme Agent 已停用：3 个已管理路径保持原样"),
    ),
  );
  assert.equal(
    warnings.filter((w) => w.includes("未知 Harness unknown-tool")).length,
    1,
  );
  const fileWarnings = warnings.filter((w) =>
    w.includes(path.join(pluginDir, "bad.json")),
  );
  assert.equal(fileWarnings.length, 1);
  assert.match(fileWarnings[0], /\$\.name/);
  assert.match(fileWarnings[0], /\$\.version\.command/);
  fs.unlinkSync(path.join(pluginDir, "acme.json"));
  warnings = engine.plan().warnings!;
  assert.equal(
    warnings.filter((w) => w.includes("acme 未安装：3 个")).length,
    1,
  );
  assert.equal(
    warnings.filter((w) => w.includes("未知 Harness acme")).length,
    1,
  );
});
