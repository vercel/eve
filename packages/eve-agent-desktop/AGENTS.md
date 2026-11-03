# @eve/agent-desktop Extension Package

This published package is the `@eve/agent-desktop` extension: accessibility-based desktop tools backed by the agent-desktop CLI, plus the `@eve/agent-desktop/sandbox` helpers that install and start the desktop.

Before writing code, read the installed eve package docs for extensions, tools, and sandboxes as applicable.

## Boundaries

- Each tool wraps one agent-desktop command; the CLI's argument surface is the contract, checked by `test/scenario/conformance.test.mjs`.
- Install only in the consumer's sandbox `prepare` through `installAgentDesktop`. Tools never install at tool time; they probe the version, restart a desktop a resumed sandbox lost, and fail with setup guidance otherwise. Bump `AGENT_DESKTOP_REVALIDATION_KEY` inputs when the install changes.
- Keep `extension/lib/sandbox.ts` and `extension/lib/process.ts` free of other extension imports; they are published as `@eve/agent-desktop/sandbox`.
- Keep shared implementation under `extension/lib/`; filesystem paths define tool names.

## Tests

Tests run against the built `dist/`, so there is no unit tier. Tiers are set by directory:

- `test/integration/`: tools and helpers with in-memory fake sandboxes.
- `test/scenario/`: real subprocesses. `conformance.test.mjs` needs the agent-desktop CLI (`AGENT_DESKTOP_BIN` or on `PATH`) and `live.test.mjs` needs `AGENT_DESKTOP_LIVE=1` on Ubuntu 24.04+ with sudo; both skip otherwise.
- `test/support/`: shared helpers, not tests.

Run typecheck, build, both tiers, lint, and package-scoped formatting before completion.
