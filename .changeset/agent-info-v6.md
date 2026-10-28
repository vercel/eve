---
"eve": minor
---

`GET /eve/v1/info` now returns agent-info version 6, which end users can read, so it no longer includes skill or schedule markdown, `agent.appRoot`, or `agent.agentRoot`, and instruction `content` is sent only by development servers; read authored files from the agent source instead. `client.info()` now ignores unknown fields and reads unknown enum values as `"unrecognized"`, so handle that value when switching on fields such as `mode` or `sourceKind`, and upgrade agents and clients together since a version 5 server is rejected with an upgrade message.
