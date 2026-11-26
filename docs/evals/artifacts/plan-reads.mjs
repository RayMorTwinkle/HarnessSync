// Run with node --import tsx .../plan-reads.mjs from the checkout under test.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const load = (name) => import(pathToFileURL(path.resolve("src/core", name)));
const { Store } = await load("store.ts");
const { Engine } = await load("engine.ts");
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const report = {
  probeSha256: digest(fs.readFileSync(new URL(import.meta.url))),
  dependencies: Object.fromEntries(
    ["tsx", "zod", "diff", "yaml"].map((name) => [
      name,
      JSON.parse(
        fs.readFileSync(
          path.resolve("node_modules", name, "package.json"),
          "utf8",
        ),
      ).version,
    ]),
  ),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  os: process.platform,
  arch: process.arch,
  fixture:
    "schemaVersion 1, global rules, four built-ins, no skills or plugins",
  samples: [],
};
const targets = {
  deepseek: ".dsh/AGENTS.md",
  opencode: ".config/opencode/AGENTS.md",
  codex: ".codex/AGENTS.md",
  claude: ".claude/CLAUDE.md",
};
const harnesses = Object.keys(targets);
for (const count of [1, 12, 48]) {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-eval-"),
  );
  try {
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    const store = await new Store(path.join(dir, "store"), home).init();
    // All revisions can open legacy source libraries. Only touch this synthetic fixture.
    const rules = Array.from({ length: count }, (_, i) => ({
      id: `rule-${String(i).padStart(3, "0")}`,
      title: `Rule ${i}`,
      body: `Line ${i} on {{device.name}} in {{vars.REGION}}`,
      enabled: true,
      scope: { kind: "global", harnesses },
    }));
    fs.rmSync(path.join(store.repo, "harness-sync.json"), { force: true });
    fs.writeFileSync(
      path.join(store.repo, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, rules, projects: [], skills: [] }),
    );
    const device = {
      ...store.device(),
      name: "lab",
      id: "fixture",
      variables: { REGION: "east" },
    };
    const deviceFile = path.join(store.root, "device.json");
    fs.writeFileSync(deviceFile, JSON.stringify(device));
    const engine = new Engine(store);
    const expected = `<!-- harness-sync:begin -->\n# HarnessSync\n\n${rules
      .map((r, i) => `## ${r.title}\n\nLine ${i} on lab in east`)
      .join("\n\n")}\n<!-- harness-sync:end -->\n`;
    let reads = { manifest: 0, device: 0, state: 0 };
    for (const key of ["manifest", "device", "state"]) {
      const read = store[key].bind(store);
      store[key] = (...args) => {
        reads[key]++;
        return read(...args);
      };
    }
    engine.plan(); // warm-up excluded
    let last;
    for (let sample = 1; sample <= 5; sample++) {
      reads = { manifest: 0, device: 0, state: 0 };
      const start = performance.now();
      last = engine.plan();
      const elapsedMs = performance.now() - start;
      assert.deepEqual(last.errors, []);
      assert.deepEqual(
        last.changes.map((c) => c.harness).sort(),
        [...harnesses].sort(),
      );
      for (const change of last.changes) {
        assert.equal(change.status, "create");
        assert.equal(change.after, expected);
        assert.equal(change.path, path.join(home, targets[change.harness]));
        assert.ok(!fs.existsSync(change.path));
      }
      report.samples.push({
        rules: count,
        sample,
        reads: { ...reads },
        elapsedMs,
        outputSha256: digest(last.changes[0].after),
      });
    }
    fs.writeFileSync(
      deviceFile,
      JSON.stringify({ ...device, name: "changed" }),
    );
    const refreshed = engine.plan();
    assert.notEqual(last.id, refreshed.id);
    assert.ok(
      refreshed.changes.every((c) => c.after.includes("on changed in east")),
    );
    await assert.rejects(engine.apply(last.id), { code: "STALE_PLAN" });
    assert.ok(last.changes.every((c) => !fs.existsSync(c.path)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
report.assertions =
  "exact bytes for every target, create actions, read-only preview, device freshness, stale apply rejected before writes";
console.log(JSON.stringify(report, null, 2));
