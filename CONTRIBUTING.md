# Contributing to HarnessSync

HarnessSync is a local-first configuration manager for AI coding tools. Contributions can improve tool support, documentation, internationalization, the GUI, or the shared core. Read [AGENTS.md](AGENTS.md) for project rules and [docs/architecture.md](docs/architecture.md) for the module map. [CONTEXT.md](CONTEXT.md) records domain terms and implementation decisions in Chinese.

## Development setup

Use Node.js 22.12 or newer, npm, and Git. CI uses Node.js 24 on macOS and Linux. Use WSL on Windows; native Windows is not supported. Real tool-session acceptance is recorded only for macOS.

```sh
git clone https://github.com/RayMorTwinkle/HarnessSync.git
cd HarnessSync
npm ci
npm run build
```

No global installation is needed. `npm run cli -- <command>` runs the source CLI; `npm run dev` serves the GUI with frontend hot reload. `npm start` serves the built GUI, and `node dist/cli.js <command>` runs the built CLI. Use the sandbox below for all of these commands.

## Use a fake HOME

Never test against your actual tool directories or your real HarnessSync library. Both HOME and HARNESS_SYNC_HOME must point to temporary directories. Setting only HARNESS_SYNC_HOME isolates the library, but leaves native deployment paths in your real home. Inherited tool-root variables can also escape a fake HOME.

Copy this block from the repository root. It initializes a temporary store, inspects an empty deployment plan, and runs targeted tests inside an isolated environment; the helper also works for interactive GUI development.

```sh
(
  sandbox=$(mktemp -d)
  mkdir -p "$sandbox/home" "$sandbox/store"
  trap 'rm -rf -- "$sandbox"' EXIT

  hs_sandbox() {
    env -u DSH_HOME -u DSH_AGENTS_HOME -u CODEX_HOME \
      -u CLAUDE_CONFIG_DIR -u XDG_CONFIG_HOME \
      HOME="$sandbox/home" HARNESS_SYNC_HOME="$sandbox/store" "$@"
  }

  hs_sandbox npm run cli -- plan --json
  hs_sandbox node --import tsx --test tests/plugins.test.ts tests/deployment.test.ts
  # For GUI work, run this here and stop it with Ctrl+C before leaving:
  # hs_sandbox npm run dev
)
```

This does not copy your credentials or configuration. Keep project bindings and imported fixtures inside the temporary directory too. For a new plugin, clear its environment overrides as well, and inspect any absolute paths in its manifest. A manifest is deployment configuration, not a sandbox.

A fake HOME alone does not isolate OS service managers or locally installed tool executables. Service tests must inject a fake command runner; use `tests/settings-helpers.ts` and `tests/service.test.ts` as examples. Do not run `service install`, `service uninstall`, or change `startup.login` in routine tests. Status/onboarding can probe tool versions from PATH; stub probes or control PATH when testing them. Do not load `.env` files, copy tokens, or use real remote credentials for fixtures.

## Project layout

| Path                             | Purpose                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/core/`                      | Source library, plans, deployment, receipts, sync, settings, services, and skill sources |
| `src/shared/types.ts`            | Shared data types and input validation                                                   |
| `src/shared/harness-manifest.ts` | Strict plugin format and cross-field validation                                          |
| `harnesses/*.json`               | Built-in tool manifests                                                                  |
| `schema/harness.schema.json`     | Generated editor schema for manifests                                                    |
| `src/cli.ts`                     | Commander CLI; calls the core                                                            |
| `src/server.ts`                  | Local HTTP API, authentication, and UI serving                                           |
| `src/web-ui.ts`                  | Browser opening and verification/reuse of an existing service                            |
| `src/ui/`                        | React UI and HTTP client                                                                 |
| `skills/`                        | Bundled installation and configuration-management skills                                 |
| `tests/`                         | Integration tests and isolated fixtures                                                  |
| `scripts/harness-schema.ts`      | Generates the committed editor schema                                                    |
| `docs/`                          | Operational guides, architecture, and evidence records                                   |
| `install.sh`                     | User-level Git-based installer                                                           |

## Invariants to preserve

These are the rules in [AGENTS.md](AGENTS.md), with the reasons behind them:

1. **One core for GUI and CLI.** Put configuration and deployment logic in `src/core/`. The UI sends API requests; it must never implement filesystem mutations. Fixing one interface must not leave different safety behavior in the other.
2. **Portable source, local device state.** The library's `repo/` is a plain Git repository of source entries and skill packages. Device paths, bindings, variables, settings, receipts, caches, and snapshots stay outside it. Device-scoped source entries do sync; their local path bindings do not.
3. **Read before planning.** Preserve instructions outside HarnessSync markers. Full-file initialization replacement is an explicit exception: stage it from a verified scan, show its full diff, recheck the scan fingerprint, and retain the original in the deployment snapshot.
4. **Ownership is required.** Refuse unowned skill collisions and edits to managed content. An identical unowned skill may be adopted through a reviewed plan without rewriting it. Explicit conflict choices can authorize replacement, import to the library, or skipping; bind those choices to the observed fingerprint. Malformed markers remain errors.
5. **Do not write through symlinks.** Reject symlink write targets and ancestors, except the verified macOS system aliases `/var`, `/tmp`, and `/etc`. The explicit final-link adoption/replacement flow may replace the link with a copy after saving it for rollback; it must not follow the link to write its target. Source skill packages reject links.
6. **Project identity is stable.** Project IDs identify source entries. Names are display labels and paths are per-device bindings. Deploy project content directly into that binding; never simulate project switching by replacing global configuration.
7. **Filesystem evidence has a limit.** A successful apply or healthy doctor result does not establish that a running tool loaded the configuration. Describe real-session evidence separately, including platform, tool version, and what was actually observed.
8. **Prove the safety boundaries.** Use integration tests for ownership, rollback, scope isolation, stale plans, and HTTP access control. Any change to these behaviors needs a meaningful regression test. After core changes, run both `npm test` and `npm run build`.

Automatic deployment follows those same rules. It defaults to enabled, but only applies a clean full plan. Warnings, adoption, replacements, unresolved sync conflicts, or incomplete recovery require review. See [settings and automatic deployment](docs/settings.md) (Chinese); do not bypass those checks in a UI or a new trigger.

## Checks and tests

Run related test files while iterating, in the isolated environment above. For example:

```sh
node --import tsx --test tests/plugins.test.ts tests/deployment.test.ts
node --import tsx --test tests/settings.test.ts tests/auto-deploy.test.ts tests/service.test.ts
npm run typecheck
```

Before submitting a core change, run the full suite and build in that environment:

```sh
npm test
npm run build
```

`npm run build` performs TypeScript checking and builds the UI and CLI. CI also checks the installer with `bash -n install.sh`. Documentation-only changes do not require the full suite: check local links, formatting, and every documented command against `src/cli.ts`. State exactly which checks you ran and which you skipped.

Use local bare Git repositories for sync and upstream-skill tests. Do not require network accounts. New HTTP mutation tests should exercise invalid token, Host, and Origin as relevant, as well as the successful path. Close servers, schedulers, and fake services before removing fixtures.

## Code and documentation style

Keep changes focused and terse. Match the surrounding TypeScript/React style: two spaces, double quotes, semicolons, and existing naming patterns. Use existing validators, Store locks, revision checks, and core entry points. Avoid unrelated refactors.

User-facing UI text, CLI help, errors, and bundled skill text are currently Simplified Chinese. Keep that convention for existing flows; internationalization contributions should handle strings consistently. English contributor documentation should use short, factual sentences. Update both READMEs when shared behavior changes.

Prettier is available. Format only changed paths, for example `npx prettier --write CONTRIBUTING.md docs/architecture.md`. The broad `npm run format` script also rewrites source and tests; avoid it for a documentation-only patch.

## Adding a tool plugin

Follow the complete [plugin guide](docs/plugins.md). A normal tool addition needs a JSON manifest, not a TypeScript adapter.

1. Verify the tool's global and project instruction files and every skill discovery directory. Record environment overrides, precedence, and behavior for same-named copies. Use official docs, source inspection, or isolated probes; distinguish evidence from assumptions.
2. Use the fictional Acme example as a starting point. Pick a stable ID, include the native directory in each reader list, and provide an unconditional main/override instruction fallback. For a built-in manifest, include `notes.zh-CN` and an English note for contributors.
3. In a fake HOME, run `hsync harness validate /absolute/tool.json`, then place it in the directory printed by `hsync harness dir`. From source, substitute `npm run cli --` for `hsync`. Exercise list, scan, plan, apply, rollback, and local enable/disable. Inspect the actual written paths. Enable/disable changes management state and invalidates old plans; it does not itself deploy.
4. Add the manifest to `harnesses/` and integration fixtures/tests. Check shared readers, project scope, environment overrides, collisions, stale plans, and disabling/re-enabling. If the format changes, update `src/shared/harness-manifest.ts` and regenerate the editor schema with `npm run schema:harness`.
5. Update both README tool tables from the manifests. Run relevant plugin/deployment/onboarding tests, then the full suite and build for core changes.

The PR should name the tool and tested version/platform, link discovery documentation or inspected source, provide sanitized reproduction steps/results, and identify any unverified behavior. Separate filesystem deployment from actual session loading. A screenshot alone does not prove discovery. If same-name behavior is uncertain, use the conservative `list` value and explain the gap.

## Pull request checklist

- Explain the problem and resulting behavior, with a reproduction when useful.
- Keep UI and CLI behavior in the shared core; preserve the invariants above.
- Add meaningful integration coverage for changed safety behavior.
- Use only fake homes, stores, projects, and remote fixtures during testing.
- Report targeted/full tests and build results, including skipped checks and why.
- Update both READMEs and relevant guides when behavior or commands change.
- Include discovery evidence for a new tool and separate session claims from file checks.
- Exclude credentials, personal paths, native configuration, snapshots, and generated local state.

## Reporting security issues privately

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or use the [private report form](https://github.com/RayMorTwinkle/HarnessSync/security/advisories/new). Include affected versions, impact, and a minimal reproduction with fake paths and redacted data.

This action is available only if the repository owner has enabled private reporting. If it is unavailable, ask a maintainer for a private contact without posting vulnerability details. Do not use public bug reports for security-sensitive reproductions. The documentation does not establish that private reporting is currently enabled.
