import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Engine, publicPlan } from "./core/engine.ts";
import { Store } from "./core/store.ts";
import { AppError, hash, parseSkill } from "./core/files.ts";
import { scopeSchema } from "./shared/types.ts";
import { installSelfSkill } from "./core/self-skill.ts";
import {
  createOnboarding,
  getOnboarding,
  bootstrapOnboarding,
} from "./core/onboarding.ts";

export async function startServer(
  store: Store,
  options: { port?: number; dev?: boolean; uiDirectory?: string } = {},
) {
  const engine = new Engine(store);
  const token = crypto.randomBytes(32).toString("hex");
  const projectRoot = path.resolve(
    fileURLToPath(new URL("..", import.meta.url)),
  );
  const uiRoot = options.uiDirectory || path.join(projectRoot, "dist/ui");
  if (!options.dev && !fs.existsSync(path.join(uiRoot, "index.html")))
    throw new AppError(
      "UI_NOT_BUILT",
      "未找到 Web UI，请先运行 npm run build 或重新安装 HarnessSync",
    );
  const vite = options.dev
    ? await (
        await import("vite")
      ).createServer({
        root: projectRoot,
        server: { middlewareMode: true },
        appType: "custom",
      })
    : null;
  let actualPort = options.port ?? 47821;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const validHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!req.headers.host || !validHosts.includes(req.headers.host))
        return send(403, {
          ok: false,
          code: "INVALID_HOST",
          message: "只允许本机访问",
        });
      const origin = req.headers.origin;
      if (origin && !validHosts.map((h) => `http://${h}`).includes(origin))
        return send(403, {
          ok: false,
          code: "INVALID_ORIGIN",
          message: "拒绝跨站请求",
        });
      const url = new URL(req.url || "/", `http://127.0.0.1:${actualPort}`);
      if (req.method === "GET" && url.pathname === "/.well-known/harness-sync")
        return send(200, {
          app: "HarnessSync",
          protocol: 1,
          rootHash: hash(store.root),
        });
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["x-harness-sync-token"] !== token)
          return send(403, {
            ok: false,
            code: "INVALID_TOKEN",
            message: "本地会话已失效，请刷新页面",
          });
        let body: any = {};
        if (!["GET", "HEAD"].includes(req.method!)) {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new AppError("CONTENT_TYPE", "需要 application/json", 415);
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024)
              throw new AppError("PAYLOAD_TOO_LARGE", "请求超过 1 MB", 413);
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          } catch {
            throw new AppError("INVALID_JSON", "JSON 无法解析");
          }
        }
        const parts = url.pathname.split("/").filter(Boolean);
        const resource = parts[1];
        const id = parts[2];
        let result: unknown;
        if (req.method === "GET" && resource === "snapshot") {
          const s = engine.snapshot();
          result = { ...s, plan: publicPlan(s.plan) };
        } else if (req.method === "GET" && resource === "inspect")
          result = engine.inspect();
        else if (req.method === "GET" && resource === "onboarding")
          result = getOnboarding(store, id);
        else if (req.method === "POST" && resource === "onboarding-scan")
          result = await createOnboarding(store);
        else if (req.method === "POST" && resource === "onboarding-bootstrap")
          result = await bootstrapOnboarding(store, z.string().parse(body.id));
        else if (req.method === "GET" && resource === "skills" && id) {
          const skill = store.manifest().skills.find((s) => s.id === id);
          if (!skill) throw new AppError("NOT_FOUND", "Skill 不存在", 404);
          const { body: markdown } = parseSkill(
            fs.readFileSync(path.join(store.skillPath(id), "SKILL.md"), "utf8"),
          );
          result = { ...skill, body: markdown };
        } else if (req.method === "POST" && resource === "rules")
          result = await store.saveRule(body.value, id, body.revision);
        else if (req.method === "POST" && resource === "skills")
          result = await store.saveSkill(body.value, id, body.revision);
        else if (req.method === "POST" && resource === "projects")
          result = await store.saveProject(body.value, id, body.revision);
        else if (req.method === "POST" && resource === "device")
          result = await store.saveDevice(body.value, body.revision);
        else if (req.method === "POST" && resource === "import")
          result = await store.importSkill(
            z.string().min(1).parse(body.path),
            scopeSchema.parse(body.scope || {}),
            body.revision,
            z.boolean().default(false).parse(body.adopt),
          );
        else if (req.method === "POST" && resource === "apply")
          result = await engine.apply(z.string().parse(body.planId));
        else if (req.method === "POST" && resource === "rollback")
          result = await engine.rollback(z.string().parse(body.id));
        else if (req.method === "POST" && resource === "restore")
          result = await store.restoreSource(
            z.string().parse(body.hash),
            body.revision,
          );
        else if (req.method === "POST" && resource === "self-skill")
          result = await installSelfSkill(store, body.revision);
        else if (
          req.method === "DELETE" &&
          ["rules", "skills", "projects"].includes(resource) &&
          id
        )
          result = await store.remove(
            resource as "rules" | "skills" | "projects",
            id,
            body.revision,
          );
        else throw new AppError("NOT_FOUND", "接口不存在", 404);
        return send(200, { ok: true, data: result });
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return send(405, { ok: false, message: "Method not allowed" });
      const renderIndex = async () => {
        let html = fs.readFileSync(
          vite
            ? path.join(projectRoot, "index.html")
            : path.join(uiRoot, "index.html"),
          "utf8",
        );
        if (vite) html = await vite.transformIndexHtml(url.pathname, html);
        html = html.replace(
          "<!--HSYNC_TOKEN-->",
          `<meta name="harness-sync-token" content="${token}">`,
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        });
        res.end(html);
      };
      if (url.pathname === "/" || url.pathname === "/index.html")
        return await renderIndex();
      if (vite)
        return vite.middlewares(req, res, () => {
          void renderIndex().catch((e) => send(500, { message: e.message }));
        });
      const filename = path.resolve(
        uiRoot,
        "." + decodeURIComponent(url.pathname),
      );
      if (!filename.startsWith(uiRoot + path.sep))
        return send(403, { message: "Forbidden" });
      if (fs.existsSync(filename) && fs.statSync(filename).isFile()) {
        const mime: Record<string, string> = {
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".woff2": "font/woff2",
        };
        res.writeHead(200, {
          "content-type":
            mime[path.extname(filename)] || "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        fs.createReadStream(filename).pipe(res);
      } else await renderIndex();
    } catch (e: any) {
      send(
        e instanceof AppError ? e.status : e instanceof z.ZodError ? 400 : 500,
        {
          ok: false,
          code: e.code || "ERROR",
          message:
            e instanceof z.ZodError
              ? e.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("；")
              : e.message,
        },
      );
    }
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(actualPort, "127.0.0.1", () => {
      actualPort = (server.address() as any).port;
      resolve();
    });
  });
  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      await vite?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
