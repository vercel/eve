---
"eve": patch
---

Trace destinations now receive common credential formats in model and tool content, span events, and span status messages as `[REDACTED]`.

The redaction covers the GenAI content attributes, their AI SDK counterparts, `agent.channel.delivery.input`, and `eve.instructions`, and it runs before any destination `exportPolicy`.
