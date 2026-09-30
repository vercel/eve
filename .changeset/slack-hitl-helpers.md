---
"eve": patch
---

`eve/channels/slack` now exports `renderInputRequestBlocks`, `deriveHitlResponse`, and `HITL_ACTION_PREFIX`, with the `SlackHitlAction`, `DerivedHitlResponse`, and `SlackHitlRoute` types. Apps can render eve's HITL Block Kit controls and decode clicks on them without importing from eve's build output.
