---
"eve": patch
---

Allow authored tools to publish presentation-only progress through `ctx.activity.update()`. Updates persist as `action.updated` session events and flow to configured channel activity renderers without entering model context or waking a parent session.
