# @eve/self-improvement

## 0.1.1

Released 2026-11-20 · [Compare with 0.1.0](https://github.com/vercel/eve/compare/%40eve%2Fself-improvement%400.1.0...%40eve%2Fself-improvement%400.1.1)

### Bug Fixes

- Fix `eve build` for an app that imports `eve/extensions/code/sandbox` and also mounts `@eve/self-improvement`.
  The self-improvement maintainer mounts its own `code` extension, so the build rejected the app's `installCodeTooling` import as belonging to two mounts. An app import now binds to the app's mount and skips mounts nested inside another extension. The coordinator's `step` tool input is now an object with an `action` enum instead of a root-level union, which Claude rejects. ([#6725](https://github.com/vercel/eve/pull/6725))

### Dependencies

- Updated eve to 1.3.0.

## 0.1.0

Released 2026-11-20 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fself-improvement%400.1.0)

### Features

- Add `@eve/self-improvement` for scheduled, evidence-backed improvements to eve agents on Vercel.
  The extension analyzes minimized Agent Runs telemetry, stores private evidence in Vercel Blob, creates and reconciles tested GitHub PRs, and reports each nightly decision through the host agent. Proposal mode is the default; automatic shipping requires independent application checks and a trusted release service. ([#6660](https://github.com/vercel/eve/pull/6660))

### Dependencies

- Updated eve to 1.2.0.
