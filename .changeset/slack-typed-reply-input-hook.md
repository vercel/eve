---
"eve": patch
---

Slack apps that set `onInputResponse` or `approvalChannel` no longer let a message typed in the thread answer an open question. Before, the typed message answered it without running `onInputResponse`, and the answer was the whole `<slack_message>` envelope. The message now reaches the agent as a new message instead.
