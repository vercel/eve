---
"eve": patch
---

Derive the Vercel function runtime from `bunVersion` in the app's `vercel.json` during production builds, so an app that selects `"1.4.x"` runs its functions on Bun 1.4 instead of Nitro's default `bun1.x` mapping.
