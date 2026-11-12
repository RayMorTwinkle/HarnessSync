import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse, stringify } from "yaml";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type Bundle = Record<string, { content: string; mode: number }>;
export const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
export const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
export const json = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8"));
export function atomicWrite(p: string, content: string | Buffer, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = `${p}.hsync-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.renameSync(temp, p);
  } finally {
    if (exists(temp)) fs.unlinkSync(temp);
  }
}
export const writeJson = (p: string, v: unknown) =>
  atomicWrite(p, JSON.stringify(v, null, 2) + "\n");
export function noSymlink(p: string) {
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    if (exists(at) && fs.lstatSync(at).isSymbolicLink()) {
      const systemAlias =
        process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(at) &&
        fs.realpathSync(at) === "/private" + at;
      if (!systemAlias)
        throw new AppError("SYMLINK_TARGET", `拒绝写入符号链接路径：${at}`);
    }
    if (path.dirname(at) === at) break;
  }
}
export function readBundle(root: string): Bundle {
  const output: Bundle = {};
  let size = 0;
  const walk = (dir: string) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new AppError(
          "SKILL_SYMLINK",
          `Skill 内含符号链接，需先改为实际文件：${file}`,
        );
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const buffer = fs.readFileSync(file);
        size += buffer.length;
        if (size > 16 * 1024 * 1024 || Object.keys(output).length >= 1000)
          throw new AppError(
            "SKILL_TOO_LARGE",
            "单个 Skill 限制为 16 MB、1000 个文件",
          );
        output[path.relative(root, file).split(path.sep).join("/")] = {
          content: buffer.toString("base64"),
          mode: fs.statSync(file).mode & 0o777,
        };
      } else throw new AppError("SPECIAL_FILE", `不支持特殊文件：${file}`);
    }
  };
  if (!fs.statSync(root).isDirectory())
    throw new AppError("INVALID_SKILL", "Skill 路径必须是目录");
  walk(root);
  return output;
}
export const bundleHash = (b: Bundle) =>
  hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(b).sort(([a], [c]) => a.localeCompare(c)),
      ),
    ),
  );
export function writeBundle(target: string, bundle: Bundle) {
  noSymlink(target);
  const stage = `${target}.hsync-${crypto.randomUUID()}`;
  const old = `${stage}-old`;
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const [relative, data] of Object.entries(bundle)) {
      const file = path.resolve(stage, relative);
      if (!file.startsWith(stage + path.sep))
        throw new AppError("UNSAFE_PATH", "Skill 包含非法文件路径");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data.content, "base64"), {
        mode: data.mode,
      });
    }
    if (exists(target)) fs.renameSync(target, old);
    try {
      fs.renameSync(stage, target);
    } catch (e) {
      if (exists(old)) fs.renameSync(old, target);
      throw e;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
}
export function parseSkill(markdown: string) {
  const matched = markdown.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!matched)
    throw new AppError("INVALID_SKILL", "SKILL.md 必须包含 YAML frontmatter");
  let metadata: any;
  try {
    metadata = parse(matched[1]);
  } catch {
    throw new AppError("INVALID_SKILL", "Skill 的 YAML frontmatter 无法解析");
  }
  if (
    !metadata ||
    typeof metadata.name !== "string" ||
    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(metadata.name) ||
    metadata.name.length > 64
  ) {
    const value = metadata?.name;
    const suggestion =
      String(value || "my-skill")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/, "") || "my-skill";
    throw new AppError(
      "INVALID_SKILL",
      `无效 name：${JSON.stringify(value) ?? "缺失"}；请使用小写 kebab-case（最多 64 字符），建议：${suggestion}`,
    );
  }
  if (typeof metadata.description !== "string" || !metadata.description.trim())
    throw new AppError(
      "INVALID_SKILL",
      "description 为空或缺失；请填写非空技能说明",
    );
  return {
    name: metadata.name,
    description: metadata.description,
    body: matched[2].replace(/^\n/, ""),
    metadata,
  };
}
export function skillMarkdown(
  name: string,
  description: string,
  body: string,
  metadata: Record<string, unknown> = {},
) {
  return `---\n${stringify({ ...metadata, name, description }).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}
export function diskHash(p: string, kind: "instructions" | "skill") {
  if (!exists(p)) return hash("ABSENT");
  noSymlink(p);
  if (kind === "skill") return bundleHash(readBundle(p));
  if (!fs.statSync(p).isFile())
    throw new AppError("INVALID_TARGET", `预期为文件：${p}`);
  return hash(fs.readFileSync(p, "utf8"));
}

// Explicit adoption permits replacing only the final link, never writing through it.
export function adoptedSkillHash(p: string, link: string) {
  noSymlink(path.dirname(p));
  if (
    !exists(p) ||
    !fs.lstatSync(p).isSymbolicLink() ||
    fs.readlinkSync(p) !== link
  )
    throw new AppError("ADOPTION_DRIFT", `待接管链接已变化：${p}`);
  return hash(
    JSON.stringify({
      link,
      bundle: bundleHash(readBundle(fs.realpathSync(p))),
    }),
  );
}
