# @eve/git Extension Package

This private package is the source of the `eve/extensions/git` extension. It owns everything GitHub-facing: the pull request skill, GitHub instructions, and, with `github` config, the Connect-brokered `gh` tool and signed-commit workflow.

Before writing code, read the installed eve package docs for extensions, tools, skills, instructions, and sandboxes as applicable.

## Boundaries

- Without `github` config, contribute no tools: agents use the `gh` and `git` CLIs from their own shell. Never tell them shell credentials are unavailable.
- With `github` config, the `gh` tool leases a repository-scoped GitHub token per invocation. Broker credentials without placing them in model-authored URLs or arguments.
- Keep GitHub and pull request content here, not in `@eve/code`. `@eve/code` imports `extension/lib/sandbox.ts` helpers for its deprecated `code({ github })` path.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/git/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json` and `packages/eve/src/extensions/git/`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`; third-party imports are bundled into eve's dist. Keep tests under `test/unit/`, `test/integration/`, and `test/scenario/`, outside the discovered extension tree. Run typecheck, all three test tiers, eve's build, lint, and package-scoped formatting before completion.
