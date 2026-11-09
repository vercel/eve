---
"eve": minor
---

`moveToCodeChannel()` from `eve/channels/slack` moves the Slack thread session that called a tool into a new code channel, keeping its sandbox and history, and releases the thread so its next message starts a fresh session.

Unlike `openCodeChannel()`, which forks a new session into the channel from the conversation's text, the session itself moves: the rest of the turn already posts in the code channel. It needs `codeChannels: true`.
