# @eve/agent-desktop

## 0.1.0-rc.0

Released 2026-11-03 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fagent-desktop%400.1.0-rc.0)

### Features

- Add the experimental `@eve/agent-desktop` extension for accessibility-based desktop automation in Linux sandboxes.
  Mount the extension to launch apps, inspect accessibility trees, act on snapshot-qualified refs, and capture screenshots. Install agent-desktop in the sandbox environment's `prepare` with `installAgentDesktop`, and include `AGENT_DESKTOP_REVALIDATION_KEY` in the environment options so templates rebuild on upgrade. The package also includes desktop startup helpers, headless defaults, and cancellation errors that preserve delivery uncertainty. ([#5804](https://github.com/vercel/eve/pull/5804))

### Dependencies

- Updated eve to 1.0.0-rc.3.
