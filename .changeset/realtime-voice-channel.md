---
"eve": patch
---

Add a realtime voice channel (`eve/channels/voice`). Talk to your agent over a WebSocket: an utterance is transcribed with AI Gateway speech-to-text, delivered to a normal durable session (so tools, skills, and subagents all work), and the streamed reply is spoken back one sentence at a time with Gateway text-to-speech. Push-to-talk with barge-in; a browser client ships with the Next.js web template at `/voice`.
