# Add a harness in JSON

1. Copy `tests/fixtures/harnesses/acme.json` into this directory.
2. Choose a stable ID and verify the tool's actual discovery paths.
3. Set native directories, all read directories and instruction precedence.
4. Add `notes.zh-CN`; optionally add English, homepage and monogram.
5. Run `hsync harness validate harnesses/your-tool.json`.
6. Test plan/apply with an isolated HOME and HARNESS_SYNC_HOME.
7. Submit the JSON, discovery evidence and integration test in a PR.
   See [the plugin guide](../docs/plugins.md) for the full schema and security model.
