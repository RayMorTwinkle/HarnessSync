import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { placeSkills, skillReaders } from "../src/core/adapters.ts";
import {
  bundleDiskHash,
  bundleHash,
  legacyBundleHash,
  readBundle,
  writeBundle,
  writeJson,
  skillMarkdown,
  atomicWrite,
} from "../src/core/files.ts";
import { harnessIds, type HarnessId } from "../src/shared/types.ts";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-deploy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  return { dir, home, store, engine: new Engine(store) };
}
const subsets: [HarnessId[], string[]][] = [
  [[], []],
  [["deepseek"], [".dsh"]],
  [["opencode"], [".config/opencode"]],
  [["codex"], [".codex"]],
  [["claude"], [".claude"]],
  [
    ["deepseek", "opencode"],
    [".dsh", ".config/opencode"],
  ],
  [
    ["deepseek", "codex"],
    [".dsh", ".codex"],
  ],
  [
    ["deepseek", "claude"],
    [".dsh", ".claude"],
  ],
  [
    ["opencode", "codex"],
    [".config/opencode", ".codex"],
  ],
  [["opencode", "claude"], [".claude"]],
  [
    ["codex", "claude"],
    [".codex", ".claude"],
  ],
  [["deepseek", "opencode", "codex"], [".agents"]],
  [
    ["deepseek", "opencode", "claude"],
    [".dsh", ".claude"],
  ],
  [
    ["deepseek", "codex", "claude"],
    [".agents", ".claude"],
  ],
  [
    ["opencode", "codex", "claude"],
    [".codex", ".claude"],
  ],
  // OpenCode and DeepSeek collapse same-named copies, so two modern dirs suffice.
  [[...harnessIds], [".agents", ".claude"]],
];
for (const project of [false, true])
  test(`placement table: all 16 subsets (${project ? "project" : "global"})`, () => {
    const base = project ? "/tmp/project" : "/tmp/home";
    const readers = skillReaders("/tmp/home", project ? base : undefined);
    for (const [selected, expected] of subsets) {
      const actual = placeSkills(selected, readers)
        .map((r) => path.relative(base, path.dirname(r.dir)))
        .sort();
      assert.deepEqual(
        actual,
        expected
          .map((p) => (project && p === ".config/opencode" ? ".opencode" : p))
          .sort(),
        selected.join(","),
      );
    }
    const modern = readers.filter((r) => !r.legacy);
    assert.deepEqual(
      placeSkills([...harnessIds], modern)
        .map((r) => path.relative(base, path.dirname(r.dir)))
        .sort(),
      [".agents", ".claude"],
    );
    assert.equal(
      placeSkills(
        ["codex"],
        [
          { dir: "old", readers: ["codex"], legacy: true },
          { dir: "new", readers: ["codex"] },
        ],
      )[0].dir,
      "new",
    );
  });

test("upgrade removes owned redundant copies, accepts old receipt hashes, and rollback restores them", async (t) => {
  const { store, engine, home } = await fixture(t);
  const skill = await store.saveSkill({
    name: "upgrade",
    description: "Upgrade",
    body: "Body",
  });
  const bundle = readBundle(store.skillPath(skill.id));
  const oldDirs = [".dsh", ".config/opencode", ".agents", ".claude"];
  const receipts = oldDirs.map((dir, i) => {
    const target = path.join(home, dir, "skills", skill.name);
    writeBundle(target, bundle);
    return {
      kind: "skill",
      harness: harnessIds[i],
      path: target,
      hash: legacyBundleHash(bundle),
      sourceId: skill.id,
    };
  });
  writeJson(path.join(store.root, "state.json"), { receipts });
  const plan = engine.plan();
  assert.equal(plan.errors.length, 0);
  assert.ok(!plan.changes.some((c) => c.status === "conflict"));
  assert.equal(plan.changes.filter((c) => c.status === "remove").length, 2);
  assert.ok(
    plan.changes
      .filter((c) => c.status === "remove")
      .every((c) => /重复副本/.test(c.reason)),
  );
  const d = await engine.apply(plan.id);
  assert.equal(store.state().receipts.length, 2);
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
  await engine.rollback(d.id!);
  for (const receipt of receipts)
    assert.equal(bundleDiskHash(receipt.path), bundleHash(bundle));
  assert.deepEqual(store.state().receipts, receipts);
  fs.chmodSync(path.join(receipts[0].path, "SKILL.md"), 0o700);
  assert.ok(
    engine
      .plan()
      .changes.some(
        (c) => c.path === receipts[0].path && c.status === "conflict",
      ),
  );
});

test("new hash is byte/mode/path sensitive and old snapshots remain rollback compatible", async (t) => {
  const { store, engine } = await fixture(t);
  const skill = await store.saveSkill({
    name: "compat",
    description: "Compat",
    body: "First",
  });
  const first = await engine.apply(engine.plan().id);
  const snapshot = path.join(store.root, "deployments", `${first.id}.json`);
  const record = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  for (const f of record.files)
    f.afterHash = legacyBundleHash(readBundle(f.path));
  writeJson(snapshot, record);
  await engine.rollback(first.id!);
  assert.ok(
    record.files.every((f: { path: string }) => !fs.existsSync(f.path)),
  );
  const source = store.skillPath(skill.id);
  const original = bundleDiskHash(source);
  assert.equal(original, bundleHash(readBundle(source)));
  fs.renameSync(path.join(source, "SKILL.md"), path.join(source, "RENAMED.md"));
  assert.notEqual(bundleDiskHash(source), original);
});

test("plan reports staging; apply cleans only owned leftovers, retaining rename backups and foreign dirs", async (t) => {
  const { home, engine } = await fixture(t);
  const root = path.join(home, ".agents/skills");
  fs.mkdirSync(root, { recursive: true });
  const stage = path.join(root, `.hsync-staging-${crypto.randomUUID()}`);
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, "SKILL.md"), "partial");
  writeJson(`${stage}.json`, {
    format: "harness-sync-staging-v1",
    target: "sample",
  });
  const foreign = path.join(root, `.hsync-staging-${crypto.randomUUID()}`);
  fs.mkdirSync(foreign);
  const originalPlan = engine.plan();
  assert.ok(originalPlan.warnings?.some((w) => w.includes(stage)));
  assert.ok(fs.existsSync(stage), "plan stays read-only");
  fs.appendFileSync(path.join(stage, "SKILL.md"), "changed after preview");
  await assert.rejects(engine.apply(originalPlan.id), /重新预览/);
  await engine.apply(engine.plan().id);
  assert.ok(!fs.existsSync(stage));
  assert.ok(!fs.existsSync(`${stage}.json`));
  assert.ok(fs.existsSync(foreign));
});

test("successful apply retains latest 20 snapshots plus older pending/failed records; latest rollback works", async (t) => {
  const { store, engine } = await fixture(t);
  const dir = path.join(store.root, "deployments");
  for (let i = 0; i < 24; i++)
    writeJson(path.join(dir, `${1000 + i}-abcdefab.json`), {
      id: `${1000 + i}-abcdefab`,
      date: "2020-01-01",
      changes: 0,
      status: i === 0 ? "failed" : "applied",
      beforeState: { receipts: [] },
      files: [],
    });
  await store.saveRule({ title: "Retention", body: "hello" });
  const deployment = await engine.apply(engine.plan().id);
  assert.equal(fs.readdirSync(dir).length, 21);
  assert.ok(fs.existsSync(path.join(dir, "1000-abcdefab.json")));
  await engine.rollback(deployment.id!);
  assert.equal(store.state().receipts.length, 0);
  // A pending record beyond the former 40-record display cap still blocks apply.
  for (let i = 0; i < 45; i++)
    writeJson(path.join(dir, `${2000 + i}-abcdefab.json`), {
      id: `${2000 + i}-abcdefab`,
      date: "2020-01-01",
      changes: 0,
      status: i === 0 ? "pending" : "failed",
      beforeState: { receipts: [] },
      files: [],
    });
  assert.ok(engine.plan().errors.some((e) => /未完成/.test(e)));
});

test("40 skills: planning reads resource bytes once, then reuses hashes; resource edits invalidate plan", async (t) => {
  const { store, engine } = await fixture(t);
  store.commit = () => {}; // Benchmark filesystem planning, without 40 unrelated git commits.
  for (let i = 0; i < 40; i++) {
    const skill = await store.saveSkill({
      name: `sample-${i}`,
      description: "Performance",
      body: "Body",
    });
    fs.writeFileSync(
      path.join(store.skillPath(skill.id), "resource.bin"),
      Buffer.alloc(4096, i),
    );
  }
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  let reads = 0,
    fullResourceReads = 0;
  fs.readSync = ((...args: any[]) => {
    const n = (originalRead as any)(...args);
    if (n > 0) reads++;
    return n;
  }) as typeof fs.readSync;
  fs.readFileSync = ((...args: any[]) => {
    if (String(args[0]).endsWith("resource.bin")) fullResourceReads++;
    return (originalReadFile as any)(...args);
  }) as typeof fs.readFileSync;
  try {
    const start = performance.now();
    const plan = engine.plan();
    assert.equal(plan.errors.length, 0);
    assert.ok(plan.changes.every((c) => !c.files));
    assert.ok(reads <= 80, `expected <= 80 content reads, got ${reads}`);
    assert.equal(fullResourceReads, 0);
    t.diagnostic(
      `40 skills cold plan: ${(performance.now() - start).toFixed(1)} ms, ${reads} file reads`,
    );
    reads = 0;
    assert.equal(engine.plan().id, plan.id);
    assert.equal(reads, 0, "warm hashes avoid rereading bytes");
    const source = store.skillPath(store.manifest().skills[0].id);
    fs.writeFileSync(
      path.join(source, "resource.bin"),
      Buffer.alloc(4096, 255),
    );
    assert.notEqual(engine.plan().id, plan.id);
    assert.equal(reads, 1);
  } finally {
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
  }
});

test("instructions preserve mode, default to 0644, and atomic temporary paths are hidden", async (t) => {
  const { store, engine, home } = await fixture(t);
  const file = path.join(home, ".dsh/AGENTS.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Existing", { mode: 0o640 });
  await store.saveRule({ title: "Mode", body: "Body" });
  await engine.apply(engine.plan().id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(
    fs.statSync(path.join(home, ".claude/CLAUDE.md")).mode & 0o777,
    0o644,
  );
  const rename = fs.renameSync;
  const temporary: string[] = [];
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    temporary.push(path.basename(String(from)));
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    atomicWrite(path.join(home, "atomic"), "test");
    writeBundle(path.join(home, "skills/mode"), {
      "SKILL.md": {
        content: Buffer.from(skillMarkdown("mode", "Mode", "")).toString(
          "base64",
        ),
        mode: 0o640,
      },
    });
  } finally {
    fs.renameSync = rename;
  }
  assert.ok(temporary.every((name) => name.startsWith(".hsync-")));
  assert.equal(
    fs.statSync(path.join(home, "skills/mode/SKILL.md")).mode & 0o777,
    0o640,
  );
});

test("plain import from shared .agents target auto-adopts without rewriting any native files", async (t) => {
  const { store, engine, home } = await fixture(t);
  const target = path.join(home, ".agents/skills/shared");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "SKILL.md"),
    skillMarkdown("shared", "Shared", "Original"),
  );
  await store.importSkill(target, {
    kind: "global",
    harnesses: ["deepseek", "opencode", "codex"],
  });
  const plan = engine.plan();
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].status, "adopt");
  const original = fs.statSync(path.join(target, "SKILL.md"));
  const rename = fs.renameSync;
  const nativeWrites: string[] = [];
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).startsWith(path.join(home, ".agents")))
      nativeWrites.push(String(to));
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    const d = await engine.apply(plan.id);
    assert.equal(store.state().receipts.length, 1);
    await engine.rollback(d.id!);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(nativeWrites, []);
  assert.equal(fs.statSync(path.join(target, "SKILL.md")).ino, original.ino);
  assert.equal(
    fs.statSync(path.join(target, "SKILL.md")).mtimeMs,
    original.mtimeMs,
  );
});

test("staging with an interrupted rename backup is detected and retained for recovery", async (t) => {
  const { home, engine } = await fixture(t);
  const root = path.join(home, ".agents/skills");
  fs.mkdirSync(root, { recursive: true });
  const stage = path.join(root, `.hsync-staging-${crypto.randomUUID()}`);
  fs.mkdirSync(`${stage}-old`);
  fs.writeFileSync(path.join(`${stage}-old`, "SKILL.md"), "only original");
  writeJson(`${stage}.json`, {
    format: "harness-sync-staging-v1",
    target: "sample",
  });
  const plan = engine.plan();
  assert.ok(plan.errors.some((e) => /原件备份/.test(e)));
  await assert.rejects(engine.apply(plan.id));
  assert.ok(fs.existsSync(`${stage}-old`));
});

test("failed promotion and failed restoration retain the only original bundle with ownership evidence", async (t) => {
  const { home, engine } = await fixture(t);
  const target = path.join(home, ".agents/skills/original");
  const bundle = {
    "SKILL.md": {
      content: Buffer.from("original bytes").toString("base64"),
      mode: 0o644,
    },
  };
  writeBundle(target, bundle);
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) throw new Error("injected rename failure");
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => writeBundle(target, bundle), /injected/);
  } finally {
    fs.renameSync = rename;
  }
  const root = path.dirname(target);
  const backup = fs.readdirSync(root).find((name) => name.endsWith("-old"))!;
  assert.ok(backup);
  assert.equal(
    fs.readFileSync(path.join(root, backup, "SKILL.md"), "utf8"),
    "original bytes",
  );
  assert.ok(fs.existsSync(path.join(root, backup.slice(0, -4) + ".json")));
  assert.ok(engine.plan().errors.some((e) => /原件备份/.test(e)));
});

test("source mutation during apply is refused before writing a bundle and preserves receipts", async (t) => {
  const { store, engine } = await fixture(t);
  const skill = await store.saveSkill({
    name: "changing",
    description: "Changing",
    body: "Before",
  });
  const plan = engine.plan();
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const result = rename(from, to);
    if (path.dirname(String(to)) === path.join(store.root, "deployments"))
      fs.writeFileSync(
        path.join(store.skillPath(skill.id), "SKILL.md"),
        skillMarkdown("changing", "Changing", "After"),
      );
    return result;
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(engine.apply(plan.id), /源 Skill 变化/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(store.state().receipts.length, 0);
  assert.ok(plan.changes.every((c) => !fs.existsSync(c.path)));
  assert.equal(engine.deployments()[0].status, "failed");
});

test("cached bundle hashes never bypass symlink target refusal", async (t) => {
  const { store, engine } = await fixture(t);
  await store.saveSkill({ name: "links", description: "Links", body: "Body" });
  await engine.apply(engine.plan().id);
  const target = engine.plan().changes[0].path;
  fs.renameSync(target, `${target}-original`);
  fs.symlinkSync(`${target}-original`, target);
  const plan = engine.plan();
  assert.equal(plan.changes.find((c) => c.path === target)?.status, "conflict");
  await assert.rejects(engine.apply(plan.id));
  assert.ok(fs.existsSync(path.join(`${target}-original`, "SKILL.md")));
});

test("configured global roots do not grant shared readers to relocated DeepSeek or Claude directories", async (t) => {
  const { home } = await fixture(t);
  const overrides = {
    HOME: home,
    DSH_HOME: path.join(home, "custom-dsh"),
    DSH_AGENTS_HOME: path.join(home, "custom-agents"),
    CODEX_HOME: path.join(home, "custom-codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "custom-claude"),
    XDG_CONFIG_HOME: path.join(home, "custom-config"),
  };
  const before = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, overrides);
  try {
    const readers = skillReaders(home);
    assert.deepEqual(
      readers.find((r) => r.dir === path.join(home, "custom-agents/skills"))
        ?.readers,
      ["deepseek"],
    );
    assert.deepEqual(
      readers.find((r) => r.dir === path.join(home, "custom-claude/skills"))
        ?.readers,
      ["claude"],
    );
    assert.deepEqual(
      readers.find((r) => r.dir === path.join(home, ".claude/skills"))?.readers,
      ["opencode"],
    );
    assert.deepEqual(
      readers.find((r) => r.dir === path.join(home, ".agents/skills"))?.readers,
      ["codex", "opencode"],
    );
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
