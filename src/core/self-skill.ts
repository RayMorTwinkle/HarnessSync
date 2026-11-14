import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./store.ts";
import {
  AppError,
  hash,
  noSymlink,
  parseSkill,
  readBundle,
  skillMarkdown,
  skillPackageHash,
  writeJson,
  type Bundle,
} from "./files.ts";
import { harnessIds, type HarnessId } from "../shared/types.ts";

const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const generatedKey = "harness-sync-generated";
const defaultProjectRoot = path.resolve(
  fileURLToPath(
    new URL(
      import.meta.url.includes("/src/core/") ? "../../" : "../",
      import.meta.url,
    ),
  ),
);
export function cliCommand(
  store: Store,
  projectRoot = defaultProjectRoot,
  portable = false,
) {
  let cliRoot = projectRoot;
  if (path.basename(path.dirname(projectRoot)) === "releases") {
    const current = path.join(
      path.dirname(path.dirname(projectRoot)),
      "current",
    );
    try {
      if (
        fs.lstatSync(current).isSymbolicLink() &&
        fs.realpathSync(current) === fs.realpathSync(projectRoot)
      )
        cliRoot = current;
    } catch {
      // Missing or unrelated current links cannot provide a stable entry point.
    }
  }
  const quotePath = (file: string) => {
    const relative = path.relative(store.home, file);
    const inHome =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative));
    return shellQuote(
      portable && inHome
        ? `{{device.home}}${relative ? "/" + relative.split(path.sep).join("/") : ""}`
        : file,
    );
  };
  return {
    projectRoot,
    command: `node ${quotePath(path.join(cliRoot, "dist/cli.js"))} --root ${quotePath(store.root)}`,
  };
}
function markdown(bundle: Bundle) {
  return parseSkill(
    Buffer.from(bundle["SKILL.md"].content, "base64").toString("utf8"),
  );
}
function fingerprint(bundle: Bundle, description: string) {
  const raw = Buffer.from(bundle["SKILL.md"].content, "base64").toString(
    "utf8",
  );
  // Remove only our top-level scalar, retaining every other source byte so even
  // whitespace edits are protected. Git-compatible permissions survive sync.
  const withoutFingerprint = raw.replace(
    /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/,
    (_, start, frontmatter, end) =>
      start +
      frontmatter.replace(
        /(?:^|\r?\n)harness-sync-generated:[^\r\n]*(?=\r?\n|$)/,
        "",
      ) +
      end,
  );
  return hash(
    JSON.stringify({
      description,
      package: skillPackageHash({
        ...bundle,
        "SKILL.md": {
          ...bundle["SKILL.md"],
          content: Buffer.from(withoutFingerprint).toString("base64"),
        },
      }),
    }),
  );
}

function generated(store: Store, projectRoot: string) {
  const bundle = readBundle(
    path.join(projectRoot, "skills/manage-harness-sync"),
  );
  const template = markdown(bundle);
  const body = template.body.replaceAll(
    "__HSYNC_CLI__",
    cliCommand(store, projectRoot, true).command,
  );
  const metadata = { ...template.metadata };
  delete metadata[generatedKey];
  bundle["SKILL.md"] = {
    mode: 0o644,
    content: Buffer.from(
      skillMarkdown(template.name, template.description, body, metadata),
    ).toString("base64"),
  };
  metadata[generatedKey] = fingerprint(bundle, template.description);
  bundle["SKILL.md"].content = Buffer.from(
    skillMarkdown(template.name, template.description, body, metadata),
  ).toString("base64");
  return { ...template, body, bundle };
}
async function reminder(store: Store, pending: boolean) {
  await store.lock(() => {
    const file = path.join(store.root, "self-skill-update.json");
    noSymlink(file);
    writeJson(file, { pending });
  });
}
export async function installSelfSkill(
  store: Store,
  revision?: string,
  targets: HarnessId[] = [...harnessIds],
  projectRoot = defaultProjectRoot,
) {
  const expectedRevision = revision ?? store.revision();
  const template = generated(store, projectRoot);
  const existing = store
    .manifest()
    .skills.find((s) => s.name === template.name);
  const result = await store.saveSkill(
    {
      name: template.name,
      description: template.description,
      displayName: existing?.displayName || "HarnessSync 配置管理",
      body: template.body,
      enabled: existing?.enabled ?? true,
      scope: existing?.scope || { kind: "global", harnesses: targets },
    },
    existing?.id,
    expectedRevision,
    template.bundle,
    { replaceResources: true },
  );
  await reminder(store, false);
  return result;
}
// No installation authorization is implied by a service start or an upgrade.
export async function refreshSelfSkill(
  store: Store,
  projectRoot = defaultProjectRoot,
) {
  const revision = store.revision();
  const existing = store
    .manifest()
    .skills.find((s) => s.name === "manage-harness-sync");
  if (!existing) return undefined;
  noSymlink(store.skillPath(existing.id));
  const current = readBundle(store.skillPath(existing.id));
  const template = generated(store, projectRoot);
  let previous: unknown;
  try {
    if (!current["SKILL.md"])
      throw new AppError("INVALID_SKILL", "缺少 SKILL.md");
    previous = markdown(current).metadata[generatedKey];
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "INVALID_SKILL")
      throw error;
    await reminder(store, true);
    return existing;
  }
  const actual = fingerprint(current, existing.description);
  const expected = fingerprint(template.bundle, template.description);
  if (actual === expected) {
    await reminder(store, false);
    return existing;
  }
  if (previous !== actual) {
    await reminder(store, true);
    return existing;
  }
  return installSelfSkill(store, revision, undefined, projectRoot);
}
