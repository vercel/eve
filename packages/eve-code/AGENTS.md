# @eve/code Extension Package

This private package is the source of the `eve/extensions/code` extension for CLI-based coding work. It contributes eve's `edit_file` tool, investigation and review skills, instruction fragments, Connect-backed authentication hooks, and consumer sandbox helpers.

Before writing code, read the installed eve package docs for extensions, hooks, tools, skills, subagents, and sandboxes as applicable.

## Boundaries

- Connector UIDs enter through extension config. The authentication hook resolves Vercel app tokens before each turn.
- GitHub instructions, the `pr` skill, and the `gh` tool belong to `@eve/git` (`eve/extensions/git`). The removed `github` config is rejected; do not add GitHub or pull request contributions here.
- Consumers with non-Connect credentials may call `authenticateGitHub` or `authenticateVercel` directly from their sandbox lifecycle.
- Broker credentials without placing them in model-authored URLs or arguments.
- Use real `git`, `gh`, and `vc` CLIs rather than bespoke repository lifecycle tools.
- Mount eve's built-in `edit_file` from `eve/tools/edit_file` as the only file editing tool. Do not add another.
- Do not mount `grep` or other search tools. The instructions point the model at `rg` and `find` in `bash`, as pi does.
- Delegation uses eve's built-in `agent` tool. The removed `worker` config is rejected with a migration hint; do not add an extension-owned worker subagent back.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.
- Computer use lives in `@eve/computer-use` (`eve/extensions/computer-use`). Import its public helpers directly; do not add computer-use code or re-exports here.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/code/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json` and `packages/eve/src/extensions/code/`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`; third-party imports are bundled into eve's dist. Keep tests under `test/unit/`, `test/integration/`, and `test/scenario/`, outside the discovered extension tree. Run typecheck, all three test tiers, eve's build, lint, and package-scoped formatting before completion.
