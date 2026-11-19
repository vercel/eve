---
"eve": patch
---

`eveVite()` no longer fails Vercel builds of single-page apps whose `vercel.json` or `vercel.ts` sets routing such as headers or rewrites; Vercel applies that routing to the static output.
