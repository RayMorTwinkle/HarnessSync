# HarnessSync

Independent local-first project. Supports DeepSeek Harness, OpenCode, Codex, and Claude Code.

- GUI and CLI must use the same core. Never implement filesystem mutations in the UI.
- Source configuration lives in a plain Git repository. Device paths and deployment state stay local.
- Read existing native configuration before planning a deployment. Preserve content outside managed instruction blocks unless an initialization replacement was explicitly staged from a verified scan; show its full diff and retain the original in the deployment snapshot.
- Refuse unowned skill collisions, edited deployments, malformed markers, and symlink write targets.
- Project identity is a stable ID; names are display labels; directories are local bindings.
- Do not claim a harness loaded configuration when only a filesystem deployment was observed.
- Verify filesystem ownership, rollback, scope isolation, stale plans, and API access controls with integration tests.
- Run `npm test` and `npm run build` after core changes.
