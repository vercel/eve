---
"eve": patch
---

A message sent to an agent task by `taskId` just as the agent's turn ends now reaches the agent and gets the reply of the turn that read it. Before, the message could be settled with the earlier turn's reply without the agent ever seeing it, and a message sent just after a `task_cancel` could be left unanswered.
