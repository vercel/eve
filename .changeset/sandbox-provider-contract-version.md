---
"eve": minor
---

Custom sandbox providers must set `contractVersion: 1` in `defineSandboxProvider()`.

eve throws when the version is missing or unsupported, both when the provider is defined and again when the app's eve uses it, so a provider package that bundles its own eve is checked too. Built-in providers already set it.
