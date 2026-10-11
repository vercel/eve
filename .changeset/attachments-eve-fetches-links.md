---
"eve": minor
---

eve now downloads attachment links itself instead of handing them to the model provider. When a channel's `fetchFile` returns `null`, or the channel has none, eve fetches a public `https:` link with the 25 MB upload cap and a 30-second timeout, at most 10 links per message and one at a time, and any other link or failed download reaches the model as a note. A private or expired link, such as a Google Drive file shared in Slack, no longer fails every later model call, and sessions that already hold such a link recover.
