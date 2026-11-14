import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./settings-helpers.ts";
import { createOnboarding, getOnboarding } from "../src/core/onboarding.ts";
import {
  skillMarkdown,
  readBundle,
  bundleHash,
  skillPackageHash,
  writeJson,
} from "../src/core/files.ts";
import { sourceStatus } from "../src/core/skill-sources.ts";
import { adapters } from "../src/core/adapters.ts";
const scope = { kind: "global" as const, harnesses: ["codex"] };
function skill(dir: string, name: string, body = "local") {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    skillMarkdown(name, "说明", body, { custom: "preserved" }),
  );
  fs.writeFileSync(path.join(dir, "assets/data.bin"), Buffer.from([0, 1, 255]));
}
function native(store: { home: string; root: string }, name: string) {
  return path.join(
    adapters(store.home, store.root).find((h) => h.id === "codex")!.skills,
    name,
  );
}

test("show recomputes same/differs/absent from the current library using full normalized packages", async (t) => {
  const { store, root } = await fixture(t);
  for (const name of ["same", "differs", "absent"])
    skill(native(store, name), name);
  const record = await createOnboarding(store);
  const source = path.join(root, "source");
  skill(source, "same");
  const same = await store.importSkill(source, scope);
  skill(source, "differs");
  fs.writeFileSync(path.join(source, "assets/data.bin"), "changed resource");
  await store.importSkill(source, scope);
  fs.chmodSync(path.join(store.skillPath(same.id), "SKILL.md"), 0o600);
  const show = getOnboarding(store, record.id)!;
  assert.deepEqual(show.inventory.summary.library, {
    same: 1,
    differs: 1,
    absent: 1,
  });
  assert.deepEqual(
    show.inventory.skills.find((s) => s.name === "same")!.library,
    { status: "same", id: same.id, name: "same" },
  );
  // Simulate a library pulled after the saved scan; do not re-scan native directories.
  skill(source, "absent");
  await store.importSkill(source, scope);
  assert.deepEqual(getOnboarding(store, record.id)!.inventory.summary.library, {
    same: 2,
    differs: 1,
    absent: 0,
  });
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(store.root, "onboarding", record.id, "session.json"),
        "utf8",
      ),
    ).inventory.summary.library,
    undefined,
  );
  fs.chmodSync(path.join(source, "assets/data.bin"), 0o755);
  assert.notEqual(
    skillPackageHash(readBundle(source)),
    skillPackageHash(
      readBundle(
        store.skillPath(
          store.manifest().skills.find((s) => s.name === "absent")!.id,
        ),
      ),
    ),
  );
});

test("same import reuses ID, stages adoption, preserves native permissions, and rolls ownership back", async (t) => {
  const { store, engine, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "same");
  const entry = await store.importSkill(source, scope);
  const target = native(store, "same");
  skill(target, "same");
  fs.chmodSync(path.join(target, "SKILL.md"), 0o600);
  const before = bundleHash(readBundle(target));
  const imported = await store.importSkill(target, scope);
  assert.equal(imported.id, entry.id);
  assert.equal(store.manifest().skills.length, 1);
  assert.equal(store.state().receipts.length, 0);
  const plan = engine.plan();
  assert.equal(plan.changes.find((c) => c.path === target)?.status, "adopt");
  const result = await engine.apply(plan.id);
  assert.equal(bundleHash(readBundle(target)), before);
  assert.equal(store.state().receipts[0].sourceId, entry.id);
  assert.equal(
    engine.plan().changes.find((c) => c.path === target)?.status,
    "unchanged",
  );
  await engine.rollback(result.id!);
  assert.equal(store.state().receipts.length, 0);
  assert.equal(bundleHash(readBundle(target)), before);
});

test("differs refuses without an explicit choice and gives all four commands without mutating", async (t) => {
  const { store, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "differs", "shared");
  const entry = await store.importSkill(source, scope);
  const target = native(store, "differs");
  skill(target, "differs", "local");
  const before = store.revision();
  await assert.rejects(
    store.importSkill(target, scope, undefined, true),
    (e: any) => {
      assert.equal(e.code, "LIBRARY_DIFFERS");
      for (const text of [
        "--use-library",
        "--replace-library",
        "--name",
        "合并目录",
        "明确同意",
        "其他设备",
      ])
        assert.ok(e.message.includes(text));
      return true;
    },
  );
  assert.equal(store.revision(), before);
  assert.ok(
    fs
      .readFileSync(path.join(store.skillPath(entry.id), "SKILL.md"), "utf8")
      .includes("shared"),
  );
});

test("use-library stages a full diff and snapshot replacement, then rollback restores local assets", async (t) => {
  const { store, engine, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "version", "shared");
  const entry = await store.importSkill(source, scope);
  const target = native(store, "version");
  skill(target, "version", "local");
  fs.writeFileSync(path.join(target, "assets/data.bin"), "local binary");
  const before = bundleHash(readBundle(target));
  assert.equal(
    (
      await store.importSkill(target, scope, undefined, false, {
        useLibrary: true,
      })
    ).id,
    entry.id,
  );
  assert.equal(bundleHash(readBundle(target)), before);
  const plan = engine.plan();
  const change = plan.changes.find((c) => c.path === target)!;
  assert.equal(change.status, "replace");
  assert.match(change.diff, /local/);
  assert.match(change.diff, /shared/);
  assert.ok(change.fileChanges?.some((f) => f.path === "assets/data.bin"));
  const result = await engine.apply(plan.id);
  assert.equal(
    bundleHash(readBundle(target)),
    bundleHash(readBundle(store.skillPath(entry.id))),
  );
  await engine.rollback(result.id!);
  assert.equal(bundleHash(readBundle(target)), before);
});

test("replace-library replaces a complete package while retaining ID, scope, enablement and display label", async (t) => {
  const { store, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "version", "shared");
  const entry = await store.importSkill(source, scope);
  await store.mutate("metadata", (m) => {
    m.skills[0].enabled = false;
    m.skills[0].displayName = "显示名称";
  });
  const local = path.join(root, "merged");
  skill(local, "version", "merged");
  fs.rmSync(path.join(local, "assets/data.bin"));
  fs.writeFileSync(path.join(local, "assets/new.txt"), "new");
  const result = await store.importSkill(
    local,
    { kind: "global", harnesses: ["claude"] },
    undefined,
    false,
    { replaceLibrary: true },
  );
  assert.equal(result.id, entry.id);
  assert.equal(result.enabled, false);
  assert.equal(result.displayName, "显示名称");
  assert.deepEqual(result.scope, scope);
  assert.equal(
    bundleHash(readBundle(store.skillPath(entry.id))),
    bundleHash(readBundle(local)),
  );
  assert.equal(store.device().origins![entry.id], local);
});

test("name keeps both packages, unknown metadata and original native content", async (t) => {
  const { store, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "version", "shared");
  await store.importSkill(source, scope);
  const target = native(store, "version");
  skill(target, "version", "local");
  const before = bundleHash(readBundle(target));
  const result = await store.importSkill(target, scope, undefined, false, {
    name: "version-local",
  });
  assert.equal(result.name, "version-local");
  assert.equal(store.device().origins?.[result.id], undefined);
  assert.ok(!sourceStatus(store).some((s) => s.id === result.id));
  assert.equal(store.manifest().skills.length, 2);
  assert.equal(bundleHash(readBundle(target)), before);
  assert.match(
    fs.readFileSync(path.join(store.skillPath(result.id), "SKILL.md"), "utf8"),
    /custom: preserved/,
  );
  assert.equal(store.state().receipts.length, 0);
  await assert.rejects(
    store.importSkill(target, scope, undefined, false, {
      name: "version-local",
    }),
    { code: "DUPLICATE_NAME" },
  );
  await assert.rejects(
    store.importSkill(target, scope, undefined, false, {
      useLibrary: true,
      replaceLibrary: true,
    }),
    { code: "IMPORT_OPTIONS" },
  );
  await assert.rejects(
    store.importSkill(target, scope, undefined, true, { name: "another" }),
    { code: "IMPORT_OPTIONS" },
  );
});

test("staged existing-library adoption and replacement reject stale plans and symlink ancestors", async (t) => {
  const { store, engine, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "version", "shared");
  await store.importSkill(source, scope);
  const target = native(store, "version");
  skill(target, "version", "local");
  await store.importSkill(target, scope, undefined, false, {
    useLibrary: true,
  });
  const plan = engine.plan();
  fs.appendFileSync(path.join(target, "SKILL.md"), "external edit");
  await assert.rejects(engine.apply(plan.id), { code: "STALE_PLAN" });
  assert.equal(
    engine.plan().changes.find((c) => c.path === target)?.status,
    "conflict",
  );
  const parent = path.dirname(target),
    moved = path.join(root, "moved");
  fs.renameSync(parent, moved);
  fs.symlinkSync(moved, parent);
  await assert.rejects(
    store.importSkill(target, scope, undefined, false, { useLibrary: true }),
    { code: "SYMLINK_TARGET" },
  );
});

test("prompt checks first-device and existing GitHub repository before import and requires consent for replacement or merge", async (t) => {
  const { store } = await fixture(t);
  const { prompt } = await createOnboarding(store);
  for (const text of [
    "这是你第一台使用 HarnessSync 的设备吗？",
    "无论答案如何",
    "gh auth status",
    "gh repo view harness-sync-config --json name,url,visibility",
    "先向用户确认仓库 URL",
    "sync setup --url <url>",
    "替换共享库或合并之前必须得到用户明确同意",
    "内容相同的条目会自动合并",
    "hsync sync conflicts",
  ])
    assert.ok(prompt.includes(text), text);
  assert.ok(prompt.indexOf("0.") < prompt.indexOf("1. 重新检查"));
  // No gh executable is invoked while scanning or displaying onboarding.
  writeJson(path.join(store.root, "sync.json"), {
    url: "/tmp/fake-repo",
    branch: "main",
    conflicts: [],
  });
  assert.match(getOnboarding(store)!.prompt, /本机已经连接同步，跳过本步骤/);
});

test("GitHub discovery uses an injected runner, checks auth before repo for either device answer and skips connected stores", async (t) => {
  const { findOnboardingRepository } =
    await import("../src/core/onboarding.ts");
  const { store } = await fixture(t);
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return {
      code: 0,
      stdout:
        args[0] === "auth"
          ? "logged in"
          : JSON.stringify({
              name: "harness-sync-config",
              url: "https://github.com/example/harness-sync-config",
              visibility: "PRIVATE",
              ignoredSecret: "secret",
            }),
    };
  };
  const result = await findOnboardingRepository(store, runner);
  assert.equal(result.status, "found");
  assert.deepEqual(calls, [
    ["gh", "auth", "status"],
    [
      "gh",
      "repo",
      "view",
      "harness-sync-config",
      "--json",
      "name,url,visibility",
    ],
  ]);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(
    (
      await findOnboardingRepository(store, async () => ({
        code: 1,
        stdout: "",
      }))
    ).status,
    "unavailable",
  );
  assert.equal(
    (
      await findOnboardingRepository(store, async (_, args) => ({
        code: args[0] === "auth" ? 0 : 1,
        stdout: "",
      }))
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await findOnboardingRepository(store, async () => {
        throw new Error("missing gh");
      })
    ).status,
    "unknown",
  );
  writeJson(path.join(store.root, "sync.json"), {
    url: "/tmp/fake-repo",
    branch: "main",
    conflicts: [],
  });
  assert.equal(
    (
      await findOnboardingRepository(store, async () => {
        assert.fail("connected must not invoke gh");
      })
    ).status,
    "connected",
  );
});

test("adoption stays local, preserves scope isolation and cannot overwrite another entry's receipt", async (t) => {
  const { store, engine, root } = await fixture(t);
  const source = path.join(root, "source");
  skill(source, "scope", "same");
  const entry = await store.importSkill(source, scope);
  const target = native(store, "scope");
  skill(target, "scope", "same");
  await store.importSkill(target, scope);
  await engine.apply(engine.plan().id);
  assert.ok(
    !store
      .git(["show", "HEAD:entries/skills/" + entry.id + ".json"])
      .includes("adoptScope"),
  );
  await store.saveSkill(
    {
      ...entry,
      body: "same",
      scope: { kind: "global", harnesses: ["claude"] },
    },
    entry.id,
  );
  assert.equal(
    engine.plan().changes.find((c) => c.path === target)?.status,
    "remove",
  );
  await assert.rejects(
    store.importSkill(target, scope, undefined, false, { useLibrary: true }),
    { code: "ALREADY_MANAGED" },
  );
});
