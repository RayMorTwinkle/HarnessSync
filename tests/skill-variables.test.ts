import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./settings-helpers.ts";
import {
  bundleDiskHash,
  bundleHash,
  readBundle,
  writeBundle,
  skillMarkdown,
} from "../src/core/files.ts";
import { autoDeployBlockers } from "../src/core/auto-deploy.ts";
import { installSelfSkill } from "../src/core/self-skill.ts";

const scope = { kind: "global", harnesses: ["claude"] };
const resource = (text: string, mode = 0o644) => ({
  content: Buffer.from(text).toString("base64"),
  mode,
});

test("技能仅渲染顶层 SKILL.md，保留其他模板、资源、源包与执行位", async (t) => {
  const { store, engine, home } = await fixture(t);
  await store.saveDevice({
    name: "测试机",
    variables: {
      FORK_DIR: "/设备/代码",
      EMPTY: "",
      NESTED: "{{vars.NOT_RECURSIVE}}",
    },
  });
  const body =
    "{{vars.FORK_DIR}} {{device.name}} {{ device.id }} {{device.home}} {{vars.EMPTY}} {{vars.NESTED}}\n{{project.path}} {{title}} {{device.unknown}} {{vars.KEY | filter}} {{ some template }}";
  const skill = await store.saveSkill(
    { name: "templated", description: "模板", body, scope },
    undefined,
    undefined,
    {
      "scripts/run.sh": resource("echo '{{vars.FORK_DIR}}'", 0o755),
      "references/SKILL.md": resource("{{vars.MISSING}}"),
      "assets/data.bin": {
        content: Buffer.from([0, 255, 1]).toString("base64"),
        mode: 0o644,
      },
    },
  );
  const sourceHash = bundleDiskHash(store.skillPath(skill.id));
  const plan = engine.plan();
  assert.deepEqual(plan.errors, []);
  const change = plan.changes.find((c) => c.sourceId === skill.id)!;
  assert.match(change.after, /\/设备\/代码 测试机/);
  assert.ok(change.after.includes(store.device().id));
  assert.ok(change.after.includes(home));
  for (const placeholder of [
    "{{project.path}}",
    "{{title}}",
    "{{device.unknown}}",
    "{{vars.KEY | filter}}",
    "{{ some template }}",
    "{{vars.NOT_RECURSIVE}}",
  ])
    assert.ok(change.after.includes(placeholder), placeholder);
  await engine.apply(plan.id);
  const deployed = readBundle(change.path),
    source = readBundle(store.skillPath(skill.id));
  assert.equal(bundleHash(deployed), change.afterHash);
  assert.equal(bundleDiskHash(store.skillPath(skill.id)), sourceHash);
  assert.ok(
    Buffer.from(source["SKILL.md"].content, "base64")
      .toString()
      .includes("{{vars.FORK_DIR}}"),
  );
  for (const file of [
    "scripts/run.sh",
    "references/SKILL.md",
    "assets/data.bin",
  ])
    assert.deepEqual(deployed[file], source[file]);
  assert.equal(store.state().receipts[0].hash, change.afterHash);
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
});

test("变量改变使旧计划失效并更新技能，无漂移误报，回滚仍恢复旧渲染值", async (t) => {
  const { store, engine } = await fixture(t);
  await store.saveDevice({ name: "设备", variables: { DIR: "/old" } });
  const skill = await store.saveSkill({
    name: "changes",
    description: "变量",
    body: "路径 {{vars.DIR}}",
    scope,
  });
  const first = engine.plan();
  await engine.apply(first.id);
  const previous = engine.plan();
  await store.saveDevice({ name: "设备", variables: { DIR: "/new" } });
  await assert.rejects(engine.apply(previous.id), { code: "STALE_PLAN" });
  const plan = engine.plan();
  assert.equal(plan.changes[0].status, "update");
  assert.match(plan.changes[0].diff, /\/old/);
  assert.match(plan.changes[0].diff, /\/new/);
  const deployment = await engine.apply(plan.id);
  assert.equal(engine.plan().changes[0].status, "unchanged");
  await engine.rollback(deployment.id!);
  const pending = engine.plan().changes.find((c) => c.sourceId === skill.id)!;
  assert.equal(pending.status, "update");
  assert.match(pending.before, /\/old/);
  fs.appendFileSync(path.join(pending.path, "SKILL.md"), "外部修改");
  assert.match(engine.plan().changes[0].reason, /外部修改/);
});

test("缺变量保留占位符原文照常部署，只给不阻断的提醒；补齐后更新", async (t) => {
  const { store, engine } = await fixture(t);
  const skill = await store.saveSkill({
    name: "missing",
    description: "缺变量",
    body: "示例语法 {{vars.KEY}}，工作目录 {{vars.ROOT}}",
    scope,
  });
  await store.saveDevice({ name: "设备", variables: { ROOT: "/work" } });
  const plan = engine.plan();
  assert.deepEqual(plan.errors, []);
  const change = plan.changes.find((c) => c.sourceId === skill.id)!;
  assert.equal(change.status, "create");
  const notice = plan.notices.find((n) => n.code === "skill-missing-variable")!;
  assert.equal(notice.blocking, false);
  assert.match(notice.message, /missing.*KEY.*device set KEY/);
  assert.ok(
    !autoDeployBlockers(engine, plan).some(
      (b) => b.code === "skill-missing-variable",
    ),
  );
  await engine.apply(plan.id);
  const receipt = store.state().receipts.find((r) => r.sourceId === skill.id)!;
  const text = fs.readFileSync(path.join(receipt.path, "SKILL.md"), "utf8");
  assert.match(text, /示例语法 \{\{vars\.KEY\}\}，工作目录 \/work/);
  assert.equal(
    engine.plan().changes.find((c) => c.sourceId === skill.id)!.status,
    "unchanged",
  );
  await store.saveDevice({
    name: "设备",
    variables: { ROOT: "/work", KEY: "值" },
  });
  assert.equal(
    engine.plan().changes.find((c) => c.sourceId === skill.id)!.status,
    "update",
  );
});

test("项目技能渲染项目变量，全局技能保留项目占位符", async (t) => {
  const { store, engine, root } = await fixture(t);
  const dir = path.join(root, "project");
  fs.mkdirSync(dir);
  const project = await store.saveProject({ name: "演示项目", path: dir });
  const skill = await store.saveSkill({
    name: "project-skill",
    description: "项目",
    body: "{{project.name}} {{project.path}}",
    scope: { kind: "project", target: project.id, harnesses: ["claude"] },
  });
  const change = engine.plan().changes.find((c) => c.sourceId === skill.id)!;
  assert.ok(change.after.includes(`演示项目 ${dir}`));
  await engine.apply(engine.plan().id);
  assert.equal(engine.plan().changes[0].status, "unchanged");
});

test("接管比较使用渲染包，模板原样导入仍会部署渲染内容", async (t) => {
  const { store, engine, root } = await fixture(t);
  await store.saveDevice({ name: "设备", variables: { DIR: "/rendered" } });
  const skill = await store.saveSkill({
    name: "adoption",
    description: "接管",
    body: "{{vars.DIR}}",
    scope,
  });
  const target = engine.plan().changes[0].path;
  const source = readBundle(store.skillPath(skill.id));
  writeBundle(target, {
    ...source,
    "SKILL.md": resource(skillMarkdown("adoption", "接管", "/rendered")),
  });
  assert.equal(engine.plan().changes[0].status, "adopt");
  await engine.apply(engine.plan().id);
  assert.equal(engine.plan().changes[0].status, "unchanged");
  const other = path.join(root, "incoming");
  writeBundle(other, {
    "SKILL.md": resource(
      skillMarkdown("import-template", "导入模板", "{{vars.DIR}}"),
    ),
  });
  const imported = await store.importSkill(other, {
    kind: "global",
    harnesses: ["claude"],
  });
  assert.ok(imported);
  const planned = engine.plan().changes.find((c) => c.sourceId !== skill.id)!;
  writeBundle(planned.path, readBundle(other));
  await store.importSkill(planned.path, {
    kind: "global",
    harnesses: ["claude"],
  });
  const next = engine.plan();
  assert.equal(
    next.changes.find((c) => c.path === planned.path)!.status,
    "replace",
  );
  await engine.apply(next.id);
  assert.match(
    fs.readFileSync(path.join(planned.path, "SKILL.md"), "utf8"),
    /\/rendered/,
  );
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
});

test("内置管理技能中的变量说明不会阻断首次部署", async (t) => {
  const { store, engine } = await fixture(t);
  await installSelfSkill(store);
  const plan = engine.plan();
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.changes.length > 0);
  assert.ok(plan.changes.every((c) => c.status === "create"));
  assert.ok(!plan.notices.some((n) => n.blocking));
  await engine.apply(plan.id);
  assert.ok(engine.plan().changes.every((c) => c.status === "unchanged"));
});
