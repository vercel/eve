---
"eve": patch
---

Fix prompt-cache detection for AWS Bedrock application inference profiles. Previously the Anthropic-direct cache path was inferred solely from the resolved model's `provider` name and `modelId`; an application inference profile id can be opaque and omit the underlying `anthropic` family, so the stable system/tool prefix received no Bedrock cache points and repeated turns were billed as fully uncached input. Detection now supports an explicit, strictly-validated override via `modelOptions.providerOptions.eve = { cachePath: "anthropic-direct" | "none" }`, which takes precedence over inference while leaving existing automatic detection (direct Anthropic, `@ai-sdk/amazon-bedrock` Anthropic model ids, Vertex Anthropic) unchanged.
