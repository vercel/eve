# @eve/cua Extension Package

This private package is the source of the `eve/extensions/cua` extension. It contributes the `computer_use` tool and the sandbox helpers that install and start the desktop and driver.

Before writing code, read the installed eve package docs for extensions, tools, and sandboxes as applicable.

## Boundaries

- Keep this extension free of coding tools; those belong in `@eve/code`.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.
- Keep the sandbox exports in `extension/lib/sandbox.ts`; `@eve/code` re-exports them for compatibility.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/cua/extension` and compiles it into the `eve` package; public entry points are declared in `packages/eve/package.json` and `packages/eve/src/extensions/cua/`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`; third-party imports are bundled into eve's dist. Keep tests under `test/scenario/`, outside the discovered extension tree. Run typecheck, the scenario tests, eve's build, lint, and package-scoped formatting before completion.
