---
"eve": patch
---

Agents can now be published as Agent2Agent (A2A) v1.0 servers with the experimental `a2aChannel` from `eve/experimental/channels/a2a`, so other agents can discover them from an Agent Card and delegate durable, streaming tasks over JSON-RPC.

A channel route whose path ends in a file extension, such as `/.well-known/agent-card.json`, no longer fails the build.
