---
"eve": patch
---

`eve add channel/telegram` now offers guided setup with Vercel Connect or portable credentials.

With Connect, it stores the bot token in a Telegram connector and routes the connector's triggers to `/eve/v1/telegram`, so Connect registers and verifies the webhook. With portable credentials, it writes the bot token and a generated webhook secret to `.env.local`.
