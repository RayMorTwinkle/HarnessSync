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
