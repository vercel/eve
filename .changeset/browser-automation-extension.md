---
"@eve/agent-browwser": minor
---

Add the experimental `@eve/agent-browwser` extension for sandboxed browser automation backed by agent-browser.

The package ports `@agent-browser/eve` with 42 browser tools, app-owned access settings, inline screenshots, per-tool overrides, and sandbox installation helpers. It targets agent-browser 0.41.1 and uses eve's environment preparation API. The existing `extension/agent-browser` registry item now installs this package.

Change imports from `@agent-browser/eve`, `@agent-browser/eve/tools`, and `@agent-browser/eve/sandbox` to the corresponding `@eve/agent-browwser` entry points. Prepare sandbox templates with `VercelSandbox.environment({ prepare })` instead of `bootstrap`.

Thanks @Railly for the upstream extension implementation.
