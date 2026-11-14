import { cancelOnboarding } from "./core/onboarding-session.ts";
import { credentialPaths } from "./core/credentials.ts";
import { SyncIgnore } from "./core/sync-ignore.ts";
import { Backups } from "./core/backup.ts";
import { Uninstaller } from "./core/uninstall.ts";
import {
  instructionCompositions,
  skillComposition,
} from "./core/composition.ts";
import {
  installGitSkills,
  updateGitSkills,
  diffGitSkill,
  detachGitSkill,
  listedSkills,
} from "./core/git-skills.ts";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Engine, publicPlan } from "./core/engine.ts";
import { collectNotices } from "./core/notices.ts";
import { Settings } from "./core/settings.ts";
import { LoginService, type ServiceOptions } from "./core/service.ts";
import {
  cachedSkillUpdates,
  type UpdateChecker,
} from "./core/update-checks.ts";
import { startBackgroundScheduler } from "./core/sync-scheduler.ts";
import { Sync } from "./core/sync.ts";
import { checkSync, type SyncCheckOptions } from "./core/sync-check.ts";
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
  options: {
    port?: number;
    dev?: boolean;
    uiDirectory?: string;
    background?: boolean;
    service?: ServiceOptions;
    schedulerIntervalMs?: number;
    autoDeployDelayMs?: number;
    updateChecker?: UpdateChecker;
    syncCheck?: SyncCheckOptions;
  } = {},
) {
  const engine = new Engine(store);
  const settings = new Settings(
    store,
    new LoginService(store, options.service),
  );
  let background: Awaited<ReturnType<typeof startBackgroundScheduler>>;
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
        if (
          resource === "composition" &&
          req.method === "GET" &&
          id === "instructions" &&
          parts.length === 3
        )
          result = { outputs: instructionCompositions(store) };
        else if (
          resource === "composition" &&
          req.method === "GET" &&
          id === "skills" &&
          parts.length === 4
        )
          result = skillComposition(store, decodeURIComponent(parts[3]));
        else if (resource === "backups" && req.method === "GET" && !id)
          result = new Backups(store).list();
        else if (resource === "backups" && req.method === "POST" && !id)
          result = await new Backups(store).create(
            z.boolean().optional().parse(body.confirmLarge),
          );
        else if (
          resource === "backups" &&
          req.method === "POST" &&
          id === "restore-plan"
        )
          result = new Backups(store).plan(
            z.string().optional().parse(body.dir),
          );
        else if (
          resource === "backups" &&
          req.method === "POST" &&
          id === "restore"
        )
          result = await new Backups(store).restore(
            z.string().parse(body.planId),
            undefined,
            z.array(z.string()).optional().parse(body.overwrite),
          );
        else if (resource === "uninstall-plan" && req.method === "POST")
          result = new Uninstaller(store, settings.service).plan(
            z
              .object({
                mode: z.enum(["restore", "keep-files"]),
                deleteLibrary: z.boolean().optional(),
              })
              .strict()
              .parse(body),
          );
        else if (resource === "uninstall" && req.method === "POST") {
          // bootout/stop can terminate this HTTP process. Remove the service
          // definition now, but send the report before invoking those commands.
          const deferred: { command: string; args: string[] }[] = [];
          const service = new LoginService(store, {
            ...options.service,
            runner: async (command, args) => {
              if (
                args.some((a) =>
                  ["bootout", "stop", "daemon-reload"].includes(a),
                )
              ) {
                deferred.push({ command, args });
                return { code: 0, stdout: "" };
              }
              return settings.service.runner(command, args);
            },
          });
          res.once("finish", () => {
            void (async () => {
              for (const call of deferred) {
                const outcome = await settings.service.runner(
                  call.command,
                  call.args,
                );
                if (outcome.code)
                  console.error("登录服务停止失败：", outcome.stdout);
              }
            })().catch((error) =>
              console.error("登录服务停止失败：", error.message),
            );
          });
          result = {
            ...(await new Uninstaller(store, service, {
              stopScheduler: async () => {
                await stopBackground();
              },
            }).apply(z.string().parse(body.planId))),
            serviceStopDeferred: deferred.length > 0,
          };
        } else if (req.method === "GET" && resource === "harnesses" && !id) {
          result = store.harnesses();
        } else if (req.method === "PUT" && resource === "harnesses" && id) {
          const input = z
            .strictObject({
              enabled: z.boolean(),
              revision: z.string().optional(),
            })
            .parse(body);
          result = await store.setHarnessEnabled(
            id,
            input.enabled,
            input.revision,
          );
        } else if (req.method === "GET" && resource === "snapshot") {
          const s = engine.snapshot();
          result = {
            ...s,
            plan: publicPlan(s.plan),
            sync: new Sync(store).local(),
            notices: collectNotices(store),
          };
        } else if (resource === "settings" && req.method === "GET")
          result = await settings.get();
        else if (resource === "settings" && req.method === "PUT")
          result = await settings.patch(
            body,
            req.headers["if-match"] as string | undefined,
          );
        else if (
          resource === "skills" &&
          id === "updates" &&
          req.method === "GET"
        )
          result = cachedSkillUpdates(store);
        else if (req.method === "GET" && resource === "inspect")
          result = engine.inspect();
        else if (
          resource === "sync" &&
          req.method === "GET" &&
          (!id || id === "status")
        )
          result = await new Sync(store).status();
        else if (resource === "sync" && id === "ignore" && req.method === "GET")
          result = new SyncIgnore(store).status();
        else if (
          resource === "sync" &&
          id === "ignore" &&
          req.method === "POST"
        )
          result = await new SyncIgnore(store).update(body);
        else if (
          resource === "sync" &&
          req.method === "GET" &&
          id === "conflicts"
        )
          result = await new Sync(store).conflicts(true);
        else if (
          resource === "sync" &&
          req.method === "GET" &&
          id === "check"
        ) {
          const create = url.searchParams.get("create");
          result = await checkSync(
            {
              url: url.searchParams.get("url") || undefined,
              create:
                create === null || create === "false"
                  ? undefined
                  : create === "" || create === "true"
                    ? true
                    : create,
            },
            { ...options.syncCheck, store },
          );
        } else if (
          resource === "sync" &&
          req.method === "POST" &&
          id === "setup"
        )
          result = await new Sync(store).setup(
            z
              .object({
                url: z.string().optional(),
                create: z.union([z.string(), z.boolean()]).optional(),
                branch: z.string().optional(),
              })
              .parse(body),
          );
        else if (resource === "sync" && req.method === "GET" && id === "auto")
          result = new Sync(store).autoSettings();
        else if (resource === "sync" && req.method === "PUT" && id === "auto")
          result = await new Sync(store).setAuto(body);
        else if (
          resource === "sync" &&
          req.method === "GET" &&
          id === "history"
        )
          result = await new Sync(store).history();
        else if (resource === "sync" && req.method === "POST" && id === "undo")
          result = await new Sync(store).undo();
        else if (resource === "sync" && req.method === "POST" && id === "now")
          result = await new Sync(store).now();
        else if (
          resource === "sync" &&
          req.method === "POST" &&
          id === "resolve"
        )
          result = await new Sync(store).resolve(
            z.string().parse(body.entryId),
            z.enum(["local", "remote", "both", "merged"]).parse(body.keep),
            z.string().optional().parse(body.from),
          );
        else if (
          resource === "sync" &&
          req.method === "POST" &&
          id === "disconnect"
        )
          result = await new Sync(store).disconnect();
        else if (req.method === "GET" && resource === "onboarding")
          result = getOnboarding(store, id);
        else if (req.method === "POST" && resource === "onboarding-scan")
          result = await createOnboarding(store);
        else if (req.method === "POST" && resource === "onboarding-cancel")
          result = await cancelOnboarding(
            store,
            z.string().uuid().parse(body.id),
          );
        else if (req.method === "POST" && resource === "onboarding-bootstrap")
          result = await bootstrapOnboarding(store, z.string().parse(body.id));
        else if (
          resource === "skills" &&
          req.method === "POST" &&
          id === "install"
        )
          result = await installGitSkills(
            store,
            z.string().min(1).parse(body.source),
            z
              .object({
                skills: z.array(z.string().min(1)).optional(),
                all: z.boolean().optional(),
                ref: z.string().min(1).optional(),
                commit: z.string().optional(),
                scope: scopeSchema.optional(),
              })
              .parse(body),
          );
        else if (
          resource === "skills" &&
          req.method === "POST" &&
          id === "updates"
        )
          result = await background.checker.now(
            z.array(z.string()).default([]).parse(body.ids),
          );
        else if (
          resource === "skills" &&
          req.method === "POST" &&
          id === "update"
        )
          result = await updateGitSkills(
            store,
            z.array(z.string()).min(1).parse(body.ids),
            z.boolean().default(false).parse(body.force),
          );
        else if (
          resource === "skills" &&
          req.method === "GET" &&
          id &&
          parts[3] === "diff"
        )
          result = await diffGitSkill(store, id);
        else if (
          resource === "skills" &&
          req.method === "POST" &&
          id &&
          parts[3] === "detach"
        )
          result = await detachGitSkill(store, id);
        else if (resource === "skills" && req.method === "GET" && !id)
          result = listedSkills(store);
        else if (req.method === "GET" && resource === "skills" && id) {
          const skill = store.manifest().skills.find((s) => s.id === id);
          if (!skill) throw new AppError("NOT_FOUND", "Skill 不存在", 404);
          const { body: markdown } = parseSkill(
            fs.readFileSync(path.join(store.skillPath(id), "SKILL.md"), "utf8"),
          );
          result = {
            ...skill,
            localSource: listedSkills(store).find((s) => s.id === id)
              ?.localSource,
            credentials: credentialPaths(store.skillPath(id)),
            body: markdown,
          };
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
            z
              .object({
                useLibrary: z.boolean().optional(),
                replaceLibrary: z.boolean().optional(),
                name: z.string().optional(),
              })
              .strict()
              .parse(body.options || {}),
          );
        else if (req.method === "GET" && resource === "plan")
          result = publicPlan(engine.plan());
        else if (req.method === "GET" && resource === "conflicts" && !id)
          result = engine.conflicts();
        else if (
          req.method === "POST" &&
          resource === "conflicts" &&
          id === "choose"
        )
          result = await engine.chooseConflict(
            z.string().min(1).parse(body.path),
            z.enum(["library", "native", "skip"]).parse(body.use),
            z.string().optional().parse(body.fingerprint),
          );
        else if (
          req.method === "POST" &&
          resource === "conflicts" &&
          id === "clear"
        )
          result = await engine.clearConflicts(
            z.string().min(1).optional().parse(body.path),
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
        // Preserve data shapes (including arrays); queue metadata belongs to the envelope.
        const mutation =
          !["GET", "HEAD"].includes(req.method!) &&
          ([
            "rules",
            "projects",
            "device",
            "import",
            "self-skill",
            "restore",
            "conflicts",
          ].includes(resource) ||
            (resource === "harnesses" && body.enabled === true) ||
            (resource === "skills" &&
              id !== "updates" &&
              !(result as { selectionRequired?: boolean })
                ?.selectionRequired) ||
            (resource === "sync" &&
              ["setup", "now", "resolve", "undo"].includes(id)) ||
            (resource === "settings" && body.deploy?.auto === true));
        const autoDeployQueued = mutation
          ? background.queue(`api:${resource}${id ? "/" + id : ""}`)
          : false;
        if (resource === "uninstall")
          res.once("finish", () => {
            server.close();
            void vite?.close();
          });
        return send(200, {
          ok: true,
          data: result,
          ...(mutation ? { autoDeployQueued } : {}),
        });
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
  try {
    background = await startBackgroundScheduler(store, engine, {
      intervalMs: options.schedulerIntervalMs,
      debounceMs: options.autoDeployDelayMs,
      serviceLog: options.background,
      checker: options.updateChecker,
    });
  } catch (e) {
    await vite?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw e;
  }
  let closing: Promise<void> | undefined;
  const stopBackground = () => (closing ??= background.close());
  server.once("close", () => {
    void stopBackground().catch(() => {});
  });
  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      await stopBackground();
      await vite?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
