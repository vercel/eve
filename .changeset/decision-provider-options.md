---
"eve": patch
---

`auto()` from `eve/models`, `auto()` from `eve/tools/approval`, and `decide()` from `eve/ai` now accept provider options for the decision model call, such as AI Gateway's `zeroDataRetention`.

Pass `modelOptions: { providerOptions: { gateway: { zeroDataRetention: true } } }` to either `auto()`, or `providerOptions` to `decide()`, to keep the decision on providers with zero data retention agreements.
