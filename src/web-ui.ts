import path from "node:path";
import { spawn } from "node:child_process";
import type { Store } from "./core/store.ts";
import { AppError, hash } from "./core/files.ts";
import { startServer } from "./server.ts";

export function parsePort(value: string | number) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new AppError("INVALID_PORT", "端口必须为 0–65535");
  return port;
}

/** Only reuse HarnessSync for the requested store, including v0.2.1 servers. */
async function existingServer(store: Store, port: number) {
  if (port === 0) return false;
  const url = `http://127.0.0.1:${port}`;
  const conflict = () =>
    new AppError(
      "PORT_IN_USE",
      `端口 ${port} 已被占用，未确认是 HarnessSync；请使用 --port 指定其他端口`,
    );
  let response: Response;
  try {
    response = await fetch(`${url}/.well-known/harness-sync`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
  } catch (error: any) {
    if (error.cause?.code === "ECONNREFUSED") return false;
    throw conflict();
  }
  let rootMatches = false;
  const text = await response.text();
  if (
    response.ok &&
    response.headers.get("content-type")?.includes("application/json")
  ) {
    let identity: any;
    try {
      identity = JSON.parse(text);
    } catch {
      throw conflict();
    }
    if (identity?.app !== "HarnessSync" || identity.protocol !== 1)
      throw conflict();
    rootMatches = identity.rootHash === hash(store.root);
  } else {
    // Older servers expose their own session token in the local index page.
    // Validate both their API shape and root before opening the browser.
    const token = text.match(
      /name="harness-sync-token" content="([a-f0-9]{64})"/,
    )?.[1];
    if (!response.ok || !token) throw conflict();
    try {
      const snapshot = await fetch(`${url}/api/snapshot`, {
        headers: { "x-harness-sync-token": token },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const result: any = await snapshot.json();
      if (
        !snapshot.ok ||
        !result.ok ||
        !result.data?.root ||
        result.data.manifest?.schemaVersion !== 1 ||
        !Array.isArray(result.data.harnesses)
      )
        throw conflict();
      rootMatches = path.resolve(result.data.root) === store.root;
    } catch {
      throw conflict();
    }
  }
  if (!rootMatches)
    throw new AppError(
      "DIFFERENT_STORE",
      `端口 ${port} 的 HarnessSync 使用另一个配置库；请使用 --port 指定其他端口`,
    );
  return true;
}

export function launchBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["/usr/bin/open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", timeout: 10_000 });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`浏览器启动命令退出：${code}`)),
    );
  });
}

export async function openWebUi(
  store: Store,
  options: {
    port?: number;
    launch?: (url: string) => Promise<void>;
    uiDirectory?: string;
  } = {},
) {
  const port = parsePort(options.port ?? 47821);
  let reused = await existingServer(store, port);
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  if (!reused) {
    try {
      running = await startServer(store, {
        port,
        uiDirectory: options.uiDirectory,
      });
    } catch (error: any) {
      if (error.code !== "EADDRINUSE" || !(await existingServer(store, port)))
        throw error;
      reused = true;
    }
  }
  const url = running?.url || `http://127.0.0.1:${port}`;
  let warning: string | undefined;
  try {
    await (options.launch || launchBrowser)(url);
  } catch (error: any) {
    warning = `无法自动打开浏览器：${error.message}。请手动访问 ${url}`;
  }
  return { url, reused, browserOpened: !warning, warning, running };
}
