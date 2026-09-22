---
"eve": minor
---

Replace object-form sandbox definitions with exported provider environments whose `open()` method starts and returns the current eve session's persistent live sandbox. After successful selector initialization, durable boundaries resume directly from immutable provider state without rerunning `defineSandbox()`; provider-specific session capabilities remain precisely typed.
