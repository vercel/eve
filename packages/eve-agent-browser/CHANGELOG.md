# @eve/agent-browser

## 0.1.0-rc.1

Released 2026-11-07 · [Compare with 0.1.0-rc.0](https://github.com/vercel/eve/compare/%40eve%2Fagent-browser%400.1.0-rc.0...%40eve%2Fagent-browser%400.1.0-rc.1)

### Dependencies

- Updated eve to 1.0.0-rc.7.

## 0.1.0-rc.0

Released 2026-11-03 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fagent-browser%400.1.0-rc.0)

### Features

- Add the experimental `@eve/agent-browser` extension for sandboxed browser automation backed by agent-browser.
  The package ports `@agent-browser/eve` with 42 browser tools, app-owned access settings, inline screenshots, per-tool overrides, and sandbox installation helpers. It targets agent-browser 0.41.1 and uses eve's environment preparation API. With content boundaries enabled, it preserves CLI boundary metadata and renders model-facing markers after screenshot filtering. The existing `extension/agent-browser` registry item now installs this package.
  Change imports from `@agent-browser/eve`, `@agent-browser/eve/tools`, and `@agent-browser/eve/sandbox` to the corresponding `@eve/agent-browser` entry points. Prepare sandbox templates with `VercelSandbox.environment({ prepare })` instead of `bootstrap`.
  Thanks @Railly for the upstream extension implementation. ([#5855](https://github.com/vercel/eve/pull/5855))

### Dependencies

- Updated eve to 1.0.0-rc.3.
