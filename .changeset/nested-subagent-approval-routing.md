---
"eve": patch
---

Fixed approvals from nested subagents stalling when a subagent relayed more than one open request, such as approvals from two of its own subagents. Answering the earlier request now reaches the subagent that asked, instead of arriving at the root agent as a new message.
