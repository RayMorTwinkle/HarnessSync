import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { adapters } from "../src/core/adapters.ts";
import { scanMachine } from "../src/core/scanner.ts";
import {
  createOnboarding,
  bootstrapOnboarding,
  getOnboarding,
  stageInstructions,
  unstageInstructions,
} from "../src/core/onboarding.ts";
import { skillMarkdown } from "../src/core/files.ts";

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
  assert.equal(ready.bootstrap?.changes, 4);
  for (const h of harnesses) {
    assert.equal(fs.readFileSync(h.instructions, "utf8"), `原件-${h.id}`);
    const base = path.join(h.skills, "manage-harness-sync");
    assert.ok(
      fs
        .readFileSync(path.join(base, "SKILL.md"), "utf8")
        .includes("# HarnessSync 配置管理"),
    );
    assert.ok(fs.existsSync(path.join(base, "references/onboarding.md")));
    assert.ok(fs.existsSync(path.join(base, "agents/openai.yaml")));
  }
  assert.ok(engine.plan().errors.some((e) => e.includes("UNSET")));
  assert.equal(getOnboarding(store, record.id)?.bootstrap?.changes, 4);
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
