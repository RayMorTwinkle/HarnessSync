# HarnessSync

One library of skills and instructions for your AI coding tools.

HarnessSync writes shared skills and instructions into each tool's native folders. Keep the source library in your own private Git repository and sync it across devices, while device paths and deployment state stay local. A local web GUI and CLI use the same core.

[简体中文](README.zh-CN.md)

![HarnessSync overview: skills, instructions and the tools they are written to](docs/images/overview.png)

The GUI, CLI messages, and bundled skills are currently in Simplified Chinese. Contributions to internationalization are welcome.

## Features

- Unified skill library: import complete packages, including scripts, assets, and executable permissions.
- Instructions and top-level skill `SKILL.md` files with device, project, and custom variables.
- Read-only instruction and skill composition through the CLI and local API.
- Global, device, and per-project configuration with stable project IDs and local directory bindings.
- Automatic deployment of clean changes, with snapshots, failure recovery, and rollback.
- Conflict choices: use the library version, import the native version, or skip a target.
- Git skill sources: install packages, check upstream changes, inspect diffs, update, or detach.
- Cross-device sync through your own private Git repository: identical entries merge themselves, differing ones become side-by-side conflicts you or your Agent can resolve.
- Declarative tool plugins: add discovery paths in JSON.
- Settings page and login service for macOS and Linux with systemd user services.
- CLI ≡ GUI: both call the same core for configuration and deployment.
- AI-manageable through the bundled [`manage-harness-sync` skill](skills/manage-harness-sync/SKILL.md).

## Supported tools

Default native paths from [`harnesses/*.json`](harnesses/). The planner may choose shared skill directories to reduce duplicate copies.

| Tool             | Global skills directory     | Global instructions file                                             |
| ---------------- | --------------------------- | -------------------------------------------------------------------- |
| DeepSeek Harness | `~/.dsh/skills`             | `~/.dsh/AGENTS.md`                                                   |
| OpenCode         | `~/.config/opencode/skills` | `~/.config/opencode/AGENTS.md`                                       |
| Codex            | `~/.agents/skills`          | `~/.codex/AGENTS.md`; nonempty `AGENTS.override.md` takes precedence |
| Claude Code      | `~/.claude/skills`          | `~/.claude/CLAUDE.md`                                                |

Roots respect `DSH_HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`. DeepSeek also reads shared paths under `DSH_AGENTS_HOME` (default `~/.agents`). Codex's native skill directory remains `~/.agents/skills` when `CODEX_HOME` changes. See [plugin path semantics](docs/plugins.md#path-templates) for the full reader map.

Project skills use `.dsh/skills`, `.opencode/skills`, `.agents/skills`, and `.claude/skills`, respectively. DeepSeek, OpenCode, and Codex share project `AGENTS.md`; project instructions for one must select all enabled peers sharing that file. Claude uses `CLAUDE.md`. Tool selection is not an access-control boundary: other tools may read shared directories.

## Install

Requires Node.js **22.12+**, npm, and Git. The installer supports macOS and Linux. Use **WSL on Windows**; native Windows is not supported. Recorded real-session verification covers macOS only; see the [acceptance record](docs/local-acceptance.md) and [adapter evidence](docs/adapters.md).

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.5.0/install.sh | bash
```

The installer uses `~/.local/share/harness-sync` and creates `~/.local/bin/hsync`. It needs no sudo, leaves shell configuration alone, and only installs the application. Add the launcher directory to PATH as directed, or use `~/.local/bin/hsync` directly. Re-run the installer for an upgrade; restart a running service to use the new build. Your library in `~/.harness-sync` is separate from the installation.

To inspect the installer first:

```sh
curl -fsSL https://raw.githubusercontent.com/RayMorTwinkle/HarnessSync/v0.5.0/install.sh -o install-harness-sync.sh
bash install-harness-sync.sh --help
```

The bundled [installation skill](skills/harness-sync-install/SKILL.md) can also guide an AI through installation and onboarding.

### Backup and uninstall

Before the first scan or deployment, HarnessSync saves a local baseline under `~/Downloads/HarnessSync 备份/` (or HOME when Downloads is absent). It includes registered skill/instruction paths, including disabled tools and bound projects; it includes credential files inside skill directories and stays local, while excluding tool roots and session history. Links are preserved without following them.

Use `hsync backup list`, `hsync backup verify <dir>`, and `hsync backup restore` to inspect and preview recovery. Execute with `--plan <id>`; external edits stay untouched unless explicitly selected with `--overwrite`. Recovery saves another snapshot and disables automatic deployment.

Preview `hsync uninstall --restore` (recommended) or `hsync uninstall --keep-files`, then execute `hsync uninstall --plan <id>`. The library is exported into the backup; local library deletion requires `--delete-library` in the preview. Remote repositories remain intact. Source runs skip program removal. See [CLI details](docs/cli.md#备份恢复与卸载v06).

## Quick start

```sh
hsync open
```

This opens the local GUI at `http://127.0.0.1:47821`. It reuses a verified service for the same library, or starts one in the current terminal. Keep that terminal open; Ctrl+C stops a newly started service. `hsync serve` runs without opening a browser.

Use the onboarding panel, or prepare the management skill and a Chinese handoff prompt:

```sh
hsync onboard prepare --json
hsync onboard show --json
hsync doctor --json
```

Onboarding scans known tool locations and deploys only the management skill to detected tools. It preserves existing global instructions. Hand the generated prompt to your chosen tool to organize the rest of your library.

The management skill uses the installer's verified `current/dist/cli.js` entry and stores paths under HOME as `{{device.home}}/...`; deployment renders local absolute paths. New `serve`/`open` services and `onboard prepare` refresh an existing, unmodified generated skill in place, preserving scope, enabled state and display name. Refreshes create source commits and service startup follows `deploy.auto`; onboarding still deploys only this skill. Startup never installs a missing skill. Modified skills and older copies without a generation fingerprint are preserved with a `SELF_SKILL_UPDATE` reminder in `status`. After reviewing, run `hsync self-skill` to explicitly replace their content and resources. Fingerprints travel with the source skill; reminder caches stay local. Paths outside HOME or different relative installation locations can still need coordination across devices.

Examples for an existing skill package and project (replace the paths; use the project ID returned by `projects add`):

```sh
hsync skills import /absolute/my-skill
hsync rules add --title 'Working agreements' --file /absolute/instructions.md
hsync projects add 'My Project' --path /absolute/project
hsync skills import /absolute/project-skill --scope project --target PROJECT_ID
hsync plan --json
```

Outside an active onboarding session, automatic deployment is on by default, so these source edits may also write clean changes to native folders. For a workflow that requires manual review before deployment, disable it **before editing**:

```sh
hsync config set deploy.auto false
hsync plan --json
hsync apply --plan PLAN_ID
hsync history
hsync rollback DEPLOYMENT_ID
```

Use the IDs returned by `plan` and `history`. See [CLI reference](docs/cli.md) (Chinese); each command also has `--help`.

## How it works

The flow is **library → plan → apply**. Source entries and complete skill packages live in `~/.harness-sync/repo/`, a plain Git repository. Device identity, variables, project directory bindings, settings, receipts, and snapshots live outside that repository. Set `HARNESS_SYNC_HOME` or use `hsync --root /absolute/store plan` to choose another store.

The planner reads existing native files, renders instructions, and computes paths, diffs, conflicts, and a plan ID. Apply recalculates that plan under the store lock and refuses stale IDs. Skills are copied as complete packages. Ownership receipts record managed paths and fingerprints; deployments do not silently overwrite unowned skill collisions or external edits.

Instruction updates preserve content outside the managed block. The exception is an explicit onboarding replacement staged from a verified scan: it shows the full diff and saves the original in the deployment snapshot. Snapshots also support failure recovery and rollback of the latest valid deployment. Rollback refuses later edits, keeps the source library unchanged, and does not immediately redeploy it.

Automatic deployment uses the same planner, receipts, and snapshots. Related CLI/API edits, pulled changes, and scheduler startup can trigger it. It accepts absent targets for creation and owned targets without external edits for updates/removal; an explicit skip must still match its fingerprint. Plan errors, conflicts, adoptions, replacements, staged instruction replacements, unfinished recovery, and blocking notices (leftover staging directories, a changed or unreadable local import source) stop the whole attempt for review. Informational notices, such as a disabled tool keeping its files or a shared directory that other tools also read, do not. It does not choose conflict resolutions or install upstream skill updates. Read `autoDeploy` in `hsync doctor --json`; for `needs-review`, inspect a fresh plan and apply it manually after resolving blockers. Details: [settings](docs/settings.md) (Chinese).

Instructions support `{{device.name}}`, `{{device.id}}`, `{{device.home}}`, `{{project.name}}`, `{{project.path}}`, and `{{vars.KEY}}`. Skills render only these recognized variables in the top-level `SKILL.md` (`project.*` only for project skills); other template syntax, scripts, and resources stay unchanged. The library and sync keep the template. Deployment hashes and adoption comparisons use rendered bytes, so changing a device variable produces an update without reporting external drift. A missing skill variable skips that skill's paths and retains existing copies; manual apply can continue with other clean paths, while the blocking notice pauses automatic deployment. Set values with `hsync device set KEY value`, then preview again. Variables are written to native files; do not use them for credentials.

`hsync compose instructions [--json]` shows every enabled tool's global output and bound project outputs, deduplicating shared files. `hsync compose skill ID [--json]` shows skill file categories. Text output includes a 40-character bar, legend, and byte counts. JSON reports UTF-8 bytes, variables separately, and ordered instruction segments that reconstruct the planned file, including user text outside managed blocks. Instruction `pending` compares source output with disk; `error` marks incomplete or blocked previews. Skill composition reports missing variables as an error. These read-only queries never read credential contents and do not prove session loading. See the [CLI/API contract](docs/cli.md#内容组成只读).

## Sync

Connect your own private, dedicated Git repository. Credentials come from your existing `gh` login, SSH setup, or system Git credential helper. GitHub HTTPS commands temporarily use `gh auth git-credential` without changing global Git configuration. HarnessSync does not accept sync login tokens; authentication stays with these local tools. Selected skill packages, including credential files, are synchronized to your private repository, which must remain private. Never put credential values in instruction text or URLs. Run `hsync sync check` first, then check your chosen URL or creation option before setup. If login is needed, run `gh auth login` yourself in a terminal and follow the browser authorization flow (in Claude Code, use `! gh auth login`).

```sh
hsync sync check --url git@github.com:USER/config.git
hsync sync setup --url git@github.com:USER/config.git
hsync sync status --json
hsync sync now --json
```

Alternatively, `hsync sync setup --create` creates a private GitHub repository using an installed, authenticated `gh`. On another device, connect the same URL before or after onboarding; onboarding asks whether this is your first device and compares local skills with the shared library. Entries merge by object, and same-named entries with identical content on two devices become one automatically. When content differs, `hsync sync conflicts` lists each conflict with diffs and folders under `~/.harness-sync/conflicts/<id>/` (`local/`, `remote/`, `merged/`). Choose `hsync sync resolve ENTRY_ID --keep local|remote|both`, or let an Agent combine them: the listing includes a prompt that makes it explain the differences and get your agreement before writing `merged/` and running `--keep merged`. Unresolved conflicts block pushing and automatic deployment.

Every CLI command attaches `reminders` (sync conflicts, paused deployments, skill updates, sync failures) so an Agent that calls `hsync` learns about them; turn this off with `hsync config set notices.cli false`.

After setup, automatic sync defaults to pushing after 120 seconds without edits and pulling every 10 minutes. It runs while `hsync open`, `hsync serve`, or `hsync sync watch` is running. Pulled changes can deploy automatically when `deploy.auto` is enabled and the entire plan is clean. Device paths, variables, snapshots, local plugins, and settings do not sync.

Package `.gitignore`, `.gitattributes`, and other ordinary `.git*` files are stored as data. Commits, sync, history comparisons, and source restore preserve raw bytes (including CRLF and binary files) and executable bits. Only device-local `sync ignore` rules restrict uploads; package `.git` internals remain excluded during import. The next commit automatically includes previously omitted files still present in the worktree. Bytes already lost and never committed cannot be recovered from old history. Files are saved in batches, avoiding a Git process per file.

Git skills are a separate source mechanism:

```sh
hsync skills install owner/repo --skill research
hsync skills updates
hsync skills diff research
hsync skills update research
hsync skills detach research
```

Replace the repository and skill name. Background checks report available updates; installation requires an explicit update. Local library edits block an upstream update unless explicitly overridden. Install/update source edits follow the automatic deployment setting.

## Adding a tool

Add a JSON manifest in the directory printed by `hsync harness dir`, validate it with `hsync harness validate /absolute/tool.json`, then inspect a deployment plan. Built-in contributions go in `harnesses/`. Follow the [plugin guide](docs/plugins.md) for fields, discovery evidence, testing, and shared-directory behavior.

Each device can turn tools on or off in Settings. A disabled tool keeps its files as they are.

![HarnessSync settings: automatic deployment, login startup and per-device tools](docs/images/settings.png)

## Safety model

- Read native configuration before planning. Check ownership and fingerprints before writing or removing managed content.
- Reject malformed instruction markers, stale plans, and writes through symlinks. Explicit adoption/replacement can replace a final symlink with a copy, preserving the original link in a snapshot; it never writes through the link.
- Keep deployment snapshots locally. Refuse rollback that would overwrite newer edits.
- Serve HTTP only on `127.0.0.1`, with Host, Origin, and session-token checks.
- Report filesystem state honestly. `doctor` and the GUI cannot prove a running tool session loaded the deployed configuration.

Current limits: one local directory per project per device; unique skill names across the library; no desktop installer. Scans cover known locations, not all configuration a tool might load. Natural-language instruction conflicts require human or AI review.

## Development

```sh
git clone https://github.com/RayMorTwinkle/HarnessSync.git
cd HarnessSync
npm ci
npm run build
```

Use a fake HOME and store for local CLI/GUI work:

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/store"
env -u DSH_HOME -u DSH_AGENTS_HOME -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u XDG_CONFIG_HOME \
  HOME="$sandbox/home" HARNESS_SYNC_HOME="$sandbox/store" npm run dev
```

Ctrl+C stops the development server. Use the same isolation for CLI commands (`npm run cli -- plan --json`), built CLI/GUI (`npm start`), and tests. `npm run typecheck` checks types; `npm test` runs the full suite; `npm run build` checks types and builds CLI/UI. See [CONTRIBUTING.md](CONTRIBUTING.md) for targeted tests and the reusable sandbox helper. Core changes require both the full suite and build.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture map](docs/architecture.md). Tool plugins, documentation, internationalization, tests, and UI improvements are welcome. Detailed operational docs are currently mostly Chinese.

Independent implementation, informed by [Skills Manager](https://github.com/xingkongliang/skills-manager).

License: [MIT](LICENSE).

### Onboarding scans and local sources

`onboard scan` (also used by prepare and the UI) starts a device-local session that pauses automatic deployment for up to seven days without changing `deploy.auto`. Status and doctor expose `onboarding` and a readable `needs-review` blocker. A successful full manual `apply --plan <id>`, including a no-op apply, finishes the session; bootstrap and failed applies do not. `onboard cancel <session-id>` abandons it while retaining source edits and staged replacements. Cancellation or expiry restores the original automatic deployment policy for subsequent triggers. A new scan supersedes the previous session.

Receipted deployment locations are not independent development sources. Apply clears local origins for adopted or removed locations; current receipts and successful deployment snapshots let older installations ignore obsolete origins automatically. Links to independent development directories retain update detection.

Scans classify product-installed skills as `origin=bundled`, with `originReason` and `bundledBy: {name,path}`. Application bundles, common installation directories, node_modules and linked software projects are recognized; project traversal stays within HOME and stops after eight ancestors. Pure skill collections remain user skills. `summary.bundledSkills` counts these advisory exclusions: do not import or upload by default, but honor an explicit user request to import them.

`inventory.skills[].credentials` and `skills show <id>.credentials` list suspected credential files by relative filename, without displaying values; `summary.credentialSkills` counts affected physical packages. All selected configuration, including secret files, follows the user's private-repository sync choice. Keep the repository private; exclude unwanted uploads with `hsync sync ignore <skill>/<file>` (provided by the sync-ignore feature). Never request tokens from the user or put values in instruction text or URLs.

`onboard repository` returns `absent` for GitHub's explicit repository-resolution failure: the default name is absent, but a differently named repository may exist. Network and permission errors remain `unknown`.

Upload-only exclusions are device-local: `hsync sync ignore add anysearch/.env genbox`, `sync ignore remove anysearch/.env`, and `sync ignore list --json`. Skill names exclude whole packages; paths support quoted `*`, `**`, and `?` globs; `rule:<ID or title>` excludes instructions. Local storage and deployment remain intact. Already uploaded versions remain on the remote; ignored local changes are not sent or overwritten by pulls. Removing a rule resumes normal merging. Uploads use separate history after enabling exclusions, but existing remote history is not erased. See [ignore semantics, API and explicit remote removal](docs/cli.md#本机上传忽略规则). `sync check` fails for public repositories with unignored credentials, warns when visibility is unknown, and reports the count for private repositories.
