import { execFile } from "node:child_process";
import { AppError } from "./files.ts";
import {
  githubCredentialArgs,
  githubRepository,
  validateSyncUrl,
} from "./sync-remote.ts";

export type SyncCheck = {
  id: string;
  status: "ok" | "warn" | "fail" | "skip";
  title: string;
  detail: string;
  fix?: string;
};
export type SyncCheckResult = {
  ready: boolean;
  checks: SyncCheck[];
  recommended: "create" | "url" | null;
};
export type SyncCheckInput = { url?: string; create?: boolean | string };
export type SyncCheckRunner = (
  command: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type SyncCheckOptions = { runner?: SyncCheckRunner; platform?: string };

const runner: SyncCheckRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        ...options,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // No terminal input, including for credential helpers.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
          stderr,
        });
      },
    ).stdin?.end();
  });

const loginFix =
  "在终端运行 gh auth login，按浏览器提示授权；Claude Code 中可用 ! gh auth login";

export async function checkSync(
  input: SyncCheckInput = {},
  options: SyncCheckOptions = {},
): Promise<SyncCheckResult> {
  if (
    (input.url !== undefined && typeof input.url !== "string") ||
    (input.create !== undefined &&
      !["boolean", "string"].includes(typeof input.create)) ||
    (input.url !== undefined &&
      input.create !== undefined &&
      input.create !== false)
  )
    throw new AppError("SYNC_OPTIONS", "请指定 --url 或 --create 其中一个");
  if (input.url !== undefined) validateSyncUrl(input.url);
  const create = input.create !== undefined && input.create !== false;
  const name =
    typeof input.create === "string" ? input.create : "harness-sync-config";
  if (create && !/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new AppError("SYNC_OPTIONS", "GitHub 仓库名称无效");
  const run = async (command: string, args: string[]) => {
    try {
      return await (options.runner ?? runner)(command, args, {
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/usr/bin/false",
          GCM_INTERACTIVE: "Never",
          GH_PROMPT_DISABLED: "1",
          GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
          SSH_ASKPASS_REQUIRE: "never",
          SSH_ASKPASS: "/usr/bin/false",
        },
      });
    } catch {
      return { code: -1, stdout: "", stderr: "" };
    }
  };
  const checks: SyncCheck[] = [];
  const add = (
    id: string,
    status: SyncCheck["status"],
    title: string,
    detail: string,
    fix?: string,
  ) => checks.push({ id, status, title, detail, ...(fix ? { fix } : {}) });
  const git = await run("git", ["--version"]);
  const gitOk = git.code === 0;
  add(
    "git",
    gitOk ? "ok" : "fail",
    "Git",
    gitOk
      ? `已安装 ${git.stdout.match(/git version [\d.]+/)?.[0] ?? "Git"}`
      : "未找到可用的 Git",
    gitOk
      ? undefined
      : (options.platform ?? process.platform) === "darwin"
        ? "在终端运行 xcode-select --install"
        : "安装 Git：https://git-scm.com/downloads",
  );

  const gh = await run("gh", ["--version"]);
  const ghOk = gh.code === 0;
  if (!ghOk) {
    const brew =
      (options.platform ?? process.platform) === "darwin"
        ? await run("brew", ["--version"])
        : undefined;
    add(
      "gh",
      create ? "fail" : "warn",
      "GitHub CLI",
      "未找到 gh；仍可用 SSH 或系统 Git 凭证助手连接已有仓库",
      brew?.code === 0
        ? "在终端运行 brew install gh"
        : "安装 GitHub CLI：https://cli.github.com（已安装 Homebrew 时可运行 brew install gh）",
    );
  } else
    add(
      "gh",
      "ok",
      "GitHub CLI",
      `已安装 ${gh.stdout.match(/gh version [\d.]+/)?.[0] ?? "gh"}`,
    );

  let authenticated = false;
  let account: string | undefined;
  let protocol: string | undefined;
  let hasRepo: boolean | undefined;
  if (ghOk) {
    const auth = await run("gh", [
      "auth",
      "status",
      "--hostname",
      "github.com",
    ]);
    authenticated = auth.code === 0;
    if (authenticated) {
      // Only use an allowlisted login returned for the active account. Raw status
      // can include a token, multiple accounts, or arbitrary helper diagnostics.
      const user = await run("gh", [
        "api",
        "user",
        "--hostname",
        "github.com",
        "--jq",
        ".login",
      ]);
      const login = user.stdout.trim();
      if (user.code === 0 && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login))
        account = login;
      const blocks = `${auth.stdout}\n${auth.stderr ?? ""}`.split(
        /(?=\s*[✓✔]\s+Logged in)/,
      );
      const active =
        blocks.find((block) => /Active account:\s*true/i.test(block)) ??
        (blocks.length <= 2 ? blocks.at(-1) : undefined);
      protocol = active
        ?.match(/Git operations protocol:\s*(https|ssh)\b/i)?.[1]
        ?.toLowerCase();
      const scopes = active?.match(/Token scopes:\s*([^\r\n]*)/i)?.[1];
      if (scopes !== undefined)
        hasRepo = scopes.split(/[,\s'"]+/).includes("repo");
      if (!protocol) {
        const config = await run("gh", [
          "config",
          "get",
          "git_protocol",
          "--host",
          "github.com",
        ]);
        if (config.code === 0 && /^(https|ssh)$/.test(config.stdout.trim()))
          protocol = config.stdout.trim();
      }
    }
    add(
      "gh-auth",
      authenticated ? "ok" : create ? "fail" : "warn",
      "GitHub 登录",
      authenticated
        ? `已登录 GitHub${account ? `：${account}` : "（账号暂时无法读取）"}；Git 协议：${protocol ?? "未知"}`
        : "gh 尚未登录 GitHub，或登录状态无法验证",
      authenticated ? undefined : loginFix,
    );
    add(
      "gh-scopes",
      !authenticated
        ? "skip"
        : hasRepo === undefined
          ? "warn"
          : hasRepo
            ? "ok"
            : create
              ? "fail"
              : "warn",
      "私有仓库授权",
      !authenticated
        ? "登录后才能检查 repo scope"
        : hasRepo === undefined
          ? "无法读取 repo scope；细粒度授权需自行确认私有仓库创建权限"
          : hasRepo
            ? "已包含 repo scope"
            : "缺少 repo scope；创建私有仓库需要此授权",
      authenticated && hasRepo !== true
        ? "在终端运行 gh auth refresh -h github.com -s repo，按浏览器提示授权"
        : undefined,
    );
  } else {
    add("gh-auth", "skip", "GitHub 登录", "安装 gh 后才能检查登录状态");
    add(
      "gh-scopes",
      "skip",
      "私有仓库授权",
      "安装并登录 gh 后才能检查 repo scope",
    );
  }

  let existingUrl: string | undefined;
  if (create) {
    if (!authenticated || !account)
      add(
        "repository",
        "skip",
        "仓库",
        "无法确认 GitHub 账号，暂不检查同名仓库",
        loginFix,
      );
    else {
      const repo = await run("gh", [
        "api",
        `repos/${account}/${name}`,
        "--hostname",
        "github.com",
      ]);
      if (repo.code === 0) {
        existingUrl = `https://github.com/${account}/${name}.git`;
        add(
          "repository",
          "fail",
          "仓库",
          "同名仓库已存在，可直接连接",
          `运行 hsync sync check --url ${existingUrl}，通过后运行 hsync sync setup --url ${existingUrl}`,
        );
      } else if (/\bHTTP 404\b/.test(`${repo.stderr}\n${repo.stdout}`))
        add("repository", "ok", "仓库", "同名仓库不存在，可以创建私有仓库");
      else
        add(
          "repository",
          "fail",
          "仓库",
          "无法确认同名仓库是否存在，请检查网络及 GitHub 授权",
          "检查网络后重试 hsync sync check --create",
        );
    }
  } else if (input.url) {
    if (!gitOk)
      add("repository", "skip", "仓库读取", "安装 Git 后才能检查仓库");
    else {
      const repo = await run("git", [
        ...githubCredentialArgs(input.url, ghOk),
        "ls-remote",
        "--",
        input.url,
      ]);
      add(
        "repository",
        repo.code === 0 ? "ok" : "fail",
        "仓库读取",
        repo.code === 0
          ? "仓库可以读取"
          : "无法读取仓库；请检查地址、网络及本机 Git 认证",
        repo.code === 0
          ? undefined
          : "确认仓库 URL；HTTPS 请检查系统凭证助手或在终端运行 gh auth login，SSH 请检查 SSH key",
      );
    }
  } else
    add(
      "repository",
      "skip",
      "仓库",
      "用 --url <url> 检查已有仓库，或用 --create [name] 检查创建条件",
    );

  const github = input.url && githubRepository(input.url);
  if (github && authenticated) {
    const push = await run("gh", [
      "api",
      `repos/${github}`,
      "--hostname",
      "github.com",
      "--jq",
      ".permissions.push",
    ]);
    const value = push.stdout.trim();
    add(
      "push",
      push.code === 0 && value === "true"
        ? "ok"
        : value === "false" && push.code === 0
          ? "fail"
          : "warn",
      "推送权限",
      push.code === 0 && value === "true"
        ? "当前 gh 账号具有推送权限；Git 实际身份的权限在首次同步时确认"
        : value === "false" && push.code === 0
          ? "当前 gh 账号没有推送权限"
          : "无法查询推送权限；首次同步时才能确认",
      value === "false" && push.code === 0
        ? "请仓库所有者授予当前账号写入权限，或换用自己拥有的仓库"
        : undefined,
    );
  } else
    add(
      "push",
      "skip",
      "推送权限",
      create || !input.url
        ? "选择已有仓库后才能检查推送权限"
        : "未使用 GitHub 或 gh 未安装/未登录；首次同步时才能确认推送权限",
    );

  const ssh = input.url?.match(/^(?:([^@/:]+)@)?([^/:]+):([^/].*)$/);
  let target: string | undefined;
  let port: string | undefined;
  if (input.url?.startsWith("ssh://")) {
    try {
      const parsed = new URL(input.url);
      target = `${parsed.username || "git"}@${parsed.hostname}`;
      port = parsed.port;
    } catch {
      throw new AppError("SYNC_URL", "SSH URL 无效");
    }
  } else if (ssh && !input.url?.includes("://"))
    target = `${ssh[1] || "git"}@${ssh[2]}`;
  if (target) {
    if (!/^[\w.-]+@[\w.-]+$/.test(target))
      throw new AppError("SYNC_URL", "SSH 地址无效");
    const auth = await run("ssh", [
      "-T",
      "-oBatchMode=yes",
      "-oConnectTimeout=10",
      ...(port ? ["-p", port] : []),
      target,
    ]);
    const success = target.endsWith("@github.com")
      ? auth.code === 1 &&
        /successfully authenticated/i.test(
          `${auth.stdout}\n${auth.stderr ?? ""}`,
        )
      : auth.code === 0;
    add(
      "ssh",
      success ? "ok" : "fail",
      "SSH 认证",
      success ? "SSH 认证成功" : "SSH 认证未通过，或连接超时",
      success
        ? undefined
        : "在 GitHub 设置 → SSH and GPG keys 添加本机公钥，并用 ssh-add 加载密钥；或改用 HTTPS URL，在终端运行 gh auth login",
    );
  } else add("ssh", "skip", "SSH 认证", "未使用 SSH URL");

  const ready =
    gitOk &&
    !checks.some((check) => check.status === "fail") &&
    (!!input.url ||
      (authenticated && hasRepo !== false && (!create || !!account)));
  return {
    ready,
    checks,
    recommended: !gitOk
      ? null
      : input.url || existingUrl
        ? "url"
        : authenticated && hasRepo !== false
          ? "create"
          : "url",
  };
}
