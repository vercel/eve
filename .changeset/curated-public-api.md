---
"eve": minor
---

Public APIs now use eve-owned contracts for history, decisions, channel integrations, and sandboxes; legacy aliases and internal helpers are no longer exported. `decide` takes `signal` instead of `abortSignal` and returns only `answers` and `usage`; update other imports using the [v27 upgrade guide](https://eve.dev/docs/concepts/upgrade-to-v27-events).
