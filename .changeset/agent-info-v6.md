---
"eve": minor
---

`GET /eve/v1/info` now returns agent-info version 6, which end users can read, so it drops authored text and server paths; upgrade agents and clients together, since a version 5 server is rejected with an upgrade message.

Gone are skill and schedule markdown, `agent.appRoot`, `agent.agentRoot`, subagent `entryPath`/`rootPath`, and backing `sourcePath`/`extensionScope.sourceRoot` (use `logicalPath`), and instruction `content` and the ChatGPT `accountLabel` come only from development servers. `client.info()` ignores unknown fields and reads unknown enum strings as `"unrecognized"`, so handle that value when switching on fields such as `mode` or `sourceKind`.
