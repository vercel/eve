---
"eve": minor
---

Set `modelOptions.gatewayAgentTag` to tag an agent's AI Gateway calls with `agent:<name>`, so AI Gateway can report spend per agent when several agents share a project.

eve adds the tag after any `providerOptions.gateway.tags` you set, never duplicates it, and skips it when your tags already fill AI Gateway's limit of 10. It's off by default because AI Gateway bills each tag.
