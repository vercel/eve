---
"eve": patch
---

Resolve eve project ownership from the nearest `package.json` that declares `dependencies.eve`, then classify its `agent/` or `agents/` shape. This avoids incorrect environment and CLI behavior in repositories that only use eve as development tooling.
