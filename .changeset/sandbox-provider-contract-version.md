---
"eve": minor
---

`defineSandboxProvider()` now requires `contractVersion: 1`, the version of eve's sandbox provider contract the provider targets, and throws when it is missing or unsupported. Add `contractVersion: 1` to custom providers; built-in providers already set it.
