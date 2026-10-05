---
"eve": minor
---

Files people send now reach the agent on more channels. Telegram keeps a file's real type instead of `application/octet-stream`, Linear reads uploaded files linked in a prompt (not only images), and Twilio passes MMS media to the agent. `messageToUserContent` from `eve/channels/chat-sdk` is now async and downloads attachments through the adapter's `fetchData`, so update callers to `await messageToUserContent(message)`.
