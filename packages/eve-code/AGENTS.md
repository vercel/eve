# eve-code Extension Package

This package is an eve extension for CLI-based coding work. It contributes one patch editing primitive, computer use, an authenticated `gh` tool, sandbox `grep`, shared PR-watch primitives, investigation and PR skills, instruction fragments, a read-only worker subagent, Connect-backed authentication hooks, and consumer sandbox helpers. Durable `prwatch` / `prwatch_delete` wrappers currently live beside e0's consumer mount because eve workflow directives are application-only.

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

`eve extension build` emits the package into `dist/`, including declarations and the compatibility manifest. Ship `dist/` only, keep `eve` as a wildcard peer and a `workspace:*` development dependency, and use catalog versions for shared third-party dependencies. Keep tests under `test/unit/`, `test/integration/`, and `test/scenario/`, outside the discovered extension tree. Run typecheck, all three test tiers, build, lint, and package-scoped formatting before completion.

This extraction is staged: keep the package private until publication and the internal-agents consumer migration are handled separately.
