## Problem and resulting behavior

Describe the trigger, the problem, and what changes for the user. Link related issues.

## Validation

List commands run and their results. Note skipped checks and why. Core changes require `npm test` and `npm run build`. Documentation-only changes can use command, link, and formatting checks.

## Tool discovery evidence (if applicable)

Name the tool, version, and platform. Link official docs or inspected source and give sanitized isolated probe results. Separate filesystem deployment from session loading. State what remains unverified, including same-name behavior.

## Checklist

- [ ] Shared core handles behavior for both CLI and GUI; the UI adds no filesystem mutations.
- [ ] Source stays portable; device paths, settings, receipts, and snapshots stay local.
- [ ] Ownership, marker preservation, symlink refusal, stale-plan checks, and rollback protection are preserved.
- [ ] Changed safety behavior has meaningful integration coverage, including scope or API access controls where relevant.
- [ ] CLI/GUI checks and tests use fake homes, stores, project paths, and remote fixtures; OS service commands are faked in tests.
- [ ] Both READMEs and relevant docs reflect changed behavior, commands, or supported tools.
- [ ] No credentials, personal configuration, deployment snapshots, or generated local state are included.
