import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./store.ts";
import { parseSkill, readBundle } from "./files.ts";
import { harnessIds, type HarnessId } from "../shared/types.ts";

const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function cliCommand(store: Store) {
  const projectRoot = path.resolve(
    fileURLToPath(
      new URL(
        import.meta.url.includes("/src/core/") ? "../../" : "../",
        import.meta.url,
      ),
    ),
  );
  return {
    projectRoot,
    command: `node ${shellQuote(path.join(projectRoot, "dist/cli.js"))} --root ${shellQuote(store.root)}`,
  };
}
export async function installSelfSkill(
  store: Store,
  revision?: string,
  targets: HarnessId[] = [...harnessIds],
) {
  const { projectRoot, command } = cliCommand(store);
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
      displayName: "HarnessSync 配置管理",
      body: template.body.replaceAll("__HSYNC_CLI__", command),
      enabled: true,
      scope: { kind: "global", harnesses: targets },
    },
    existing?.id,
    revision,
    readBundle(path.join(projectRoot, "skills/manage-harness-sync")),
  );
}
