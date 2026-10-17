---
"eve": minor
---

Slack card, Twilio webhook, and Vercel sandbox settings now use eve-owned contracts. Create Vercel drives through `@vercel/sandbox` and mount by ID; import Next.js config types from `next` instead of the removed `EveNext*` aliases, and use the narrowed, documented workflow helpers.
