import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError, exists, hash, noSymlink, writeJson } from "./files.ts";

export type NativeTree = {
  mode: number;
  files: Record<string, { mode: number; content?: string; link?: string }>;
};
// Snapshot every entry, including hidden files and empty directories; never follow links.
export function readNative(root: string): NativeTree {
  noSymlink(path.dirname(root));
  const files: NativeTree["files"] = Object.create(null);
  let size = 0,
    count = 0;
  const walk = (p: string, relative: string) => {
    const stat = fs.lstatSync(p);
    if (++count > 10000)
      throw new AppError("SNAPSHOT_TOO_LARGE", "原生快照超过 10000 个条目");
    const entry: NativeTree["files"][string] = { mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) entry.link = fs.readlinkSync(p);
    else if (stat.isFile()) {
      size += stat.size;
      if (size > 64 * 1024 * 1024)
        throw new AppError("SNAPSHOT_TOO_LARGE", "原生快照超过 64 MiB");
      entry.content = fs.readFileSync(p).toString("base64");
    } else if (!stat.isDirectory())
      throw new AppError("SPECIAL_FILE", `不支持特殊文件：${p}`);
    files[relative] = entry;
    if (stat.isDirectory())
      for (const name of fs.readdirSync(p).sort())
        walk(path.join(p, name), relative ? `${relative}/${name}` : name);
  };
  walk(root, "");
  return { mode: files[""].mode, files };
}
const legacyNativeHash = (p: string) => {
  const tree = readNative(p);
  if (tree.files[""].link !== undefined) {
    try {
      return hash(
        JSON.stringify({ tree, target: readNative(fs.realpathSync(p)) }),
      );
    } catch (e: any) {
      return hash(JSON.stringify({ tree, error: e.code || e.message }));
    }
  }
  return hash(JSON.stringify(tree));
};
// Fingerprinting streams file bytes and is independent of snapshot capacity limits.
export function nativeHash(root: string) {
  const fingerprint = (p: string) => {
    noSymlink(path.dirname(p));
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const walk = (file: string, relative: string) => {
      const stat = fs.lstatSync(file);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink())
        digest.update(
          JSON.stringify([relative, mode, "link", fs.readlinkSync(file)]) +
            "\n",
        );
      else if (stat.isDirectory()) {
        digest.update(JSON.stringify([relative, mode, "directory"]) + "\n");
        for (const name of fs.readdirSync(file).sort())
          walk(path.join(file, name), relative ? `${relative}/${name}` : name);
      } else if (stat.isFile()) {
        digest.update(
          JSON.stringify([relative, mode, "file", stat.size]) + "\n",
        );
        const fd = fs.openSync(file, "r");
        try {
          let n: number;
          while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
            digest.update(buffer.subarray(0, n));
        } finally {
          fs.closeSync(fd);
        }
        digest.update("\n");
      } else
        digest.update(JSON.stringify([relative, stat.mode, "special"]) + "\n");
    };
    walk(p, "");
    return digest.digest("hex");
  };
  const tree = fingerprint(root);
  if (!fs.lstatSync(root).isSymbolicLink()) return "native-v1:" + tree;
  try {
    return (
      "native-v1:" +
      hash(JSON.stringify({ tree, target: fingerprint(fs.realpathSync(root)) }))
    );
  } catch (e: any) {
    return (
      "native-v1:" + hash(JSON.stringify({ tree, error: e.code || e.message }))
    );
  }
}
export function matchesNativeHash(p: string, expected: string) {
  return (
    (expected.startsWith("native-v1:")
      ? nativeHash(p)
      : legacyNativeHash(p)) === expected
  );
}
export function restoreNative(root: string, tree: NativeTree) {
  noSymlink(path.dirname(root));
  if (!Object.hasOwn(tree.files, ""))
    throw new AppError("INVALID_SNAPSHOT", "快照缺少根节点");
  const entries = Object.entries(tree.files).sort(
    ([a], [b]) =>
      (a ? a.split("/").length : 0) - (b ? b.split("/").length : 0) ||
      a.localeCompare(b),
  );
  const stage = path.join(
    path.dirname(root),
    `.hsync-staging-${crypto.randomUUID()}`,
  );
  const marker = `${stage}.json`,
    old = `${stage}-old`;
  const restored = path.join(stage, "restored");
  writeJson(marker, {
    format: "harness-sync-staging-v1",
    target: path.basename(root),
  });
  fs.mkdirSync(stage, { mode: 0o700 });
  let published = false;
  try {
    // Build parents before children, independent of integer-key enumeration order.
    for (const [relative, entry] of entries) {
      const p = path.resolve(restored, relative);
      if (
        path.isAbsolute(relative) ||
        (p !== restored && !p.startsWith(restored + path.sep))
      )
        throw new AppError("UNSAFE_PATH", "快照路径无效");
      noSymlink(path.dirname(p));
      if (entry.link !== undefined) fs.symlinkSync(entry.link, p);
      else if (entry.content !== undefined) {
        fs.writeFileSync(p, Buffer.from(entry.content, "base64"));
        fs.chmodSync(p, entry.mode);
      } else fs.mkdirSync(p);
    }
    for (const [relative, entry] of [...entries].reverse())
      if (entry.link === undefined && entry.content === undefined)
        fs.chmodSync(path.join(restored, relative), entry.mode);
    noSymlink(path.dirname(root));
    if (exists(root)) fs.renameSync(root, old);
    try {
      fs.renameSync(restored, root);
      published = true;
    } catch (e) {
      if (exists(old)) fs.renameSync(old, root);
      throw e;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (published) fs.rmSync(old, { recursive: true, force: true });
    // Retain the only original and its ownership marker if promotion recovery failed.
    if (!exists(old)) fs.rmSync(marker, { force: true });
  }
}
