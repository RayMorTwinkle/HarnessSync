import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, ui } from "./settings-helpers.ts";
import {
  instructionCompositions,
  instructionComposition,
  skillComposition,
  compositionBar,
  type InstructionComposition,
} from "../src/core/composition.ts";
import { adapters } from "../src/core/adapters.ts";
import { startServer } from "../src/server.ts";
import { isCredentialPath } from "../src/core/credentials.ts";
import { writeJson } from "../src/core/files.ts";
import { START, segmentsText } from "../src/core/rendering.ts";

const total = (values: Record<string, number>) =>
  Object.values(values).reduce((sum, n) => sum + n, 0);
function check(output: InstructionComposition, expected: string) {
  assert.equal(segmentsText(output.segments), expected);
  assert.equal(output.bytes, Buffer.byteLength(expected));
  assert.equal(total(output.totals), output.bytes);
  for (const segment of output.segments)
    assert.equal(
      segment.bytes,
      Buffer.byteLength(segment.parts.map((p) => p.text).join("")),
    );
}

test("组成与部署完全一致：共享、工具、设备、项目、变量、框架及用户自有文字", async (t) => {
  const { store, engine, home, root } = await fixture(t);
  await store.saveDevice({
    name: "本机",
    variables: { FORK_DIR: "/仓库/$&/$$", BLANK: "" },
  });
  const shared = await store.saveRule({
    title: "共享",
    body: "  通用 {{vars.FORK_DIR}}  \n",
  });
  const harness = await store.saveRule({
    title: "工具",
    body: "Codex {{device.home}}",
    scope: { kind: "global", harnesses: ["codex"] },
  });
  const device = await store.saveRule({
    title: "本机",
    body: "本机 {{device.name}}",
    scope: { kind: "device", target: store.device().id },
  });
  await store.saveRule({
    title: "其他设备",
    body: "不可见",
    scope: { kind: "device", target: "another" },
  });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);
  const project = await store.saveProject({ name: "项目甲", path: projectDir });
  const projectRule = await store.saveRule({
    title: "项目",
    body: "{{project.name}} 位于 {{project.path}}",
    scope: { kind: "project", target: project.id },
  });
  const codex = adapters(home, store.root).find(
    (h) => h.id === "codex",
  )!.instructions;
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, "用户自有文字");
  const plan = engine.plan();
  const outputs = instructionCompositions(store);
  assert.equal(outputs.length, 6);
  assert.equal(new Set(outputs.map((o) => o.path)).size, outputs.length);
  for (const output of outputs) {
    assert.equal(output.error, undefined);
    check(output, plan.changes.find((c) => c.path === output.path)!.after);
    assert.equal(output.pending, true);
  }
  const composed = instructionComposition(store, codex);
  assert.equal(composed.exists, true);
  assert.equal(composed.segments[0].kind, "native");
  assert.equal(composed.totals.native, Buffer.byteLength("用户自有文字"));
  assert.equal(
    composed.totals.variable,
    Buffer.byteLength(`/仓库/$&/$$${home}本机`),
  );
  for (const [id, kind] of [
    [shared.id, "shared"],
    [harness.id, "harness"],
    [device.id, "device"],
  ])
    assert.equal(composed.segments.find((s) => s.ruleId === id)!.kind, kind);
  assert.ok(
    composed.segments
      .filter((s) => s.kind === "frame")
      .some((s) => s.parts[0].text.includes("## 共享")),
  );
  const projectOutput = outputs.find(
    (o) => o.path === path.join(projectDir, "AGENTS.md"),
  )!;
  assert.deepEqual([...projectOutput.harnesses].sort(), [
    "codex",
    "deepseek",
    "opencode",
  ]);
  assert.equal(projectOutput.projectId, project.id);
  assert.equal(
    projectOutput.segments.find((s) => s.ruleId === projectRule.id)!.kind,
    "project",
  );
  await engine.apply(plan.id);
  fs.appendFileSync(codex, "\n用户后缀\n");
  const after = instructionComposition(store, codex);
  check(after, fs.readFileSync(codex, "utf8"));
  assert.equal(after.pending, false);
  assert.equal(after.segments.filter((s) => s.kind === "native").length, 2);
  const update = await store.saveRule(
    { title: "共享", body: "更新 {{vars.FORK_DIR}}" },
    shared.id,
  );
  assert.equal(update.id, shared.id);
  check(
    instructionComposition(store, codex),
    engine.plan().changes.find((c) => c.path === codex)!.after,
  );
  await engine.apply(engine.plan().id);
  assert.equal(instructionComposition(store, codex).pending, false);
});

test("无规则、停用工具、撤下区块及完整初始化替换遵循计划", async (t) => {
  const { store, engine, home } = await fixture(t);
  const codex = adapters(home, store.root).find(
    (h) => h.id === "codex",
  )!.instructions;
  assert.equal(instructionCompositions(store).length, 4);
  const empty = instructionComposition(store, codex);
  check(empty, "");
  assert.equal(empty.exists, false);
  assert.equal(empty.pending, false);
  await store.setHarnessEnabled("claude", false);
  assert.equal(instructionCompositions(store).length, 3);
  const rule = await store.saveRule({ title: "规则", body: "正文" });
  await engine.apply(engine.plan().id);
  await store.saveRule({ ...rule, body: "正文", enabled: false }, rule.id);
  const removal = engine.plan().changes.find((c) => c.path === codex)!;
  check(instructionComposition(store, codex), removal.after);
  await engine.apply(engine.plan().id);
  assert.equal(instructionComposition(store, codex).exists, false);
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, "原生内容\n");
  check(instructionComposition(store, codex), "原生内容\n");
  await store.saveRule({ ...rule, body: "正文", enabled: true }, rule.id);
  const beforeHash = engine
    .plan()
    .changes.find((c) => c.path === codex)!.beforeHash;
  writeJson(path.join(store.root, "state.json"), {
    ...store.state(),
    instructionReplacements: [{ path: codex, hash: beforeHash }],
  });
  const replacement = instructionComposition(store, codex);
  check(
    replacement,
    engine.plan().changes.find((c) => c.path === codex)!.after,
  );
  assert.equal(replacement.totals.native, 0);
});

test("组成错误保留可计算片段，未知路径、损坏标记及链接不会被写入", async (t) => {
  const { store, home, root } = await fixture(t);
  await store.saveRule({
    title: "缺变量",
    body: "前 {{vars.MISSING}} 后",
    scope: { kind: "global", harnesses: ["codex"] },
  });
  const codex = adapters(home, store.root).find(
    (h) => h.id === "codex",
  )!.instructions;
  const missing = instructionComposition(store, codex);
  assert.match(missing.error!, /vars.MISSING/);
  assert.ok(missing.segments.some((s) => s.ruleId));
  assert.equal(total(missing.totals), missing.bytes);
  assert.throws(
    () => instructionComposition(store, path.join(root, "arbitrary")),
    { code: "NOT_FOUND" },
  );
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, START);
  assert.match(instructionComposition(store, codex).error!, /标记损坏/);
  fs.unlinkSync(codex);
  const target = path.join(root, "target");
  fs.writeFileSync(target, "不读取或写入链接目标");
  fs.symlinkSync(target, codex);
  const linked = instructionComposition(store, codex);
  assert.equal(linked.exists, true);
  assert.match(linked.error!, /符号链接/);
  assert.equal(fs.readFileSync(target, "utf8"), "不读取或写入链接目标");
  assert.ok(fs.lstatSync(codex).isSymbolicLink());
  await store.saveRule({
    title: "大指令",
    body: "x".repeat(49 * 1024),
    scope: { kind: "global", harnesses: ["opencode"] },
  });
  const large = instructionCompositions(store).find((o) =>
    o.harnesses.includes("opencode"),
  )!;
  assert.match(large.error!, /48 KiB/);
  assert.equal(total(large.totals), large.bytes);
});

test("技能分类、变量字节及凭证只 stat，不读取其他文件内容", async (t) => {
  const { store } = await fixture(t);
  await store.saveDevice({ name: "机器", variables: { ROOT: "/中文" } });
  const skill = await store.saveSkill({
    name: "files",
    description: "组成",
    body: "{{vars.ROOT}} {{device.name}} {{unknown}}",
  });
  const root = store.skillPath(skill.id);
  const names: [string, string, number?][] = [
    ["scripts/no-extension", "script"],
    ["run", "script", 0o755],
    ["code.py", "script"],
    ["references/data.json", "reference"],
    ["notes.txt", "reference"],
    ["assets/picture.dat", "asset"],
    ["font.woff2", "asset"],
    ["data.json", "other"],
    ["auth.json", "credential"],
    ["scripts/private.key", "credential"],
    ["references/SKILL.md", "reference"],
  ];
  for (const [name, , mode] of names) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{{vars.UNKNOWN_RESOURCE}}", {
      mode: mode || 0o644,
    });
  }
  const original = fs.readFileSync;
  const read: string[] = [];
  t.mock.method(
    fs,
    "readFileSync",
    (...args: Parameters<typeof fs.readFileSync>) => {
      const file = String(args[0]);
      if (file.startsWith(root + path.sep)) {
        assert.equal(isCredentialPath(file), false, "凭证内容不得读取");
        assert.equal(path.relative(root, file), "SKILL.md", "其他资源只 stat");
        read.push(file);
      }
      return Reflect.apply(original, fs, args);
    },
  );
  const result = skillComposition(store, skill.id);
  for (const [name, kind] of names) {
    const file = result.files.find((f) => f.path === name)!;
    assert.equal(file.kind, kind, name);
    assert.equal(file.syncIgnored, false);
    assert.deepEqual(file.variables, []);
    assert.equal(file.bytes, fs.statSync(path.join(root, name)).size);
  }
  assert.deepEqual(result.files.find((f) => f.path === "SKILL.md")!.variables, [
    "vars.ROOT",
    "device.name",
  ]);
  assert.equal(result.totals.variable, Buffer.byteLength("/中文机器"));
  assert.equal(total(result.totals), result.bytes);
  assert.deepEqual(read, [path.join(root, "SKILL.md")]);
  assert.throws(() => skillComposition(store, "unknown"), {
    code: "NOT_FOUND",
    status: 404,
  });
});

test("组成 API 遵循本机会话访问控制与 404；CLI JSON 和字符条", async (t) => {
  const { store, settings, root, home, defer } = await fixture(t);
  await settings.patch({ deploy: { auto: false }, updates: { check: false } });
  await store.saveRule({ title: "规则", body: "内容" });
  const skill = await store.saveSkill({
    name: "api-skill",
    description: "接口",
    body: "正文",
  });
  const server = await startServer(store, {
    port: 0,
    uiDirectory: ui(root),
    service: { platform: "test-unsupported" },
  });
  defer(() => server.close());
  const token = (await (await fetch(server.url)).text()).match(
    /content="([a-f0-9]+)"/,
  )![1];
  const headers = { "x-harness-sync-token": token };
  assert.equal(
    (await fetch(`${server.url}/api/composition/instructions`)).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${server.url}/api/composition/instructions`, {
        headers: { ...headers, origin: "http://other.invalid" },
      })
    ).status,
    403,
  );
  const response = await fetch(`${server.url}/api/composition/instructions`, {
    headers,
  });
  assert.deepEqual((await response.json()).data, {
    outputs: instructionCompositions(store),
  });
  const skillResponse = await fetch(
    `${server.url}/api/composition/skills/${skill.id}`,
    { headers },
  );
  assert.deepEqual(
    (await skillResponse.json()).data,
    skillComposition(store, skill.id),
  );
  assert.equal(
    (await fetch(`${server.url}/api/composition/skills/missing`, { headers }))
      .status,
    404,
  );
  assert.equal(
    (
      await fetch(`${server.url}/api/composition/skills/${skill.id}/extra`, {
        headers,
      })
    ).status,
    404,
  );
  const invoke = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, HARNESS_SYNC_HOME: store.root },
    });
  assert.deepEqual(
    JSON.parse(invoke("compose", "instructions", "--json")).outputs,
    instructionCompositions(store),
  );
  assert.deepEqual(
    JSON.parse(invoke("compose", "skill", skill.id, "--json")),
    skillComposition(store, skill.id),
  );
  const bar = invoke("compose", "instructions");
  assert.match(bar, /\[[A-Z ]{40}\] \d+ B/);
  assert.match(bar, /共享/);
  assert.match(invoke("compose", "skill", skill.id), /指令/);
  assert.match(compositionBar({ native: 0 }), /\[ {40}\] 0 B/);
});
