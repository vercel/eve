---
"eve": patch
---

`server-only` and `client-only` imports now load as empty modules in every eve bundle, so tools, channels, workflow steps, and shared workspace packages that import them build and boot without `--conditions=react-server` or a direct dependency. Thanks @jakeleventhal for the original implementation in #3752.
