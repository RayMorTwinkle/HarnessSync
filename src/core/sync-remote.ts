import { AppError } from "./files.ts";

export function validateSyncUrl(url: string) {
  if (
    !url ||
    url.startsWith("-") ||
    /[\r\n\0]/.test(url) ||
    /(https?:\/\/[^/]*@|:\/\/[^/]*:[^/]*@|[?#])/i.test(url)
  )
    throw new AppError(
      "SYNC_URL",
      "Git URL 无效；请勿在 URL 中嵌入凭证，使用 SSH 或 Git 凭证助手",
    );
}

export function githubRepository(url: string) {
  let pathname = url.match(/^git@github\.com:(.+)$/i)?.[1];
  if (!pathname) {
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname !== "github.com" ||
        !["https:", "ssh:"].includes(parsed.protocol)
      )
        return undefined;
      pathname = parsed.pathname.slice(1);
    } catch {
      return undefined;
    }
  }
  return pathname
    .match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    ?.slice(1)
    .join("/");
}

export function githubCredentialArgs(url: string, gh: boolean) {
  return gh && url.startsWith("https://github.com/")
    ? [
        "-c",
        "credential.https://github.com.helper=",
        "-c",
        "credential.https://github.com.helper=!gh auth git-credential",
      ]
    : [];
}

// Never return authentication diagnostics verbatim to a CLI/API consumer.
export function redactSyncOutput(value: string) {
  return value
    .split("\n")
    .filter((line) => !/\b(token|authorization|password)\b/i.test(line))
    .join("\n")
    .replace(/https?:\/\/[^\s/]*@/gi, "https://[已隐藏]@")
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[已隐藏]");
}
