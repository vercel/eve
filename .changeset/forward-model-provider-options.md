---
"eve": patch
---

fix(harness): forward authored model `providerOptions` to the model call

Authored `modelOptions.providerOptions` were resolved onto the model reference but
only applied on the `gateway-auto` cache path, so direct-provider agents silently
lost them. For the OpenAI Responses model this left `store` defaulting to `true`,
which broke multi-turn against `store: false` backends (prior turns were sent as
unresolvable `item_reference`s, failing follow-ups with "Item … not found").
