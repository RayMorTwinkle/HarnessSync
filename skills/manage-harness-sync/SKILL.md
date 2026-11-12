---
name: manage-harness-sync
description: Manage HarnessSync shared skills, instructions, device variables and named projects. Use when asked to add, edit, deploy, inspect or roll back local AI harness configuration.
---

# Manage HarnessSync

Use the local CLI to manage shared configuration for DeepSeek Harness and OpenCode.

CLI: `__HSYNC_CLI__`

The installer replaces the CLI placeholder with this installation's exact path. For a manually installed copy, use `hsync` from PATH.

## Working with configuration

- Start with `status --json` to inspect source, device, project bindings, changes and conflicts. `doctor --json` checks the current deployment without writing to an initialized store.
- Use `--help` on unfamiliar command groups. Source commands are `rules`, `skills`, `projects`, and `device`.
- Edit source through the CLI; avoid editing generated native files.
- After a source change, run `plan --json`. Review affected paths, then `apply --plan <id>` when deployment is within the user's authorized request. A stale plan must be regenerated.
- Use `history` for source commits and deployments. `restore <commit>` restores source and creates a new commit; `rollback <deployment-id>` restores native files, newest deployment first.
- Report filesystem deployment separately from session loading. A successful `doctor` alone does not prove that a running session loaded the change.

## Creating skills and instructions

Create a directory bundle with `SKILL.md`, then run `skills import /absolute/skill-directory`. Scripts, executable bits, references, assets and extra frontmatter are preserved. Use `skills edit <id> --file /absolute/SKILL.md` for body edits while retaining resources.

The default scope is global and both harnesses. Add `--scope project --target <project-id>` for a project, `--scope device --target <device-id>` for this device, or `--harness deepseek` / `--harness opencode` to select a harness. Project instructions share one `AGENTS.md` and must target both harnesses in v0.1; project skills can select either.

For instructions, use `rules add --title <title> --file /absolute/rules.md`. Variables are resolved in instruction fragments: `{{device.name}}`, `{{device.home}}`, `{{device.id}}`, `{{project.name}}`, `{{project.path}}`, `{{vars.KEY}}`. Skill resources remain byte-for-byte copies.

`skills import <native-directory> --adopt` explicitly takes ownership of a matching native skill directory. This allows later updates and removal. Ordinary import leaves the original unmanaged. For an already imported skill, adoption requires the native directory and library bundle to be identical.

## Limits

Do not overwrite foreign files or ignore deployment drift. Keep device paths and variables local; do not place credentials in instructions or skills.

The CLI follows the harness's filesystem permissions. If a mutation is denied by its sandbox, report the required paths and use the harness's available approval mechanism. Do not claim a denied mutation succeeded.

Source saves create local Git commits. Remote multi-device synchronization is not implemented in v0.1.
