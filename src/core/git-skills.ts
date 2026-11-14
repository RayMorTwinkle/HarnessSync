import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createTwoFilesPatch } from "diff";
import {
  scopeSchema,
  type GitSkillSource,
  type Skill,
} from "../shared/types.ts";
import { Store } from "./store.ts";
import { skillSource } from "./skill-sources.ts";
import { skillCommitMessage } from "./skill-messages.ts";
import {
  AppError,
  bundleHash,
  exists,
  json,
  noSymlink,
  parseSkill,
  readBundle,
  writeBundle,
  writeJson,
  type Bundle,
} from "./files.ts";

export type InstallGitOptions = {
  skills?: string[];
  all?: boolean;
  ref?: string;
  commit?: string;
  scope?: unknown;
};
type GitSkill = Omit<Skill, "source"> & { source: GitSkillSource };
type Candidate = {
  name: string;
  description: string;
  subpath: string;
  error?: string;
};
type UpdateCheck = {
  id: string;
  name: string;
  checkedAt: string;
  commit: string;
  latestCommit?: string;
  available?: boolean;
  error?: string;
};

// Bound network work across HTTP requests, without blocking the event loop.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>) {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
let ghAvailable: Promise<boolean> | undefined;
function hasGh() {
  return (ghAvailable ||= new Promise<boolean>((resolve) => {
    execFile("gh", ["--version"], { timeout: 5_000 }, (error) =>
      resolve(!error),
    );
  }));
}
async function git(url: string, args: string[], cwd: string, timeout = 60_000) {
  const credentials =
    url.startsWith("https://github.com/") && (await hasGh())
      ? [
          "-c",
          "credential.https://github.com.helper=",
          "-c",
          "credential.https://github.com.helper=!gh auth git-credential",
        ]
      : [];
  return limited(
    () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          [...credentials, ...args],
          {
            cwd,
            timeout,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_SSH_COMMAND:
                process.env.GIT_SSH_COMMAND ||
                "ssh -oBatchMode=yes -oConnectTimeout=15",
            },
          },
          (error, stdout, stderr) => {
            const detail = stderr
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            const reason = (
              detail.find((line) =>
                /fatal|error|denied|not found/i.test(line),
              ) ||
              detail[0] ||
              error?.message ||
              ""
            )
              .replaceAll(url, "[远端]")
              .replace(/(?:https?|ssh|file):\/\/\S+/g, "[远端]")
              .slice(0, 200);
            if (error)
              reject(
                new AppError(
                  "SKILL_GIT",
                  `Git 技能操作失败${error.killed ? "（超时）" : ""}：${reason}；请检查地址、ref、网络及认证，GitHub 私有仓库请先 gh auth login`,
                  409,
                ),
              );
            else resolve(stdout.trim());
          },
        );
      }),
  );
}
function safeSubpath(value: string) {
  if (
    value &&
    (path.posix.isAbsolute(value) ||
      value.split(/[\\/]/).some((p) => p === ".." || p === ".git") ||
      value.includes("\\"))
  )
    throw new AppError("INVALID_PATH", "仓库子路径不能越界或指向 .git");
  return value.replace(/\/$/, "");
}
export function parseGitSkillSource(input: string, explicitRef?: string) {
  if (!input || /[\x00-\x1f]/.test(input) || input.startsWith("-"))
    throw new AppError("INVALID_SOURCE", "Git 来源无效");
  let url = input;
  let subpath = "";
  let ref = explicitRef || "HEAD";
  const github =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?\/?$/.exec(input);
  if (github) {
    url = `https://github.com/${github[1]}/${github[2].replace(/\.git$/, "")}.git`;
    if (github[3]) {
      const tree = decodeURIComponent(github[3]);
      const treeRef =
        explicitRef &&
        (tree === explicitRef || tree.startsWith(explicitRef + "/"))
          ? explicitRef
          : tree.split("/")[0];
      ref = explicitRef || treeRef;
      subpath = tree.slice(treeRef.length).replace(/^\//, "");
    }
  } else if (exists(path.resolve(input))) {
    url = pathToFileURL(path.resolve(input)).href;
  } else if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(input)) {
    const [owner, repo, ...parts] = input.split("/");
    url = `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`;
    subpath = parts.join("/");
  }
  if (
    !/^(https?:\/\/|ssh:\/\/|file:\/\/|[^\s/@]+@[^\s/:]+:)/.test(url) ||
    /[\x00-\x20]/.test(url)
  )
    throw new AppError(
      "INVALID_SOURCE",
      "需要 Git URL、本地仓库路径或 owner/repo",
    );
  if (ref.startsWith("-") || /[\x00-\x20]/.test(ref))
    throw new AppError("INVALID_REF", "Git ref 无效");
  // Embedded credentials must never enter the source repository.
  if (
    /^(https?|ssh):\/\//.test(url) &&
    (new URL(url).password ||
      new URL(url).search ||
      new URL(url).hash ||
      (/^https?:/.test(url) && new URL(url).username))
  )
    throw new AppError(
      "INVALID_SOURCE",
      "请使用凭证助手，不要在 Git URL 中包含认证信息",
    );
  return { url, ref, subpath: safeSubpath(subpath) };
}
function cacheRoot(store: Store) {
  const root = path.join(store.root, "cache", "git-skills");
  noSymlink(root);
  fs.mkdirSync(root, { recursive: true });
  // Each clone has a PID owner. Reclaim clones abandoned by a terminated process.
  for (const name of fs.readdirSync(root)) {
    const match = /^(\d+)-[a-f0-9-]+$/.exec(name);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (e: any) {
      if (e.code === "ESRCH") {
        const abandoned = path.join(root, name);
        noSymlink(abandoned);
        fs.rmSync(abandoned, { recursive: true, force: true });
      }
    }
  }
  return root;
}
async function checkout<T>(
  store: Store,
  source: { url: string; ref: string },
  commit: string | undefined,
  fn: (dir: string, commit: string) => T | Promise<T>,
) {
  if (commit && !/^[0-9a-f]{40,64}$/.test(commit))
    throw new AppError("INVALID_COMMIT", "提交 ID 无效");
  const dir = path.join(
    cacheRoot(store),
    `${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(dir);
  try {
    // init + depth-one fetch supports branches, tags and exact commits alike.
    await git(source.url, ["init", "--quiet", dir], store.root);
    await git(
      source.url,
      [
        "fetch",
        "--depth=1",
        "--no-tags",
        "--",
        source.url,
        commit || source.ref,
      ],
      dir,
    );
    await git(
      source.url,
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
      dir,
    );
    const head = await git(source.url, ["rev-parse", "HEAD"], dir);
    return await fn(dir, head);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function readGitBundle(root: string) {
  const bundle = readBundle(root);
  // Git only preserves the executable bit; checkout permissions also depend on umask.
  for (const file of Object.values(bundle))
    file.mode = file.mode & 0o111 ? 0o755 : 0o644;
  return bundle;
}
async function gitTrees(
  url: string,
  dir: string,
  commit: string,
  timeout = 60_000,
) {
  const [root, output] = await Promise.all([
    git(url, ["rev-parse", `${commit}^{tree}`], dir, timeout),
    git(
      url,
      ["ls-tree", "-r", "-d", "-z", "--full-tree", commit],
      dir,
      timeout,
    ),
  ]);
  const trees = new Map([["", root]]);
  for (const row of output.split("\0")) {
    const match = /^040000 tree ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(row);
    if (match) trees.set(match[2], match[1]);
  }
  return trees;
}
function discover(root: string, subpath: string) {
  const result: Candidate[] = [];
  const start = path.join(root, safeSubpath(subpath));
  noSymlink(start);
  const walk = (dir: string) => {
    if (exists(path.join(dir, "SKILL.md"))) {
      const subpath = path.relative(root, dir).split(path.sep).join("/");
      try {
        noSymlink(path.join(dir, "SKILL.md"));
        const parsed = parseSkill(
          fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"),
        );
        result.push({
          name: parsed.name,
          description: parsed.description,
          subpath,
        });
      } catch (e: any) {
        result.push({
          name: path.basename(dir),
          description: "",
          subpath,
          error: e.message,
        });
      }
    }
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && ![".git", "node_modules"].includes(e.name))
        walk(path.join(dir, e.name));
  };
  walk(start);
  if (!result.length)
    throw new AppError("NO_SKILLS", "仓库或子路径内没有 SKILL.md");
  return result;
}
export function listedSkills(store: Store) {
  return store
    .manifest()
    .skills.map((s) => ({ ...s, localSource: skillSource(store, s.id) }));
}
export async function installGitSkills(
  store: Store,
  input: string,
  options: InstallGitOptions = {},
) {
  if (options.all && options.skills?.length)
    throw new AppError("INVALID_ARGUMENT", "--all 与 --skill 不能同时使用");
  const source = parseGitSkillSource(input, options.ref);
  if (
    !options.ref &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\//.test(input)
  ) {
    const tree = decodeURIComponent(input.split("/tree/")[1]);
    const refs = await remoteRefs(store, source.url);
    const match = refs
      .map(([, ref]) => ref.replace(/^refs\/(heads|tags)\//, ""))
      .filter(
        (ref) =>
          !ref.endsWith("^{}") && (tree === ref || tree.startsWith(ref + "/")),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      source.ref = match;
      source.subpath = safeSubpath(tree.slice(match.length).replace(/^\//, ""));
    }
  }
  const scope = scopeSchema.parse(options.scope || {});
  return checkout(store, source, options.commit, async (dir, commit) => {
    const candidates = discover(dir, source.subpath);
    if (!options.all && !options.skills?.length && candidates.length > 1)
      return {
        selectionRequired: true,
        url: source.url,
        ref: source.ref,
        commit,
        candidates,
        installed: [] as Skill[],
      };
    const selected =
      options.all || !options.skills?.length
        ? candidates
        : options.skills.map((name) => {
            const matches = candidates.filter(
              (c) => (!c.error && c.name === name) || c.subpath === name,
            );
            if (matches.length !== 1)
              throw new AppError(
                "INVALID_SELECTION",
                `未找到唯一候选技能：${name}；可使用子路径选择`,
              );
            return matches[0];
          });
    const trees = await gitTrees(source.url, dir, commit);
    const bundles = selected.map((c) => {
      if (c.error)
        throw new AppError(
          "INVALID_SKILL",
          `技能 ${c.subpath || c.name} 无效：${c.error}`,
        );
      return readGitBundle(path.join(dir, c.subpath));
    });
    const installed = await store.mutate(
      skillCommitMessage(
        "从 Git 安装技能",
        selected.map((c) => c.name),
      ),
      (m) => {
        if (
          scope.kind === "project" &&
          !m.projects.some((p) => p.id === scope.target)
        )
          throw new AppError("PROJECT_NOT_FOUND", "作用域引用的项目不存在");
        const names = new Set(m.skills.map((s) => s.name));
        for (const c of selected) {
          if (names.has(c.name))
            throw new AppError(
              "DUPLICATE_NAME",
              `技能库已有 ${c.name}；请使用 skills update`,
              409,
            );
          names.add(c.name);
        }
        return selected.map((c, i) => {
          const entry: Skill = {
            id: crypto.randomUUID(),
            name: c.name,
            description: c.description,
            enabled: true,
            scope,
            source: {
              type: "git",
              url: source.url,
              ref: source.ref,
              subpath: c.subpath,
              commit,
              installedHash: bundleHash(bundles[i]),
              tree: trees.get(c.subpath)!,
            },
          };
          writeBundle(store.skillPath(entry.id), bundles[i]);
          m.skills.push(entry);
          return entry;
        });
      },
    );
    return {
      selectionRequired: false,
      url: source.url,
      ref: source.ref,
      commit,
      candidates,
      installed,
    };
  });
}
function gitEntries(store: Store, ids: string[] = []) {
  const all = store.manifest().skills;
  return (
    ids.length
      ? [...new Set(ids)].map((id) => {
          const entry = all.find((s) => s.id === id || s.name === id);
          if (!entry) throw new AppError("NOT_FOUND", `技能不存在：${id}`, 404);
          if (typeof entry.source !== "object")
            throw new AppError(
              "NO_GIT_SOURCE",
              `技能没有 Git 上游：${entry.name}`,
            );
          return entry;
        })
      : all.filter((s) => typeof s.source === "object")
  ) as GitSkill[];
}
type RefRequests = Map<string, Promise<string[][]>>;
// Skills from one repository share a single ls-remote within one check. A new
// check never reuses a request that started earlier, which could predate a push.
function remoteRefs(
  store: Store,
  url: string,
  shared: RefRequests = new Map(),
) {
  let pending = shared.get(url);
  if (!pending) {
    pending = git(url, ["ls-remote", "--", url], store.root, 15_000).then(
      (output) =>
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(/\s+/)),
    );
    shared.set(url, pending);
  }
  return pending;
}
async function remoteHead(
  store: Store,
  source: GitSkillSource,
  shared?: RefRequests,
) {
  const lines = await remoteRefs(store, source.url, shared);
  const ref = source.ref;
  if (/^[0-9a-f]{40,64}$/.test(ref)) return ref;
  const names =
    ref === "HEAD"
      ? ["HEAD"]
      : ref.startsWith("refs/")
        ? [`${ref}^{}`, ref]
        : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  const head = names
    .map((name) => lines.find(([, r]) => r === name))
    .find(Boolean);
  if (!head || !/^[0-9a-f]{40,64}$/.test(head[0]))
    throw new AppError("SKILL_GIT", "上游 ref 不存在", 409);
  return head[0];
}
const remoteTreeChecks = new Map<
  string,
  Promise<Map<string, Map<string, string>>>
>();
function remoteTrees(store: Store, url: string, commits: string[]) {
  const key = JSON.stringify([store.root, url, commits.sort()]);
  let pending = remoteTreeChecks.get(key);
  if (!pending) {
    pending = (async () => {
      const dir = path.join(
        cacheRoot(store),
        `${process.pid}-${crypto.randomUUID()}`,
      );
      fs.mkdirSync(dir);
      try {
        await git(url, ["init", "--bare", "--quiet", dir], store.root, 15_000);
        await git(
          url,
          [
            "fetch",
            "--depth=1",
            "--filter=blob:none",
            "--no-tags",
            "--",
            url,
            ...commits,
          ],
          dir,
          15_000,
        );
        return new Map(
          await Promise.all(
            commits.map(
              async (commit) =>
                [commit, await gitTrees(url, dir, commit, 15_000)] as const,
            ),
          ),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
    remoteTreeChecks.set(key, pending);
    void pending.finally(() => remoteTreeChecks.delete(key)).catch(() => {});
  }
  return pending;
}
export async function checkGitSkillUpdates(store: Store, ids: string[] = []) {
  const entries = gitEntries(store, ids);
  const refs: RefRequests = new Map();
  const checks: UpdateCheck[] = await Promise.all(
    entries.map(async (s) => {
      const base = {
        id: s.id,
        name: s.name,
        checkedAt: new Date().toISOString(),
        commit: s.source.commit,
      };
      try {
        const latestCommit = await remoteHead(store, s.source, refs);
        return {
          ...base,
          latestCommit,
          available: latestCommit !== s.source.commit,
        };
      } catch (e: any) {
        return { ...base, error: e.message };
      }
    }),
  );
  const repositories = new Map<string, Set<string>>();
  for (const [i, entry] of entries.entries())
    if (checks[i].available && entry.source.tree) {
      const commits = repositories.get(entry.source.url) || new Set<string>();
      commits.add(checks[i].latestCommit!);
      repositories.set(entry.source.url, commits);
    }
  const trees = new Map(
    [...repositories].map(
      ([url, commits]) => [url, remoteTrees(store, url, [...commits])] as const,
    ),
  );
  const results: UpdateCheck[] = await Promise.all(
    checks.map(async (check, i) => {
      const { source } = entries[i];
      // Legacy records retain commit-based checks until their next update.
      if (!check.available || !source.tree) return check;
      try {
        const commits = await trees.get(source.url)!;
        const tree = commits
          .get(check.latestCommit!)!
          .get(safeSubpath(source.subpath));
        if (!tree)
          throw new AppError(
            "SKILL_GIT",
            `上游技能目录不存在：${source.subpath}`,
            409,
          );
        return { ...check, available: tree !== source.tree };
      } catch (e: any) {
        const { available, ...base } = check;
        return { ...base, error: e.message };
      }
    }),
  );
  await store.lock(() => {
    const file = path.join(store.root, "skill-updates.json");
    noSymlink(file);
    const previous = exists(file)
      ? json<Record<string, UpdateCheck>>(file)
      : {};
    for (const r of results) previous[r.id] = r;
    writeJson(file, previous);
  });
  return results;
}
function bundleDiff(before: Bundle, after: Bundle) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((file) => {
      const a = before[file],
        b = after[file];
      if (a?.content === b?.content && a?.mode === b?.mode) return [];
      const old = Buffer.from(a?.content || "", "base64"),
        next = Buffer.from(b?.content || "", "base64");
      const binary = [old, next].some(
        (v) => v.includes(0) || !Buffer.from(v.toString("utf8")).equals(v),
      );
      return [
        {
          path: file,
          status: !a ? "added" : !b ? "removed" : "modified",
          binary,
          beforeMode: a?.mode,
          afterMode: b?.mode,
          diff: binary
            ? "二进制文件有变化"
            : createTwoFilesPatch(
                `库/${file}`,
                `上游/${file}`,
                old.toString("utf8"),
                next.toString("utf8"),
              ),
        },
      ];
    });
}
async function upstream(store: Store, entry: GitSkill) {
  return checkout(store, entry.source, undefined, async (dir, commit) => {
    const target = path.join(dir, safeSubpath(entry.source.subpath));
    noSymlink(target);
    const bundle = readGitBundle(target);
    if (!bundle["SKILL.md"])
      throw new AppError("INVALID_SKILL", "上游目录缺少 SKILL.md");
    const parsed = parseSkill(
      Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
    );
    if (parsed.name !== entry.name)
      throw new AppError(
        "SOURCE_NAME_CHANGED",
        `上游技能名称已变化：${entry.name} → ${parsed.name}；请单独安装`,
      );
    const trees = await gitTrees(entry.source.url, dir, commit);
    return { bundle, commit, parsed, tree: trees.get(entry.source.subpath)! };
  });
}
export async function diffGitSkill(store: Store, id: string) {
  const entry = gitEntries(store, [id])[0];
  const before = readBundle(store.skillPath(entry.id));
  const latest = await upstream(store, entry);
  return {
    id: entry.id,
    commit: entry.source.commit,
    latestCommit: latest.commit,
    files: bundleDiff(before, latest.bundle),
  };
}
export async function updateGitSkills(
  store: Store,
  ids: string[],
  force = false,
) {
  if (!ids.length) throw new AppError("INVALID_ARGUMENT", "请选择要更新的技能");
  const revision = store.revision();
  const entries = gitEntries(store, ids);
  for (const entry of entries)
    if (
      !force &&
      bundleHash(readBundle(store.skillPath(entry.id))) !==
        entry.source.installedHash
    )
      throw new AppError(
        "LOCAL_SKILL_CHANGED",
        `技能 ${entry.name} 已在本地修改；请先查看差异，或使用 --force`,
        409,
      );
  const downloads = await Promise.allSettled(
    entries.map((entry) => upstream(store, entry)),
  );
  const failure = downloads.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const latest = downloads.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
  return store.mutate(
    skillCommitMessage(
      "更新 Git 技能",
      entries.map((entry) => entry.name),
    ),
    (m) =>
      entries.map((entry, i) => {
        const current = m.skills.find((s) => s.id === entry.id)!;
        const next = latest[i];
        const files = bundleDiff(
          readBundle(store.skillPath(entry.id)),
          next.bundle,
        );
        writeBundle(store.skillPath(entry.id), next.bundle);
        current.description = next.parsed.description;
        current.source = {
          ...entry.source,
          commit: next.commit,
          installedHash: bundleHash(next.bundle),
          tree: next.tree,
        };
        return {
          id: entry.id,
          name: entry.name,
          commit: next.commit,
          files,
          note: "已更新源库，请预览部署",
        };
      }),
    revision,
  );
}
export async function detachGitSkill(store: Store, id: string) {
  const entry = gitEntries(store, [id])[0];
  return store.mutate("技能脱离 Git 上游", (m) => {
    const current = m.skills.find((s) => s.id === entry.id);
    if (!current) throw new AppError("NOT_FOUND", "技能不存在", 404);
    delete current.source;
    return current;
  });
}
