import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./store.ts";
import { parseSkill } from "./files.ts";

const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function installSelfSkill(store: Store, revision?: string) {
  const projectRoot = path.resolve(
    fileURLToPath(
      new URL(
        import.meta.url.includes("/src/core/") ? "../../" : "../",
        import.meta.url,
      ),
    ),
  );
  const command = `node ${shellQuote(path.join(projectRoot, "dist/cli.js"))} --root ${shellQuote(store.root)}`;
  const template = parseSkill(
    fs.readFileSync(
      path.join(projectRoot, "skills/manage-harness-sync/SKILL.md"),
      "utf8",
    ),
  );
  const existing = store
    .manifest()
    .skills.find((s) => s.name === template.name);
  return store.saveSkill(
    {
      name: template.name,
      description: template.description,
      body: template.body.replaceAll("__HSYNC_CLI__", command),
      enabled: true,
      scope: { kind: "global", harnesses: ["deepseek", "opencode"] },
    },
    existing?.id,
    revision,
  );
}
