import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store } from "./store.ts";
import { Sync } from "./sync.ts";
import {
  AppError,
  atomicWrite,
  exists,
  hash,
  json,
  noSymlink,
  writeJson,
} from "./files.ts";
import { LoginService } from "./service.ts";

const interval = z.number().int().min(1).max(86400);
const deploySchema = z.object({ auto: z.boolean() }).strict();
const syncSchema = z
  .object({
    auto: z.boolean(),
    pushDelaySeconds: interval,
    pullIntervalMinutes: interval,
  })
  .strict();
const updatesSchema = z
  .object({
    check: z.boolean(),
    intervalHours: z.union([z.literal(6), z.literal(24), z.literal(168)]),
  })
  .strict();
const startupSchema = z.object({ login: z.boolean() }).strict();
export const settingsSchema = z
  .object({
    deploy: deploySchema,
    sync: syncSchema,
    updates: updatesSchema,
    startup: startupSchema,
  })
  .strict();
const localSchema = z
  .object({ deploy: deploySchema, updates: updatesSchema })
  .strict();
const patchSchema = z
  .object({
    deploy: deploySchema.partial().optional(),
    sync: syncSchema.partial().optional(),
    updates: updatesSchema.partial().optional(),
    startup: startupSchema.partial().optional(),
  })
  .strict();
export type SettingsValue = z.infer<typeof settingsSchema>;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "SETTINGS_OPTIONS",
      "设置无效：仅接受已知字段、布尔值及允许范围内的整数",
    );
  return result.data;
};
export class Settings {
  readonly file: string;
  constructor(
    readonly store: Store,
    readonly service = new LoginService(store),
  ) {
    this.file = path.join(store.root, "settings.json");
  }
  preferences() {
    noSymlink(this.file);
    if (!exists(this.file))
      return {
        deploy: { auto: true },
        updates: { check: true, intervalHours: 24 as const },
      };
    try {
      return parse(localSchema, json(this.file));
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        "SETTINGS_FILE",
        "无法读取本机设置，请检查 settings.json 的内容和权限",
      );
    }
  }

  async get() {
    const local = this.preferences();
    const sync = new Sync(this.store).autoSettings();
    const service = await this.service.status();
    const settings: SettingsValue = {
      ...local,
      sync: {
        auto: sync.enabled,
        pushDelaySeconds: sync.debounceSeconds,
        pullIntervalMinutes: sync.pullIntervalMinutes,
      },
      startup: { login: service.login },
    };
    return {
      settings,
      meta: {
        path: this.file,
        revision: hash(JSON.stringify(settings)),
        allowed: {
          "updates.intervalHours": [6, 24, 168],
          "sync.pushDelaySeconds": { min: 1, max: 86400 },
          "sync.pullIntervalMinutes": { min: 1, max: 86400 },
        },
        service,
      },
    };
  }
  async patch(input: unknown, revision?: string) {
    const patch = parse(patchSchema, input);
    return this.store.lock(async () => {
      const current = await this.get();
      if (revision && revision !== current.meta.revision)
        throw new AppError(
          "STALE_REVISION",
          "设置已被其他窗口修改，请刷新后重试",
          409,
        );
      const value = parse(
        settingsSchema,
        Object.fromEntries(
          Object.entries(current.settings).map(([key, previous]) => [
            key,
            { ...previous, ...patch[key as keyof typeof patch] },
          ]),
        ),
      );
      // Validate every input and destination before invoking external side effects.
      noSymlink(this.file);
      noSymlink(path.join(this.store.root, "sync-auto.json"));
      const files = [this.file, path.join(this.store.root, "sync-auto.json")];
      const before = files.map((file) =>
        exists(file) ? fs.readFileSync(file) : undefined,
      );
      let service = current.meta.service;
      try {
        if (patch.sync)
          await new Sync(this.store).setAuto(
            {
              ...(patch.sync.auto !== undefined
                ? { enabled: patch.sync.auto }
                : {}),
              ...(patch.sync.pushDelaySeconds !== undefined
                ? { debounceSeconds: patch.sync.pushDelaySeconds }
                : {}),
              ...(patch.sync.pullIntervalMinutes !== undefined
                ? { pullIntervalMinutes: patch.sync.pullIntervalMinutes }
                : {}),
            },
            { locked: true },
          );
        writeJson(this.file, { deploy: value.deploy, updates: value.updates });
        // Persist other preferences before a bootout that may stop this process.
        if (
          patch.startup?.login !== undefined &&
          value.startup.login !== current.settings.startup.login
        )
          service = value.startup.login
            ? await this.service.install()
            : await this.service.uninstall();
      } catch (e) {
        for (const [index, file] of files.entries()) {
          noSymlink(file);
          if (before[index] !== undefined) atomicWrite(file, before[index]!);
          else if (exists(file)) fs.unlinkSync(file);
        }
        throw e;
      }
      value.startup.login = service.login;
      return {
        settings: value,
        meta: {
          ...current.meta,
          service,
          revision: hash(JSON.stringify(value)),
        },
      };
    });
  }
  async set(key: string, raw: string) {
    const [group, field, extra] = key.split(".");
    if (
      !group ||
      !field ||
      extra ||
      !["deploy", "sync", "updates", "startup"].includes(group)
    )
      throw new AppError(
        "SETTINGS_KEY",
        "设置键不存在，请使用 config list 查看",
      );
    const value =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : /^\d+$/.test(raw)
            ? Number(raw)
            : raw;
    return this.patch({ [group]: { [field]: value } });
  }
  async read(key: string) {
    const [group, field, extra] = key.split(".");
    const { settings } = await this.get();
    if (
      extra ||
      !Object.hasOwn(settings, group) ||
      !Object.hasOwn(settings[group as keyof SettingsValue], field)
    )
      throw new AppError(
        "SETTINGS_KEY",
        "设置键不存在，请使用 config list 查看",
      );
    return (settings[group as keyof SettingsValue] as Record<string, unknown>)[
      field
    ];
  }
}
