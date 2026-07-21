---
"eve": patch
---

Anthropic models served through the standard `@ai-sdk/amazon-bedrock` Converse provider are now detected as cacheable. Prompt-cache breakpoints previously only matched on the provider name, so Bedrock (which reports provider `amazon-bedrock` and carries the Anthropic identity in the model id) fell through to no caching. The cache marker now also carries the Bedrock `cachePoint` namespace that the Converse provider reads.
