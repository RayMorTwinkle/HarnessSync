export const harnessIds = ["deepseek", "opencode", "codex", "claude"] as const;
export const harnessNames: Record<(typeof harnessIds)[number], string> = {
  deepseek: "DeepSeek Harness",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
};
