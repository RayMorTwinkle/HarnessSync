import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import {
  createOnboarding,
  bootstrapOnboarding,
} from "../src/core/onboarding.ts";
import { autoDeploy } from "../src/core/auto-deploy.ts";
import {
  registry,
  resolveTemplate,
  validateHarnessFile,
} from "../src/core/harness-registry.ts";
import { harnessManifestSchema } from "../src/shared/harness-manifest.ts";
import {
  projectTargets,
  sharedInstructionPeers,
} from "../src/core/adapters.ts";
import { sourceStatus } from "../src/core/skill-sources.ts";
const acme = JSON.parse(
  fs.readFileSync(
    new URL("fixtures/harnesses/acme.json", import.meta.url),
    "utf8",
  ),
);
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsync-safety-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const store = await new Store(path.join(dir, "store"), home).init();
  fs.mkdirSync(path.join(store.root, "harnesses"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (m: any) => {
    const file = path.join(store.root, "harnesses", `${m.id}.json`);
    fs.writeFileSync(file, JSON.stringify(m));
    return file;
  };
  return { dir, home, store, engine: new Engine(store), write };
}
function env(t: TestContext, values: Record<string, string>) {
  const old = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}
test("snapshot never executes user probes or disabled built-ins", async (t) => {
  const { dir, home, store, engine, write } = await fixture(t);
  const bin = path.join(dir, "bin"),
    marker = path.join(dir, "executed");
  fs.mkdirSync(bin);
  for (const command of ["rm", "sh", "claude", "codex", "dsh", "opencode"])
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh\nprintf '${command}\\n' >> '${marker}'\nprintf 'test-version\\n'\n`,
      { mode: 0o755 },
    );
  for (const command of ["rm", "sh"])
    write({
      ...acme,
      id: `test-${command}`,
      version: { command, args: ["version"] },
    });
  for (const id of ["codex", "deepseek", "opencode"])
    await store.setHarnessEnabled(id, false);
  env(t, { HOME: home, PATH: `${bin}:${process.env.PATH}` });
  const snapshot = engine.snapshot();
  assert.equal(
    snapshot.harnesses.find((h) => h.id === "claude")!.version,
    "test-version",
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "claude\n");
  await store.setHarnessEnabled("claude", false);
  const disabled = engine.snapshot();
  assert.ok(disabled.harnesses.every((h) => h.version === null));
  assert.equal(fs.readFileSync(marker, "utf8"), "claude\n");
  const onboarding = await createOnboarding(store);
  await assert.rejects(bootstrapOnboarding(store, onboarding.id), /未检测到/);
  assert.equal(fs.readFileSync(marker, "utf8"), "claude\n");
});
test("resolved path validation rejects broad and store targets, including changed env", async (t) => {
  const { home, store, write } = await fixture(t);
  for (const target of [
    "~",
    "/",
    path.dirname(home),
    "~/../outside",
    store.root,
  ]) {
    const file = write({
      ...acme,
      skills: {
        ...acme.skills,
        global: target,
        reads: { ...acme.skills.reads, global: [target] },
      },
    });
    assert.ok(
      validateHarnessFile(file, home, store.root).error?.issues.some(
        (i) => i.path === "$.skills.global",
      ),
      target,
    );
    assert.ok(
      !registry(home, store.root).entries.some((e) => e.manifest.id === "acme"),
    );
  }
  for (const m of [
    { ...acme, root: { default: "~" } },
    {
      ...acme,
      instructions: {
        ...acme.instructions,
        global: [{ path: "~/FILE.md", kind: "main" }],
      },
    },
  ])
    assert.ok(validateHarnessFile(write(m), home, store.root).error);
  write({ ...acme, root: { default: "~/.acme", env: "SAFETY_ROOT" } });
  env(t, { HOME: home, SAFETY_ROOT: path.join(home, ".safe") });
  assert.ok(
    registry(home, store.root).entries.some((e) => e.manifest.id === "acme"),
  );
  process.env.SAFETY_ROOT = home;
  assert.ok(
    registry(home, store.root).errors.some((e) =>
      e.issues.some((i) => i.path === "$.root.env"),
    ),
  );
});
test("unreceipted sources under declared native roots still report changed and unreadable", async (t) => {
  const { home, store, write } = await fixture(t);
  write(acme);
  const source = path.join(home, ".acme/skills/upstream");
  fs.mkdirSync(source, { recursive: true });
  const file = path.join(source, "SKILL.md");
  fs.writeFileSync(
    file,
    "---\nname: upstream\ndescription: upstream\n---\none\n",
  );
  await store.importSkill(source, { kind: "global", harnesses: ["acme"] });
  fs.appendFileSync(file, "changed");
  assert.equal(sourceStatus(store)[0].status, "changed");
  fs.rmSync(source, { recursive: true });
  assert.equal(sourceStatus(store)[0].status, "unreadable");
});
test("global instruction collisions accept identical renders and reject different renders", async (t) => {
  const { store, engine, write } = await fixture(t);
  write(acme);
  write({ ...acme, id: "peer" });
  await store.saveRule({
    title: "same",
    body: "same",
    scope: { harnesses: ["acme", "peer"] },
  });
  assert.deepEqual(engine.plan().errors, []);
  assert.equal(
    engine.plan().changes.filter((c) => c.kind === "instructions").length,
    1,
  );
  await engine.apply(engine.plan().id);
  await store.saveRule({
    title: "different",
    body: "different",
    scope: { harnesses: ["peer"] },
  });
  assert.ok(
    engine
      .plan()
      .errors.some(
        (e) =>
          e.includes("acme") && e.includes("peer") && e.includes("内容冲突"),
      ),
  );
  await assert.rejects(engine.apply(engine.plan().id), /错误和冲突/);
});
test("project path aliases are rejected and equal resolved paths form peer groups", async (t) => {
  const { home, store, write } = await fixture(t);
  for (const p of [
    ".",
    "..",
    "./AGENTS.md",
    "a/../AGENTS.md",
    "/AGENTS.md",
    "a//b",
    "a/",
    "C:/file",
    "",
  ]) {
    assert.equal(
      harnessManifestSchema.safeParse({
        ...acme,
        instructions: { ...acme.instructions, project: p },
      }).success,
      false,
      p,
    );
    assert.equal(
      harnessManifestSchema.safeParse({
        ...acme,
        skills: { ...acme.skills, project: p },
      }).success,
      false,
      p,
    );
  }
  write({
    ...acme,
    instructions: { ...acme.instructions, project: "AGENTS.md" },
  });
  assert.deepEqual(sharedInstructionPeers("acme", home, store.root), [
    "deepseek",
    "opencode",
    "codex",
    "acme",
  ]);
});
test("template replacements preserve literal dollar sequences", () => {
  const home = "/tmp/test-$&-$$-$`-$'";
  const root = path.join(home, ".root-$&");
  assert.equal(
    resolveTemplate("{root}/skills", home, root),
    path.join(root, "skills"),
  );
  assert.equal(
    resolveTemplate("{root}/{root}", home, root),
    path.resolve(root + "/" + root),
  );
});
test("root relocation blocks auto deployment, preserves receipts, and requires manual apply", async (t) => {
  const { home, store, engine } = await fixture(t);
  const oldRoot = path.join(home, ".claude-old"),
    newRoot = path.join(home, ".claude-new");
  env(t, { HOME: home, CLAUDE_CONFIG_DIR: oldRoot });
  await store.saveSkill({
    name: "move",
    description: "move",
    body: "move",
    scope: { harnesses: ["claude"] },
  });
  await store.saveRule({
    title: "move",
    body: "move",
    scope: { harnesses: ["claude"] },
  });
  await engine.apply(engine.plan().id);
  const before = store.state().receipts;
  process.env.CLAUDE_CONFIG_DIR = newRoot;
  const plan = engine.plan();
  assert.ok(
    plan.notices.some(
      (n) =>
        n.code === "harness-root-changed" &&
        n.blocking &&
        n.message.includes(oldRoot) &&
        n.message.includes(newRoot),
    ),
  );
  assert.equal((await autoDeploy(engine, "测试迁移")).outcome, "needs-review");
  assert.deepEqual(store.state().receipts, before);
  assert.ok(fs.existsSync(path.join(oldRoot, "skills/move/SKILL.md")));
  assert.equal(fs.existsSync(newRoot), false);
  await engine.apply(plan.id);
  assert.ok(fs.existsSync(path.join(newRoot, "skills/move/SKILL.md")));
  assert.equal(fs.existsSync(path.join(oldRoot, "skills/move")), false);
  assert.ok(
    !engine.plan().notices.some((n) => n.code === "harness-root-changed"),
  );
  process.env.CLAUDE_CONFIG_DIR = oldRoot;
  assert.equal(
    (await autoDeploy(engine, "测试反向迁移")).outcome,
    "needs-review",
  );
});

test("project targets cannot enter the local store", async (t) => {
  const { home, store, write } = await fixture(t);
  write(acme);
  assert.throws(
    () => projectTargets("acme", store.root, home, store.root),
    /\$\.instructions.project.*HARNESS_SYNC_HOME/,
  );
});
test("legacy receipts detect relocation and rollback restores the old location", async (t) => {
  const { home, store, engine } = await fixture(t);
  env(t, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".old") });
  await store.saveSkill({
    name: "legacy",
    description: "legacy",
    body: "legacy",
    scope: { harnesses: ["claude"] },
  });
  await engine.apply(engine.plan().id);
  const state = store.state();
  for (const receipt of state.receipts) delete receipt.globalPaths;
  fs.writeFileSync(path.join(store.root, "state.json"), JSON.stringify(state));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".new");
  assert.equal(
    (await autoDeploy(engine, "旧版收据迁移")).outcome,
    "needs-review",
  );
  const deployment = await engine.apply(engine.plan().id);
  await engine.rollback(deployment.id!);
  assert.deepEqual(store.state().receipts, state.receipts);
  assert.ok(fs.existsSync(path.join(home, ".old/skills/legacy/SKILL.md")));
  assert.equal(fs.existsSync(path.join(home, ".new/skills/legacy")), false);
});
test("manual confirmation updates root metadata even when shared skill target is unchanged", async (t) => {
  const { home, store, engine } = await fixture(t);
  env(t, { HOME: home, CODEX_HOME: path.join(home, ".codex-old") });
  await store.saveSkill({
    name: "shared",
    description: "shared",
    body: "shared",
    scope: { harnesses: ["deepseek", "opencode", "codex"] },
  });
  await engine.apply(engine.plan().id);
  process.env.CODEX_HOME = path.join(home, ".codex-new");
  assert.equal(
    (await autoDeploy(engine, "根变化但共享技能位置不变")).outcome,
    "needs-review",
  );
  const plan = engine.plan();
  assert.ok(plan.changes.every((c) => c.status === "unchanged"));
  await engine.apply(plan.id);
  assert.ok(
    !engine.plan().notices.some((n) => n.code === "harness-root-changed"),
  );
});
