---
"eve": minor
---

eve's authoring and configuration types no longer expose AI SDK, zod, OpenTelemetry, or channel-adapter types, so import eve's own types where you named the third-party ones.

Agent `model` fields accept `EveLanguageModel`, `DecisionModel` requires specification `v4`, memory providers return `MemoryToolSet` instead of the removed `MemoryToolDefinition`, `TokenUsage` is exported from `eve`, and `eve/instrumentation/otel`, `eve/channels/linq`, and `eve/channels/photon` export eve-owned span processor/exporter, `LinqWebhookVerifier`, and `PhotonIMessageWebhookVerifier`/`PhotonProjectCredentials` types. Any AI SDK language model or OpenTelemetry processor still type-checks wherever eve accepts one.
