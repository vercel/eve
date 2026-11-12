---
"eve": patch
---

Send a Slack sign-in prompt to the person's DM when the session has no thread, instead of posting a status top-level in the channel.

The DM names the channel the request came from, is edited in place with the outcome, and needs no Slack scope beyond `chat:write`. If the DM can't be sent, eve posts in the channel as before. Threaded sessions and code channels are unchanged.
