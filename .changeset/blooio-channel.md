---
"eve": minor
"@vercel/eve-catalog": minor
---

Add a built-in Blooio channel (`eve/channels/blooio`).

`blooioChannel()` connects an agent to iMessage, RCS, and SMS through the Blooio v2 API. It verifies inbound `X-Blooio-Signature` webhooks (HMAC-SHA256 over `<timestamp>.<body>`), dispatches `message.received` events with per-line continuation tokens, and supports 1:1 and group conversations. The `BlooioHandle` exposed to hooks and event handlers wraps the full messaging surface: sending text/attachments with iMessage send-effects, inline replies, idempotency keys and contact-card sharing, tapback/emoji reactions, typing indicators, read receipts, contact capability checks, message history, and a raw API escape hatch. Credentials default to `BLOOIO_API_KEY` and `BLOOIO_WEBHOOK_SECRET`.
