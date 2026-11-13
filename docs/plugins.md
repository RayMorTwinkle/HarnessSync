# Declarative harness plugins

A harness plugin is a JSON description of where a tool reads instructions and
skills. It contains no JavaScript, installation hooks, or deployment scripts.
The same registry drives the CLI, HTTP API, scanner and deployment engine.
Adding a built-in tool requires a JSON file in `harnesses/`, not a TypeScript
adapter or a frontend icon. A contributor should supply evidence for the tool's
actual discovery behavior and integration tests with an isolated home.

For a device-local experiment, put a manifest in the directory printed by
`hsync harness dir`: `$HARNESS_SYNC_HOME/harnesses`, or
`~/.harness-sync/harnesses` by default. These files and enable/disable choices
are not part of the synced source repository. `--root` selects the corresponding
store's plugin directory. Files must end in `.json`; symbolic-link manifests
are rejected. Adding, changing or deleting a file is detected without restart
using the directory listing and file metadata (mtime, ctime, size and inode).

Built-ins are discovered from the package's `harnesses/` directory. User IDs
cannot override built-ins. When user JSON files claim duplicate IDs, all
those manifests are rejected. A malformed file is skipped and reported with its
filename, JSON path (for example `$.version.command`) and a Chinese explanation.
Other plugins continue to work. `harness list`, status and doctor expose errors.

## Acme Agent walkthrough

Acme is a fictional tool. Start with this complete manifest, save it as
`acme.json`, and replace the discovery paths with verified paths for your tool:

```json
{
  "$schema": "../schema/harness.schema.json",
  "id": "acme",
  "name": "Acme Agent",
  "homepage": "https://example.com/acme",
  "monogram": "Ac",
  "root": { "env": "ACME_HOME", "default": "~/.acme" },
  "detect": ["{root}"],
  "version": { "command": "acme", "args": ["--version"] },
  "instructions": {
    "global": [{ "path": "{root}/ACME.md", "kind": "main" }],
    "fragments": [],
    "project": "ACME.md"
  },
  "skills": {
    "global": "{root}/skills",
    "project": ".acme/skills",
    "reads": { "global": ["{root}/skills"], "project": [".acme/skills"] },
    "sameNameCopies": "list"
  },
  "notes": { "en": "Fictional test harness; filesystem deployment only." }
}
```

`$schema` is an editor hint, never fetched or executed by the loader. Adjust its
relative path for your editor, or use a local absolute path to the schema.

From the repository, use an isolated home and store (do not copy credentials):

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/store/harnesses"
export HOME="$sandbox/home"
export HARNESS_SYNC_HOME="$sandbox/store"
unset DSH_HOME DSH_AGENTS_HOME CODEX_HOME CLAUDE_CONFIG_DIR XDG_CONFIG_HOME ACME_HOME
hsync harness validate ./acme.json
cp ./acme.json "$HARNESS_SYNC_HOME/harnesses/acme.json"
hsync harness list --json
hsync init
hsync plan --json
```

For source development substitute `node --import tsx src/cli.ts` for `hsync`.
Validation works on a file anywhere and does not initialize the store. A plan
without source entries has no writes. Add a skill through the existing skill
commands, using `--harness acme` for an isolated selection or `--harness all` for
all tools. Inspect the plan's complete paths and differences, then use
`hsync apply --plan <id>`. Verify the resulting files. Test disabling and
re-enabling with `hsync harness disable acme` and `hsync harness enable acme`.
Neither operation itself deploys or removes anything.

For a PR, copy the manifest to `harnesses/acme.json`, add `notes.zh-CN`, include
links/evidence for the reader map in your PR, and add a fixture test. The schema
lives in `src/shared/harness-manifest.ts`; regenerate its committed editor schema
with `npm run schema:harness` when changing the format. The test suite asserts
that `schema/harness.schema.json` matches Zod's output. Run targeted tests with
that same isolated environment:

```sh
npx tsx --test tests/plugins.test.ts tests/deployment.test.ts tests/onboarding.test.ts
npx tsc --noEmit
```

## Field reference

Every object is strict: unknown keys are errors. All fields are required unless
marked optional. Empty scope lists are not an alias for all tools.

| Field                        | Meaning and validation                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`                    | Optional string; editor hint only.                                                                                                                   |
| `id`                         | Stable identity, `^[a-z][a-z0-9-]{1,31}$`. Renaming this creates a different tool.                                                                   |
| `name`                       | Display label, 1–40 characters.                                                                                                                      |
| `homepage`                   | Optional valid URL.                                                                                                                                  |
| `monogram`                   | Optional 1–2 visible Unicode code points; whitespace/control characters rejected. UI fallback when no bundled icon exists.                           |
| `root.env`                   | Optional environment variable name, `^[A-Z_][A-Z0-9_]*$`. Nonempty value overrides the default for the local home only.                              |
| `root.default`               | Path template; cannot reference `{root}` itself.                                                                                                     |
| `detect`                     | Nonempty array of path templates; existence of any path marks filesystem detection. Does not prove the tool loaded configuration.                    |
| `version`                    | Optional object described below.                                                                                                                     |
| `version.command`            | Bare executable name matching `^[A-Za-z0-9._-]+$`; no path or shell syntax.                                                                          |
| `version.args`               | Exactly one of `--version`, `-v`, `-V`, `version` in an array.                                                                                       |
| `instructions.global`        | Nonempty ordered array of `{ path, kind, when? }`.                                                                                                   |
| `instructions.global[].path` | Path template.                                                                                                                                       |
| `instructions.global[].kind` | `main`, `override`, `shared`, or `rules`. Shared/rules entries are scan-only.                                                                        |
| `instructions.global[].when` | Optional `non-empty`; requires an existing regular file with size greater than zero.                                                                 |
| `instructions.fragments`     | Array of scan-only globs ending in `/**/*.md`; empty is allowed. Recursive scanning stops after depth 6 and does not follow directory symlinks.      |
| `instructions.project`       | Relative project path without `..`, templates, or control characters; normally a filename. Equal paths form shared-instruction peer groups.          |
| `skills.global`              | Native global skill-directory template.                                                                                                              |
| `skills.project`             | Native relative project skill directory, with the same relative-path restrictions.                                                                   |
| `skills.reads.global`        | Nonempty array of path templates or `{ "path": "…", "legacy": true }`. Enumerate every supported discovery directory.                                |
| `skills.reads.project`       | Same structure, with relative project paths.                                                                                                         |
| `skills.reads.*[].legacy`    | Optional boolean, defaults to false. Marks an actual readable but less preferred legacy directory.                                                   |
| `skills.sameNameCopies`      | `collapse` if the tool resolves same-named copies into one entry; otherwise `list`. Use `list` when uncertain.                                       |
| `notes`                      | Localized object with optional `zh-CN` and `en` strings; `zh-CN` is required for built-ins. Fallback is Chinese, then English, then an empty string. |

The first active `main`/`override` global entry is the deployment target. Other
candidates remain visible as inactive scan sources. Include an unconditional
main/override fallback. `shared` and `rules` are never deployment targets.
The read arrays must include the exact native directory template. These two
cross-field constraints and the built-in Chinese-note requirement are checked
at runtime; JSON Schema cannot express all these relationships. Always run
`harness validate`, even if the editor reports no errors.

## Path templates

`~` and `~/…` expand to the target home. `{root}` expands to this manifest's
resolved root. `{env:NAME|fallback}` expands to a nonempty environment variable
or its fallback, for example `{env:XDG_CONFIG_HOME|~/.config}/opencode`.
Fallbacks may include `~`, but nested brace expressions are not supported.
Other brace syntax and control characters are errors. Relative global paths
resolve against the target home. Project paths resolve against each local
project binding.

Environment overrides are honored only when the target home equals
`os.homedir()`. When testing a different target home programmatically, only
fallbacks apply. Changing `HOME` makes it the process's local home, so clear
inherited override variables in isolated CLI tests as shown above.

## Reader map and placement

The registry unions readers by resolved directory. A directory is legacy only
if every contributing declaration marks it legacy. Native owners appear first
in reader lists; remaining readers use reverse registration order, preserving
existing built-in behavior. Default discovery remains:

| Global / project directory                     | Readers                   |
| ---------------------------------------------- | ------------------------- |
| `.dsh/skills` / `.dsh/skills`                  | DeepSeek                  |
| `.config/opencode/skills` / `.opencode/skills` | OpenCode                  |
| `.agents/skills` / `.agents/skills`            | Codex, OpenCode, DeepSeek |
| `.claude/skills` / `.claude/skills`            | Claude, OpenCode          |
| `.codex/skills` / `.codex/skills`              | Codex (legacy)            |

DeepSeek's redirected `DSH_AGENTS_HOME` belongs only to DeepSeek. OpenCode still
reads `~/.agents/skills`. A redirected `CLAUDE_CONFIG_DIR` belongs only to Claude;
OpenCode still reads `~/.claude/skills`. Manifests encode these distinctions.

Placement covers all selected enabled tools, then minimizes this lexicographic
score: extra copies visible to tools that list duplicates; extra unselected
readers; legacy directories; physical copies. An exact branch-and-bound search
uses monotone lower bounds and remaining coverage. Ties retain the first subset
in the old enumeration order. This is an exact set-cover search, so worst-case
exponential complexity remains; it is not a general polynomial-time guarantee.
500 deterministic random maps are compared against brute force, and a 24-directory
case has a 100 ms regression threshold.

A stored scope containing exactly the four original built-in IDs represents
**all enabled registered tools**, including plugins added later. Missing
`harnesses` parses as those same four IDs, as in v0.4. New “all” selections use
that explicit four-ID representation, so v0.4 still reads them correctly.
Explicit plugin subsets require v0.5. Unknown IDs are ignored with status/doctor
warnings; their unwanted owned receipts are preserved until the plugin returns.

Disabled tools are excluded from placement needs. Any path wanted by an enabled
tool in the current plan remains managed normally, even when a disabled tool
reads it or owns its old receipt. Only an unwanted path whose receipt belongs to
a disabled or missing tool is retained without updates or removal. Other unwanted
owned paths are removed normally. The same rule applies to shared instruction
files. Disable is not a visibility or access-control boundary; re-enabling resumes
management. Retained-path warnings are counted per harness, unknown scope IDs are
reported once per ID, and manifest validation issues are grouped per file.

## Security and packaging

JSON manifests cannot supply executable plugin code, hooks, shell commands, or
arbitrary arguments. The optional version probe runs a locally installed bare
executable from PATH through `execFileSync`, with no shell, a four-second timeout
and bounded output. This is still execution of a local executable: PATH and the
installed tool must be trusted. Version probes are cached by command and args;
validation, listing and planning never invoke them. Snapshot/onboarding may query
versions. A manifest cannot install an executable.

Plugins name filesystem paths, including absolute global paths; they are not a
filesystem sandbox. Treat manifests as deployment configuration you review.
Writes still go through plan → apply, native-content checks, ownership receipts,
symlink refusal and deployment snapshots. A changed manifest invalidates a
reviewed plan. No plugin-specific filesystem mutation runs in the UI. A successful
deployment reports filesystem state, not a running model's loaded context.

The npm package includes `harnesses/`, `schema/`, `skills/` and `dist/`.
The bundled CLI locates manifests next to `dist/`, matching the management-skill
template layout. The Git-based installer retains these directories and checks
for manifest/schema assets before activating the release.

## API contract

Authenticated `GET /api/harnesses` returns the standard API envelope:

```ts
{ ok: true, data: { harnesses: Harness[], errors: { file: string, issues: { path: string, message: string }[] }[], pluginDir: string } }
```

Authenticated `PUT /api/harnesses/<id>` accepts
`{ enabled: boolean, revision?: string }` and returns the same envelope. Send the
snapshot revision in the JSON body for optimistic concurrency, as with the other
mutation endpoints. Both endpoints retain the server's token, Host and Origin
checks and the existing error envelope.

Snapshot's `harnesses` includes enabled and disabled built-in/user entries.
`Harness.id` is a string; use the returned `name`, `source`, `enabled`, optional
`monogram`, optional `homepage`, and localized `notes`. Keep bundled icons keyed
only by known built-in IDs, with a monogram/name fallback for other IDs.
