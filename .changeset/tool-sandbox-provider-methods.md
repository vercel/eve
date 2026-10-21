---
"eve": patch
---

Inside tools, `ctx.getSandbox(environment)` now exposes every method of a custom provider's session, including methods defined on its class. Previously those were missing at runtime even though the type promised them.
