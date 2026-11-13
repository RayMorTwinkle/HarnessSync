import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { LoginService, type CommandRunner } from "../src/core/service.ts";
import { Settings } from "../src/core/settings.ts";

export async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-settings-"),
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const cleanups: (() => Promise<unknown>)[] = [];
  const defer = (fn: () => Promise<unknown>) => cleanups.push(fn);
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = await new Store(path.join(root, "store"), home).init();
  const service = new LoginService(store, {
    platform: "test-unsupported",
    runner: async () => {
      throw new Error("must not run");
    },
  });
  return {
    root,
    defer,
    home,
    store,
    engine: new Engine(store),
    settings: new Settings(store, service),
  };
}
export function fakeRunner() {
  let loaded = false;
  const calls: { command: string; args: string[] }[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (["print", "is-active", "is-enabled"].some((s) => args.includes(s)))
      return {
        code: loaded ? 0 : 3,
        stdout: loaded ? "running" : "not loaded",
      };
    if (args.some((a) => ["bootstrap", "enable"].includes(a))) loaded = true;
    if (args.some((a) => ["bootout", "disable", "stop"].includes(a)))
      loaded = false;
    return { code: 0, stdout: "" };
  };
  return {
    runner,
    calls,
    setLoaded(value: boolean) {
      loaded = value;
    },
  };
}
export const pause = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("等待条件超时");
    await pause(20);
  }
}
export function ui(root: string) {
  const dir = path.join(root, "ui");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<!--HSYNC_TOKEN-->");
  return dir;
}
