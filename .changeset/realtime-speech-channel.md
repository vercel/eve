---
"eve": patch
---

Add a Vercel realtime speech channel (exported at `eve/channels/vercel/speech`) plus a React voice hook. The channel mints AI Gateway realtime client secrets so the browser can hold the audio socket, while finalized transcripts run as ordinary durable turns through the existing `/eve/v1/session` routes and event stream — no Eve request blocks for a full model turn, and spoken replies are read back on `message.completed`. `eve/react/voice` provides the browser hook (`useEveVoice`); non-React clients use `setupVoice` plus `client.session()`.
