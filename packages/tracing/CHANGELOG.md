# @vercel/agent-runs

## 1.0.0-rc.0

Released 2026-10-30 · [Compare with 0.0.4](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.4...%40vercel%2Fagent-runs%401.0.0-rc.0)

### Breaking Changes

- `@vercel/agent-runs` 1.0 puts its public API under semantic versioning, so it changes incompatibly only in a major release. ([#5620](https://github.com/vercel/eve/pull/5620))

## 0.0.4

Released 2026-10-29 · [Compare with 0.0.3](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.3...%40vercel%2Fagent-runs%400.0.4)

### Bug Fixes

- Release notes now list breaking changes first and use plain headings, one paragraph per change, and a single compare link.
  A `minor` changeset always appears under Breaking Changes, so breaking changes merged with an internal PR title are no longer left out. The 0.86.0 and 0.87.0 notes now include the two breaking changes they missed. ([#5588](https://github.com/vercel/eve/pull/5588))

## 0.0.3

Released 2026-10-28 · [Compare with 0.0.2](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.2...%40vercel%2Fagent-runs%400.0.3)

### Bug Fixes

- Resolve catalog dependencies in staged packages so npm can install them. ([#5554](https://github.com/vercel/eve/pull/5554))
- Restore current release notes to `CHANGELOG.md` at the package root. ([#5552](https://github.com/vercel/eve/pull/5552))

## 0.0.2

Released 2026-10-28 · [Compare with 0.0.1](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.1...%40vercel%2Fagent-runs%400.0.2)

### Features

- Ship current release notes at `dist/CHANGELOG.md` with a version-pinned link to the full changelog. ([#5446](https://github.com/vercel/eve/pull/5446))

## 0.0.1

### Patch Changes

- c1b079c: Publish framework-neutral tracing as `@vercel/agent-runs` with singular `createAgentRun` and `AgentRun` APIs; eve still bundles it without a new runtime dependency. Also fix a development-server build failure in npm-installed apps when generating source maps.
