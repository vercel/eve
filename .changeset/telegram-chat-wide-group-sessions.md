---
"eve": minor
---

Telegram group and supergroup chats now keep one continuous session per chat or forum topic, the same way private chats do. A fresh mention resumes the conversation instead of starting a new session anchored to that message, replies to bot messages and callback queries land on the same session, and outbound group sends no longer re-key the session to the posted message id. Pass `conversationId` on a proactive `receive` target to pin a specific thread.
