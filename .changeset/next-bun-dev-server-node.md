---
"eve": patch
---

Start the `withEve` local dev server with Node when Next.js itself is running under Bun, avoiding Bun-only runtime globals leaking into the eve Nitro worker.
