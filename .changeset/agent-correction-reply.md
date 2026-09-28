---
"eve": patch
---

Correcting an agent by `taskId` while it works now gets the agent's corrected reply, and a correction sent during the agent's first turn joins that turn instead of waiting for it to end. Before, a message the agent read only after its turn ended was answered with the earlier turn's reply, and the corrected reply was lost, which could leave the caller's turn waiting forever. The same applies to `ctx.agent(name).send()`: a response resolves with the result of the turn that read its message.
