---
"eve": patch
---

Remote agent dispatch now ignores an empty `outputSchema` (`{}`) passed by the model on the lowered subagent tool call, matching local subagent dispatch. An empty schema constrains nothing, but forwarding it flipped the remote child into structured-output mode and replaced its text reply with `{}`.
