---
"eve": minor
---

eve's public types no longer expose AI SDK, zod, OpenTelemetry, or channel-adapter types: `anthropic()`, `openai()`, `chatgpt()`, and `mockModel()` return `EveLanguageModel` (use an AI SDK provider's model when calling AI SDK functions directly), `DecisionModel` requires specification `v4`, memory providers return `MemoryToolSet` in place of the removed `MemoryToolDefinition`, and `eve/instrumentation/otel`, `eve/channels/linq`, and `eve/channels/photon` export eve-owned span processor/exporter, `LinqWebhookVerifier`, and `PhotonIMessageWebhookVerifier`/`PhotonProjectCredentials` types. Any AI SDK language model or OpenTelemetry processor still type-checks wherever eve accepts one.
