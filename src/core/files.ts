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
  const temp = path.join(path.dirname(p), `.hsync-file-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.chmodSync(temp, mode);
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
// v1 remains readable for receipts and deployment snapshots written before v0.3.
export const legacyBundleHash = (b: Bundle) =>
  hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(b).sort(([a], [c]) => a.localeCompare(c)),
      ),
    ),
  );
const fileHashes = new Map<string, { key: string; digest: string }>();
function fileHash(file: string, stat: fs.Stats) {
  const key = [stat.size, stat.mtimeMs, stat.ino, stat.ctimeMs, stat.mode].join(
    ":",
  );
  const cached = fileHashes.get(file);
  if (cached?.key === key) return cached.digest;
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  const value = digest.digest("hex");
  if (fileHashes.size >= 10000) fileHashes.clear();
  fileHashes.set(file, { key, digest: value });
  return value;
}
function hashEntries(entries: [string, number, string][]) {
  const digest = crypto.createHash("sha256");
  for (const [name, mode, contentHash] of entries.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    digest.update(
      `${Buffer.byteLength(name)}:${name}:${mode}:${contentHash}\n`,
    );
  }
  return "v2:" + digest.digest("hex");
}
export const bundleHash = (b: Bundle) =>
  hashEntries(
    Object.entries(b).map(([name, data]) => [
      name,
      data.mode,
      crypto
        .createHash("sha256")
        .update(Buffer.from(data.content, "base64"))
        .digest("hex"),
    ]),
  );
export function bundleDiskHash(root: string) {
  noSymlink(root);
  if (!fs.statSync(root).isDirectory())
    throw new AppError("INVALID_SKILL", "Skill 路径必须是目录");
  const entries: [string, number, string][] = [];
  let size = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new AppError("SKILL_SYMLINK", `Skill 内含符号链接：${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        size += stat.size;
        if (size > 16 * 1024 * 1024 || entries.length >= 1000)
          throw new AppError(
            "SKILL_TOO_LARGE",
            "单个 Skill 限制为 16 MB、1000 个文件",
          );
        entries.push([
          path.relative(root, file).split(path.sep).join("/"),
          stat.mode & 0o777,
          fileHash(file, stat),
        ]);
      } else throw new AppError("SPECIAL_FILE", `不支持特殊文件：${file}`);
    }
  };
  walk(root);
  return hashEntries(entries);
}
const legacyHashes = new Map<string, { current: string; legacy: string }>();
export function matchesDiskHash(
  p: string,
  kind: "instructions" | "skill",
  expected: string,
) {
  const actual = diskHash(p, kind);
  if (actual === expected) return true;
  if (kind !== "skill" || !exists(p) || expected.startsWith("v2:"))
    return false;
  let cached = legacyHashes.get(p);
  if (cached?.current !== actual) {
    cached = { current: actual, legacy: legacyBundleHash(readBundle(p)) };
    if (legacyHashes.size >= 10000) legacyHashes.clear();
    legacyHashes.set(p, cached);
  }
  return cached.legacy === expected;
}
export function writeBundle(target: string, bundle: Bundle) {
  noSymlink(target);
  const stage = path.join(
    path.dirname(target),
    `.hsync-staging-${crypto.randomUUID()}`,
  );
  const marker = `${stage}.json`;
  writeJson(marker, {
    format: "harness-sync-staging-v1",
    target: path.basename(target),
  });
  const old = `${stage}-old`;
  fs.mkdirSync(stage, { recursive: true });
  let published = false;
  try {
    for (const [relative, data] of Object.entries(bundle)) {
      const file = path.resolve(stage, relative);
      if (!file.startsWith(stage + path.sep))
        throw new AppError("UNSAFE_PATH", "Skill 包含非法文件路径");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data.content, "base64"), {
        mode: data.mode,
      });
      fs.chmodSync(file, data.mode);
    }
    if (exists(target)) fs.renameSync(target, old);
    try {
      fs.renameSync(stage, target);
      published = true;
    } catch (e) {
      if (exists(old)) fs.renameSync(old, target);
      throw e;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (published) fs.rmSync(old, { recursive: true, force: true });
    // If restoring the original rename also failed, retain its only backup.
    if (!exists(old)) fs.rmSync(marker, { force: true });
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
  if (kind === "skill") return bundleDiskHash(p);
  if (!fs.statSync(p).isFile())
    throw new AppError("INVALID_TARGET", `预期为文件：${p}`);
  return hash(fs.readFileSync(p, "utf8"));
}

// Only sidecars emitted by writeBundle authorize cleanup. Never infer ownership
// from an arbitrary directory name, and retain interrupted rename backups.
export function stagingLeftovers(dir: string) {
  if (!exists(dir)) return [];
  noSymlink(dir);
  const result: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.hsync-staging-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const marker = path.join(dir, name);
    noSymlink(marker);
    try {
      const data = json<{ format: string; target: string }>(marker);
      if (
        data.format !== "harness-sync-staging-v1" ||
        path.basename(data.target) !== data.target
      )
        continue;
      const stage = marker.slice(0, -5);
      noSymlink(stage);
      noSymlink(`${stage}-old`);
      result.push(stage);
    } catch {
      /* malformed or untrusted leftovers need manual inspection */
    }
  }
  return result.sort();
}
export function cleanStaging(stage: string) {
  if (!stagingLeftovers(path.dirname(stage)).includes(stage))
    throw new AppError("UNOWNED_STAGING", "暂存目录缺少有效所有权记录");
  if (exists(`${stage}-old`))
    throw new AppError(
      "STAGING_RECOVERY",
      "暂存目录含原件备份，请先恢复未完成部署",
    );
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(`${stage}.json`);
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
