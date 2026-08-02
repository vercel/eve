---
"eve": patch
---

Accept an explicit Bedrock provider-family override for prompt caching on opaque
application inference profile ids (#1314).

`detectPromptCachePath` previously inferred the Anthropic-direct cache path on
Bedrock only when the model id contained `anthropic`. Application inference
profile ids can be opaque, so an Anthropic model reached through one classified
as `none` and the stable prefix received no Bedrock cache points.

An agent can now declare the profile's underlying provider family via
`modelOptions.providerOptions.bedrock.inferenceProfileTarget = "anthropic"`.