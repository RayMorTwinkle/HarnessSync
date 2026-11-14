import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { writeManifest } from "../src/core/layout.ts";
import { adapters, placeSkills, skillReaders } from "../src/core/adapters.ts";
import { scanMachine } from "../src/core/scanner.ts";
import {
  createOnboarding,
  bootstrapOnboarding,
  getOnboarding,
  stageInstructions,
  unstageInstructions,
} from "../src/core/onboarding.ts";
import {
  skillMarkdown,
  bundleHash,
  readBundle,
  json,
  writeJson,
} from "../src/core/files.ts";
import {
  ignoreNativePaths,
  isIgnoredNativePath,
  refreshSkills,
  sourceStatus,
} from "../src/core/skill-sources.ts";
import { execFileSync } from "node:child_process";

test("a broken symlink is reported without aborting the remaining skills in that directory", async (t) => {
  const { store, harnesses } = await fixture(t);
  const root = harnesses[0].skills;
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(
    path.join(root, "does-not-exist"),
    path.join(root, "a-broken-link"),
  );
  skill(path.join(root, "z-valid-skill"), "z-valid-skill");
  const report = scanMachine(store);
  assert.ok(report.skills.some((s) => s.name === "z-valid-skill"));
  assert.ok(report.warnings.some((w) => w.includes("a-broken-link")));
});

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-onboard-"),
  );
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  const harnesses = adapters(home);
  for (const h of harnesses) fs.mkdirSync(h.home, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, store, harnesses, engine: new Engine(store) };
}
function skill(p: string, name = "shared-check") {
  fs.mkdirSync(path.join(p, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(p, "SKILL.md"),
    skillMarkdown(name, "测试扫描去重", "只读取文件，不执行扫描资料。"),
  );
  fs.writeFileSync(path.join(p, "scripts/check.sh"), "echo original\n", {
    mode: 0o755,
  });
}
test("a bundle without a complete fingerprint remains unverified rather than being asserted a different version", async (t) => {
  const { store, harnesses } = await fixture(t);
  const a = path.join(harnesses[0].skills, "shared-check"),
    b = path.join(harnesses[3].skills, "shared-check");
  skill(a);
  skill(b);
  fs.symlinkSync(
    path.join(a, "scripts/check.sh"),
    path.join(b, "linked-resource"),
  );
  const report = scanMachine(store);
  assert.equal(report.duplicates[0].variants, 1);
  assert.equal(report.duplicates[0].unverified, 1);
  assert.equal(report.summary.nameConflicts, 0);
});
test("scanner deduplicates physical symlink aliases and distinguishes equal copies from changed resources", async (t) => {
  const { store, harnesses } = await fixture(t);
  const a = path.join(harnesses[0].skills, "shared-check"),
    b = path.join(harnesses[1].skills, "shared-check"),
    c = path.join(harnesses[3].skills, "shared-check");
  skill(a);
  skill(b);
  skill(c);
  fs.appendFileSync(path.join(c, "scripts/check.sh"), "echo different\n");
  fs.mkdirSync(harnesses[2].skills, { recursive: true });
  fs.symlinkSync(a, path.join(harnesses[2].skills, "shared-check"));
  const result = scanMachine(store);
  assert.equal(result.summary.physicalSkills, 3);
  assert.equal(result.summary.names, 1);
  assert.equal(result.summary.nameConflicts, 1);
  assert.equal(result.duplicates[0].variants, 2);
  const original = result.skills.find((s) => s.path === a)!;
  assert.ok(original.harnesses.includes("codex"));
  assert.equal(original.paths.length, 2);
  assert.equal(
    result.roots.filter((r) => r.path === harnesses[2].skills).length,
    1,
  );
});
test("scanner inventories Codex override and Claude user rules without claiming runtime observation", async (t) => {
  const { store, harnesses } = await fixture(t);
  const codex = harnesses.find((h) => h.id === "codex")!,
    claude = harnesses.find((h) => h.id === "claude")!;
  fs.writeFileSync(codex.instructions, "base");
  fs.writeFileSync(path.join(codex.home, "AGENTS.override.md"), "override");
  fs.mkdirSync(path.join(claude.home, "rules"));
  fs.writeFileSync(path.join(claude.home, "rules/local.md"), "local rule");
  const report = scanMachine(store);
  assert.equal(
    report.instructions.find((i) => i.path === codex.instructions)?.active,
    false,
  );
  assert.equal(
    report.instructions.find((i) => i.kind === "override")?.active,
    true,
  );
  assert.ok(report.instructions.some((i) => i.kind === "rules" && i.exists));
  assert.equal(
    adapters(store.home).find((h) => h.id === "codex")!.instructions,
    path.join(codex.home, "AGENTS.override.md"),
  );
});
test("bootstrap installs Chinese management bundle to all four and leaves native instructions and unrelated pending changes intact", async (t) => {
  const { store, harnesses, engine } = await fixture(t);
  for (const h of harnesses) fs.writeFileSync(h.instructions, `原件-${h.id}`);
  await store.saveRule({ title: "未完成的变量", body: "{{vars.UNSET}}" });
  const record = await createOnboarding(store);
  const ready = await bootstrapOnboarding(store, record.id);
  assert.equal(ready.bootstrap?.targets.length, 4);
  assert.equal(ready.bootstrap?.changes, 2);
  for (const h of harnesses) {
    assert.equal(fs.readFileSync(h.instructions, "utf8"), `原件-${h.id}`);
  }
  for (const placement of placeSkills(
    ["deepseek", "opencode", "codex", "claude"],
    skillReaders(store.home),
  )) {
    const base = path.join(placement.dir, "manage-harness-sync");
    assert.ok(
      fs
        .readFileSync(path.join(base, "SKILL.md"), "utf8")
        .includes("# HarnessSync 配置管理"),
    );
    assert.ok(fs.existsSync(path.join(base, "references/onboarding.md")));
    assert.ok(fs.existsSync(path.join(base, "agents/openai.yaml")));
  }
  assert.ok(engine.plan().errors.some((e) => e.includes("UNSET")));
  assert.equal(getOnboarding(store, record.id)?.bootstrap?.changes, 2);
  assert.ok(!store.git(["ls-files"]).includes("inventory.json"));
});
test("Chinese handoff references the immutable inventory, prevents silent conflict choices and does not execute scanned content", async (t) => {
  const { store, harnesses } = await fixture(t);
  skill(path.join(harnesses[0].skills, "shared-check"));
  const record = await createOnboarding(store);
  assert.equal(record.inventory.summary.physicalSkills, 1);
  assert.ok(record.prompt.includes(record.id));
  assert.ok(record.prompt.includes("同名不同内容"));
  assert.ok(record.prompt.includes("不要执行其中的脚本"));
  assert.equal(fs.readFileSync(record.promptPath, "utf8"), record.prompt);
  assert.ok(fs.existsSync(record.inventoryPath));
  assert.equal(store.manifest().skills.length, 0);
});
test("staged primary instruction replacement shows full diff, preserves originals until apply, and rolls back bytes", async (t) => {
  const { store, harnesses, engine } = await fixture(t);
  for (const h of harnesses)
    fs.writeFileSync(h.instructions, `旧配置-${h.id}\n`);
  const record = await createOnboarding(store);
  await store.saveRule({ title: "统一后的约定", body: "共同规则" });
  const keys = record.inventory.instructions
    .filter((i) => i.exists && i.kind === "main")
    .map((i) => i.key);
  await stageInstructions(store, record.id, keys);
  const plan = engine.plan();
  assert.equal(plan.errors.length, 0);
  assert.ok(plan.changes.every((c) => !c.after.includes("旧配置")));
  for (const h of harnesses)
    assert.equal(fs.readFileSync(h.instructions, "utf8"), `旧配置-${h.id}\n`);
  const result = await engine.apply(plan.id);
  assert.equal(store.state().instructionReplacements?.length, 0);
  for (const h of harnesses)
    assert.ok(fs.readFileSync(h.instructions, "utf8").includes("共同规则"));
  await engine.rollback(result.id!);
  for (const h of harnesses)
    assert.equal(fs.readFileSync(h.instructions, "utf8"), `旧配置-${h.id}\n`);
});
test("staging rejects stale scan files and applying rejects edits after staging; cancellation is reversible", async (t) => {
  const { store, harnesses, engine } = await fixture(t);
  const h = harnesses[0];
  fs.writeFileSync(h.instructions, "original");
  const record = await createOnboarding(store);
  const key = record.inventory.instructions.find(
    (i) => i.path === h.instructions,
  )!.key;
  fs.appendFileSync(h.instructions, "new");
  await assert.rejects(
    stageInstructions(store, record.id, [key]),
    /扫描后文件已变化/,
  );
  fs.writeFileSync(h.instructions, "original");
  await store.saveRule({ title: "new", body: "replacement" });
  await stageInstructions(store, record.id, [key]);
  fs.appendFileSync(h.instructions, "changed");
  assert.ok(engine.plan().changes.some((c) => c.status === "conflict"));
  await assert.rejects(engine.apply(engine.plan().id));
  await unstageInstructions(store);
  assert.equal(store.state().instructionReplacements?.length, 0);
  assert.equal(fs.readFileSync(h.instructions, "utf8"), "originalchanged");
});
test("Claude project instructions can be separate while shared AGENTS requires all three readers", async (t) => {
  const { dir, store, engine } = await fixture(t);
  const project = await store.saveProject({ name: "Example", path: dir });
  await store.saveRule({
    title: "Claude only",
    body: "Claude workflow",
    scope: { kind: "project", target: project.id, harnesses: ["claude"] },
  });
  let plan = engine.plan();
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].path, path.join(dir, "CLAUDE.md"));
  await store.saveRule({
    title: "Codex only",
    body: "Cannot isolate through shared file",
    scope: { kind: "project", target: project.id, harnesses: ["codex"] },
  });
  assert.ok(engine.plan().errors.some((e) => e.includes("共用项目 AGENTS.md")));
});

// v0.3: all native fixtures stay under the test home.
const linkedScope = {
  kind: "global" as const,
  harnesses: ["deepseek" as const, "opencode" as const, "codex" as const],
};
const codexScope = { kind: "global" as const, harnesses: ["codex" as const] };

test("origins exclude synced, system markers and lock-managed skills from default import", async (t) => {
  const { store, home } = await fixture(t);
  const entries = [
    [".claude/skills/synced/uuid/cloud-skill", "cloud-skill", "platform"],
    [".codex/skills/.system/system-skill", "system-skill", "system"],
    [".dsh/skills/builtin/marked-skill", "marked-skill", "system"],
    [".agents/skills/locked-skill", "locked-skill", "tool-managed"],
    [".config/opencode/skills/other-locked", "other-locked", "tool-managed"],
    [".agents/skills/user-skill", "user-skill", "user"],
  ];
  for (const [p, name] of entries) skill(path.join(home, p), name);
  fs.writeFileSync(
    path.join(home, ".dsh/skills/builtin/.codex-system-skills.marker"),
    "",
  );
  writeJson(path.join(home, ".agents/.skill-lock.json"), {
    version: 1,
    skills: {
      "locked-skill": {
        source: "owner/repo",
        sourceUrl: "https://example.test/skill",
      },
    },
  });
  writeJson(path.join(home, ".config/opencode/skills-lock.json"), {
    version: 1,
    skills: { "other-locked": { source: "other/repo" } },
  });
  const scan = scanMachine(store);
  for (const [, name, origin] of entries) {
    assert.equal(
      scan.skills.find((s) => s.name === name)?.origin,
      origin,
      name,
    );
    assert.ok(scan.skills.find((s) => s.name === name)?.originReason);
  }
  assert.equal(
    scan.skills.find((s) => s.name === "locked-skill")?.sourceUrl,
    "https://example.test/skill",
  );
  assert.equal(scan.summary.importableSkills, 1);
  assert.equal(scan.summary.excludedSkills, 5);
  // Plugin skills are namespaced by Claude Code and never scanned as user skills.
  skill(
    path.join(
      home,
      ".claude/plugins/cache/vendor/plugin/1/skills/plugin-skill",
    ),
    "plugin-skill",
  );
  assert.ok(!scanMachine(store).skills.some((s) => s.name === "plugin-skill"));
  const record = await createOnboarding(store);
  assert.match(record.prompt, /origin=platform\/tool-managed\/system 默认排除/);
  assert.match(record.prompt, /排除 5 个/);
  assert.match(record.prompt, /一个分组问题/);
  assert.match(record.prompt, /跨设备同步（可选）/);
});

test("malformed locks warn once and do not block other skills", async (t) => {
  const { store, home } = await fixture(t);
  skill(path.join(home, ".agents/skills/one"), "one");
  skill(path.join(home, ".agents/skills/two"), "two");
  const lock = path.join(home, ".agents/.skill-lock.json");
  for (const malformed of ["{broken", '{"skills":null}', '{"skills":[]}']) {
    fs.writeFileSync(lock, malformed);
    const scan = scanMachine(store);
    assert.equal(scan.summary.importableSkills, 2);
    assert.equal(scan.warnings.filter((w) => w.includes(lock)).length, 1);
  }
});

test("invalid skills explain missing SKILL.md, offending name and empty description without fixing files", async (t) => {
  const { store, home } = await fixture(t);
  const root = path.join(home, ".agents/skills");
  const missing = path.join(root, "missing");
  fs.mkdirSync(missing, { recursive: true });
  skill(path.join(root, "invalid-name"), "Bad_Name");
  skill(path.join(root, "empty-description"), "empty-description");
  const emptyFile = path.join(root, "empty-description/SKILL.md");
  fs.writeFileSync(
    emptyFile,
    "---\nname: empty-description\ndescription: ''\n---\n",
  );
  const scan = scanMachine(store);
  assert.match(
    scan.skills.find((s) => s.path === missing)!.error!,
    /缺少 SKILL.md/,
  );
  const invalid = scan.skills.find((s) => s.path.endsWith("invalid-name"))!;
  assert.match(invalid.error!, /Bad_Name/);
  assert.match(invalid.error!, /bad-name/);
  assert.match(
    scan.skills.find((s) => s.path.endsWith("empty-description"))!.error!,
    /description 为空/,
  );
  assert.equal(scan.skills.filter((s) => s.valid).length, 0);
  assert.equal(fs.existsSync(path.join(missing, "SKILL.md")), false);
});

test("adopted link is replaced only on apply and rollback restores its literal relative target", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/linked-check");
  const native = path.join(home, ".agents/skills/linked-check");
  skill(source, "linked-check");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  const link = path.relative(path.dirname(native), source);
  fs.symlinkSync(link, native);
  const scanned = scanMachine(store).skills.find(
    (s) => s.name === "linked-check",
  )!;
  assert.equal(scanned.linked, true);
  assert.equal(scanned.path, source);
  assert.deepEqual(scanned.paths, [native]);
  const imported = await store.importSkill(
    native,
    linkedScope,
    undefined,
    true,
  );
  assert.equal(store.device().origins?.[imported.id], native);
  assert.equal(store.device().originRealPaths?.[imported.id], source);
  assert.equal(imported.source, "local-import");
  const plan = engine.plan();
  assert.equal(plan.changes[0].reason, "以副本替换链接");
  assert.equal(plan.changes[0].status, "update");
  assert.equal(fs.readlinkSync(native), link);
  const deployed = await engine.apply(plan.id);
  assert.equal(fs.lstatSync(native).isSymbolicLink(), false);
  assert.equal(bundleHash(readBundle(native)), bundleHash(readBundle(source)));
  const snapshot = json<any>(
    path.join(store.root, "deployments", `${deployed.id}.json`),
  );
  assert.equal(snapshot.files[0].link, link);
  fs.appendFileSync(path.join(source, "scripts/check.sh"), "echo dev update\n");
  assert.equal(sourceStatus(store)[0].changed, true);
  assert.match(engine.plan().warnings!.join("\n"), /源目录有更新/);
  await refreshSkills(store, [imported.id]);
  assert.equal(sourceStatus(store)[0].changed, false);
  // Refresh updates the library, leaving both native and dev source for explicit deployment.
  assert.notEqual(
    bundleHash(readBundle(native)),
    bundleHash(readBundle(source)),
  );
  await engine.rollback(deployed.id!);
  assert.equal(fs.readlinkSync(native), link);
  assert.match(
    fs.readFileSync(path.join(source, "scripts/check.sh"), "utf8"),
    /dev update/,
  );
});

test("plain link import never authorizes replacement; adoption refuses changed links and symlink ancestors", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/linked-check");
  skill(source, "linked-check");
  const root = path.join(home, ".agents/skills");
  fs.mkdirSync(root, { recursive: true });
  const native = path.join(root, "linked-check");
  fs.symlinkSync(source, native);
  await store.importSkill(native, linkedScope);
  assert.equal(engine.plan().changes[0].status, "conflict");
  await store.importSkill(native, linkedScope, undefined, true);
  const plan = engine.plan();
  fs.appendFileSync(path.join(source, "scripts/check.sh"), "echo changed\n");
  await assert.rejects(engine.apply(plan.id), /重新预览/);
  assert.equal(engine.plan().changes[0].status, "conflict");
  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(path.dirname(source), root);
  const other = new Store(path.join(dir, "other-store"), home);
  await other.init();
  await assert.rejects(
    other.importSkill(
      path.join(root, "linked-check"),
      codexScope,
      undefined,
      true,
    ),
    /符号链接路径/,
  );
});

test("external reservation survives reopening and is info only even for a matching library skill", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/linked-check");
  skill(source, "linked-check");
  const native = path.join(home, ".agents/skills/linked-check");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync(source, native);
  await ignoreNativePaths(store, [native]);
  await store.importSkill(source, linkedScope);
  const reopened = await new Store(store.root, home).init();
  assert.equal(isIgnoredNativePath(reopened, native), true);
  assert.equal(scanMachine(reopened).summary.ignoredSkills, 1);
  assert.equal(scanMachine(reopened).summary.importableSkills, 0);
  const plan = engine.plan();
  assert.equal(plan.changes[0].status, "unchanged");
  assert.match(plan.changes[0].reason, /外部保留/);
  assert.equal(plan.errors.length, 0);
  assert.equal((await engine.apply(plan.id)).changes, 0);
  assert.equal(fs.readlinkSync(native), source);
  await assert.rejects(
    store.importSkill(native, linkedScope, undefined, true),
    /外部保留/,
  );
  await ignoreNativePaths(store, [native], false);
  assert.equal(engine.plan().changes[0].status, "conflict");
});

test("refresh replaces the full bundle, preserves metadata and migrates legacy absolute sources locally", async (t) => {
  const { store, dir } = await fixture(t);
  const source = path.join(dir, "dev/refresh-check");
  skill(source, "refresh-check");
  const entry = await store.importSkill(source, codexScope);
  await store.saveSkill(
    {
      ...entry,
      displayName: "自定义显示名",
      enabled: false,
      body: "library text",
    },
    entry.id,
  );
  fs.rmSync(path.join(source, "scripts/check.sh"));
  fs.writeFileSync(path.join(source, "new.bin"), Buffer.from([0, 255, 127]));
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    skillMarkdown("refresh-check", "更新说明", "new body", { custom: true }),
  );
  assert.equal(sourceStatus(store)[0].changed, true);
  const result = await refreshSkills(store, [entry.id]);
  assert.equal(result[0].changed, true);
  assert.equal(
    bundleHash(readBundle(store.skillPath(entry.id))),
    bundleHash(readBundle(source)),
  );
  const refreshed = store.manifest().skills[0];
  assert.deepEqual(refreshed.scope, entry.scope);
  assert.equal(refreshed.displayName, "自定义显示名");
  assert.equal(refreshed.enabled, false);
  assert.equal(refreshed.description, "更新说明");
  assert.equal((await refreshSkills(store, [entry.id]))[0].changed, false);
  // Fixture for the former manifest source field.
  const manifest = store.manifest();
  manifest.skills[0].source = source;
  writeManifest(store.repo, manifest);
  const device = store.device();
  delete device.origins;
  writeJson(path.join(store.root, "device.json"), device);
  assert.equal(sourceStatus(store)[0].source, source);
  await refreshSkills(store, [entry.id]);
  assert.equal(store.manifest().skills[0].source, "local-import");
  assert.equal(store.device().origins?.[entry.id], source);
  assert.ok(
    !store
      .git(["show", `HEAD:entries/skills/${entry.id}.json`])
      .includes(source),
  );
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    skillMarkdown("renamed", "说明", "changed"),
  );
  await assert.rejects(refreshSkills(store, [entry.id]), /源技能名称已变化/);
  assert.equal(store.manifest().skills[0].name, "refresh-check");
});

test("CLI refresh --all and doctor expose source updates using a temp HOME", async (t) => {
  const { store, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/cli-check");
  skill(source, "cli-check");
  await store.importSkill(source, codexScope);
  const env = {
    ...process.env,
    HOME: home,
    HARNESS_SYNC_HOME: store.root,
  };
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args, "--json"],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 },
      ),
    );
  fs.appendFileSync(path.join(source, "scripts/check.sh"), "echo changed\n");
  assert.equal(cli("doctor").sourceUpdates[0].note, "源目录有更新");
  assert.equal(cli("skills", "refresh", "--all")[0].changed, true);
  // doctor lists only sources that changed or cannot be read.
  assert.deepEqual(cli("doctor").sourceUpdates, []);
});

test("link replacement failure restores the link and deployment rollback rejects subsequent copy edits", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/failure-check");
  skill(source, "failure-check");
  const native = path.join(home, ".agents/skills/failure-check");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync(source, native);
  await store.importSkill(native, linkedScope, undefined, true);
  const originalRename = fs.renameSync;
  let fail = true;
  const mock = t.mock.method(
    fs,
    "renameSync",
    (from: fs.PathLike, to: fs.PathLike) => {
      if (fail && String(to) === native && String(from).includes(".hsync-")) {
        fail = false;
        throw new Error("injected replacement failure");
      }
      return originalRename(from, to);
    },
  );
  await assert.rejects(
    engine.apply(engine.plan().id),
    /injected replacement failure/,
  );
  mock.mock.restore();
  assert.equal(fs.readlinkSync(native), source);
  assert.ok(store.state().receipts[0].adoptedLink);
  const result = await engine.apply(engine.plan().id);
  fs.appendFileSync(
    path.join(native, "scripts/check.sh"),
    "echo native edit\n",
  );
  await assert.rejects(engine.rollback(result.id!), /目标有部署后的新修改/);
  assert.equal(fs.lstatSync(native).isSymbolicLink(), false);
  assert.ok(
    !fs
      .readFileSync(path.join(source, "scripts/check.sh"), "utf8")
      .includes("native edit"),
  );
});

test("adoption checks literal link changes and linked ancestors introduced after planning", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/drift-check");
  skill(source, "drift-check");
  const root = path.join(home, ".agents/skills");
  fs.mkdirSync(root, { recursive: true });
  const native = path.join(root, "drift-check");
  fs.symlinkSync(source, native);
  await store.importSkill(native, linkedScope, undefined, true);
  const plan = engine.plan();
  fs.unlinkSync(native);
  fs.symlinkSync(path.relative(root, source), native);
  assert.equal(engine.plan().changes[0].status, "conflict");
  await assert.rejects(engine.apply(plan.id), /重新预览/);
  fs.unlinkSync(native);
  fs.symlinkSync(source, native);
  const moved = path.join(dir, "moved-root");
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root);
  assert.match(engine.plan().changes[0].reason, /符号链接路径/);
  await assert.rejects(engine.apply(plan.id), /重新预览/);
  assert.equal(fs.readlinkSync(path.join(moved, "drift-check")), source);
});

test("refresh all is atomic on invalid sources and reports missing source directories", async (t) => {
  const { store, dir } = await fixture(t);
  const a = path.join(dir, "dev/first"),
    b = path.join(dir, "dev/second");
  skill(a, "first");
  skill(b, "second");
  const first = await store.importSkill(a, codexScope);
  const second = await store.importSkill(b, codexScope);
  const before = bundleHash(readBundle(store.skillPath(first.id)));
  fs.appendFileSync(path.join(a, "scripts/check.sh"), "echo changed\n");
  fs.rmSync(path.join(b, "SKILL.md"));
  await assert.rejects(
    refreshSkills(store, [first.id, second.id]),
    /缺少 SKILL.md/,
  );
  assert.equal(bundleHash(readBundle(store.skillPath(first.id))), before);
  fs.rmSync(b, { recursive: true });
  assert.match(
    sourceStatus(store).find((s) => s.id === second.id)!.note,
    /源目录无法读取/,
  );
  const manual = await store.saveSkill({
    name: "manual",
    description: "说明",
    body: "手工",
  });
  await assert.rejects(refreshSkills(store, [manual.id]), /没有本机源目录/);
});

test("pending snapshot recovers an interrupted link replacement after unlink", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/pending-check");
  skill(source, "pending-check");
  const native = path.join(home, ".agents/skills/pending-check");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync(source, native);
  await store.importSkill(native, linkedScope, undefined, true);
  const result = await engine.apply(engine.plan().id);
  const file = path.join(store.root, "deployments", `${result.id}.json`);
  const record = json<any>(file);
  record.status = "pending";
  writeJson(file, record);
  fs.rmSync(native, { recursive: true });
  await engine.rollback(result.id!);
  assert.equal(fs.readlinkSync(native), source);
  assert.ok(store.state().receipts[0].adoptedLink);
});

test("adoption refuses links outside placement without changing the link, source or library", async (t) => {
  const { store, home, dir } = await fixture(t);
  for (const relative of [".config/opencode/skills", ".agents/skills"]) {
    const source = path.join(dir, "dev/non-target");
    skill(source, "non-target");
    const native = path.join(home, relative, "non-target");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.symlinkSync(source, native);
    const before = bundleHash(readBundle(source));
    await assert.rejects(
      store.importSkill(
        native,
        relative === ".agents/skills"
          ? codexScope
          : {
              kind: "global",
              harnesses: ["deepseek", "opencode", "codex", "claude"],
            },
        undefined,
        true,
      ),
      /链接不在当前技能放置目标中/,
    );
    assert.equal(fs.readlinkSync(native), source);
    assert.equal(bundleHash(readBundle(source)), before);
    assert.equal(store.manifest().skills.length, 0);
    assert.equal(store.state().receipts.length, 0);
    fs.unlinkSync(native);
  }
});

test("plan reports unreadable sources and refresh writes v2 entries without leaking local paths", async (t) => {
  const { store, engine, dir } = await fixture(t);
  const source = path.join(dir, "dev/local-source");
  skill(source, "local-source");
  const entry = await store.importSkill(source, linkedScope);
  fs.rmSync(source, { recursive: true });
  assert.match(engine.plan().warnings!.join("\n"), /源目录无法读取/);
  assert.equal(engine.plan().errors.length, 0);
  skill(source, "local-source");
  await engine.apply(engine.plan().id);
  assert.ok(store.state().receipts.every((r) => r.hash.startsWith("v2:")));
  assert.equal(scanMachine(store).skills.filter((s) => s.managed).length, 1);
  const manifest = store.manifest();
  manifest.skills[0].source = source;
  // Exercise genuine v1 migration as well as v2 source migration above.
  fs.rmSync(path.join(store.repo, "harness-sync.json"));
  fs.rmSync(path.join(store.repo, "entries"), { recursive: true });
  writeJson(path.join(store.repo, "manifest.json"), manifest);
  const device = store.device();
  delete device.origins;
  writeJson(path.join(store.root, "device.json"), device);
  await refreshSkills(store, [entry.id]);
  assert.equal(store.device().origins?.[entry.id], source);
  assert.equal(store.manifest().skills[0].source, "local-import");
  assert.ok(!fs.existsSync(path.join(store.repo, "manifest.json")));
  assert.ok(
    !store
      .git(["show", `HEAD:entries/skills/${entry.id}.json`])
      .includes(source),
  );
});

test("pending link adoption rollback accepts the original link without touching its source", async (t) => {
  const { store, engine, home, dir } = await fixture(t);
  const source = path.join(dir, "dev/untouched-link");
  skill(source, "untouched-link");
  const native = path.join(home, ".agents/skills/untouched-link");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync(source, native);
  const entry = await store.importSkill(native, linkedScope, undefined, true);
  const result = await engine.apply(engine.plan().id);
  const file = path.join(store.root, "deployments", `${result.id}.json`);
  const record = json<any>(file);
  record.status = "pending";
  writeJson(file, record);
  fs.rmSync(native, { recursive: true });
  fs.symlinkSync(source, native);
  const before = bundleHash(readBundle(source));
  await engine.rollback(result.id!);
  assert.equal(fs.readlinkSync(native), source);
  assert.equal(bundleHash(readBundle(source)), before);
  // A later placement change cannot authorize deleting an unconverted link.
  await store.saveSkill(
    { ...entry, body: "library", scope: codexScope },
    entry.id,
  );
  const plan = engine.plan();
  assert.match(
    plan.changes.find((c) => c.path === native)!.reason,
    /链接尚未接管/,
  );
  await assert.rejects(engine.apply(plan.id), /冲突/);
  assert.equal(fs.readlinkSync(native), source);
  assert.equal(bundleHash(readBundle(source)), before);
});
