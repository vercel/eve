---
"eve": patch
---

Direct-provider models (e.g. `anthropic(...)`) no longer fail to compile when their model id is absent from the Vercel AI Gateway catalog or the gateway is unreachable. External-routed models skip the catalog requirement and keep their provider-native id, resolving their context window best-effort and falling back to a default compaction threshold when unknown. Gateway-routed models still require known context-window metadata, now with a clearer, actionable error.
