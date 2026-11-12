import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../src/core/store.ts";
import { startServer } from "../src/server.ts";
import { openWebUi } from "../src/web-ui.ts";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hsync-open-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = await new Store(
    path.join(root, "store"),
    path.join(root, "home"),
  ).init();
  const uiDirectory = path.join(root, "ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(
    path.join(uiDirectory, "index.html"),
    "<html><!--HSYNC_TOKEN-->HarnessSync</html>",
  );
  return { root, store, uiDirectory };
}

test("open starts a local GUI and launches its actual URL, then reuses the same store server", async (t) => {
  const { store, uiDirectory } = await fixture(t);
  const opened: string[] = [];
  const launch = async (url: string) => {
    opened.push(url);
  };
  const first = await openWebUi(store, { port: 0, uiDirectory, launch });
  t.after(() => first.running!.close());
  assert.equal(first.reused, false);
  assert.equal(first.browserOpened, true);
  assert.deepEqual(opened, [first.url]);
  assert.match(await (await fetch(first.url)).text(), /HarnessSync/);
  const second = await openWebUi(store, { port: first.running!.port, launch });
  assert.equal(second.reused, true);
  assert.equal(second.running, undefined);
  assert.deepEqual(opened, [first.url, first.url]);
  const identity = await (
    await fetch(first.url + "/.well-known/harness-sync")
  ).json();
  assert.equal(identity.app, "HarnessSync");
  assert.ok(!JSON.stringify(identity).includes(store.root));
});

test("open refuses another configuration store rather than opening the wrong GUI", async (t) => {
  const { root, store, uiDirectory } = await fixture(t);
  const running = await startServer(store, { port: 0, uiDirectory });
  t.after(() => running.close());
  const other = await new Store(path.join(root, "other"), store.home).init();
  await assert.rejects(
    openWebUi(other, {
      port: running.port,
      launch: async () => {
        assert.fail("must not open browser");
      },
    }),
    { code: "DIFFERENT_STORE" },
  );
});

test("open refuses an unrelated HTTP listener and leaves it running", async (t) => {
  const { store } = await fixture(t);
  const server = http.createServer((_req, res) => res.end("unrelated app"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as { port: number }).port;
  await assert.rejects(
    openWebUi(store, {
      port,
      launch: async () => {
        assert.fail("must not open browser");
      },
    }),
    { code: "PORT_IN_USE" },
  );
  assert.equal(
    await (await fetch(`http://127.0.0.1:${port}`)).text(),
    "unrelated app",
  );
});

test("open can reuse older HarnessSync servers after verifying their session API and store", async (t) => {
  const { store } = await fixture(t);
  const token = "a".repeat(64);
  const server = http.createServer((req, res) => {
    if (req.url === "/api/snapshot") {
      assert.equal(req.headers["x-harness-sync-token"], token);
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            root: store.root,
            manifest: { schemaVersion: 1 },
            harnesses: [],
          },
        }),
      );
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<html><meta name="harness-sync-token" content="${token}">HarnessSync</html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const result = await openWebUi(store, {
    port: (server.address() as { port: number }).port,
    launch: async () => {},
  });
  assert.equal(result.reused, true);
  assert.equal(result.browserOpened, true);
});

test("browser launch failure keeps the GUI accessible and reports its URL", async (t) => {
  const { store, uiDirectory } = await fixture(t);
  const result = await openWebUi(store, {
    port: 0,
    uiDirectory,
    launch: async () => {
      throw new Error("no desktop session");
    },
  });
  t.after(() => result.running!.close());
  assert.equal(result.browserOpened, false);
  assert.ok(result.warning?.includes(result.url));
  assert.equal((await fetch(result.url)).status, 200);
});
