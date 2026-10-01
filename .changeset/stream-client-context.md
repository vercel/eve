---
"eve": patch
---

Record each turn's `clientContext` on its `message.received` stream event as `data.clientContext`, exactly as the client sent it. The default message reducer exposes it on the confirmed user message as `metadata.clientContext`, so apps that rebuild chat history from the stream can recover it.
