---
"eve": patch
---

`auto()` from `eve/models` and `eve/tools/approval` accept `modelOptions.providerOptions`, and `decide()` accepts `providerOptions`, so decision calls can set options such as AI Gateway's `zeroDataRetention`.
