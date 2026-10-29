# @vercel/agent-runs

## 0.0.3

Released 2026-10-28 · [Compare with 0.0.2](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.2...%40vercel%2Fagent-runs%400.0.3)

### Bug Fixes

- Resolve catalog dependencies in staged packages so npm can install them. ([#5554](https://github.com/vercel/eve/pull/5554))
- Restore current release notes to `CHANGELOG.md` at the package root. ([#5552](https://github.com/vercel/eve/pull/5552))

Thanks to [@chadhietala](https://github.com/chadhietala).

## 0.0.2

Released 2026-10-28 · [Compare with 0.0.1](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.1...%40vercel%2Fagent-runs%400.0.2)

### Features

- Ship current release notes at `dist/CHANGELOG.md` with a version-pinned link to the full changelog. ([#5446](https://github.com/vercel/eve/pull/5446))

Thanks to [@chadhietala](https://github.com/chadhietala).

## 0.0.1

### Patch Changes

- c1b079c: Publish framework-neutral tracing as `@vercel/agent-runs` with singular `createAgentRun` and `AgentRun` APIs; eve still bundles it without a new runtime dependency. Also fix a development-server build failure in npm-installed apps when generating source maps.
