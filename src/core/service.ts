import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Store } from "./store.ts";
import { AppError, atomicWrite, exists, noSymlink } from "./files.ts";

export const serviceLabel = "io.github.raymortwinkle.harness-sync";
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr?: string }>;
const commandRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 15_000 },
      (e, stdout, stderr) => {
        if (e && typeof e.code !== "number") return reject(e);
        resolve({ code: e ? Number(e.code) : 0, stdout, stderr });
      },
    );
  });
const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export type ServiceOptions = {
  platform?: string;
  runner?: CommandRunner;
  cliPath?: string;
  execPath?: string;
  uid?: number;
  envPath?: string;
};
export class LoginService {
  readonly platform: string;
  readonly runner: CommandRunner;
  readonly file: string;
  constructor(
    readonly store: Store,
    readonly options: ServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? commandRunner;
    this.file =
      this.platform === "darwin"
        ? path.join(store.home, "Library/LaunchAgents", `${serviceLabel}.plist`)
        : path.join(store.home, ".config/systemd/user/harness-sync.service");
  }
  get supported() {
    return ["darwin", "linux"].includes(this.platform);
  }
  private get domain() {
    return `gui/${this.options.uid ?? process.getuid?.() ?? 0}`;
  }
  private owned(content: string) {
    return this.platform === "darwin"
      ? content.includes(`<key>Label</key><string>${serviceLabel}</string>`) &&
          content.includes("<!-- HarnessSync login service -->")
      : content.startsWith("# HarnessSync login service\n") &&
          content.includes(`Description=${serviceLabel}\n`);
  }
  private verify() {
    noSymlink(this.file);
    if (exists(this.file) && !this.owned(fs.readFileSync(this.file, "utf8")))
      throw new AppError(
        "FOREIGN_SERVICE",
        "登录服务文件不属于 HarnessSync，拒绝覆盖或删除",
      );
  }
  async status() {
    if (!this.supported)
      return {
        supported: false,
        installed: false,
        loaded: false,
        login: false,
        file: this.file,
      };
    this.verify();
    try {
      const result = await this.runner(
        this.platform === "darwin" ? "launchctl" : "systemctl",
        this.platform === "darwin"
          ? ["print", `${this.domain}/${serviceLabel}`]
          : ["--user", "is-active", "harness-sync.service"],
      );
      const loaded = result.code === 0;
      const installed = exists(this.file);
      let enabled = loaded;
      if (this.platform === "linux") {
        const check = await this.runner("systemctl", [
          "--user",
          "is-enabled",
          "harness-sync.service",
        ]);
        enabled = check.code === 0;
      }
      return {
        supported: true,
        installed,
        loaded,
        login: installed && enabled,
        file: this.file,
      };
    } catch (e: any) {
      throw new AppError(
        "SERVICE_STATUS",
        `无法读取登录服务状态：${e.message}`,
      );
    }
  }
  private content() {
    const cli = this.options.cliPath ?? process.argv[1];
    if (
      !cli ||
      !path.isAbsolute(cli) ||
      !/[/\\]dist[/\\]cli\.js$/.test(cli) ||
      !exists(cli)
    )
      throw new AppError(
        "SERVICE_DEV_CHECKOUT",
        "登录启动需要已安装的 dist/cli.js；请先构建并安装，再用安装后的 hsync service install",
      );
    const exec = this.options.execPath ?? process.execPath;
    if (!path.isAbsolute(exec))
      throw new AppError("SERVICE_PATH", "Node 可执行文件必须使用绝对路径");
    const log = path.join(this.store.root, "logs/service.log");
    const envPath =
      this.options.envPath ??
      process.env.PATH ??
      "/usr/local/bin:/usr/bin:/bin";
    const args = [exec, cli, "serve", "--background"];
    if (this.platform === "darwin")
      return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- HarnessSync login service -->\n<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>EnvironmentVariables</key><dict><key>HARNESS_SYNC_HOME</key><string>${xml(this.store.root)}</string><key>PATH</key><string>${xml(envPath)}</string></dict>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
    if (/[\r\n]/.test(log) || /\s$/.test(log))
      throw new AppError(
        "SERVICE_PATH",
        "Linux 服务日志路径不能包含换行或末尾空白",
      );
    // systemd uses its own quoting and specifier expansion, never a shell.
    const quote = (s: string) =>
      '"' +
      s
        .replace(/%/g, "%%")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r") +
      '"';
    return `# HarnessSync login service\n[Unit]\nDescription=${serviceLabel}\n[Service]\nExecStart=${args.map((s) => quote(s.replace(/\$/g, () => "$$"))).join(" ")}\nEnvironment=${quote(`HARNESS_SYNC_HOME=${this.store.root}`)}\nEnvironment=${quote(`PATH=${envPath}`)}\nRestart=on-failure\nRestartSec=5\nStandardOutput=append:${log.replace(/%/g, "%%")}\nStandardError=append:${log.replace(/%/g, "%%")}\n[Install]\nWantedBy=default.target\n`;
  }
  private async run(args: string[]) {
    try {
      const r = await this.runner(
        this.platform === "darwin" ? "launchctl" : "systemctl",
        args,
      );
      if (r.code) throw new Error(r.stderr || r.stdout || `退出码 ${r.code}`);
    } catch (e: any) {
      throw new AppError("SERVICE_COMMAND", `登录服务操作失败：${e.message}`);
    }
  }
  async install() {
    if (!this.supported)
      throw new AppError("SERVICE_UNSUPPORTED", "当前系统不支持登录启动");
    const content = this.content();
    this.verify();
    const status = await this.status();
    if (status.login && fs.readFileSync(this.file, "utf8") === content)
      return status;
    rotateServiceLog(this.store);
    const previous = exists(this.file)
      ? fs.readFileSync(this.file, "utf8")
      : undefined;
    if (status.loaded)
      await this.run(
        this.platform === "darwin"
          ? ["bootout", `${this.domain}/${serviceLabel}`]
          : ["--user", "stop", "harness-sync.service"],
      );
    atomicWrite(this.file, content);
    try {
      if (this.platform === "linux")
        await this.run(["--user", "daemon-reload"]);
      await this.run(
        this.platform === "darwin"
          ? ["bootstrap", this.domain, this.file]
          : ["--user", "enable", "--now", "harness-sync.service"],
      );
    } catch (e) {
      if (previous !== undefined) atomicWrite(this.file, previous);
      else fs.unlinkSync(this.file);
      if (previous !== undefined && status.loaded) {
        try {
          if (this.platform === "linux")
            await this.run(["--user", "daemon-reload"]);
          await this.run(
            this.platform === "darwin"
              ? ["bootstrap", this.domain, this.file]
              : ["--user", "enable", "--now", "harness-sync.service"],
          );
        } catch (restore: any) {
          throw new AppError(
            "SERVICE_RECOVERY",
            `登录服务更新失败，恢复旧服务也失败：${(e as Error).message}；${restore.message}`,
          );
        }
      }
      throw e;
    }
    return this.status();
  }
  async uninstall() {
    if (!this.supported)
      throw new AppError("SERVICE_UNSUPPORTED", "当前系统不支持登录启动");
    this.verify();
    if (!exists(this.file)) return this.status();
    const status = await this.status();
    const previous = fs.readFileSync(this.file, "utf8");
    // Unloading can terminate this very server. Remove the owned file first.
    if (this.platform === "linux")
      await this.run(["--user", "disable", "harness-sync.service"]);
    this.verify();
    fs.unlinkSync(this.file);
    try {
      if (this.platform === "linux")
        await this.run(["--user", "stop", "harness-sync.service"]);
      else if (status.loaded)
        await this.run(["bootout", `${this.domain}/${serviceLabel}`]);
      if (this.platform === "linux")
        await this.run(["--user", "daemon-reload"]);
    } catch (e) {
      noSymlink(this.file);
      if (!exists(this.file)) atomicWrite(this.file, previous);
      throw e;
    }
    return this.status();
  }
}
export function rotateServiceLog(store: Store, maxBytes = 5 * 1024 * 1024) {
  const log = path.join(store.root, "logs/service.log");
  noSymlink(log);
  noSymlink(log + ".1");
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  if (exists(log) && fs.statSync(log).size >= maxBytes) {
    // launchd/systemd retain the open descriptor: preserve its inode.
    fs.copyFileSync(log, log + ".1");
    fs.chmodSync(log + ".1", 0o600);
    fs.truncateSync(log, 0);
  }
}
