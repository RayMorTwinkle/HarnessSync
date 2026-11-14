import fs from "node:fs";
import { AppError } from "./files.ts";
import path from "node:path";

// Files that usually hold secrets. Detection only informs the user; the sync choice stays theirs.
const names = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);
const examples = /\.(example|sample|template|dist)$/i;
const patterns = [
  /^\.env\./i,
  /(^|[._-])(tokens?|secrets?|credentials?|api[-_]?keys?)([._-]|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

export function isCredentialPath(relative: string) {
  const base = path.posix.basename(relative.split(path.sep).join("/"));
  if (examples.test(base)) return false;
  return names.has(base.toLowerCase()) || patterns.some((p) => p.test(base));
}

// Enumerate names only; never open a candidate file or follow package links.
export function credentialPaths(root: string) {
  const found: string[] = [];
  let count = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 64)
      throw new AppError("SKILL_TOO_LARGE", "技能目录层级超过扫描上限");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      if (++count > 5000)
        throw new AppError("SKILL_TOO_LARGE", "技能目录条目超过扫描上限");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else {
        const relative = path.relative(root, file).split(path.sep).join("/");
        if (isCredentialPath(relative)) found.push(relative);
      }
    }
  };
  walk(root, 0);
  return found.sort();
}
