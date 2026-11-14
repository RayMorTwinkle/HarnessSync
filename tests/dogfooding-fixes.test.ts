import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "./settings-helpers.ts";
import { autoDeploy, lastAutoDeploy } from "../src/core/auto-deploy.ts";
import {
  activeOnboarding,
  cancelOnboarding,
} from "../src/core/onboarding-session.ts";
import {
  createOnboarding,
  bootstrapOnboarding,
  findOnboardingRepository,
} from "../src/core/onboarding.ts";
import { credentialPaths } from "../src/core/credentials.ts";
import { scanMachine } from "../src/core/scanner.ts";
import {
  sourceStatus,
  skillSource,
  refreshSkills,
} from "../src/core/skill-sources.ts";
import { skillMarkdown, writeJson } from "../src/core/files.ts";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";

const all = {
  kind: "global" as const,
  harnesses: ["deepseek", "opencode", "codex", "claude"],
};
const codex = { kind: "global" as const, harnesses: ["codex"] };
function skill(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    skillMarkdown(name, "测试", "original"),
  );
}
function link(source: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
}
function cli(store: Store, args: string[]) {
  const env = { ...process.env, HOME: store.home, HSYNC_NO_NOTICES: "1" };
  for (const key of [
    "DSH_HOME",
    "DSH_AGENTS_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
  ])
    delete (env as Record<string, string | undefined>)[key];
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--root",
        store.root,
        "--json",
        ...args,
      ],
      { env, encoding: "utf8" },
    ),
  );
}

test("repository discovery distinguishes explicit absence from transport and permission failures", async (t) => {
  const { store } = await fixture(t);
  for (const [stderr, status] of [
    [
      "GraphQL: Could not resolve to a Repository with the name 'example/harness-sync-config'. (repository)",
      "absent",
    ],
    ["error connecting to api.github.com", "unknown"],
    ["HTTP 403: Resource not accessible by integration", "unknown"],
    ["HTTP 404: Not Found", "unknown"],
  ]) {
    const result = await findOnboardingRepository(store, async (_, args) => ({
      code: args[0] === "auth" ? 0 : 1,
      stdout: "",
      stderr,
    }));
    assert.equal(result.status, status);
    if (status === "absent")
      assert.match(result.message, /默认名称的仓库不存在.*其他名字/);
  }
});

test("scan pauses automatic deployment, bootstrap preserves the pause and full manual apply resumes it", async (t) => {
  const { store, engine, home, settings } = await fixture(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const session = await createOnboarding(store);
  assert.match(
    fs.readFileSync(path.join(session.backupDir!, "如何恢复.md"), "utf8"),
    /包含技能目录内的凭证文件/,
  );
  assert.equal(activeOnboarding(store)?.id, session.id);
  assert.equal(settings.preferences().deploy.auto, true);
  assert.match(lastAutoDeploy(store)!.blockers![0].reason, /初始化进行中/);
  assert.equal(engine.snapshot().onboarding?.id, session.id);
  const source = path.join(home, "dev/example");
  skill(source, "example");
  await store.importSkill(source, codex);
  const paused = await autoDeploy(engine, "import");
  assert.equal(paused.outcome, "needs-review");
  assert.ok(!fs.existsSync(path.join(home, ".agents/skills/example")));
  await bootstrapOnboarding(store, session.id);
  assert.equal(activeOnboarding(store)?.id, session.id);
  const stale = engine.plan();
  await store.saveRule({
    title: "rule",
    body: "test",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  await assert.rejects(engine.apply(stale.id), { code: "STALE_PLAN" });
  assert.equal(activeOnboarding(store)?.id, session.id);
  await engine.apply(engine.plan().id);
  assert.equal(activeOnboarding(store), null);
  assert.equal(settings.preferences().deploy.auto, true);
  assert.ok(
    !lastAutoDeploy(store)?.blockers?.some((b) => b.status === "onboarding"),
  );
  await store.saveRule({
    title: "after",
    body: "new",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  assert.equal((await autoDeploy(engine, "after")).outcome, "applied");
});

test("expired sessions and explicit cancellation release the pause without changing settings", async (t) => {
  const { store, engine, settings } = await fixture(t);
  const first = await createOnboarding(store);
  const second = await createOnboarding(store);
  await assert.rejects(cancelOnboarding(store, first.id), {
    code: "ONBOARDING_SESSION",
  });
  await cancelOnboarding(store, second.id);
  assert.equal(activeOnboarding(store), null);
  const third = await createOnboarding(store);
  await autoDeploy(engine, "paused");
  const state = store.state();
  state.onboarding!.expiresAt = new Date(Date.now() - 1).toISOString();
  writeJson(path.join(store.root, "state.json"), state);
  assert.equal(activeOnboarding(store), null);
  assert.equal(lastAutoDeploy(store), null);
  await store.saveRule({
    title: "expired",
    body: "ready",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  assert.equal((await autoDeploy(engine, "expired")).outcome, "applied");
  assert.equal(settings.preferences().deploy.auto, true);
  // An unchanged full manual apply also finishes a session.
  await cancelOnboarding(store, third.id);
  await createOnboarding(store);
  await engine.apply(engine.plan().id);
  assert.equal(activeOnboarding(store), null);
});

test("CLI onboarding scan, status, doctor and cancellation use the same local session", async (t) => {
  const { store } = await fixture(t);
  const session = cli(store, ["onboard", "scan"]);
  assert.equal(cli(store, ["status"]).onboarding.id, session.id);
  assert.match(
    cli(store, ["doctor"]).autoDeploy.blockers[0].reason,
    /初始化进行中/,
  );
  cli(store, ["onboard", "cancel", session.id]);
  assert.equal(cli(store, ["status"]).onboarding, null);
});

test("relocated adopted OpenCode source is cleared, old installs self-heal and later automatic deployment succeeds", async (t) => {
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, ".config/opencode/skills/relocated");
  skill(source, "relocated");
  const entry = await store.importSkill(source, all, undefined, true);
  const legacy = store.device();
  const plan = engine.plan();
  assert.equal(plan.changes.find((c) => c.path === source)?.status, "remove");
  const applied = await engine.apply(plan.id);
  assert.ok(applied.id);
  assert.ok(!fs.existsSync(source));
  assert.equal(store.device().origins?.[entry.id], undefined);
  assert.equal(store.device().originHashes?.[entry.id], undefined);
  assert.deepEqual(sourceStatus(store), []);
  assert.deepEqual(cli(store, ["doctor"]).sourceUpdates, []);
  // Simulate the obsolete device record left by the released version.
  writeJson(path.join(store.root, "device.json"), legacy);
  const reopened = await new Store(store.root, home).init();
  assert.deepEqual(sourceStatus(reopened), []);
  assert.equal(skillSource(reopened, entry.id), undefined);
  assert.deepEqual(cli(reopened, ["doctor"]).sourceUpdates, []);
  const currentEngine = new Engine(reopened);
  await reopened.saveSkill({ ...entry, body: "library changed" }, entry.id);
  assert.equal(
    (await autoDeploy(currentEngine, "library edit")).outcome,
    "applied",
  );
  assert.ok(
    !currentEngine
      .plan()
      .notices.some((n) => n.code === "skill-source-unreadable"),
  );
});

test("a managed deployment is not a refreshable source after an unchanged adoption", async (t) => {
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, ".agents/skills/owned");
  skill(source, "owned");
  const entry = await store.importSkill(source, codex, undefined, true);
  await engine.apply(engine.plan().id);
  assert.equal(store.device().origins?.[entry.id], undefined);
  await store.saveSkill({ ...entry, body: "new library" }, entry.id);
  assert.equal((await autoDeploy(engine, "edit")).outcome, "applied");
  assert.deepEqual(sourceStatus(store), []);
  await assert.rejects(refreshSkills(store, [entry.id]), {
    code: "NO_SKILL_SOURCE",
  });
});

test("adopted links retain the independent development source and detect its updates", async (t) => {
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, "development/linked");
  const target = path.join(home, ".agents/skills/linked");
  skill(source, "linked");
  link(source, target);
  const entry = await store.importSkill(
    target,
    { kind: "global", harnesses: ["deepseek", "opencode", "codex"] },
    undefined,
    true,
  );
  assert.equal(sourceStatus(store)[0].status, "unchanged");
  await engine.apply(engine.plan().id);
  assert.equal(store.device().originRealPaths?.[entry.id], source);
  assert.ok(!fs.lstatSync(target).isSymbolicLink());
  fs.appendFileSync(path.join(source, "SKILL.md"), "\nsource update");
  assert.equal(sourceStatus(store)[0].status, "changed");
  assert.equal(
    (await autoDeploy(engine, "source edit")).outcome,
    "needs-review",
  );
  await refreshSkills(store, [entry.id]);
  assert.equal((await autoDeploy(engine, "refresh")).outcome, "applied");
});

test("rollback restores the relocated native directory and its local origin record", async (t) => {
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, ".config/opencode/skills/rollback-source");
  skill(source, "rollback-source");
  const entry = await store.importSkill(source, all, undefined, true);
  const before = store.device();
  const applied = await engine.apply(engine.plan().id);
  assert.equal(store.device().origins?.[entry.id], undefined);
  await engine.rollback(applied.id!);
  assert.ok(fs.existsSync(source));
  assert.deepEqual(store.device(), before);
});

test("bundled applications and software projects are advisory exclusions; pure skill collections stay user skills", async (t) => {
  const { store, home } = await fixture(t);
  const appRoot = path.join(home, "Applications/ego lite.app");
  const app = path.join(appRoot, "Contents/Resources/ego-skills/ego-browser");
  const project = path.join(home, "Documents/Fork/de-run");
  const dev = path.join(project, "skills/de-run-subagent");
  const directProject = path.join(home, "Documents/Fork/direct-tool");
  const collection = path.join(home, "skill-collection");
  const user = path.join(collection, "skills/user-skill");
  const local = path.join(home, ".local/share/installed-tool/skills/installed");
  const module = path.join(
    home,
    "packages/node_modules/@tools/tool/skills/module-skill",
  );
  for (const [dir, name] of [
    [app, "ego-browser"],
    [dev, "de-run-subagent"],
    [directProject, "direct-tool"],
    [user, "user-skill"],
    [local, "installed"],
    [module, "module-skill"],
  ]) {
    skill(dir, name);
    link(dir, path.join(home, ".agents/skills", name));
  }
  fs.mkdirSync(path.join(directProject, "src"));
  fs.writeFileSync(path.join(directProject, "pyproject.toml"), "[project]\n");
  fs.mkdirSync(path.join(project, "src"));
  writeJson(path.join(project, "package.json"), {
    name: "irrelevant-display-name",
  });
  writeJson(path.join(collection, "package.json"), { private: true });
  const scan = scanMachine(store);
  assert.equal(scan.summary.bundledSkills, 5);
  assert.equal(scan.summary.excludedSkills, 5);
  assert.equal(scan.summary.importableSkills, 1);
  assert.equal(
    scan.skills.find((s) => s.name === "user-skill")?.origin,
    "user",
  );
  for (const [name, owner, dir] of [
    ["ego-browser", "ego lite", appRoot],
    ["de-run-subagent", "de-run", project],
    ["direct-tool", "direct-tool", directProject],
  ]) {
    const item = scan.skills.find((s) => s.name === name)!;
    assert.equal(item.origin, "bundled");
    assert.deepEqual(item.bundledBy, { name: owner, path: dir });
    assert.match(item.originReason, /随产品更新/);
  }
  const imported = await store.importSkill(
    path.join(home, ".agents/skills/ego-browser"),
    codex,
  );
  assert.equal(imported.name, "ego-browser");
});

test("credential enumeration only inspects names, ignores examples and never follows package links", async (t) => {
  const { home } = await fixture(t);
  const dir = path.join(home, "credentials-fixture");
  skill(dir, "credentials-fixture");
  fs.mkdirSync(path.join(dir, "nested"));
  for (const name of [
    ".env",
    ".genbox_token",
    "nested/private.pem",
    ".env.example",
    "nested/token.sample",
    "ordinary.txt",
  ])
    fs.writeFileSync(path.join(dir, name), "synthetic test fixture");
  link(path.join(home, "missing"), path.join(dir, "linked-dir"));
  const read = t.mock.method(fs, "readFileSync", () =>
    assert.fail("filename enumeration must not read contents"),
  );
  assert.deepEqual(credentialPaths(dir), [
    ".env",
    ".genbox_token",
    "nested/private.pem",
  ]);
  read.mock.restore();
});

test("scan counts credential skills once per real directory and CLI show lists library credential paths", async (t) => {
  const { store, home } = await fixture(t);
  const source = path.join(home, ".agents/skills/credentials-skill");
  skill(source, "credentials-skill");
  fs.mkdirSync(path.join(source, "nested"));
  fs.writeFileSync(path.join(source, ".env"), "synthetic test fixture");
  fs.writeFileSync(
    path.join(source, "nested/api_token.json"),
    "synthetic test fixture",
  );
  fs.writeFileSync(path.join(source, ".env.example"), "example only");
  link(source, path.join(home, ".claude/skills/credentials-skill"));
  const scan = scanMachine(store);
  assert.equal(scan.summary.credentialSkills, 1);
  assert.deepEqual(scan.skills[0].credentials, [
    ".env",
    "nested/api_token.json",
  ]);
  const entry = await store.importSkill(source, codex);
  assert.deepEqual(
    cli(store, ["skills", "show", entry.id]).credentials,
    scan.skills[0].credentials,
  );
  const { prompt } = await createOnboarding(store);
  for (const text of [
    "默认名称的仓库不存在",
    "无需手动关闭 deploy.auto",
    "用户坚持时照常",
    "仓库必须保持私有",
    "hsync sync ignore <技能名>/<文件>",
  ])
    assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes("不要把 API Key"));
});

test("an onboarding session started between auto plan and apply prevents all native writes", async (t) => {
  const { store, engine, home } = await fixture(t);
  await store.saveRule({
    title: "race",
    body: "ready",
    scope: { kind: "global", harnesses: ["claude"] },
  });
  const apply = engine.apply.bind(engine);
  engine.apply = async (id, options) => {
    await createOnboarding(store);
    return apply(id, options);
  };
  assert.equal(
    (await autoDeploy(engine, "racing scan")).outcome,
    "needs-review",
  );
  assert.ok(activeOnboarding(store));
  assert.ok(!fs.existsSync(path.join(home, ".claude/CLAUDE.md")));
});

test("failed final snapshot commit restores native files and origin records", async (t) => {
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, ".config/opencode/skills/failure-source");
  skill(source, "failure-source");
  await store.importSkill(source, all, undefined, true);
  const before = store.device();
  const plan = engine.plan();
  const rename = fs.renameSync;
  let snapshots = 0;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (
      String(to).startsWith(path.join(store.root, "deployments") + path.sep) &&
      ++snapshots === 2
    )
      throw new Error("injected snapshot failure");
    return rename(from, to);
  });
  await assert.rejects(engine.apply(plan.id), /injected snapshot failure/);
  assert.deepEqual(store.device(), before);
  assert.ok(fs.existsSync(source));
  assert.equal(engine.deployments()[0].status, "failed");
});

test("pending deployment rollback recovers origins whether cleanup had already happened or not", async (t) => {
  for (const cleaned of [true, false]) {
    const { store, engine, home } = await fixture(t);
    const source = path.join(home, ".config/opencode/skills/pending-source");
    skill(source, "pending-source");
    await store.importSkill(source, all, undefined, true);
    const before = store.device();
    const applied = await engine.apply(engine.plan().id);
    const file = path.join(store.root, "deployments", `${applied.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.status = "pending";
    writeJson(file, record);
    if (!cleaned) writeJson(path.join(store.root, "device.json"), before);
    await engine.rollback(applied.id!);
    assert.deepEqual(store.device(), before);
    assert.ok(fs.existsSync(source));
  }
});

test("rollback refuses newer origin records before touching native files and identity remapping follows cleanup snapshots", async (t) => {
  const { referenceChanges } = await import("../src/core/sync-identity.ts");
  const { store, engine, home } = await fixture(t);
  const source = path.join(home, ".config/opencode/skills/drift-source");
  skill(source, "drift-source");
  const entry = await store.importSkill(source, all, undefined, true);
  const applied = await engine.apply(engine.plan().id);
  const references = referenceChanges(store, { [entry.id]: "canonical-id" });
  const snapshot = references.after[`deployments/${applied.id}.json`];
  assert.equal(
    JSON.parse(Buffer.from(snapshot.content, "base64").toString())
      .removedOrigins[0].id,
    "canonical-id",
  );
  const device = store.device();
  device.origins = {
    ...device.origins,
    [entry.id]: path.join(home, "new-development-source"),
  };
  writeJson(path.join(store.root, "device.json"), device);
  await assert.rejects(engine.rollback(applied.id!), {
    code: "ROLLBACK_DRIFT",
  });
  assert.ok(!fs.existsSync(source));
});
