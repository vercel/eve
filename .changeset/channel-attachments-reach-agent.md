---
"eve": patch
---

Files people send now reach the agent on more channels. Telegram keeps a file's real type instead of `application/octet-stream`, Linear reads uploaded files linked in a prompt (not only images) and leaves a note for one it can't download, and Twilio passes MMS media to the agent. Slack, Telegram, Twilio, and Linear stop a file download at the upload limit instead of reading the whole file into memory.
