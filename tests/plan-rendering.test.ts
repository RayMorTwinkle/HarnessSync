import test from "node:test";
import assert from "node:assert/strict";
import { instructionCompositions } from "../src/core/composition.ts";
import { fixture } from "./settings-helpers.ts";

test("添加同作用域规则不会增加单次预览读取设备与清单的次数", async (t) => {
  const { store, engine } = await fixture(t);
  const manifest = t.mock.method(store, "manifest");
  const device = t.mock.method(store, "device");

  function previewCounts() {
    manifest.mock.resetCalls();
    device.mock.resetCalls();
    const plan = engine.plan();
    assert.deepEqual(plan.errors, []);
    return [manifest.mock.callCount(), device.mock.callCount()];
  }
  await store.saveRule({ title: "First", body: "Hello {{device.name}}" });
  const counts = previewCounts();
  await store.saveRule({ title: "Second", body: "From {{device.home}}" });
  assert.deepEqual(previewCounts(), counts);

  await store.saveDevice({ name: "old", variables: {} });
  const previous = engine.plan();
  await store.saveDevice({ name: "new", variables: {} });
  const next = engine.plan();
  assert.notEqual(previous.id, next.id);
  for (const change of next.changes) assert.match(change.after, /Hello new/);
  for (const output of instructionCompositions(store)) {
    const variable = output.segments
      .flatMap((s) => s.parts)
      .find((p) => p.key === "device.name");
    assert.equal(variable?.text, "new");
  }
  await assert.rejects(engine.apply(previous.id), { code: "STALE_PLAN" });
});
