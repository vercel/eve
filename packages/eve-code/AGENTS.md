# @eve/code Extension Package

This private package is the source of the `eve/extensions/code` extension for CLI-based coding work. It contributes one patch editing primitive, computer use, an authenticated `gh` tool, sandbox `grep`, shared PR-watch primitives, investigation and PR skills, instruction fragments, a read-only worker subagent, Connect-backed authentication hooks, and consumer sandbox helpers. Durable `prwatch` / `prwatch_delete` wrappers currently live beside e0's consumer mount because eve workflow directives are application-only.

Before writing code, read the installed eve package docs for extensions, hooks, tools, skills, subagents, and sandboxes as applicable.

## Boundaries

- Connector UIDs and GitHub organization names enter through extension config. The authentication hook resolves Vercel app tokens before each turn; the `gh` tool leases a repository-scoped GitHub token per invocation.
- Consumers with non-Connect credentials may call `authenticateGitHub` or `authenticateVercel` directly from their sandbox lifecycle.
- Broker credentials without placing them in model-authored URLs or arguments.
- Use real `git`, `gh`, and `vc` CLIs rather than bespoke repository lifecycle tools.
- Keep `apply_patch` as the only extension-owned file editing primitive.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.
- Preserve the computer-use sandbox exports in `extension/lib/sandbox.ts`.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/code/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json` and `packages/eve/src/extensions/code/`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`; third-party imports are bundled into eve's dist. Keep tests under `test/unit/`, `test/integration/`, and `test/scenario/`, outside the discovered extension tree. Run typecheck, all three test tiers, eve's build, lint, and package-scoped formatting before completion.
