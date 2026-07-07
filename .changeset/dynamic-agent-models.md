---
"eve": patch
---

Add `defineDynamic({ fallback, events })` support for scoped dynamic agent model selection. Agents can choose a model once per session, once per turn, or per model step while keeping a compiled fallback for metadata and unset scopes.
