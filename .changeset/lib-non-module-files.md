---
"eve": patch
---

Non-module files under `agent/lib/`, such as a JSON file imported by a helper, no longer fail discovery. eve ignores them like it does in `tools/`, `channels/`, and `hooks/`, and the bundler resolves them when imported.
